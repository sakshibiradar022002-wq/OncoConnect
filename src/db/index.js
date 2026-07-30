// Single shared SQLite connection via the adapter (better-sqlite3 or node:sqlite).

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { pbkdf2Sync, randomBytes } from 'node:crypto';
import { config } from '../config.js';
import { openDatabase, activeImpl } from './adapter.js';
import { encryptPHI, randomToken } from '../crypto.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

export const db = await openDatabase(config.dbPath);
await db.pragma('journal_mode = WAL');
await db.pragma('foreign_keys = ON');
console.log(`[db] using ${activeImpl()}`);

export async function initSchema() {
  const schema = readFileSync(join(__dirname, 'schema.sql'), 'utf8');
  await db.exec(schema);
  // Column additions for databases created before these features existed.
  try { await db.exec('ALTER TABLE users ADD COLUMN totp_enc TEXT'); } catch { /* already there */ }
  console.log('[db] schema ready');
}

// For ephemeral (in-memory) databases used in testing/preview, auto-create test users
export async function initTestData() {
  if (config.dbPath !== ':memory:') return; // only for ephemeral

  console.log('[db] Initializing test data for ephemeral database...');

  // Helper to hash passwords (same as crypto.js hashUiPasswordV2)
  function hashPassword(pwd) {
    const salt = randomBytes(16).toString('base64url');
    const hash = pbkdf2Sync(String(pwd), salt, 210000, 32, 'sha256').toString('base64');
    return `pbkdf2v2:210000:${salt}:${hash}`;
  }

  try {
    // Test doctor account
    const docId = randomToken(8);
    await db.prepare(`
      INSERT INTO users (id, email, name, role, pass_hash, active, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(docId, 'test@example.com', 'Test Doctor', 'doctor', hashPassword('testdoc123'), 1, new Date().toISOString(), new Date().toISOString());
    console.log('[test-data] ✓ Created doctor: test@example.com / testdoc123');

    // Test patient data
    const patId = randomToken(8);
    const patientKey = 'pat_12345';
    const patientData = {
      mrn: '12345',
      name: 'Test Patient',
      dob: '1985-06-15',
      diag: 'Acute Lymphoblastic Leukemia (ALL)',
      docId: docId,
      pass: hashPassword('testpat123'),
    };
    await db.prepare(`
      INSERT INTO kv_store (owner_id, k, v_enc, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(docId, patientKey, encryptPHI(patientData), new Date().toISOString(), new Date().toISOString());
    console.log('[test-data] ✓ Created patient: MRN=12345 / testpat123');

    // Test lab account
    const labId = randomToken(8);
    const labKey = `lab_${docId}_${labId}`;
    const labData = {
      name: 'Test Lab',
      username: 'testlab',
      password: hashPassword('testlab123'),
      labId: labId,
      docId: docId,
    };
    await db.prepare(`
      INSERT INTO kv_store (owner_id, k, v_enc, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(docId, labKey, encryptPHI(labData), new Date().toISOString(), new Date().toISOString());
    console.log('[test-data] ✓ Created lab account: testlab / testlab123');

    console.log('[test-data] ✅ Test data initialized. Ready to test!');
  } catch (e) {
    console.error('[test-data] Error creating test data:', e.message);
  }
}

export async function writeAudit({ actorId, actorRole, action, targetId, detail, ip }) {
  await db.prepare(`
    INSERT INTO audit_log (id, actor_id, actor_role, action, target_id, detail_enc, ip, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    randomToken(12), actorId || null, actorRole || null, action,
    targetId || null, detail ? encryptPHI(detail) : null, ip || null,
    new Date().toISOString()
  );
}
