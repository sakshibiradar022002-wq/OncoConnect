// Encrypted key-value sync for the doctor/patient UIs.
//
// The apps keep their working data in localStorage under cc_* keys. This
// router mirrors an account's whole keyspace server-side, encrypted with the
// PHI master key, so data follows the account across devices instead of
// living in one browser. Doctors sync everything they own; patients get a
// session scoped to the keys that mention their MRN.

import { Router } from 'express';
import { pbkdf2Sync, timingSafeEqual, randomBytes } from 'node:crypto';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import { db, writeAudit } from '../db/index.js';
import { encryptPHI, decryptPHI } from '../crypto.js';
import { authenticate, requireRole, createSession } from '../middleware/auth.js';
import { validate, asyncHandler } from '../middleware/validate.js';
import { notifySubject } from '../push.js';
import { validateLabSubmission } from '../validators/labResults.js';

// Fire-and-forget doctor notifications for incoming alert / lab-result keys.
function pushDoctorForChanges(ownerId, changes) {
  for (const [k, v] of Object.entries(changes || {})) {
    if (k.startsWith('alerts_') && Array.isArray(v) && v[0]) {
      const a = v[0];
      notifySubject(ownerId, {
        title: a.urgent ? '🚨 Urgent patient alert' : 'Patient update',
        body: `${a.name || a.mrn}: ${a.text}`,
        url: '/',
      }).catch(() => {});
    } else if (k.startsWith('lab_subs_')) {
      notifySubject(ownerId, { title: 'New lab result', body: 'A lab uploaded new results. Tap to review.', url: '/' }).catch(() => {});
    }
  }
}

export const syncRouter = Router();

/**
 * @swagger
 * /sync:
 *   get:
 *     summary: Doctor - Sync pull keyspace
 *     tags: [Sync]
 *     security:
 *       - BearerAuth: []
 *     responses:
 *       200:
 *         description: Complete encrypted keyspace for doctor
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 keys:
 *                   type: object
 *   put:
 *     summary: Doctor - Sync push changes
 *     tags: [Sync]
 *     security:
 *       - BearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [changes]
 *             properties:
 *               changes:
 *                 type: object
 *                 description: Key-value changes (null value = delete)
 *     responses:
 *       200:
 *         description: Changes synced successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 ok: { type: boolean }
 *                 count: { type: integer, description: 'Number of keys synced' }
 *                 warnings: { type: array, items: { type: string } }
 *       400:
 *         description: Lab result validation failed or too many keys

 * /sync/patient-login:
 *   post:
 *     summary: Patient login against synced records
 *     tags: [Sync]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [mrn, password]
 *             properties:
 *               mrn:
 *                 type: string
 *                 description: Patient Medical Record Number
 *               password:
 *                 type: string
 *                 description: Patient password
 *     responses:
 *       200:
 *         description: Login successful with patient keyspace
 *       401:
 *         description: Invalid MRN or password
 *       429:
 *         description: Too many login attempts

 * /sync/patient:
 *   get:
 *     summary: Patient - Refresh own keys
 *     tags: [Sync]
 *     security:
 *       - BearerAuth: []
 *     responses:
 *       200:
 *         description: Patient's encrypted keyspace
 *   put:
 *     summary: Patient - Push changes to own keys
 *     tags: [Sync]
 *     security:
 *       - BearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [changes]
 *             properties:
 *               changes:
 *                 type: object
 *                 description: Key-value changes (null value = delete)
 *     responses:
 *       200:
 *         description: Changes synced successfully
 *       400:
 *         description: Lab result validation failed

 * /sync/lab-login:
 *   post:
 *     summary: Lab technician login
 *     tags: [Sync]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [username, password]
 *             properties:
 *               username:
 *                 type: string
 *                 description: Lab account username
 *               password:
 *                 type: string
 *                 description: Lab account password
 *     responses:
 *       200:
 *         description: Login successful with lab keyspace
 *       401:
 *         description: Invalid username or password
 *       429:
 *         description: Too many login attempts

 * /sync/lab:
 *   get:
 *     summary: Lab - Refresh own keys
 *     tags: [Sync]
 *     security:
 *       - BearerAuth: []
 *     responses:
 *       200:
 *         description: Lab's encrypted keyspace
 *   put:
 *     summary: Lab - Push changes (submissions & task tokens)
 *     tags: [Sync]
 *     security:
 *       - BearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [changes]
 *             properties:
 *               changes:
 *                 type: object
 *                 description: Lab submissions and task token updates
 *     responses:
 *       200:
 *         description: Changes synced successfully
 *       400:
 *         description: Lab result validation failed
 */

