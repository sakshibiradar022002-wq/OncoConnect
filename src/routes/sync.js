// Encrypted key-value sync for the doctor/patient UIs.
//
// The apps keep their working data in localStorage under cc_* keys. This
// router mirrors an account's whole keyspace server-side, encrypted with the
// PHI master key, so data follows the account across devices instead of
// living in one browser. Doctors sync everything they own; patients get a
// session scoped to the keys that mention their MRN.

import { Router } from 'express';
import { pbkdf2Sync, timingSafeEqual } from 'node:crypto';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import { db, writeAudit } from '../db/index.js';
import { encryptPHI, decryptPHI } from '../crypto.js';
import { authenticate, requireRole, createSession } from '../middleware/auth.js';
import { validate, asyncHandler } from '../middleware/validate.js';

export const syncRouter = Router();

const MAX_KEYS_PER_PUSH = 500;
const MAX_KEY_LENGTH = 200;

function upsertKey(ownerId, k, v, now) {
  if (v === null || v === undefined) {
    db.prepare('DELETE FROM kv_store WHERE owner_id = ? AND k = ?').run(ownerId, k);
  } else {
    db.prepare(`
      INSERT INTO kv_store (owner_id, k, v_enc, updated_at) VALUES (?, ?, ?, ?)
      ON CONFLICT(owner_id, k) DO UPDATE SET v_enc = excluded.v_enc, updated_at = excluded.updated_at
    `).run(ownerId, k, encryptPHI(v), now);
  }
}

function applyChanges(ownerId, changes, allow) {
  const entries = Object.entries(changes);
  if (entries.length > MAX_KEYS_PER_PUSH) {
    const e = new Error('Too many keys in one push'); e.status = 400; throw e;
  }
  const now = new Date().toISOString();
  let count = 0;
  for (const [k, v] of entries) {
    if (typeof k !== 'string' || !k || k.length > MAX_KEY_LENGTH) continue;
    if (allow && !allow(k)) continue;
    upsertKey(ownerId, k, v ?? null, now);
    count++;
  }
  return count;
}

const pushSchema = z.object({ changes: z.record(z.any()) });

// ── Doctor: pull the whole keyspace ───────────────────────────────
syncRouter.get('/', authenticate, requireRole('doctor', 'admin'), asyncHandler(async (req, res) => {
  const rows = db.prepare('SELECT k, v_enc, updated_at FROM kv_store WHERE owner_id = ?')
    .all(req.auth.subjectId);
  const keys = {};
  for (const r of rows) keys[r.k] = { v: decryptPHI(r.v_enc), ts: r.updated_at };
  res.json({ keys });
}));

// ── Doctor: push changes (value null = delete) ────────────────────
syncRouter.put('/', authenticate, requireRole('doctor', 'admin'), validate(pushSchema), asyncHandler(async (req, res) => {
  const count = applyChanges(req.auth.subjectId, req.valid.changes);
  writeAudit({ actorId: req.auth.subjectId, actorRole: req.auth.role, action: 'sync.push', detail: { count }, ip: req.ip });
  res.json({ ok: true, count });
}));

// ── Patient login against the synced records ──────────────────────
// The UI stores patient passwords as "pbkdf2:<salt>:<base64>" hashed in the
// browser with PBKDF2-SHA256 / 100k iterations (legacy records: plaintext).
function verifyUiPassword(password, stored) {
  if (!stored) return false;
  let expected = String(stored);
  let actual = String(password);
  if (expected.startsWith('pbkdf2:')) {
    const [, salt, hash] = expected.split(':');
    if (!salt || !hash) return false;
    actual = pbkdf2Sync(actual, salt, 100000, 32, 'sha256').toString('base64');
    expected = hash;
  }
  const a = Buffer.from(actual);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

// Everything the patient app needs: keys mentioning the MRN, plus the owning
// doctor's profile with credentials stripped.
function collectPatientKeys(ownerId, mrn) {
  const rows = db.prepare('SELECT k, v_enc, updated_at FROM kv_store WHERE owner_id = ? AND instr(k, ?) > 0')
    .all(ownerId, mrn);
  const keys = {};
  let docId = null;
  for (const r of rows) {
    if (r.k.startsWith('doc_')) continue;
    const v = decryptPHI(r.v_enc);
    keys[r.k] = { v, ts: r.updated_at };
    if (r.k === 'pat_' + mrn && v && v.docId) docId = v.docId;
  }
  if (docId) {
    const d = db.prepare('SELECT k, v_enc, updated_at FROM kv_store WHERE owner_id = ? AND k = ?')
      .get(ownerId, 'doc_' + docId);
    if (d) {
      const doc = decryptPHI(d.v_enc) || {};
      delete doc.pass;
      delete doc.passPlain;
      keys[d.k] = { v: doc, ts: d.updated_at };
    }
  }
  return keys;
}

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many attempts, please try again later' },
});

const patientLoginSchema = z.object({
  mrn: z.string().min(3).max(40).transform(s => s.trim().toUpperCase()),
  password: z.string().min(1).max(200),
});

syncRouter.post('/patient-login', loginLimiter, validate(patientLoginSchema), asyncHandler(async (req, res) => {
  const { mrn, password } = req.valid;
  const rows = db.prepare('SELECT owner_id, v_enc FROM kv_store WHERE k = ?').all('pat_' + mrn);

  let ownerId = null;
  for (const r of rows) {
    const rec = decryptPHI(r.v_enc);
    if (rec && (verifyUiPassword(password, rec.pass) || verifyUiPassword(password, rec.passPlain))) {
      ownerId = r.owner_id;
      break;
    }
  }
  if (!ownerId) return res.status(401).json({ error: 'Invalid MRN or password' });

  // Session subject encodes which doctor's keyspace this patient lives in.
  createSession(res, { subjectId: `${ownerId}::${mrn}`, subjectType: 'kv-patient', role: 'kv-patient' });
  writeAudit({ actorId: mrn, actorRole: 'kv-patient', action: 'sync.patient_login', targetId: ownerId, ip: req.ip });

  res.json({ ok: true, mrn, keys: collectPatientKeys(ownerId, mrn) });
}));

function patientScope(req, res, next) {
  const [ownerId, mrn] = String(req.auth.subjectId).split('::');
  if (!ownerId || !mrn) return res.status(401).json({ error: 'Invalid session' });
  req.patientScope = { ownerId, mrn };
  next();
}

// ── Patient: refresh own keys ─────────────────────────────────────
syncRouter.get('/patient', authenticate, requireRole('kv-patient'), patientScope, asyncHandler(async (req, res) => {
  const { ownerId, mrn } = req.patientScope;
  res.json({ keys: collectPatientKeys(ownerId, mrn) });
}));

// ── Patient: push changes — only keys that mention their MRN ──────
syncRouter.put('/patient', authenticate, requireRole('kv-patient'), patientScope, validate(pushSchema), asyncHandler(async (req, res) => {
  const { ownerId, mrn } = req.patientScope;
  const count = applyChanges(ownerId, req.valid.changes, k => k.includes(mrn) && !k.startsWith('doc_'));
  writeAudit({ actorId: mrn, actorRole: 'kv-patient', action: 'sync.patient_push', targetId: ownerId, detail: { count }, ip: req.ip });
  res.json({ ok: true, count });
}));
