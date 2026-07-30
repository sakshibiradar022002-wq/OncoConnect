# OncoConnect Operational Documentation

Runbooks for deploying, operating, and troubleshooting OncoConnect in production.

## Runbooks

| Runbook | Use when |
|---|---|
| **[Deployment](runbooks/DEPLOYMENT.md)** | Deploying, rolling back, or setting up a new environment |
| **[Configuration](runbooks/CONFIGURATION.md)** | Looking up an environment variable or its failure mode |
| **[Monitoring](runbooks/MONITORING.md)** | Setting up alerts, reading metrics, tracing a request |
| **[Troubleshooting](runbooks/TROUBLESHOOTING.md)** | Something is broken and you need to find out why |
| **[Incident Response](runbooks/INCIDENT_RESPONSE.md)** | A production incident is in progress |
| **[Backup & Recovery](runbooks/BACKUP_RECOVERY.md)** | Backing up, restoring, or recovering lost data |
| **[Database](runbooks/DATABASE.md)** | Schema changes, maintenance, direct data inspection |
| **[Security](runbooks/SECURITY.md)** | Key rotation, access control, hardening |
| **[Scaling](runbooks/SCALING.md)** | Growth is straining the current deployment |

## Start here in an incident

1. [Incident Response → Response phases](runbooks/INCIDENT_RESPONSE.md#response-phases)
2. [Troubleshooting → 60-second triage](runbooks/TROUBLESHOOTING.md#first-triage-in-60-seconds)

```bash
BASE=https://oncoconnect-server.onrender.com
curl -s $BASE/health              # process up?
curl -s "$BASE/health?deep=1"     # database reachable?
```

## System overview

OncoConnect is a neuro-oncology EMR with four user surfaces:

- **Doctor app** — patient records, treatment planning, team collaboration
- **Patient app** — symptom diary, appointments, education (PWA, offline-capable)
- **Lab portal** — result submission and task worklist
- **Admin panel** — user approval, audit log

### Architecture

A single stateless Node process (`node src/server.js`) serves both the API and
the static frontend from `public/`. There is no build step.

| Layer | Implementation |
|---|---|
| Backend | Node >= 20, Express 4 |
| Database | SQLite via an adapter — Turso (libsql), better-sqlite3, or node:sqlite |
| Clinical data | `kv_store` — per-owner encrypted key-value store |
| Auth | Server-side sessions (JWT + `sessions` table), optional TOTP 2FA |
| Encryption | AES-256-GCM on all PHI columns at rest |
| Frontend | Vanilla JS PWA, syncs localStorage against the server keyspace |
| Observability | Structured JSON logs, correlation IDs, in-memory flow metrics, optional Sentry |

### Deployment targets

- **Render.com** via `render.yaml` blueprint — primary
- **Vercel** serverless — see [`DEPLOY_VERCEL.md`](../DEPLOY_VERCEL.md) (requires Turso)
- **Docker** via `Dockerfile` — self-hosted

## Operational commands

```bash
npm start                              # run the server
npm test                               # API end-to-end tests
npm run test:ui                        # Playwright UI tests
npm run audit                          # production dependency audit
npm run backup -- /data/backups        # online database snapshot
npm run rotate-key                     # re-encrypt PHI under a new key
npm run make-admin -- user@x.com admin # grant a role (also activates)
npm run load-test                      # k6 load test
```

## Severity levels

Severity is set by **patient-safety impact**, not technical interest.

| Level | Definition | Response |
|---|---|---|
| **P0** | Clinicians cannot access patient data, or data loss is in progress | Immediate |
| **P1** | A clinical workflow is broken but data is safe | 1 hour |
| **P2** | Degraded but usable; workaround exists | 4 hours |
| **P3** | Cosmetic or documentation | Best effort |

Full definitions: [Incident Response → Severity levels](runbooks/INCIDENT_RESPONSE.md#severity-levels).

## API documentation

Interactive OpenAPI docs are served by the app itself:

- Swagger UI — `/api/docs`
- Raw OpenAPI spec — `/api/docs.json`

Locally: `npm run dev`, then http://localhost:3000/api/docs

## Related documentation

**Security & compliance**
- [`SECURITY.md`](../SECURITY.md) — security policy and disclosure
- [`SECURITY_SCANNING.md`](../SECURITY_SCANNING.md) — CI security gates
- [`HIPAA_COMPLIANCE_GUIDE.md`](HIPAA_COMPLIANCE_GUIDE.md)
- [`DPIA.md`](../DPIA.md) — data protection impact assessment
- [`GOVERNANCE.md`](../GOVERNANCE.md) — DPDP mapping and data governance

**Setup & testing**
- [`DEPLOYMENT_SETUP.md`](../DEPLOYMENT_SETUP.md) / [`DEPLOY_VERCEL.md`](../DEPLOY_VERCEL.md)
- [`EMAIL_SETUP.md`](../EMAIL_SETUP.md) — SMTP configuration
- [`LOAD_TESTING.md`](../LOAD_TESTING.md) / [`FRONTEND_TESTING.md`](../FRONTEND_TESTING.md)
- [`IMPLEMENTATION_KIT.md`](../IMPLEMENTATION_KIT.md) — clinic onboarding