const MAX_KEYS_PER_PUSH = 500;
const MAX_KEY_LENGTH = 200;

async function upsertKey(ownerId, k, v, now) {
  if (v === null || v === undefined) {
    await db.prepare('DELETE FROM kv_store WHERE owner_id = ? AND k = ?').run(ownerId, k);
  } else {
    await db.prepare(`
      INSERT INTO kv_store (owner_id, k, v_enc, updated_at) VALUES (?, ?, ?, ?)
      ON CONFLICT(owner_id, k) DO UPDATE SET v_enc = excluded.v_enc, updated_at = excluded.updated_at
    `).run(ownerId, k, encryptPHI(v), now);
  }
}

async function applyChanges(ownerId, changes, allow) {
  const entries = Object.entries(changes);
  if (entries.length > MAX_KEYS_PER_PUSH) {
    const e = new Error('Too many keys in one push'); e.status = 400; throw e;
  }
  const now = new Date().toISOString();
  let count = 0;
  for (const [k, v] of entries) {
    if (typeof k !== 'string' || !k || k.length > MAX_KEY_LENGTH) continue;
    if (allow && !allow(k)) continue;
    await upsertKey(ownerId, k, v ?? null, now);
    count++;
  }
  return count;
}

const pushSchema = z.object({ changes: z.record(z.any()) });

// ── Doctor: pull the keyspace, in full or incrementally ───────────
//
// Without ?since, this returns and decrypts EVERY key the doctor owns. A busy
// clinician accumulates thousands, and the 45s background poll paid that cost
// each time just to notice one new lab result.
//
// ?since=<ISO timestamp> returns only keys modified after it, served by the
// idx_kv_owner_updated index. The response carries the server's own clock as
// `now`; clients echo that back on the next poll rather than using their own,
// so client/server clock skew can't skip a write.
//
// Deletions are not reported by either mode — a deleted row simply isn't
// there. That is unchanged behaviour: the client merge only adds and updates,
// so a full pull never propagated deletions either.
syncRouter.get('/', authenticate, requireRole('doctor', 'admin'), asyncHandler(async (req, res) => {
  const since = typeof req.query.since === 'string' ? req.query.since : null;

  // Reject an unparseable timestamp rather than silently falling back to a
  // full pull — a client sending garbage should find out, not just get slower.
  if (since !== null && Number.isNaN(Date.parse(since))) {
    return res.status(400).json({ error: 'Invalid `since` timestamp; expected ISO 8601' });
  }

  const now = new Date().toISOString();
  const rows = since
    ? await db.prepare(
        'SELECT k, v_enc, updated_at FROM kv_store WHERE owner_id = ? AND updated_at > ? ORDER BY updated_at'
      ).all(req.auth.subjectId, since)
    : await db.prepare(
        'SELECT k, v_enc, updated_at FROM kv_store WHERE owner_id = ?'
      ).all(req.auth.subjectId);

  const keys = {};
  for (const r of rows) keys[r.k] = { v: decryptPHI(r.v_enc), ts: r.updated_at };
  res.json({ keys, now, partial: Boolean(since) });
}));

