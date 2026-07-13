// Database adapter. Three backends behind one tiny async interface:
//
//   - libsql (@libsql/client)  — used when TURSO_DATABASE_URL is set. Points
//     at a Turso cloud database (free tier, no disk needed on the host) or a
//     local file via a file: URL.
//   - better-sqlite3           — local file, fast native binding.
//   - node:sqlite              — local file, zero build step (Node >= 22).
//
// The interface every backend exposes:
//   db.prepare(sql) -> { run(...args), get(...args), all(...args) }  (async)
//   db.exec(sql), db.pragma(str)                                     (async)
//
// All methods return promises so the same route code works against both the
// in-process SQLite files and the remote Turso HTTP API.

let impl = null;

export async function openDatabase(path) {
  const tursoUrl = process.env.TURSO_DATABASE_URL || process.env.LIBSQL_URL;
  if (tursoUrl) {
    const { createClient } = await import('@libsql/client');
    const client = createClient({
      url: tursoUrl,
      authToken: process.env.TURSO_AUTH_TOKEN || undefined,
    });
    impl = 'libsql';
    return wrapLibsql(client, tursoUrl);
  }

  // Serverless hosts (Vercel, Netlify, Cloudflare) have a read-only, ephemeral
  // filesystem — a local SQLite file cannot work there. Fail with a clear,
  // actionable message instead of a cryptic native crash.
  if (process.env.VERCEL || process.env.NETLIFY || process.env.AWS_LAMBDA_FUNCTION_NAME) {
    throw new Error(
      'This is a serverless deployment but no TURSO_DATABASE_URL is set. ' +
      'SQLite files cannot persist on serverless hosts — create a free Turso ' +
      'database (https://turso.tech) and set TURSO_DATABASE_URL and ' +
      'TURSO_AUTH_TOKEN in your host\'s environment variables. ' +
      'Alternatively deploy to a host with a persistent disk (Render, Fly.io, Railway).'
    );
  }

  // Try better-sqlite3 first.
  try {
    const mod = await import('better-sqlite3');
    const db = new mod.default(path);
    impl = 'better-sqlite3';
    return wrapSync(db, (s) => db.pragma(s), path);
  } catch {
    // Fall back to built-in node:sqlite (Node >= 22); it has no .pragma().
    const { DatabaseSync } = await import('node:sqlite');
    const db = new DatabaseSync(path);
    impl = 'node:sqlite';
    return wrapSync(db, (s) => db.exec(`PRAGMA ${s};`), path);
  }
}

export function activeImpl() { return impl; }

// Promisify a synchronous sqlite handle (both share prepare/exec).
function wrapSync(db, pragma, dbPath) {
  return {
    async exec(sql) { db.exec(sql); },
    async pragma(str) { pragma(str); },
    prepare(sql) {
      const stmt = db.prepare(sql);
      return {
        async run(...args) { return stmt.run(...args); },
        async get(...args) { return stmt.get(...args); },
        async all(...args) { return stmt.all(...args); },
      };
    },
    name: dbPath,
  };
}

function wrapLibsql(client, url) {
  return {
    async exec(sql) {
      // executeMultiple runs a whole script (schema files); PRAGMAs are
      // meaningless over the remote HTTP protocol, so strip them.
      const script = sql.split('\n').filter(l => !/^\s*PRAGMA\b/i.test(l)).join('\n');
      await client.executeMultiple(script);
    },
    async pragma() { /* not applicable to a remote database */ },
    prepare(sql) {
      return {
        async run(...args) {
          const r = await client.execute({ sql, args });
          return { changes: r.rowsAffected };
        },
        async get(...args) {
          const r = await client.execute({ sql, args });
          return r.rows[0] ? { ...r.rows[0] } : undefined;
        },
        async all(...args) {
          const r = await client.execute({ sql, args });
          return r.rows.map(row => ({ ...row }));
        },
      };
    },
    name: url,
  };
}
