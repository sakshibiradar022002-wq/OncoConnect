// Lab management + direct task routing (doctor assigns → lab uploads).

import { Router } from 'express';
import { z } from 'zod';
import { db, writeAudit } from '../db/index.js';
import {
  hashPassword, encryptPHI, decryptPHI, randomToken, generatePassword,
} from '../crypto.js';
import { authenticate, requireRole } from '../middleware/auth.js';
import { validate, asyncHandler } from '../middleware/validate.js';

export const labsRouter = Router();
labsRouter.use(authenticate);

// ── Register a lab (doctor) — auto-generates credentials ──────────
const createLabSchema = z.object({
  name: z.string().min(2).max(160),
  contact: z.string().max(160).optional(),
  phone: z.string().max(40).optional(),
  email: z.string().email().optional(),
  address: z.string().max(300).optional(),
});

labsRouter.post('/', requireRole('doctor'), validate(createLabSchema), asyncHandler(async (req, res) => {
  const { name, contact, phone, email, address } = req.valid;
  const labId = randomToken(16);
  const now = new Date().toISOString();

  await db.prepare(`
    INSERT INTO labs (id, doctor_id, name_enc, meta_enc, created_at)
    VALUES (?, ?, ?, ?, ?)
  `).run(labId, req.auth.subjectId, encryptPHI(name), encryptPHI({ contact, phone, email, address }), now);

  // Create a lab-technician user account bound to this lab.
  const username = 'lab_' + randomToken(4).toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 8);
  const labEmail = `${username}@lab.chemocure.local`;
  const plainPassword = generatePassword(12);
  const userId = randomToken(16);

  await db.prepare(`
    INSERT INTO users (id, email, password_hash, role, name_enc, lab_id, active, created_at)
    VALUES (?, ?, ?, 'lab', ?, ?, 1, ?)
  `).run(userId, labEmail, hashPassword(plainPassword), encryptPHI(name + ' (Lab Tech)'), labId, now);

  await writeAudit({ actorId: req.auth.subjectId, actorRole: 'doctor', action: 'lab.create', targetId: labId, ip: req.ip });

  res.status(201).json({
    ok: true, labId,
    credentials: { email: labEmail, password: plainPassword },  // shown once
  });
}));

// ── List my labs (doctor) ─────────────────────────────────────────
labsRouter.get('/', requireRole('doctor', 'admin'), asyncHandler(async (req, res) => {
  const rows = await db.prepare('SELECT id, name_enc, meta_enc, created_at FROM labs WHERE doctor_id = ?').all(req.auth.subjectId);
  res.json({ labs: rows.map(r => ({ id: r.id, name: decryptPHI(r.name_enc), meta: decryptPHI(r.meta_enc), createdAt: r.created_at })) });
}));

// ── Assign a task to a lab (doctor) → direct push ─────────────────
const assignSchema = z.object({
  labId: z.string(),
  patientId: z.string(),
  description: z.string().min(1).max(500),
  priority: z.enum(['Routine', 'Urgent', 'STAT']).default('Routine'),
  dueDate: z.string(),   // YYYY-MM-DD
});

labsRouter.post('/tasks', requireRole('doctor'), validate(assignSchema), asyncHandler(async (req, res) => {
  const { labId, patientId, description, priority, dueDate } = req.valid;

  // Verify the lab and patient both belong to this doctor.
  const lab = await db.prepare('SELECT * FROM labs WHERE id = ? AND doctor_id = ?').get(labId, req.auth.subjectId);
  if (!lab) return res.status(403).json({ error: 'Lab not found or not yours' });
  const patient = await db.prepare('SELECT * FROM patients WHERE id = ? AND doctor_id = ?').get(patientId, req.auth.subjectId);
  if (!patient) return res.status(403).json({ error: 'Patient not found or not yours' });

  const patientRec = decryptPHI(patient.record_enc) || {};
  const taskId = randomToken(16);
  const now = new Date().toISOString();

  await db.prepare(`
    INSERT INTO lab_tasks (id, doctor_id, lab_id, patient_id, payload_enc, due_date, priority, status, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, 'Pending Upload', ?)
  `).run(
    taskId, req.auth.subjectId, labId, patientId,
    encryptPHI({ description, patientName: patientRec.name, mrn: patient.mrn }),
    dueDate, priority, now
  );

  await writeAudit({ actorId: req.auth.subjectId, actorRole: 'doctor', action: 'lab_task.create', targetId: taskId, ip: req.ip });
  res.status(201).json({ ok: true, taskId });
}));

