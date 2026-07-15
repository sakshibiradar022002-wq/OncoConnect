// Re-encrypt every PHI column under a new master key.
//
// Usage:
//   PHI_ENCRYPTION_KEY=<current 64-hex> NEW_PHI_ENCRYPTION_KEY=<new 64-hex> \
//     node scripts/rotate-phi-key.js
//
// Works against whichever backend the server is configured for (local SQLite
// file or Turso via TURSO_DATABASE_URL). Runs in one transaction on local
// backends; on libsql it applies row-by-row, so run it during a maintenance
// window. Afterwards, set PHI_ENCRYPTION_KEY to the new value everywhere and
// restart. Keep the old key until you have verified reads.

import crypto from 'node:crypto';
import { db } from '../src/db/index.js';
import { decryptPHI } from '../src/crypto.js';
import { activeImpl } from '../src/db/adapter.js';

const newKeyHex = process.env.NEW_PHI_ENCRYPTION_KEY;
if (!newKeyHex || !/^[0-9a-fA-F]{64}$/.test(newKeyHex)) {
  console.error('Set NEW_PHI_ENCRYPTION_KEY to a 64-hex-char key (and PHI_ENCRYPTION_KEY to the current one).');
  process.exit(1);
}
if (newKeyHex.toLowerCase() === (process.env.PHI_ENCRYPTION_KEY || '').toLowerCase()) {
  console.error('New key is identical to the current key — nothing to do.');
  process.exit(1);
}
const NEW_KEY = Buffer.from(newKeyHex, 'hex');

function encryptWithNewKey(value) {
  if (value === null || value === undefined) return null;
  const plaintext = Buffer.from(JSON.stringify(value), 'utf8');
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', NEW_KEY, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return `v1.${iv.toString('base64')}.${cipher.getAuthTag().toString('base64')}.${ciphertext.toString('base64')}`;
}

// Every encrypted column in the schema.
const TARGETS = [
  ['users', 'id', ['name_enc', 'meta_enc', 'totp_enc']],
  ['audit_log', 'id', ['detail_enc']],
  ['push_subs', 'endpoint', ['sub_enc']],
];
// kv_store has a composite key; handle it separately below.

const isLocal = activeImpl() !== 'libsql';
let rotated = 0, failed = 0;

if (isLocal) await db.exec('BEGIN');
try {
  for (const [table, pk, cols] of TARGETS) {
    const rows = await db.prepare(`SELECT ${pk} AS pk, ${cols.join(', ')} FROM ${table}`).all();
    for (const row of rows) {
      for (const col of cols) {
        if (!row[col]) continue;
        const plain = decryptPHI(row[col]);   // uses the CURRENT key from env
        if (plain === null) { failed++; console.error(`  ! ${table}.${col} pk=${row.pk} did not decrypt — wrong current key?`); continue; }
        await db.prepare(`UPDATE ${table} SET ${col} = ? WHERE ${pk} = ?`).run(encryptWithNewKey(plain), row.pk);
        rotated++;
      }
    }
    console.log(`  ${table}: done`);
  }

  const kvRows = await db.prepare('SELECT owner_id, k, v_enc FROM kv_store').all();
  for (const row of kvRows) {
    if (!row.v_enc) continue;
    const plain = decryptPHI(row.v_enc);
    if (plain === null) { failed++; console.error(`  ! kv_store ${row.owner_id}/${row.k} did not decrypt`); continue; }
    await db.prepare('UPDATE kv_store SET v_enc = ? WHERE owner_id = ? AND k = ?')
      .run(encryptWithNewKey(plain), row.owner_id, row.k);
    rotated++;
  }
  console.log('  kv_store: done');

  if (failed > 0) throw new Error(`${failed} record(s) failed to decrypt — ${isLocal ? 'rolling back, nothing was changed' : 'STOPPING; already-rotated rows keep the new key'}.`);
  if (isLocal) await db.exec('COMMIT');
  console.log(`\nRotated ${rotated} encrypted values.`);
  console.log('NOW: set PHI_ENCRYPTION_KEY to the new key in your environment and restart the server.');
  process.exit(0);
} catch (err) {
  if (isLocal) await db.exec('ROLLBACK');
  console.error('\nRotation aborted:', err.message);
  process.exit(1);
}