// ── Doctor: push changes (value null = delete) ────────────────────
syncRouter.put('/', authenticate, requireRole('doctor', 'admin'), validate(pushSchema), asyncHandler(async (req, res) => {
  const changes = req.valid.changes;
  const warnings = [];

  // Validate lab submissions for physiological ranges
  for (const [k, v] of Object.entries(changes)) {
    if (k.startsWith('lab_subs_') && v && typeof v === 'object') {
      const validation = validateLabSubmission(v);
      if (!validation.valid) {
        const e = new Error(`Lab result validation failed: ${validation.errors.join('; ')}`);
        e.status = 400;
        throw e;
      }
      if (validation.warnings.length > 0) {
        warnings.push(...validation.warnings);
      }
    }
  }

  const count = await applyChanges(req.auth.subjectId, changes);
  await writeAudit({
    actorId: req.auth.subjectId,
    actorRole: req.auth.role,
    action: 'sync.push',
    detail: { count, labWarnings: warnings.length > 0 ? warnings : undefined },
    ip: req.ip,
  });
  res.json({ ok: true, count, warnings: warnings.length > 0 ? warnings : undefined });
}));

// ── Patient login against the synced records ──────────────────────
// Password formats, oldest to newest:
//   plaintext                              (legacy prototype records)
//   pbkdf2:<salt>:<b64>                    (browser, SHA-256 / 100k)
//   pbkdf2v2:<iterations>:<salt>:<b64>     (server upgrade, SHA-256 / 210k)
// Legacy records are re-hashed to v2 on successful login (see upgradeStoredPassword).
const V2_ITERATIONS = 210000;

function hashUiPasswordV2(password) {
  const salt = randomBytes(16).toString('base64url');
  const hash = pbkdf2Sync(String(password), salt, V2_ITERATIONS, 32, 'sha256').toString('base64');
  return `pbkdf2v2:${V2_ITERATIONS}:${salt}:${hash}`;
}

function verifyUiPassword(password, stored) {
  if (!stored) return false;
  let expected = String(stored);
  let actual = String(password);
  if (expected.startsWith('pbkdf2v2:')) {
    const [, iterStr, salt, hash] = expected.split(':');
    const iterations = parseInt(iterStr, 10);
    if (!salt || !hash || !iterations) return false;
    actual = pbkdf2Sync(actual, salt, iterations, 32, 'sha256').toString('base64');
    expected = hash;
  } else if (expected.startsWith('pbkdf2:')) {
    const [, salt, hash] = expected.split(':');
    if (!salt || !hash) return false;
    actual = pbkdf2Sync(actual, salt, 100000, 32, 'sha256').toString('base64');
    expected = hash;
  }
  const a = Buffer.from(actual);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

// After a successful login, upgrade weak/plaintext stored credentials to v2.
async function upgradeStoredPassword(ownerId, key, rec, password, passField) {
  const stored = rec[passField];
  const isWeak = !String(stored || '').startsWith('pbkdf2') || rec.passPlain;
  if (!isWeak) return;
  const upgraded = { ...rec, [passField]: hashUiPasswordV2(password) };
  delete upgraded.passPlain;
  await upsertKey(ownerId, key, upgraded, new Date().toISOString());
}

// A key belongs to exactly this patient — matched by precise pattern, not a
// loose substring. Substring matching (instr / includes) was safe only while
// every MRN was the same length; exact patterns keep patients isolated even
// if the MRN format ever changes, and stop a patient injecting arbitrary keys.
// Exported so the isolation boundary can be unit-tested directly. This is the
// check that stops one patient reading or writing another's records, so it
// deserves tests that don't depend on standing up a server.
export function patientOwnsKey(k, mrn) {
  const exact = ['pat_', 'msgs_', 'appts_', 'lab_subs_', 'pat_tokens_',
    'reminders_', 'invoices_', 'checkin_', 'travel_'].map(pre => pre + mrn);
  if (exact.includes(k)) return true;
  // Red-flag / triage alerts: alerts_<docId>_<mrn>. Without this the
  // patient app's urgent alerts never leave the patient's own browser.
  if (k.startsWith('alerts_') && k.endsWith('_' + mrn)) return true;
  // date/suffix-scoped families: log_<mrn>_<date>, medlog_<mrn>_<date>,
  // factbr_<mrn>...
  return k.startsWith('log_' + mrn + '_') || k.startsWith('medlog_' + mrn + '_')
    || k.startsWith('factbr_' + mrn);
}

// Everything the patient app needs: their own keys, plus the owning doctor's
// profile with credentials stripped.
async function collectPatientKeys(ownerId, mrn) {
  const rows = await db.prepare('SELECT k, v_enc, updated_at FROM kv_store WHERE owner_id = ?')
    .all(ownerId);
  const keys = {};
  let docId = null;
  for (const r of rows) {
    if (!patientOwnsKey(r.k, mrn)) continue;
    const v = decryptPHI(r.v_enc);
    keys[r.k] = { v, ts: r.updated_at };
    if (r.k === 'pat_' + mrn && v && v.docId) docId = v.docId;
  }
  if (docId) {
    const d = await db.prepare('SELECT k, v_enc, updated_at FROM kv_store WHERE owner_id = ? AND k = ?')
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
  const rows = await db.prepare('SELECT owner_id, v_enc FROM kv_store WHERE k = ?').all('pat_' + mrn);

  let ownerId = null;
  for (const r of rows) {
    const rec = decryptPHI(r.v_enc);
    if (rec && (verifyUiPassword(password, rec.pass) || verifyUiPassword(password, rec.passPlain))) {
      ownerId = r.owner_id;
      await upgradeStoredPassword(ownerId, 'pat_' + mrn, rec, password, 'pass');
      break;
    }
  }
  if (!ownerId) return res.status(401).json({ error: 'Invalid MRN or password' });

  // Session subject encodes which doctor's keyspace this patient lives in.
  await createSession(res, { subjectId: `${ownerId}::${mrn}`, subjectType: 'kv-patient', role: 'kv-patient' });
  await writeAudit({ actorId: mrn, actorRole: 'kv-patient', action: 'sync.patient_login', targetId: ownerId, ip: req.ip });

  res.json({ ok: true, mrn, keys: await collectPatientKeys(ownerId, mrn) });
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
  res.json({ keys: await collectPatientKeys(ownerId, mrn) });
}));

