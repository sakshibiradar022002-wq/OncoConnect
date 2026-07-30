// Load testing suite for OncoConnect API — baseline performance validation
// Run with: k6 run tests/load.js
// With options: k6 run tests/load.js -e BASE_URL=http://localhost:3000 -e VUS=10 -e DURATION=30s

import http from 'k6/http';
import { check, group, sleep } from 'k6';

// Configuration
const BASE_URL = __ENV.BASE_URL || 'http://localhost:3000';
const VUS = parseInt(__ENV.VUS || '5');
const DURATION = __ENV.DURATION || '20s';

export const options = {
  stages: [
    { duration: '1m', target: VUS },       // Ramp up
    { duration: DURATION, target: VUS },   // Hold steady
    { duration: '30s', target: 0 },        // Ramp down
  ],
  thresholds: {
    'http_req_duration': ['p(95)<500'],    // 95th percentile under 500ms
    'http_req_duration{staticAsset:yes}': ['p(95)<200'],
    'http_req_failed': ['rate<0.1'],       // Error rate < 10%
  },
};

// Test data
let testDoctor = { email: '', password: '', id: '' };
let testPatient = { mrn: '', password: '' };
let testLab = { username: '', password: '', labId: '' };

export function setup() {
  // Register test doctor
  const regRes = http.post(`${BASE_URL}/api/auth/register`, {
    email: `doc_${Date.now()}@test.local`,
    password: 'TestPass123!@#',
  });

  check(regRes, {
    'registration succeeded': (r) => r.status === 201,
  });

  if (regRes.status !== 201) {
    console.error('Setup failed: doctor registration');
    return null;
  }

  testDoctor.email = JSON.parse(regRes.body).email || `doc_${Date.now()}@test.local`;
  testDoctor.password = 'TestPass123!@#';
  testDoctor.id = JSON.parse(regRes.body).id;

  // Create test patient
  const patRes = http.put(`${BASE_URL}/api/sync`, {
    changes: {
      [`pat_TEST${Date.now()}`]: {
        mrn: `TEST${Date.now()}`,
        name: 'Test Patient',
        pass: 'PatPass123!',
      },
    },
  }, { cookies: { session: regRes.cookies.session[0].value } });

  testPatient.mrn = `TEST${Date.now()}`;
  testPatient.password = 'PatPass123!';

  console.log(`Setup: Doctor ${testDoctor.email}, Patient MRN ${testPatient.mrn}`);
  return { doctor: testDoctor, patient: testPatient };
}

export default function (data) {
  const session = http.cookieJar().cookiesForURL(BASE_URL);

  group('Health Check', () => {
    let res = http.get(`${BASE_URL}/health`, {
      tags: { staticAsset: 'yes' },
    });
    check(res, {
      'status is 200': (r) => r.status === 200,
      'has ok flag': (r) => r.body.includes('ok'),
    });
    sleep(0.1);
  });

  group('Auth Flow', () => {
    // Login
    let res = http.post(
      `${BASE_URL}/api/auth/login`,
      {
        email: data.doctor.email,
        password: data.doctor.password,
      },
      { redirects: 0 }
    );
    check(res, {
      'login returns 200': (r) => r.status === 200,
    });
    sleep(0.2);
  });

  group('Sync Operations', () => {
    // Doctor pull
    let res = http.get(`${BASE_URL}/api/sync`, {
      headers: { 'Cookie': `session=${session}` },
    });
    check(res, {
      'sync pull returns 200': (r) => r.status === 200,
      'response contains keys': (r) => r.body.includes('keys'),
    });
    sleep(0.3);

    // Doctor push (add patient data)
    res = http.put(
      `${BASE_URL}/api/sync`,
      {
        changes: {
          [`doc_TEST${Date.now()}`]: {
            name: 'Test Doctor',
            specialty: 'Neuro-oncology',
          },
        },
      },
      { headers: { 'Cookie': `session=${session}` } }
    );
    check(res, {
      'sync push returns 200': (r) => r.status === 200,
    });
    sleep(0.2);
  });

  group('Patient Portal', () => {
    // Patient login
    let res = http.post(`${BASE_URL}/api/sync/patient-login`, {
      mrn: data.patient.mrn,
      password: data.patient.password,
    });
    check(res, {
      'patient login returns 200': (r) => r.status === 200,
      'patient session created': (r) => r.status === 200,
    });

    if (res.status === 200) {
      const patientSession = JSON.parse(res.body).session;
      // Patient pull
      res = http.get(`${BASE_URL}/api/sync/patient`, {
        headers: { 'Cookie': `session=${patientSession}` },
      });
      check(res, {
        'patient pull returns 200': (r) => r.status === 200,
      });
      sleep(0.2);

      // Patient push (diary entry)
      res = http.put(
        `${BASE_URL}/api/sync/patient`,
        {
          changes: {
            [`medlog_${data.patient.mrn}_${new Date().toISOString().split('T')[0]}`]: {
              date: new Date().toISOString().split('T')[0],
              symptoms: ['fatigue', 'nausea'],
              grade: 2,
            },
          },
        },
        { headers: { 'Cookie': `session=${patientSession}` } }
      );
      check(res, {
        'patient push returns 200': (r) => r.status === 200,
      });
    }
    sleep(0.2);
  });
}

export function teardown(data) {
  console.log('Load test complete.');
}
