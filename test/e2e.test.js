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
const stranger = jar();

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
  assert.equal(r.data.user.name, 'Dr. Test Suite');
});

test('unauthenticated requests are rejected', async () => {
  const r = await call(stranger, 'GET', '/api/sync');
  assert.equal(r.status, 401);
});

test('kv sync: doctor push/pull, patient login, scope enforcement', async () => {
  const push = await call(doctor, 'PUT', '/api/sync', {
    changes: {
      'pat_KV-42': { name: 'KV Patient', diag: 'Glioblastoma', pass: 'kv-plain-pw', docId: 'DOC-9' },
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

test('no plaintext PHI in the database file', () => {
  if (process.env.TURSO_DATABASE_URL && !process.env.TURSO_DATABASE_URL.startsWith('file:')) return;
  const path = process.env.TURSO_DATABASE_URL
    ? process.env.TURSO_DATABASE_URL.slice(5)
    : process.env.DB_PATH;
  const raw = readFileSync(path, 'latin1');
  for (const phi of ['KV Patient', 'Glioblastoma', 'kv-plain-pw', 'doctor-secret-hash']) {
    assert.ok(!raw.includes(phi), `plaintext PHI found in db: ${phi}`);
  }
});
