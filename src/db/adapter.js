// Database adapter — prefers better-sqlite3 (fast, battle-tested), but falls
// back to Node's built-in node:sqlite so the app runs anywhere with zero native
// build step. Both expose the same tiny interface we use: .prepare().run/get/all
// and .exec() and .pragma().

let impl = null;

export async function openDatabase(path) {
  // Try better-sqlite3 first.
  try {
    const mod = await import('better-sqlite3');
    const Database = mod.default;
    const db = new Database(path);
    impl = 'better-sqlite3';
    return db;
  } catch {
    // Fall back to built-in node:sqlite (Node >= 22).
    const { DatabaseSync } = await import('node:sqlite');
    const raw = new DatabaseSync(path);
    impl = 'node:sqlite';
    return wrapNodeSqlite(raw, path);
  }
}

export function activeImpl() { return impl; }

// node:sqlite has a slightly different API — wrap it to match better-sqlite3.
function wrapNodeSqlite(raw, dbPath) {
  return {
    exec(sql) { raw.exec(sql); },
    pragma(str) {
      // better-sqlite3 style: db.pragma('journal_mode = WAL')
      raw.exec(`PRAGMA ${str};`);
    },
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
