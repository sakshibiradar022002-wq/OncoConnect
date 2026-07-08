// Authentication (JWT in httpOnly cookie) + server-side revocable sessions + RBAC.

import jwt from 'jsonwebtoken';
import { config } from '../config.js';
import { db } from '../db/index.js';
import { randomToken } from '../crypto.js';

const COOKIE_NAME = 'cc_session';

// ── Issue a session ───────────────────────────────────────────────
export async function createSession(res, { subjectId, subjectType, role }) {
  const jti = randomToken(16);
  const now = new Date();
  const expires = new Date(now.getTime() + config.sessionTtlMinutes * 60 * 1000);

  await db.prepare(`
    INSERT INTO sessions (id, subject_id, subject_type, role, created_at, expires_at, revoked)
    VALUES (?, ?, ?, ?, ?, ?, 0)
  `).run(jti, subjectId, subjectType, role, now.toISOString(), expires.toISOString());

  const token = jwt.sign(
    { sub: subjectId, type: subjectType, role, jti },
    config.jwtSecret,
    { expiresIn: `${config.sessionTtlMinutes}m` }
  );

  res.cookie(COOKIE_NAME, token, {
    httpOnly: true,                 // JS cannot read it → XSS-resistant
    secure: config.isProd,          // HTTPS-only in production
    sameSite: 'lax',                // CSRF mitigation
    maxAge: config.sessionTtlMinutes * 60 * 1000,
    path: '/',
  });

  return jti;
}

// ── Revoke (logout) ───────────────────────────────────────────────
export async function revokeSession(jti) {
  await db.prepare('UPDATE sessions SET revoked = 1 WHERE id = ?').run(jti);
}

export function clearSessionCookie(res) {
  res.clearCookie(COOKIE_NAME, { path: '/' });
}

// ── Verify on each request ────────────────────────────────────────
export async function authenticate(req, res, next) {
  const token = req.cookies?.[COOKIE_NAME];
  if (!token) return res.status(401).json({ error: 'Not authenticated' });

  let payload;
  try {
    payload = jwt.verify(token, config.jwtSecret);
  } catch {
    return res.status(401).json({ error: 'Invalid or expired session' });
  }

  // Check the session still exists and isn't revoked/expired server-side.
  const session = await db.prepare('SELECT * FROM sessions WHERE id = ?').get(payload.jti);
  if (!session || session.revoked) {
    return res.status(401).json({ error: 'Session revoked' });
  }
  if (new Date(session.expires_at) < new Date()) {
    return res.status(401).json({ error: 'Session expired' });
  }

  req.auth = {
    subjectId: payload.sub,
    subjectType: payload.type,   // 'user' | 'patient'
    role: payload.role,          // 'doctor' | 'lab' | 'admin' | 'patient'
    jti: payload.jti,
  };
  next();
}

// ── Role gate ─────────────────────────────────────────────────────
export function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.auth) return res.status(401).json({ error: 'Not authenticated' });
    if (!roles.includes(req.auth.role)) {
      return res.status(403).json({ error: 'Insufficient permissions' });
    }
    next();
  };
}
