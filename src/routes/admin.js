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

/**
 * @swagger
 * /admin/users:
 *   get:
 *     summary: List all users (admin only)
 *     tags: [Admin]
 *     security:
 *       - BearerAuth: []
 *     responses:
 *       200:
 *         description: List of all users with status and metadata
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 users:
 *                   type: array
 *                   items:
 *                     type: object
 *                     properties:
 *                       id: { type: string }
 *                       email: { type: string }
 *                       role: { type: string, enum: [doctor, admin, kv-lab] }
 *                       active: { type: boolean }
 *                       createdAt: { type: string, format: 'date-time' }
 *                       lastLogin: { type: string, format: 'date-time' }
 *                       name: { type: string }
 *       403:
 *         description: Admin access required

 * /admin/users/{id}/active:
 *   post:
 *     summary: Approve or deactivate a user (admin only)
 *     tags: [Admin]
 *     security:
 *       - BearerAuth: []
 *     parameters:
 *       - name: id
 *         in: path
 *         required: true
 *         schema: { type: string }
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [active]
 *             properties:
 *               active: { type: boolean }
 *     responses:
 *       200:
 *         description: User status updated
 *       400:
 *         description: Cannot deactivate own account
 *       403:
 *         description: Admin access required
 *       404:
 *         description: User not found

 * /admin/audit:
 *   get:
 *     summary: Retrieve audit log (admin only)
 *     tags: [Admin]
 *     security:
 *       - BearerAuth: []
 *     parameters:
 *       - name: limit
 *         in: query
 *         schema: { type: integer, default: 100, maximum: 500 }
 *         description: Maximum audit entries to return
 *     responses:
 *       200:
 *         description: Audit log entries
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 entries:
 *                   type: array
 *                   items:
 *                     type: object
 *                     properties:
 *                       ts: { type: string, format: 'date-time' }
 *                       actorId: { type: string }
 *                       actorRole: { type: string }
 *                       action: { type: string }
 *                       targetId: { type: string }
 *                       ip: { type: string }
 *                       detail: { type: object }
 *       403:
 *         description: Admin access required
 */

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
