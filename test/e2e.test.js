// End-to-end API tests. Boots the real server on a random port with a
// throwaway database, then exercises every route group through real HTTP.
//
//   npm test                       — run against the default local backend
//   TURSO_DATABASE_URL=file:/tmp/t.db npm test   — run against the libsql backend
//
// No test framework needed — plain node:test (built into Node 20+).

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir = mkdtempSync(join(tmpdir(), 'chemocure-test-'));
process.env.DB_PATH = join(dir, 'test.db');
process.env.PORT = '0'; // pick a free port
process.env.NODE_ENV = 'test';

let server;
let base;

// Cookie jars: tiny manual implementation so we can act as several users.
function jar() {
  const cookies = new Map();
  return {
    headers(extra = {}) {
      const cookie = [...cookies.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
      return cookie ? { ...extra, cookie } : extra;
    },
    absorb(res) {
      for (const line of res.headers.getSetCookie?.() || []) {
        const [pair] = line.split(';');
        const idx = pair.indexOf('=');
        cookies.set(pair.slice(0, idx).trim(), pair.slice(idx + 1).trim());
      }
    },
  };
}

async function call(j, method, path, body) {
  const res = await fetch(base + path, {
    method,
    headers: j.headers(body ? { 'content-type': 'application/json' } : {}),
    body: body ? JSON.stringify(body) : undefined,
  });
  j.absorb(res);
  let data = null;
  try { data = await res.json(); } catch { /* non-JSON responses */ }
  return { status: res.status, data };
}

before(async () => {
  const { app } = await import('../src/app.js');
  const http = await import('node:http');
  server = http.createServer(app);
  await new Promise(resolve => server.listen(0, resolve));
  base = `http://localhost:${server.address().port}`;
});

after(() => {
  server?.close();
  rmSync(dir, { recursive: true, force: true });
});

const doctor = jar();
const patient = jar();
const lab = jar();
const stranger = jar();

let patientId, patientMrn, patientPassword, labId, labCreds, taskId;

test('health check responds', async () => {
  const r = await call(stranger, 'GET', '/health');
  assert.equal(r.status, 200);
  assert.equal(r.data.ok, true);
});

test('doctor registration', async () => {
  const r = await call(doctor, 'POST', '/api/auth/register', {
    name: 'Dr. Test Suite', email: 'suite@onco.test', password: 'SuitePass!2026',
    specialty: 'Neuro-Oncology',
  });
  assert.equal(r.status, 201);
});

test('duplicate email is rejected', async () => {
  const r = await call(stranger, 'POST', '/api/auth/register', {
    name: 'Dr. Dup', email: 'suite@onco.test', password: 'SuitePass!2026',
  });
  assert.equal(r.status, 409);
});

test('wrong password is rejected', async () => {
  const r = await call(stranger, 'POST', '/api/auth/login', {
    email: 'suite@onco.test', password: 'wrong-password',
  });
  assert.equal(r.status, 401);
});

test('doctor login sets a working session', async () => {
  const r = await call(doctor, 'POST', '/api/auth/login', {
    email: 'suite@onco.test', password: 'SuitePass!2026',
  });
  assert.equal(r.status, 200);
  const me = await call(doctor, 'GET', '/api/auth/me');
  assert.equal(me.data.name, 'Dr. Test Suite');
});

test('unauthenticated requests are rejected', async () => {
  const r = await call(stranger, 'GET', '/api/patients');
  assert.equal(r.status, 401);
});

test('doctor creates and lists a patient', async () => {
  const r = await call(doctor, 'POST', '/api/patients', {
    record: { name: 'Suite Patient', diag: 'Glioblastoma', phase: 'Diagnosis' },
  });
  assert.equal(r.status, 201);
  ({ id: patientId, mrn: patientMrn, password: patientPassword } = r.data);
  const list = await call(doctor, 'GET', '/api/patients');
  assert.equal(list.data.patients.length, 1);
  assert.equal(list.data.patients[0].name, 'Suite Patient');
});

test('patient portal login + RBAC denial', async () => {
  const r = await call(patient, 'POST', '/api/auth/patient-login', {
    mrn: patientMrn, password: patientPassword,
  });
  assert.equal(r.status, 200);
  const denied = await call(patient, 'GET', '/api/patients');
  assert.equal(denied.status, 403);
});

test('messages flow both ways', async () => {
  const send = await call(doctor, 'POST', '/api/clinical/messages', {
    patientId, body: 'How are you feeling?',
  });
  assert.equal(send.status, 201);
  const reply = await call(patient, 'POST', '/api/clinical/messages', {
    body: 'Feeling okay today.',
  });
  assert.equal(reply.status, 201);
  const thread = await call(doctor, 'GET', `/api/clinical/messages/${patientId}`);
  assert.equal(thread.data.messages.length, 2);
});

test('appointments and symptom logs', async () => {
  const appt = await call(doctor, 'POST', '/api/clinical/appointments', {
    patientId, date: '2026-09-01', time: '10:00', type: 'MRI Review',
  });
  assert.equal(appt.status, 201);
  const log = await call(patient, 'POST', '/api/clinical/symptom-logs', {
    logDate: '2026-07-08', data: { fatigue: 2, nausea: 0 },
  });
  assert.equal(log.status, 201);
  const logs = await call(doctor, 'GET', `/api/clinical/symptom-logs/${patientId}`);
  assert.equal(logs.data.logs.length, 1);
});

test('full lab workflow', async () => {
  const create = await call(doctor, 'POST', '/api/labs', { name: 'Suite Lab', contact: 'lab@suite.test' });
  assert.equal(create.status, 201);
  labId = create.data.labId;
  labCreds = create.data.credentials;

  const assign = await call(doctor, 'POST', '/api/labs/tasks', {
    labId, patientId, description: 'MGMT methylation', dueDate: '2026-07-20', priority: 'Urgent',
  });
  assert.equal(assign.status, 201);
  taskId = assign.data.taskId;

  const login = await call(lab, 'POST', '/api/auth/login', {
    email: labCreds.email, password: labCreds.password,
  });
  assert.equal(login.status, 200);

  const tasks = await call(lab, 'GET', '/api/labs/my-tasks');
  assert.equal(tasks.data.tasks.length, 1);
  assert.equal(tasks.data.tasks[0].patientName, 'Suite Patient');

  const submit = await call(lab, 'POST', '/api/labs/submit', {
    taskId, result: { status: 'Methylated' }, notes: 'QC passed',
  });
  assert.equal(submit.status, 200);

  const subs = await call(doctor, 'GET', `/api/labs/submissions/${patientId}`);
  assert.equal(subs.data.submissions.length, 1);
});

test('kv sync: doctor push/pull, patient login, scope enforcement', async () => {
  const push = await call(doctor, 'PUT', '/api/sync', {
    changes: {
      'pat_KV-42': { name: 'KV Patient', pass: 'kv-plain-pw', docId: 'DOC-9' },
      'doc_DOC-9': { name: 'Dr. Test Suite', pass: 'doctor-secret-hash' },
    },
  });
  assert.equal(push.data.count, 2);

  const pull = await call(doctor, 'GET', '/api/sync');
  assert.equal(pull.data.keys['pat_KV-42'].v.name, 'KV Patient');

  const kvPatient = jar();
  const login = await call(kvPatient, 'POST', '/api/sync/patient-login', {
    mrn: 'KV-42', password: 'kv-plain-pw',
  });
  assert.equal(login.status, 200);
  // The doctor's profile comes back with credentials stripped.
  assert.equal(login.data.keys['doc_DOC-9'].v.pass, undefined);

  const ownWrite = await call(kvPatient, 'PUT', '/api/sync/patient', {
    changes: { 'log_KV-42_today': { fatigue: 1 } },
  });
  assert.equal(ownWrite.data.count, 1);

  const foreignWrite = await call(kvPatient, 'PUT', '/api/sync/patient', {
    changes: { 'doc_DOC-9': { pwned: true }, 'pat_OTHER': { x: 1 } },
  });
  assert.equal(foreignWrite.data.count, 0);
});

test('logout revokes the session server-side', async () => {
  const out = await call(doctor, 'POST', '/api/auth/logout');
  assert.equal(out.status, 200);
  const after_ = await call(doctor, 'GET', '/api/patients');
  assert.equal(after_.status, 401);
});

test('no plaintext PHI in the database file', () => {
  if (process.env.TURSO_DATABASE_URL && !process.env.TURSO_DATABASE_URL.startsWith('file:')) return;
  const path = process.env.TURSO_DATABASE_URL
    ? process.env.TURSO_DATABASE_URL.slice(5)
    : process.env.DB_PATH;
  const raw = readFileSync(path, 'latin1');
  for (const phi of ['Suite Patient', 'Glioblastoma', 'How are you feeling', 'KV Patient', 'MGMT methylation']) {
    assert.ok(!raw.includes(phi), `plaintext PHI found in db: ${phi}`);
  }
});
