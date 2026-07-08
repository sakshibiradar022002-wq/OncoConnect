// Clinical data shared between doctor and patient: messages, appointments, symptom logs.
// Access rules:
//   - A doctor may only touch patients they own (patients.doctor_id === doctor).
//   - A patient may only touch their own records (req.auth.subjectId === patient.id).
// All free-text / clinical content is encrypted at rest; only dates/status are plaintext
// (needed for sorting and querying).

import { Router } from 'express';
import { z } from 'zod';
import { db, writeAudit } from '../db/index.js';
import { encryptPHI, decryptPHI, randomToken } from '../crypto.js';
import { authenticate, requireRole } from '../middleware/auth.js';
import { validate, asyncHandler } from '../middleware/validate.js';

export const clinicalRouter = Router();
clinicalRouter.use(authenticate);

// ── Access helper ─────────────────────────────────────────────────
// Returns the patient row if the caller is allowed to access it, else throws.
function resolvePatientAccess(req, patientId) {
  const patient = db.prepare('SELECT id, doctor_id FROM patients WHERE id = ? AND active = 1').get(patientId);
  if (!patient) { const e = new Error('Patient not found'); e.status = 404; throw e; }

  if (req.auth.role === 'patient') {
    if (req.auth.subjectId !== patient.id) { const e = new Error('Forbidden'); e.status = 403; throw e; }
  } else if (req.auth.role === 'doctor' || req.auth.role === 'admin') {
    if (patient.doctor_id !== req.auth.subjectId && req.auth.role !== 'admin') {
      const e = new Error('Not your patient'); e.status = 403; throw e;
    }
  } else {
    const e = new Error('Forbidden'); e.status = 403; throw e; // labs cannot touch clinical data
  }
  return patient;
}

// If the caller is a patient, they act on themselves; ignore any patientId in the body.
function targetPatientId(req, bodyOrParamId) {
  return req.auth.role === 'patient' ? req.auth.subjectId : bodyOrParamId;
}

const now = () => new Date().toISOString();

/* ════════════════════════ MESSAGES ════════════════════════ */

const messageSchema = z.object({
  patientId: z.string().optional(),
  body: z.string().min(1).max(5000),
});

// Send a message (doctor -> patient, or patient -> doctor)
clinicalRouter.post('/messages', validate(messageSchema), asyncHandler(async (req, res) => {
  const patientId = targetPatientId(req, req.valid.patientId);
  if (!patientId) { return res.status(400).json({ error: 'patientId required' }); }
  resolvePatientAccess(req, patientId);

  const id = randomToken(12);
  db.prepare(`INSERT INTO messages (id, patient_id, sender_role, body_enc, created_at)
              VALUES (?, ?, ?, ?, ?)`)
    .run(id, patientId, req.auth.role === 'patient' ? 'patient' : 'doctor', encryptPHI(req.valid.body), now());

  writeAudit({ actorId: req.auth.subjectId, actorRole: req.auth.role, action: 'message.send', targetId: patientId, ip: req.ip });
  res.status(201).json({ ok: true, id });
}));

// Get the message thread for a patient
clinicalRouter.get('/messages/:patientId', asyncHandler(async (req, res) => {
  const patientId = targetPatientId(req, req.params.patientId);
  resolvePatientAccess(req, patientId);

  const rows = db.prepare('SELECT id, sender_role, body_enc, created_at, read_at FROM messages WHERE patient_id = ? ORDER BY created_at ASC').all(patientId);

  // Mark messages from the OTHER party as read.
  const mine = req.auth.role === 'patient' ? 'patient' : 'doctor';
  const unread = rows.filter(r => r.sender_role !== mine && !r.read_at).map(r => r.id);
  if (unread.length) {
    const stmt = db.prepare('UPDATE messages SET read_at = ? WHERE id = ?');
    const ts = now();
    unread.forEach(mid => stmt.run(ts, mid));
  }

  res.json({
    ok: true,
    messages: rows.map(r => ({
      id: r.id,
      from: r.sender_role,
      body: decryptPHI(r.body_enc),
      createdAt: r.created_at,
      readAt: r.read_at,
    })),
  });
}));

/* ════════════════════════ APPOINTMENTS ════════════════════════ */

const apptSchema = z.object({
  patientId: z.string().optional(),
  date: z.string().min(4),
  time: z.string().optional(),
  type: z.string().max(200).optional(),
  notes: z.string().max(2000).optional(),
  status: z.string().optional(),
});

// Create an appointment (doctor creates; patient may request)
clinicalRouter.post('/appointments', validate(apptSchema), asyncHandler(async (req, res) => {
  const patientId = targetPatientId(req, req.valid.patientId);
  if (!patientId) { return res.status(400).json({ error: 'patientId required' }); }
  resolvePatientAccess(req, patientId);

  const id = randomToken(12);
  // Patient-created appts are "Requested"; doctor-created default "Scheduled".
  const status = req.valid.status || (req.auth.role === 'patient' ? 'Requested' : 'Scheduled');
  const data = encryptPHI({ type: req.valid.type || 'Appointment', notes: req.valid.notes || '' });

  db.prepare(`INSERT INTO appointments (id, patient_id, data_enc, date, time, status, created_at)
              VALUES (?, ?, ?, ?, ?, ?, ?)`)
    .run(id, patientId, data, req.valid.date, req.valid.time || null, status, now());

  writeAudit({ actorId: req.auth.subjectId, actorRole: req.auth.role, action: 'appointment.create', targetId: patientId, ip: req.ip });
  res.status(201).json({ ok: true, id, status });
}));