// ── Patient: push changes — only keys that mention their MRN ──────
syncRouter.put('/patient', authenticate, requireRole('kv-patient'), patientScope, validate(pushSchema), asyncHandler(async (req, res) => {
  const { ownerId, mrn } = req.patientScope;
  const changes = req.valid.changes;
  const warnings = [];

  // Validate lab submissions for physiological ranges
  for (const [k, v] of Object.entries(changes)) {
    if ((k.startsWith('lab_subs_') || k === `lab_subs_${mrn}`) && v && typeof v === 'object') {
      const validation = validateLabSubmission(v);
      if (!validation.valid) {
        const e = new Error(`Lab result validation failed: ${validation.errors.join('; ')}`);
        e.status = 400;
        throw e;
      }
      if (validation.warnings.length > 0) {
        warnings.push(...validation.warnings);
      }
    }
  }

  const count = await applyChanges(ownerId, changes, k => patientOwnsKey(k, mrn));
  pushDoctorForChanges(ownerId, changes);
  await writeAudit({
    actorId: mrn,
    actorRole: 'kv-patient',
    action: 'sync.patient_push',
    targetId: ownerId,
    detail: { count, labWarnings: warnings.length > 0 ? warnings : undefined },
    ip: req.ip,
  });
  res.json({ ok: true, count, warnings: warnings.length > 0 ? warnings : undefined });
}));

// ── Lab technician login against the synced records ───────────────
// Lab accounts are created in the doctor UI and stored under
// lab_<docId>_<labId> as { name, username, password, labId, docId }.
// Everything the lab portal needs:
//   - its own account record
//   - pat_tokens_<docId>   (assigned tasks; the lab marks tokens used)
//   - lab_subs_<docId>     (submission list; the lab appends results)
//   - lab_pat_<docId>      (synthesized, sanitized patient list — mrn/name/
//     diagnosis only, no credentials — for the upload dropdown)
async function collectLabKeys(ownerId, docId, labId) {
  const keys = {};
  const wanted = [`lab_${docId}_${labId}`, `pat_tokens_${docId}`, `lab_subs_${docId}`];
  for (const k of wanted) {
    const r = await db.prepare('SELECT k, v_enc, updated_at FROM kv_store WHERE owner_id = ? AND k = ?')
      .get(ownerId, k);
    if (r) keys[r.k] = { v: decryptPHI(r.v_enc), ts: r.updated_at };
  }

  const patRows = await db.prepare("SELECT k, v_enc FROM kv_store WHERE owner_id = ? AND k LIKE 'pat_%' AND k NOT LIKE 'pat_tokens_%'")
    .all(ownerId);
  const patients = [];
  for (const r of patRows) {
    const p = decryptPHI(r.v_enc);
    if (p && p.docId === docId && p.mrn && p.name) {
      patients.push({ mrn: p.mrn, name: p.name, diag: p.diag || '', docId: p.docId });
    }
  }
  keys[`lab_pat_${docId}`] = { v: patients, ts: new Date().toISOString() };
  return keys;
}