// ── Doctor: view active task queue ────────────────────────────────
labsRouter.get('/tasks', requireRole('doctor'), asyncHandler(async (req, res) => {
  const rows = await db.prepare(`
    SELECT * FROM lab_tasks WHERE doctor_id = ? AND status = 'Pending Upload'
    ORDER BY due_date ASC
  `).all(req.auth.subjectId);
  res.json({ tasks: rows.map(mapTask) });
}));

// ── Lab tech: see tasks assigned to my lab ────────────────────────
labsRouter.get('/my-tasks', requireRole('lab'), asyncHandler(async (req, res) => {
  const me = await db.prepare('SELECT lab_id FROM users WHERE id = ?').get(req.auth.subjectId);
  if (!me?.lab_id) return res.json({ tasks: [] });

  const rows = await db.prepare(`
    SELECT * FROM lab_tasks WHERE lab_id = ? AND status = 'Pending Upload'
    ORDER BY due_date ASC
  `).all(me.lab_id);
  res.json({ tasks: rows.map(mapTask) });
}));

// ── Lab tech: submit results for a task ───────────────────────────
const submitSchema = z.object({
  taskId: z.string(),
  results: z.array(z.object({}).passthrough()).optional(),
  files: z.array(z.object({ name: z.string(), dataUrl: z.string() })).optional(),
  notes: z.string().max(2000).optional(),
});

labsRouter.post('/submit', requireRole('lab'), validate(submitSchema), asyncHandler(async (req, res) => {
  const { taskId, results, files, notes } = req.valid;
  const me = await db.prepare('SELECT lab_id FROM users WHERE id = ?').get(req.auth.subjectId);

  const task = await db.prepare('SELECT * FROM lab_tasks WHERE id = ?').get(taskId);
  if (!task || task.lab_id !== me?.lab_id) return res.status(403).json({ error: 'Task not assigned to your lab' });
  if (task.status !== 'Pending Upload') return res.status(409).json({ error: 'Task already completed' });

  const now = new Date().toISOString();
  await db.prepare(`
    INSERT INTO lab_submissions (id, task_id, lab_id, patient_id, data_enc, created_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(randomToken(16), taskId, task.lab_id, task.patient_id, encryptPHI({ results, files, notes }), now);

  await db.prepare("UPDATE lab_tasks SET status = 'Completed', completed_at = ? WHERE id = ?").run(now, taskId);
  await writeAudit({ actorId: req.auth.subjectId, actorRole: 'lab', action: 'lab_task.submit', targetId: taskId, ip: req.ip });

  res.json({ ok: true });
}));

// ── Doctor: view submissions for a patient ────────────────────────
labsRouter.get('/submissions/:patientId', requireRole('doctor'), asyncHandler(async (req, res) => {
  const patient = await db.prepare('SELECT id FROM patients WHERE id = ? AND doctor_id = ?').get(req.params.patientId, req.auth.subjectId);
  if (!patient) return res.status(403).json({ error: 'Not your patient' });

  const rows = await db.prepare('SELECT * FROM lab_submissions WHERE patient_id = ? ORDER BY created_at DESC').all(req.params.patientId);
  res.json({ submissions: rows.map(r => ({ id: r.id, taskId: r.task_id, data: decryptPHI(r.data_enc), createdAt: r.created_at })) });
}));

function mapTask(r) {
  const payload = decryptPHI(r.payload_enc) || {};
  return {
    id: r.id, patientId: r.patient_id,
    description: payload.description, patientName: payload.patientName, mrn: payload.mrn,
    priority: r.priority, dueDate: r.due_date, status: r.status, createdAt: r.created_at,
  };
}
