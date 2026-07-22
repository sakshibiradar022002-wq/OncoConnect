// Consistent online backup of the database.
//
//   node scripts/backup.js [output-dir]        (default ./backups)
// Cron example (daily at 02:00):
//   0 2 * * * cd /app && node scripts/backup.js /data/backups
//
// Local SQLite backends use WAL-safe VACUUM INTO. For Turso (libsql), use
// Turso's own point-in-time restore / `turso db shell --dump` instead — this
// script will tell you and exit.
//
// Backups contain ciphertext only — PHI stays encrypted. Store the
// PHI_ENCRYPTION_KEY separately from backups; one without the other is
// useless to an attacker, and both together are a full disclosure.

import { mkdirSync, readdirSync, statSync, unlinkSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { db } from '../src/db/index.js';
import { activeImpl } from '../src/db/adapter.js';

if (activeImpl() === 'libsql') {
  console.error('Remote Turso database detected. Use Turso\'s built-in backups:');
  console.error('  turso db shell <db-name> .dump > backup.sql');
  process.exit(1);
}

const outDir = resolve(process.argv[2] || './backups');
mkdirSync(outDir, { recursive: true });

const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
const outFile = join(outDir, `oncoconnect-${stamp}.db`);

await db.exec(`VACUUM INTO '${outFile.replace(/'/g, "''")}'`);
console.log(`Backup written: ${outFile} (${(statSync(outFile).size / 1024).toFixed(1)} KB)`);

// Keep the most recent 30 backups.
const old = readdirSync(outDir).filter(f => f.startsWith('oncoconnect-') && f.endsWith('.db')).sort().reverse().slice(30);
for (const f of old) { unlinkSync(join(outDir, f)); console.log(`Pruned old backup: ${f}`); }
process.exit(0);
