// Admin: user approval + audit log. The first registered user (by
// created_at) is the instance admin, as is anyone with role='admin'.

import { Router } from 'express';
import { z } from 'zod';
import { db, writeAudit } from '../db/index.js';
import { decryptPHI } from '../crypto.js';
import { authenticate } from '../middleware/auth.js';
import { validate, asyncHandler } from '../middleware/validate.js';

export const adminRouter = Router();
adminRouter.use(authenticate);

async function requireAdmin(req, res, next) {
  if (req.auth.role === 'admin') return next();
  const first = await db.prepare('SELECT id FROM users ORDER BY created_at ASC LIMIT 1').get();
  if (first && first.id === req.auth.subjectId) return next();
  res.status(403).json({ error: 'Admin access required' });
}
adminRouter.use(requireAdmin);

// ── List users ────────────────────────────────────────────────────
adminRouter.get('/users', asyncHandler(async (req, res) => {
  const rows = await db.prepare('SELECT id, email, role, active, created_at, last_login, name_enc FROM users ORDER BY created_at DESC').all();
  res.json({
    users: rows.map(u => ({
      id: u.id, email: u.email, role: u.role, active: !!u.active,
      createdAt: u.created_at, lastLogin: u.last_login,
      name: decryptPHI(u.name_enc),
    })),
  });
}));

// ── Approve / deactivate a user ───────────────────────────────────
const activeSchema = z.object({ active: z.boolean() });
adminRouter.post('/users/:id/active', validate(activeSchema), asyncHandler(async (req, res) => {
  if (req.params.id === req.auth.subjectId) {
    return res.status(400).json({ error: 'You cannot deactivate your own account' });
  }
  const r = await db.prepare('UPDATE users SET active = ? WHERE id = ?').run(req.valid.active ? 1 : 0, req.params.id);
  if (!r.changes) return res.status(404).json({ error: 'User not found' });
  await writeAudit({
    actorId: req.auth.subjectId, actorRole: 'admin',
    action: req.valid.active ? 'admin.user_approve' : 'admin.user_deactivate',
    targetId: req.params.id, ip: req.ip,
  });
  res.json({ ok: true });
}));

// ── Audit log (most recent first) ─────────────────────────────────
adminRouter.get('/audit', asyncHandler(async (req, res) => {
  const limit = Math.min(parseInt(req.query.limit || '100', 10) || 100, 500);
  const rows = await db.prepare('SELECT * FROM audit_log ORDER BY created_at DESC LIMIT ?').all(limit);
  res.json({
    entries: rows.map(r => ({
      ts: r.created_at, actorId: r.actor_id, actorRole: r.actor_role,
      action: r.action, targetId: r.target_id, ip: r.ip,
      detail: r.detail_enc ? decryptPHI(r.detail_enc) : null,
    })),
  });
}));
