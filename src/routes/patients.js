// Patient records. The full clinical record is stored as one encrypted JSON blob.
// Access control: doctors see only their own patients; patients see only themselves.

import { Router } from 'express';
import { z } from 'zod';
import { db, writeAudit } from '../db/index.js';
import {
  hashPassword, encryptPHI, decryptPHI, randomToken, generateMRN, generatePassword,
} from '../crypto.js';
import { authenticate, requireRole } from '../middleware/auth.js';
import { validate, asyncHandler } from '../middleware/validate.js';

export const patientsRouter = Router();
patientsRouter.use(authenticate);

// Helper: ensure the requesting doctor owns this patient.
async function assertDoctorOwns(patientId, doctorId) {
  const row = await db.prepare('SELECT doctor_id FROM patients WHERE id = ?').get(patientId);
  if (!row) { const e = new Error('Patient not found'); e.status = 404; throw e; }
  if (row.doctor_id !== doctorId) { const e = new Error('Not your patient'); e.status = 403; throw e; }
}

// ── List my patients (doctor) ─────────────────────────────────────
patientsRouter.get('/', requireRole('doctor', 'admin'), asyncHandler(async (req, res) => {
  const rows = await db.prepare('SELECT id, mrn, record_enc, created_at, updated_at FROM patients WHERE doctor_id = ? AND active = 1 ORDER BY updated_at DESC')
    .all(req.auth.subjectId);
  // Return only lightweight summary fields, not the whole record, for the list view.
  const patients = rows.map(r => {
    const rec = decryptPHI(r.record_enc) || {};
    return {
      id: r.id, mrn: r.mrn,
      name: rec.name, diagnosis: rec.diag, phase: rec.phase,
      updatedAt: r.updated_at,
    };
  });
  res.json({ patients });
}));

// ── Create a patient (doctor) ─────────────────────────────────────
const createSchema = z.object({
  record: z.object({}).passthrough(),   // the full clinical record object
});

patientsRouter.post('/', requireRole('doctor'), validate(createSchema), asyncHandler(async (req, res) => {
  const id = randomToken(16);
  const mrn = generateMRN();
  const plainPassword = generatePassword(14);
  const now = new Date().toISOString();
  const record = { ...req.valid.record, mrn };

  await db.prepare(`
    INSERT INTO patients (id, mrn, password_hash, doctor_id, record_enc, active, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, 1, ?, ?)
  `).run(id, mrn, hashPassword(plainPassword), req.auth.subjectId, encryptPHI(record), now, now);

  await writeAudit({ actorId: req.auth.subjectId, actorRole: 'doctor', action: 'patient.create', targetId: id, ip: req.ip });

  // Return the generated credentials ONCE — the doctor must record them now.
  res.status(201).json({ ok: true, id, mrn, password: plainPassword, record });
}));

// ── Read one patient ──────────────────────────────────────────────
patientsRouter.get('/:id', asyncHandler(async (req, res) => {
  const { id } = req.params;

  // Patients can only read themselves.
  if (req.auth.role === 'patient' && req.auth.subjectId !== id) {
    return res.status(403).json({ error: 'Forbidden' });
  }
  if (req.auth.role === 'doctor') await assertDoctorOwns(id, req.auth.subjectId);

  const row = await db.prepare('SELECT * FROM patients WHERE id = ? AND active = 1').get(id);
  if (!row) return res.status(404).json({ error: 'Patient not found' });

  res.json({ id: row.id, mrn: row.mrn, record: decryptPHI(row.record_enc), updatedAt: row.updated_at });
}));

// ── Update a patient's record (doctor) ────────────────────────────
const updateSchema = z.object({
  record: z.object({}).passthrough(),
  changedFields: z.array(z.string()).optional(),  // for the audit diff
});

patientsRouter.put('/:id', requireRole('doctor'), validate(updateSchema), asyncHandler(async (req, res) => {
  const { id } = req.params;
  await assertDoctorOwns(id, req.auth.subjectId);

  const now = new Date().toISOString();
  const record = { ...req.valid.record };

  await db.prepare('UPDATE patients SET record_enc = ?, updated_at = ? WHERE id = ?')
    .run(encryptPHI(record), now, id);

  await writeAudit({
    actorId: req.auth.subjectId, actorRole: 'doctor', action: 'patient.update',
    targetId: id, detail: { changedFields: req.valid.changedFields || [] }, ip: req.ip,
  });

  res.json({ ok: true, updatedAt: now });
}));

// ── Reset a patient's password (doctor) ───────────────────────────
patientsRouter.post('/:id/reset-password', requireRole('doctor'), asyncHandler(async (req, res) => {
  const { id } = req.params;
  await assertDoctorOwns(id, req.auth.subjectId);

  const newPassword = generatePassword(14);
  await db.prepare('UPDATE patients SET password_hash = ? WHERE id = ?').run(hashPassword(newPassword), id);
  await writeAudit({ actorId: req.auth.subjectId, actorRole: 'doctor', action: 'patient.reset_password', targetId: id, ip: req.ip });

  res.json({ ok: true, password: newPassword });
}));

// ── Soft-delete (doctor) ──────────────────────────────────────────
patientsRouter.delete('/:id', requireRole('doctor'), asyncHandler(async (req, res) => {
  const { id } = req.params;
  await assertDoctorOwns(id, req.auth.subjectId);
  await db.prepare('UPDATE patients SET active = 0 WHERE id = ?').run(id);
  await writeAudit({ actorId: req.auth.subjectId, actorRole: 'doctor', action: 'patient.delete', targetId: id, ip: req.ip });
  res.json({ ok: true });
}));
