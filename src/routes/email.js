// Email endpoints: registration OTP (pre-auth, rate-limited) and doctor
// notifications (authenticated). The OTP is generated and verified
// SERVER-side — the browser never sees the code unless email is
// unconfigured, in which case we return it as devCode to preserve the
// existing on-screen dev fallback.

import { Router } from 'express';
import { createHash, randomInt } from 'node:crypto';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import { db, writeAudit } from '../db/index.js';
import { mailConfigured, mailProvider, sendMail, verifyMail } from '../mail.js';
import { authenticate } from '../middleware/auth.js';
import { validate, asyncHandler } from '../middleware/validate.js';

export const emailRouter = Router();

/**
 * @swagger
 * /email/status:
 *   get:
 *     summary: Check email configuration status
 *     tags: [Email]
 *     parameters:
 *       - name: verify
 *         in: query
 *         schema: { type: string, enum: ['0', '1'] }
 *         description: Verify email configuration (0=no, 1=yes)
 *     responses:
 *       200:
 *         description: Email configuration status
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 configured: { type: boolean }
 *                 provider: { type: string }

 * /email/otp:
 *   post:
 *     summary: Request registration OTP code
 *     tags: [Email]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [email]
 *             properties:
 *               email: { type: string, format: email }
 *               name: { type: string, description: 'User name (optional)' }
 *     responses:
 *       200:
 *         description: OTP sent or available (dev mode)
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 sent: { type: boolean }
 *                 devCode: { type: string, description: 'Code for dev mode only' }
 *                 expiresMin: { type: integer }
 *       429:
 *         description: Too many code requests

 * /email/otp/verify:
 *   post:
 *     summary: Verify OTP code
 *     tags: [Email]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [email, code]
 *             properties:
 *               email: { type: string, format: email }
 *               code: { type: string, minLength: 6, maxLength: 6 }
 *     responses:
 *       200:
 *         description: Code verified successfully
 *       400:
 *         description: Code expired or incorrect
 *       429:
 *         description: Too many wrong attempts

 * /email/send:
 *   post:
 *     summary: Send authenticated email (doctors only)
 *     tags: [Email]
 *     security:
 *       - BearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [to, subject, text]
 *             properties:
 *               to: { type: string, format: email }
 *               subject: { type: string, maxLength: 200 }
 *               text: { type: string, maxLength: 5000 }
 *     responses:
 *       200:
 *         description: Email sent successfully
 *       503:
 *         description: Email not configured on this server
 */

const otpLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 8, // 8 OTP requests / 15 min / IP — codes go to inboxes, keep it tight
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many code requests, please try again later' },
});
const sendLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 30, // 30 outbound mails / hour / IP for authenticated senders
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Email rate limit reached, please try again later' },
});

const hashCode = (email, code) =>
  createHash('sha256').update(email.toLowerCase() + '|' + code).digest('hex');

// ── Status: lets the UI show whether server email is live ─────────
emailRouter.get('/status', asyncHandler(async (req, res) => {
  if (req.query.verify === '1') return res.json(await verifyMail());
  res.json({ configured: mailConfigured(), provider: mailProvider() });
}));

// ── Registration OTP ──────────────────────────────────────────────
const otpSchema = z.object({
  email: z.string().email().toLowerCase(),
  name: z.string().max(120).optional(),
});

emailRouter.post('/otp', otpLimiter, validate(otpSchema), asyncHandler(async (req, res) => {
  const { email, name } = req.valid;
  const code = String(randomInt(100000, 1000000));
  const expires = new Date(Date.now() + 10 * 60 * 1000).toISOString();

  await db.prepare('DELETE FROM email_otps WHERE email = ?').run(email);
  await db.prepare('INSERT INTO email_otps (email, code_hash, expires_at, attempts) VALUES (?, ?, ?, 0)')
    .run(email, hashCode(email, code), expires);

  if (!mailConfigured()) {
    // Dev fallback: no mail server — hand the code back so the UI can show
    // it on screen, exactly like the old client-side flow.
    return res.json({ sent: false, devCode: code, expiresMin: 10 });
  }
  await sendMail({
    to: email,
    subject: `${code} is your OncoConnect verification code`,
    text: `Hello${name ? ' ' + name : ''},\n\nYour OncoConnect verification code is: ${code}\n\nIt expires in 10 minutes. If you didn't request this, ignore this email.`,
    html: `<div style="font-family:system-ui,sans-serif;max-width:420px;margin:0 auto;padding:24px;">
      <h2 style="color:#2C5EAD;margin:0 0 6px;">OncoConnect</h2>
      <p>Hello${name ? ' ' + name : ''},</p>
      <p>Your verification code is:</p>
      <div style="font-size:32px;font-weight:800;letter-spacing:6px;background:#F1F8FD;border:1px solid #C4E2F5;border-radius:10px;padding:14px;text-align:center;">${code}</div>
      <p style="color:#64748b;font-size:13px;">It expires in 10 minutes. If you didn't request this, ignore this email.</p>
    </div>`,
  });
  await writeAudit({ actorId: email, actorRole: 'anon', action: 'email.otp_sent', ip: req.ip });
  res.json({ sent: true, expiresMin: 10 });
}));

const verifySchema = z.object({
  email: z.string().email().toLowerCase(),
  code: z.string().min(6).max(6),
});

emailRouter.post('/otp/verify', otpLimiter, validate(verifySchema), asyncHandler(async (req, res) => {
  const { email, code } = req.valid;
  const row = await db.prepare('SELECT * FROM email_otps WHERE email = ?').get(email);
  if (!row) return res.status(400).json({ error: 'No code pending for this email. Request a new one.' });
  if (new Date(row.expires_at) < new Date()) {
    await db.prepare('DELETE FROM email_otps WHERE email = ?').run(email);
    return res.status(400).json({ error: 'Code expired. Request a new one.' });
  }
  if (row.attempts >= 5) {
    await db.prepare('DELETE FROM email_otps WHERE email = ?').run(email);
    return res.status(429).json({ error: 'Too many wrong attempts. Request a new code.' });
  }
  if (row.code_hash !== hashCode(email, code)) {
    await db.prepare('UPDATE email_otps SET attempts = attempts + 1 WHERE email = ?').run(email);
    return res.status(400).json({ error: 'Incorrect code.' });
  }
  await db.prepare('DELETE FROM email_otps WHERE email = ?').run(email); // single-use
  res.json({ ok: true });
}));

// ── Authenticated outbound mail (appointment reminders, tests) ────
const sendSchema = z.object({
  to: z.string().email(),
  subject: z.string().min(1).max(200),
  text: z.string().min(1).max(5000),
});

emailRouter.post('/send', authenticate, sendLimiter, validate(sendSchema), asyncHandler(async (req, res) => {
  if (!mailConfigured()) {
    return res.status(503).json({ error: 'Email is not configured on this server. Set GMAIL_USER and GMAIL_APP_PASSWORD.' });
  }
  const { to, subject, text } = req.valid;
  await sendMail({ to, subject, text });
  await writeAudit({
    actorId: req.auth.subjectId, actorRole: req.auth.role,
    action: 'email.send', detail: { to, subject }, ip: req.ip,
  });
  res.json({ ok: true });
}));
