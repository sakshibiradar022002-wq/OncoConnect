// Doctor account registration and login. Patient and lab logins live in
// routes/sync.js — they authenticate against the synced records.

import { Router } from 'express';
import { z } from 'zod';
import { db, writeAudit } from '../db/index.js';
import {
  hashPassword, verifyPassword, encryptPHI, decryptPHI, randomToken,
  generateTotpSecret, verifyTotp,
} from '../crypto.js';
import {
  createSession, revokeSession, clearSessionCookie, authenticate,
} from '../middleware/auth.js';
import { validate, asyncHandler } from '../middleware/validate.js';
import { config } from '../config.js';

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

  // With REQUIRE_DOCTOR_APPROVAL=true, new accounts start inactive until an
  // admin flips users.active to 1. The very first account is always approved
  // so the instance owner can't lock themselves out.
  let active = 1;
  if (config.requireDoctorApproval) {
    const anyUser = await db.prepare('SELECT id FROM users LIMIT 1').get();
    if (anyUser) active = 0;
  }

  const id = randomToken(16);
  await db.prepare(`
    INSERT INTO users (id, email, password_hash, role, name_enc, meta_enc, active, created_at)
    VALUES (?, ?, ?, 'doctor', ?, ?, ?, ?)
  `).run(
    id, email, hashPassword(password),
    encryptPHI(name), encryptPHI({ specialty, institution }),
    active, new Date().toISOString()
  );

  await writeAudit({ actorId: id, actorRole: 'doctor', action: 'doctor.register', targetId: id, ip: req.ip });
  res.status(201).json({
    ok: true,
    message: active ? 'Account created. You can now sign in.' : 'Account created. An administrator must approve it before you can sign in.',
  });
}));

// ── Doctor / admin / lab login (by email) ─────────────────────────
const loginSchema = z.object({
  email: z.string().email().toLowerCase(),
  password: z.string().min(1),
  totpCode: z.string().optional(),
});

authRouter.post('/login', validate(loginSchema), asyncHandler(async (req, res) => {
  const { email, password, totpCode } = req.valid;
  const user = await db.prepare('SELECT * FROM users WHERE email = ? AND active = 1').get(email);

  // Constant-ish behaviour whether or not the user exists.
  const ok = user && verifyPassword(password, user.password_hash);
  if (!ok) return res.status(401).json({ error: 'Invalid email or password' });

  // Second factor, if the account has enabled it.
  const totp = decryptPHI(user.totp_enc);
  if (totp?.enabled) {
    if (!totpCode) return res.status(401).json({ error: 'TOTP code required', totpRequired: true });
    if (!verifyTotp(totp.secret, totpCode)) {
      return res.status(401).json({ error: 'Invalid TOTP code', totpRequired: true });
    }
  }

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

// ── Two-factor auth (TOTP, RFC 6238) for doctor/admin accounts ────
// Setup: returns a fresh secret + otpauth:// URL for the authenticator app.
authRouter.post('/totp/setup', authenticate, asyncHandler(async (req, res) => {
  if (req.auth.subjectType !== 'user') return res.status(403).json({ error: 'Accounts only' });
  const u = await db.prepare('SELECT email, totp_enc FROM users WHERE id = ?').get(req.auth.subjectId);
  if (!u) return res.status(404).json({ error: 'Not found' });
  const existing = decryptPHI(u.totp_enc);
  if (existing?.enabled) return res.status(409).json({ error: '2FA already enabled' });

  const secret = generateTotpSecret();
  await db.prepare('UPDATE users SET totp_enc = ? WHERE id = ?')
    .run(encryptPHI({ secret, enabled: false }), req.auth.subjectId);
  res.json({
    ok: true, secret,
    otpauthUrl: `otpauth://totp/ChemoCure:${encodeURIComponent(u.email)}?secret=${secret}&issuer=ChemoCure`,
  });
}));

// Enable: prove possession of the authenticator by echoing a valid code.
const totpCodeSchema = z.object({ code: z.string().min(6).max(6) });
authRouter.post('/totp/enable', authenticate, validate(totpCodeSchema), asyncHandler(async (req, res) => {
  if (req.auth.subjectType !== 'user') return res.status(403).json({ error: 'Accounts only' });
  const u = await db.prepare('SELECT totp_enc FROM users WHERE id = ?').get(req.auth.subjectId);
  const totp = decryptPHI(u?.totp_enc);
  if (!totp?.secret) return res.status(400).json({ error: 'Run /totp/setup first' });
  if (!verifyTotp(totp.secret, req.valid.code)) return res.status(401).json({ error: 'Invalid code' });

  await db.prepare('UPDATE users SET totp_enc = ? WHERE id = ?')
    .run(encryptPHI({ secret: totp.secret, enabled: true }), req.auth.subjectId);
  await writeAudit({ actorId: req.auth.subjectId, actorRole: req.auth.role, action: 'totp.enable', targetId: req.auth.subjectId, ip: req.ip });
  res.json({ ok: true, message: '2FA enabled. Codes will be required at login.' });
}));

// Disable (requires a valid current code).
authRouter.post('/totp/disable', authenticate, validate(totpCodeSchema), asyncHandler(async (req, res) => {
  if (req.auth.subjectType !== 'user') return res.status(403).json({ error: 'Accounts only' });
  const u = await db.prepare('SELECT totp_enc FROM users WHERE id = ?').get(req.auth.subjectId);
  const totp = decryptPHI(u?.totp_enc);
  if (!totp?.enabled) return res.status(400).json({ error: '2FA not enabled' });
  if (!verifyTotp(totp.secret, req.valid.code)) return res.status(401).json({ error: 'Invalid code' });

  await db.prepare('UPDATE users SET totp_enc = NULL WHERE id = ?').run(req.auth.subjectId);
  await writeAudit({ actorId: req.auth.subjectId, actorRole: req.auth.role, action: 'totp.disable', targetId: req.auth.subjectId, ip: req.ip });
  res.json({ ok: true });
}));

// ── Logout: revoke the session server-side, not just client-side ──
authRouter.post('/logout', authenticate, asyncHandler(async (req, res) => {
  await revokeSession(req.auth.jti);
  clearSessionCookie(res);
  await writeAudit({ actorId: req.auth.subjectId, actorRole: req.auth.role, action: 'user.logout', ip: req.ip });
  res.json({ ok: true });
}));