// List appointments for a patient
clinicalRouter.get('/appointments/:patientId', asyncHandler(async (req, res) => {
  const patientId = targetPatientId(req, req.params.patientId);
  resolvePatientAccess(req, patientId);

  const rows = db.prepare('SELECT id, data_enc, date, time, status, created_at FROM appointments WHERE patient_id = ? ORDER BY date ASC, time ASC').all(patientId);
  res.json({
    ok: true,
    appointments: rows.map(r => {
      const d = decryptPHI(r.data_enc) || {};
      return { id: r.id, date: r.date, time: r.time, status: r.status, type: d.type, notes: d.notes, createdAt: r.created_at };
    }),
  });
}));

// Update appointment status (confirm / decline / complete). Doctor only.
const apptStatusSchema = z.object({ status: z.string().min(1) });
clinicalRouter.put('/appointments/:id/status', requireRole('doctor', 'admin'), validate(apptStatusSchema), asyncHandler(async (req, res) => {
  const appt = db.prepare('SELECT patient_id FROM appointments WHERE id = ?').get(req.params.id);
  if (!appt) return res.status(404).json({ error: 'Appointment not found' });
  resolvePatientAccess(req, appt.patient_id);

  db.prepare('UPDATE appointments SET status = ? WHERE id = ?').run(req.valid.status, req.params.id);
  writeAudit({ actorId: req.auth.subjectId, actorRole: req.auth.role, action: 'appointment.status', targetId: req.params.id, detail: { status: req.valid.status }, ip: req.ip });
  res.json({ ok: true });
}));

/* ════════════════════════ SYMPTOM LOGS ════════════════════════ */

const logSchema = z.object({
  patientId: z.string().optional(),
  logDate: z.string().min(4),
  data: z.record(z.any()),   // all symptom scores as one object
});

// Create or update a daily symptom log (patient writes; doctor can view).
// UNIQUE(patient_id, log_date) means we upsert.
clinicalRouter.post('/symptom-logs', validate(logSchema), asyncHandler(async (req, res) => {
  const patientId = targetPatientId(req, req.valid.patientId);
  if (!patientId) { return res.status(400).json({ error: 'patientId required' }); }
  resolvePatientAccess(req, patientId);

  const existing = db.prepare('SELECT id FROM symptom_logs WHERE patient_id = ? AND log_date = ?').get(patientId, req.valid.logDate);
  const enc = encryptPHI(req.valid.data);

  if (existing) {
    db.prepare('UPDATE symptom_logs SET data_enc = ?, created_at = ? WHERE id = ?').run(enc, now(), existing.id);
    res.json({ ok: true, id: existing.id, updated: true });
  } else {
    const id = randomToken(12);
    db.prepare('INSERT INTO symptom_logs (id, patient_id, log_date, data_enc, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(id, patientId, req.valid.logDate, enc, now());
    res.status(201).json({ ok: true, id, updated: false });
  }
  writeAudit({ actorId: req.auth.subjectId, actorRole: req.auth.role, action: 'symptom_log.save', targetId: patientId, ip: req.ip });
}));

// List symptom logs for a patient (optionally by date range)
clinicalRouter.get('/symptom-logs/:patientId', asyncHandler(async (req, res) => {
  const patientId = targetPatientId(req, req.params.patientId);
  resolvePatientAccess(req, patientId);

  const { from, to } = req.query;
  let rows;
  if (from && to) {
    rows = db.prepare('SELECT id, log_date, data_enc, created_at FROM symptom_logs WHERE patient_id = ? AND log_date BETWEEN ? AND ? ORDER BY log_date DESC').all(patientId, from, to);
  } else {
    rows = db.prepare('SELECT id, log_date, data_enc, created_at FROM symptom_logs WHERE patient_id = ? ORDER BY log_date DESC LIMIT 120').all(patientId);
  }

  res.json({
    ok: true,
    logs: rows.map(r => ({ id: r.id, date: r.log_date, data: decryptPHI(r.data_enc), createdAt: r.created_at })),
  });
}));

// Get a single day's log
clinicalRouter.get('/symptom-logs/:patientId/:date', asyncHandler(async (req, res) => {
  const patientId = targetPatientId(req, req.params.patientId);
  resolvePatientAccess(req, patientId);
  const row = db.prepare('SELECT id, log_date, data_enc, created_at FROM symptom_logs WHERE patient_id = ? AND log_date = ?').get(patientId, req.params.date);
  if (!row) return res.json({ ok: true, log: null });
  res.json({ ok: true, log: { id: row.id, date: row.log_date, data: decryptPHI(row.data_enc), createdAt: row.created_at } });
}));
