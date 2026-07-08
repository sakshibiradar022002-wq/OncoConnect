// Single shared SQLite connection via the adapter (better-sqlite3 or node:sqlite).

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { config } from '../config.js';
import { openDatabase, activeImpl } from './adapter.js';
import { encryptPHI, randomToken } from '../crypto.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

export const db = await openDatabase(config.dbPath);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');
console.log(`[db] using ${activeImpl()}`);

export function initSchema() {
  const schema = readFileSync(join(__dirname, 'schema.sql'), 'utf8');
  db.exec(schema);
  console.log('[db] schema ready');
}

export function writeAudit({ actorId, actorRole, action, targetId, detail, ip }) {
  db.prepare(`
    INSERT INTO audit_log (id, actor_id, actor_role, action, target_id, detail_enc, ip, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    randomToken(12), actorId || null, actorRole || null, action,
    targetId || null, detail ? encryptPHI(detail) : null, ip || null,
    new Date().toISOString()
  );
}
