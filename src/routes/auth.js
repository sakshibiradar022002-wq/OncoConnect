// Authentication endpoints for doctors, patients, and lab technicians.

import { Router } from 'express';
import { z } from 'zod';
import { db, writeAudit } from '../db/index.js';
import {
  hashPassword, verifyPassword, encryptPHI, decryptPHI, randomToken,
} from '../crypto.js';
import {
  createSession, revokeSession, clearSessionCookie, authenticate,
} from '../middleware/auth.js';
import { validate, asyncHandler } from '../middleware/validate.js';

export const authRouter = Router();

// ── Doctor registration ───────────────────────────────────────────
const registerSchema = z.object({
  name: z.string().min(2).max(120),
  email: z.string().email().toLowerCase(),
  password: z.string().min(8).max(200),
  specialty: z.string().max(120).optional(),
  institution: z.string().max(200).optional(),
});

authRouter.post('/register', validate(registerSchema), asyncHandler(async (req, res) => {
  const { name, email, password, specialty, institution } = req.valid;

  const existing = await db.prepare('SELECT id FROM users WHERE email = ?').get(email);
  if (existing) return res.status(409).json({ error: 'An account already exists for this email' });

  const id = randomToken(16);
  await db.prepare(`
    INSERT INTO users (id, email, password_hash, role, name_enc, meta_enc, active, created_at)
    VALUES (?, ?, ?, 'doctor', ?, ?, 1, ?)
  `).run(
    id, email, hashPassword(password),
    encryptPHI(name), encryptPHI({ specialty, institution }),
    new Date().toISOString()
  );

  await writeAudit({ actorId: id, actorRole: 'doctor', action: 'doctor.register', targetId: id, ip: req.ip });
  res.status(201).json({ ok: true, message: 'Account created. You can now sign in.' });
}));

// ── Doctor / admin / lab login (by email) ─────────────────────────
const loginSchema = z.object({
  email: z.string().email().toLowerCase(),
  password: z.string().min(1),
});

authRouter.post('/login', validate(loginSchema), asyncHandler(async (req, res) => {
  const { email, password } = req.valid;
  const user = await db.prepare('SELECT * FROM users WHERE email = ? AND active = 1').get(email);

  // Constant-ish behaviour whether or not the user exists.
  const ok = user && verifyPassword(password, user.password_hash);
  if (!ok) return res.status(401).json({ error: 'Invalid email or password' });

  await db.prepare('UPDATE users SET last_login = ? WHERE id = ?').run(new Date().toISOString(), user.id);
  await createSession(res, { subjectId: user.id, subjectType: 'user', role: user.role });
  await writeAudit({ actorId: user.id, actorRole: user.role, action: 'user.login', targetId: user.id, ip: req.ip });

  res.json({
    ok: true,
    user: {
      id: user.id, email: user.email, role: user.role,
      name: decryptPHI(user.name_enc),
      meta: decryptPHI(user.meta_enc),
      labId: user.lab_id,
    },
  });
}));

// ── Patient login (by MRN) ────────────────────────────────────────
const patientLoginSchema = z.object({
  mrn: z.string().min(3).toUpperCase(),
  password: z.string().min(1),
});

authRouter.post('/patient-login', validate(patientLoginSchema), asyncHandler(async (req, res) => {
  const { mrn, password } = req.valid;
  const patient = await db.prepare('SELECT * FROM patients WHERE mrn = ? AND active = 1').get(mrn);

  const ok = patient && verifyPassword(password, patient.password_hash);
  if (!ok) return res.status(401).json({ error: 'Invalid MRN or password' });

  await db.prepare('UPDATE patients SET last_login = ? WHERE id = ?').run(new Date().toISOString(), patient.id);
  await createSession(res, { subjectId: patient.id, subjectType: 'patient', role: 'patient' });
  await writeAudit({ actorId: patient.id, actorRole: 'patient', action: 'patient.login', targetId: patient.id, ip: req.ip });

  const record = decryptPHI(patient.record_enc) || {};
  res.json({ ok: true, patient: { id: patient.id, mrn: patient.mrn, name: record.name } });
}));

// ── Current session info ──────────────────────────────────────────
authRouter.get('/me', authenticate, asyncHandler(async (req, res) => {
  if (req.auth.subjectType === 'user') {
    const u = await db.prepare('SELECT * FROM users WHERE id = ?').get(req.auth.subjectId);
    if (!u) return res.status(404).json({ error: 'Not found' });
    return res.json({
      type: 'user', id: u.id, email: u.email, role: u.role,
      name: decryptPHI(u.name_enc), meta: decryptPHI(u.meta_enc), labId: u.lab_id,
    });
  }
  const p = await db.prepare('SELECT * FROM patients WHERE id = ?').get(req.auth.subjectId);
  if (!p) return res.status(404).json({ error: 'Not found' });
  const record = decryptPHI(p.record_enc) || {};
  res.json({ type: 'patient', id: p.id, mrn: p.mrn, name: record.name });
}));

// ── Logout ────────────────────────────────────────────────────────
authRouter.post('/logout', authenticate, asyncHandler(async (req, res) => {
  await revokeSession(req.auth.jti);
  clearSessionCookie(res);
  res.json({ ok: true });
}));