const labLoginSchema = z.object({
  username: z.string().min(1).max(100).transform(s => s.trim()),
  password: z.string().min(1).max(200),
});

syncRouter.post('/lab-login', loginLimiter, validate(labLoginSchema), asyncHandler(async (req, res) => {
  const { username, password } = req.valid;
  const rows = await db.prepare("SELECT owner_id, k, v_enc FROM kv_store WHERE k LIKE 'lab_%'").all();

  let found = null;
  for (const r of rows) {
    if (r.k.startsWith('lab_subs_') || r.k.startsWith('lab_tokens_') || r.k.startsWith('lab_pat_')) continue;
    const rec = decryptPHI(r.v_enc);
    if (rec && rec.labId && rec.username === username && verifyUiPassword(password, rec.password)) {
      found = { ownerId: r.owner_id, rec };
      await upgradeStoredPassword(r.owner_id, r.k, rec, password, 'password');
      break;
    }
  }
  if (!found) return res.status(401).json({ error: 'Invalid username or password' });

  const { ownerId, rec } = found;
  await createSession(res, {
    subjectId: `${ownerId}::${rec.docId}::${rec.labId}`,
    subjectType: 'kv-lab',
    role: 'kv-lab',
  });
  await writeAudit({ actorId: rec.labId, actorRole: 'kv-lab', action: 'sync.lab_login', targetId: ownerId, ip: req.ip });

  res.json({ ok: true, labId: rec.labId, keys: await collectLabKeys(ownerId, rec.docId, rec.labId) });
}));

function labScope(req, res, next) {
  const [ownerId, docId, labId] = String(req.auth.subjectId).split('::');
  if (!ownerId || !docId || !labId) return res.status(401).json({ error: 'Invalid session' });
  req.labScope = { ownerId, docId, labId };
  next();
}

// ── Lab: refresh own keys ─────────────────────────────────────────
syncRouter.get('/lab', authenticate, requireRole('kv-lab'), labScope, asyncHandler(async (req, res) => {
  const { ownerId, docId, labId } = req.labScope;
  res.json({ keys: await collectLabKeys(ownerId, docId, labId) });
}));

// ── Lab: push changes — only its task tokens and submissions ──────
syncRouter.put('/lab', authenticate, requireRole('kv-lab'), labScope, validate(pushSchema), asyncHandler(async (req, res) => {
  const { ownerId, docId, labId } = req.labScope;
  const allowed = new Set([`pat_tokens_${docId}`, `lab_subs_${docId}`]);
  const changes = req.valid.changes;
  const warnings = [];

  // Validate lab submissions for physiological ranges
  for (const [k, v] of Object.entries(changes)) {
    if (k === `lab_subs_${docId}` && v && typeof v === 'object') {
      const validation = validateLabSubmission(v);
      if (!validation.valid) {
        const e = new Error(`Lab result validation failed: ${validation.errors.join('; ')}`);
        e.status = 400;
        throw e;
      }
      if (validation.warnings.length > 0) {
        warnings.push(...validation.warnings);
      }
    }
  }

  const count = await applyChanges(ownerId, changes, k => allowed.has(k));
  pushDoctorForChanges(ownerId, changes);
  await writeAudit({
    actorId: labId,
    actorRole: 'kv-lab',
    action: 'sync.lab_push',
    targetId: ownerId,
    detail: { count, labWarnings: warnings.length > 0 ? warnings : undefined },
    ip: req.ip,
  });
  res.json({ ok: true, count, warnings: warnings.length > 0 ? warnings : undefined });
}));
