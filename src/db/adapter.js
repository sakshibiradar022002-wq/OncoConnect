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

  // Try better-sqlite3 first.
  try {
    const mod = await import('better-sqlite3');
    const Database = mod.default;
    const db = new Database(path);
    impl = 'better-sqlite3';
    return wrapSync(db, path);
  } catch {
    // Fall back to built-in node:sqlite (Node >= 22).
    const { DatabaseSync } = await import('node:sqlite');
    const raw = new DatabaseSync(path);
    impl = 'node:sqlite';
    return wrapSync(wrapNodeSqlite(raw, path), path);
  }
}

export function activeImpl() { return impl; }

// Promisify a synchronous better-sqlite3-style handle.
function wrapSync(db, dbPath) {
  return {
    async exec(sql) { db.exec(sql); },
    async pragma(str) { db.pragma(str); },
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

// node:sqlite has a slightly different API — match better-sqlite3 first.
function wrapNodeSqlite(raw, dbPath) {
  return {
    exec(sql) { raw.exec(sql); },
    pragma(str) { raw.exec(`PRAGMA ${str};`); },
    prepare(sql) {
      const stmt = raw.prepare(sql);
      return {
        run(...args) { return stmt.run(...args); },
        get(...args) { return stmt.get(...args); },
        all(...args) { return stmt.all(...args); },
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
