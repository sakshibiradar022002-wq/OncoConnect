// Team management: invites, members, and patient sharing permissions.

import { Router } from 'express';
import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import { db, writeAudit } from '../db/index.js';
import { authenticate, requireRole } from '../middleware/auth.js';
import { validate, asyncHandler } from '../middleware/validate.js';
import { encryptPHI, randomToken } from '../crypto.js';

export const teamRouter = Router();

// Helper: Get or create team_id for a doctor (default: user_id)
async function getOrCreateTeamId(doctorId) {
  const user = await db.prepare('SELECT id FROM users WHERE id = ?').get(doctorId);
  if (!user) throw new Error('User not found');

  const existing = await db.prepare('SELECT team_id FROM team_members WHERE user_id = ?').get(doctorId);
  if (existing) return existing.team_id;

  // Create team (team_id = first user's id)
  const teamId = doctorId;
  await db.prepare(`
    INSERT INTO team_members (id, team_id, user_id, role, joined_at)
    VALUES (?, ?, ?, ?, ?)
  `).run(randomToken(8), teamId, doctorId, 'owner', new Date().toISOString());

  return teamId;
}

// ── Send team invite ──────────────────────────────────────────────
const inviteSchema = z.object({
  email: z.string().email(),
  role: z.enum(['doctor', 'specialist']),
  specialty: z.string().optional(),
});

teamRouter.post('/invite', authenticate, requireRole('doctor', 'admin'), validate(inviteSchema), asyncHandler(async (req, res) => {
  const teamId = await getOrCreateTeamId(req.auth.subjectId);
  const { email: inviteeEmail, role, specialty } = req.valid;

  // Check if already invited or member
  const existing = await db.prepare(
    'SELECT id FROM team_members WHERE team_id = ? AND user_id = (SELECT id FROM users WHERE LOWER(email) = ?)'
  ).get(teamId, inviteeEmail.toLowerCase());

  if (existing) {
    return res.status(409).json({ error: 'User already member of this team' });
  }

  const inviteCode = randomBytes(32).toString('hex');
  await db.prepare(`
    INSERT INTO team_invites (id, team_id, email, role, invite_code, invited_by, created_at, expires_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    randomToken(8), teamId, inviteeEmail.toLowerCase(), role, inviteCode,
    req.auth.subjectId, new Date().toISOString(),
    new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString() // 7 days
  );

  // TODO: Send email with invite link
  // const inviteUrl = `${process.env.APP_URL}/accept-invite?code=${inviteCode}`;

  await writeAudit({
    actorId: req.auth.subjectId, actorRole: 'doctor',
    action: 'team.invite_sent',
    detail: { email: inviteeEmail, role, teamId },
    ip: req.ip,
  });

  res.json({ ok: true, inviteCode, expiresIn: '7 days' });
}));

// ── Accept team invite ────────────────────────────────────────────
const acceptSchema = z.object({ code: z.string() });

teamRouter.post('/invite/:code/accept', validate(acceptSchema), asyncHandler(async (req, res) => {
  const { code } = req.params;

  const invite = await db.prepare(
    'SELECT * FROM team_invites WHERE invite_code = ? AND expires_at > datetime("now")'
  ).get(code);

  if (!invite || invite.accepted_at) {
    return res.status(404).json({ error: 'Invite not found or expired' });
  }

  // User must be logged in
  if (!req.auth) {
    return res.status(401).json({ error: 'Please login first' });
  }

  // Verify email matches
  const user = await db.prepare('SELECT email FROM users WHERE id = ?').get(req.auth.subjectId);
  if (!user || user.email.toLowerCase() !== invite.email.toLowerCase()) {
    return res.status(403).json({ error: 'Email does not match invite' });
  }

  // Add to team
  await db.prepare(`
    INSERT INTO team_members (id, team_id, user_id, role, joined_at)
    VALUES (?, ?, ?, ?, ?)
  `).run(randomToken(8), invite.team_id, req.auth.subjectId, invite.role, new Date().toISOString());

  // Mark invite accepted
  await db.prepare('UPDATE team_invites SET accepted_at = ? WHERE id = ?').run(
    new Date().toISOString(), invite.id
  );

  await writeAudit({
    actorId: req.auth.subjectId, actorRole: invite.role,
    action: 'team.invite_accepted',
    detail: { teamId: invite.team_id },
    ip: req.ip,
  });

  res.json({ ok: true, teamId: invite.team_id });
}));

// ── List team members ─────────────────────────────────────────────
teamRouter.get('/members', authenticate, requireRole('doctor', 'specialist', 'admin'), asyncHandler(async (req, res) => {
  const teamId = await getOrCreateTeamId(req.auth.subjectId);

  const members = await db.prepare(`
    SELECT
      tm.id, tm.role, tm.specialty, tm.joined_at,
      u.id AS user_id, u.email, u.name_enc
    FROM team_members tm
    JOIN users u ON u.id = tm.user_id
    WHERE tm.team_id = ?
    ORDER BY tm.joined_at DESC
  `).all(teamId);

  res.json({ members });
}));

// ── Grant patient access to colleague ──────────────────────────────
const accessSchema = z.object({
  patientMrn: z.string(),
  doctorId: z.string(),
  accessType: z.enum(['view', 'edit', 'manage']),
});

teamRouter.post('/patients/:mrn/grant', authenticate, requireRole('doctor', 'admin'), validate(accessSchema), asyncHandler(async (req, res) => {
  const { patientMrn, doctorId, accessType } = req.valid;
  const teamId = await getOrCreateTeamId(req.auth.subjectId);

  // Verify grantee is on the same team
  const grantee = await db.prepare(
    'SELECT role FROM team_members WHERE team_id = ? AND user_id = ?'
  ).get(teamId, doctorId);

  if (!grantee) {
    return res.status(403).json({ error: 'Colleague not on your team' });
  }

  // Grant access
  await db.prepare(`
    INSERT OR REPLACE INTO patient_access (patient_mrn, owner_id, doctor_id, access_type, granted_at)
    VALUES (?, ?, ?, ?, ?)
  `).run(patientMrn, req.auth.subjectId, doctorId, accessType, new Date().toISOString());

  await writeAudit({
    actorId: req.auth.subjectId, actorRole: 'doctor',
    action: 'team.grant_access',
    detail: { patientMrn, doctorId, accessType },
    ip: req.ip,
  });

  res.json({ ok: true });
}));

// ── Revoke patient access ──────────────────────────────────────────
teamRouter.delete('/patients/:mrn/access/:doctorId', authenticate, requireRole('doctor', 'admin'), asyncHandler(async (req, res) => {
  const { mrn, doctorId } = req.params;

  await db.prepare(
    'DELETE FROM patient_access WHERE patient_mrn = ? AND owner_id = ? AND doctor_id = ?'
  ).run(mrn, req.auth.subjectId, doctorId);

  await writeAudit({
    actorId: req.auth.subjectId, actorRole: 'doctor',
    action: 'team.revoke_access',
    detail: { patientMrn: mrn, doctorId },
    ip: req.ip,
  });

  res.json({ ok: true });
}));
