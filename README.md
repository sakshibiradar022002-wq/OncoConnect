# ChemoCure Server — Secure Neuro-Oncology EMR Backend

Real backend for the ChemoCure platform. Node + Express + SQLite, built security-first:
**PHI encrypted at rest, revocable server-side sessions, and role-based access control.**

This turns the single-file HTML prototype into real software — cross-device sync, real
authentication, and encrypted patient data all come from moving off localStorage to this server.

## What makes this "real" (vs the localStorage prototype)

| Concern | Prototype (localStorage) | This backend |
|---|---|---|
| Cross-device | Same browser only | Any device — data lives on the server |
| PHI at rest | Plaintext JSON | AES-256-GCM encrypted, per-record IV + auth tag |
| Passwords | Hashed in-browser | PBKDF2-SHA512, 210k iterations, per-user salt, timing-safe |
| Sessions | None | httpOnly cookie + server-side revocable session table |
| Access control | None | RBAC — doctors see only their patients; labs see only their tasks |
| Storage limit | ~5 MB | Disk-bound (gigabytes) |
| Audit | What changed | Who changed it, when, from what IP — append-only, encrypted |

Every one of these is covered by an automated end-to-end test (31 assertions, all passing).

## Security architecture

- **src/crypto.js** — all cryptographic primitives in one auditable place.
  - Passwords: PBKDF2-SHA512, 210,000 iterations, 16-byte random salt, timingSafeEqual.
  - PHI: AES-256-GCM. Each record gets a fresh 12-byte IV; the GCM auth tag detects tampering.
    Blob format: v1.<iv_b64>.<tag_b64>.<ciphertext_b64>.
  - Master PHI key comes only from PHI_ENCRYPTION_KEY (env). Never hard-coded.
- **src/middleware/auth.js** — JWT in an httpOnly, sameSite=lax, secure (prod) cookie,
  backed by a server-side session row so logout/revocation is real, not just token expiry.
- **RBAC** via requireRole('doctor') etc. Ownership enforced per query (WHERE doctor_id = ?),
  so one doctor can never read another's patients.
- **Rate limiting** — 30 auth attempts / 15 min, 300 API calls / min per IP.
- **Helmet** sets a strict Content-Security-Policy and hardening headers.
- **Zod** validates every request body before it touches the database.

### What's plaintext (on purpose)
Only non-PHI, index-needed columns: internal ids, MRNs and emails (login identifiers),
timestamps, roles, foreign keys, due dates and priorities (for sorting). Every clinical
field — names, diagnoses, molecular results, lab values, symptom logs, messages — is encrypted.

## Quick start (local)

```bash
npm install
cp .env.example .env
# generate the two secrets:
node -e "console.log('JWT_SECRET='+require('crypto').randomBytes(32).toString('hex'))"
node -e "console.log('PHI_ENCRYPTION_KEY='+require('crypto').randomBytes(32).toString('hex'))"
# paste both into .env, then:
npm run init-db
npm start
```

Open http://localhost:3000 — doctor app at /, patient/lab app at /patient.html.

Node 20+ required. Uses better-sqlite3 if it compiles, otherwise falls back to the
built-in node:sqlite (Node 22+) automatically — zero native build step needed.

## Deploy to a cloud host

### Render (easiest)
1. Push this folder to a Git repo.
2. On Render: New -> Blueprint, point it at the repo. render.yaml does the rest.
3. Render auto-generates JWT_SECRET. You must set PHI_ENCRYPTION_KEY manually
   (64 hex chars) in the dashboard. A 1 GB persistent disk is mounted at /data
   so the database survives deploys.

### Fly.io
```bash
fly launch
fly volumes create chemocure_data --size 1
fly secrets set JWT_SECRET=$(node -e "console.log(require('crypto').randomBytes(32).toString('hex'))")
fly secrets set PHI_ENCRYPTION_KEY=$(node -e "console.log(require('crypto').randomBytes(32).toString('hex'))")
fly deploy
```
Mount the volume at /data and set DB_PATH=/data/chemocure.db.

### Railway
New project -> Deploy from repo. Add the same env vars in Variables, add a volume
mounted where DB_PATH points.

CRITICAL: back up PHI_ENCRYPTION_KEY somewhere safe and separate from the database.
If you lose it, every encrypted record becomes permanently unreadable.

## Two installable apps (PWA)

The platform ships as **two separate installable apps**, both served by this one server:

| App | URL | Installs as | Theme |
|---|---|---|---|
| **ChemoCure Pro** (Doctor) | `/` | Desktop/laptop software | Blue |
| **ChemoCure** (Patient) | `/patient.html` | Phone app (home screen) | Green |

Each has its own web manifest, service worker (scoped so they never collide), and app icon.
Once deployed over HTTPS, the browser offers an **Install** button:

- **Doctor (desktop):** Chrome/Edge show an install icon in the address bar, or use the
  in-app "Install ChemoCure Pro" banner. It then opens in its own window like native software.
- **Patient (phone):** Android Chrome shows an "Install" banner; iOS Safari shows a hint to
  tap **Share → Add to Home Screen**. It launches full-screen with no browser chrome.

**Offline behavior:** the app shell (HTML/JS/icons) is cached so each app opens instantly and
works offline for the last-loaded view. **PHI is never cached** — every `/api/*` request goes
straight to the network and requires a valid session, so patient data is always fresh and
server-authorized.

> PWAs require HTTPS. All the recommended hosts (Render/Fly/Railway) provide it automatically.
> On `localhost` it also works for testing.

## API surface

All under /api. Session cookie is sent automatically (credentials: 'include').

Auth: POST /auth/register, POST /auth/login, POST /auth/patient-login, GET /auth/me, POST /auth/logout
Patients (doctor): GET /patients, POST /patients, GET /patients/:id, PUT /patients/:id,
  POST /patients/:id/reset-password, DELETE /patients/:id
Labs: POST /labs (register + auto-credentials), GET /labs, POST /labs/tasks (assign),
  GET /labs/tasks (doctor queue), GET /labs/my-tasks (lab tech), POST /labs/submit,
  GET /labs/submissions/:patientId
Clinical: POST/GET /clinical/messages, POST/GET /clinical/appointments (+ PUT status),
  POST/GET /clinical/symptom-logs
Sync: GET/PUT /sync (doctor keyspace), POST /sync/patient-login,
  GET/PUT /sync/patient (MRN-scoped)

The frontend talks to the structured API through public/api-client.js (window.ChemoCureAPI).

## How the HTML apps stay connected (cross-device sync)

The UIs keep their working data in localStorage for instant, offline-capable
reads — and public/sync-client.js mirrors every change to the server:

- Signing in authenticates against the backend and pulls the account's data
  onto the device (per-key last-write-wins), so a doctor can log in anywhere
  and see their patients; a patient needs only their MRN + password on any phone.
- Every localStorage write is pushed back to the server (debounced), stored
  AES-256-GCM encrypted in the kv_store table.
- Accounts created before the backend existed are enrolled automatically on
  their next login, and local-only data is uploaded on first server sign-in.
- If the server is unreachable, both apps keep working local-only and the
  sync retries later.

## Testing

Verified with 31 end-to-end assertions: registration, login, duplicate-email and
wrong-password rejection, RBAC, patient CRUD, the full lab workflow (assign -> tech login
-> submit -> doctor reads results), session revocation on logout, and — most importantly —
confirming patient names and diagnoses are never present in plaintext in the raw database.

## Not yet included (honest scope)

This is the security-first core. Still worth adding for full production:
- PHI key-rotation script
- HTTPS is assumed to be terminated by the host (Render/Fly/Railway all do this)
- Formal HIPAA/GDPR compliance review before real patient use
