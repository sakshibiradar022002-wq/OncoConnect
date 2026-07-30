# Monitoring & Alerting Runbook

Observe OncoConnect in production and know when something is wrong.

## Overview

Observability is built in with no external dependencies (`src/observability.js`):

- **Correlation IDs** — every request gets `X-Request-Id` (honoured if the client
  sends one) echoed on the response and attached to every log line
- **Structured logs** — one JSON line per request, 5xx to stderr, everything else
  to stdout
- **Flow metrics** — in-memory counters and latency for the critical clinical
  paths, exposed at `/api/metrics`
- **Error tracking** — Sentry, active only when `SENTRY_DSN` is set

## Health endpoints

| Endpoint | Auth | Checks | Use for |
|---|---|---|---|
| `GET /health` | none | Process is up | Load balancer polling (Render's `healthCheckPath`) |
| `GET /health?deep=1` | none | Process **and** database | Alerting, post-deploy verification |

`?deep=1` runs `SELECT 1` against the database and returns **503** with
`{"ok":false,"db":false}` when it fails. Alert on this one — the shallow check
stays green while the database is unreachable.

## Metrics

`GET /api/metrics` — **admin only** (role `admin`, or the first registered
account; see `src/app.js`). Requires an authenticated session.

Response shape:

```json
{
  "uptimeSec": 84213,
  "memory": 98123776,
  "flows": {
    "auth.login":          { "count": 412, "errors": 2, "errorRate": 0.0049, "avgMs": 88, "maxMs": 640 },
    "sync.doctor_pull":    { "count": 1893, "errors": 0, "errorRate": 0, "avgMs": 143, "maxMs": 2100 },
    "diary.patient_push":  { "count": 771, "errors": 1, "errorRate": 0.0013, "avgMs": 96, "maxMs": 410 }
  }
}
```

`errors` counts **5xx only** — 4xx (bad credentials, validation failures) are
deliberately excluded, so `errorRate` reflects server faults rather than user
mistakes.

### Tracked flows

Only clinically meaningful paths are counted; static assets and `/health` are
ignored by design.

| Flow | Path | Why it matters |
|---|---|---|
| `auth.login` | `/api/auth/login` | Doctors cannot work if this breaks |
| `auth.portal_login` | `/api/sync/{patient,lab}-login` | Patient and lab portal access |
| `auth.register` | `/api/auth/register` | New doctor onboarding |
| `sync.doctor_pull` / `sync.doctor_push` | `GET`/`PUT /api/sync` | Core EMR read/write |
| `sync.patient_pull` / `diary.patient_push` | `GET`/`PUT /api/sync/patient` | Symptom diary — patient-reported data |
| `sync.lab` | `/api/sync/lab` | Lab result ingestion |
| `email.otp` / `email.send` | `/api/email/*` | Registration and reminders |
| `push` | `/api/push/*` | Notification delivery |
| `admin` | `/api/admin/*` | Admin operations |

> Metrics are **in-memory and per-instance**. They reset on restart and are not
> aggregated across replicas. Treat them as a live dashboard, not a historical
> record — scrape into a time-series store if you need retention.

## Structured logs

One JSON line per request:

```json
{"t":"2026-07-30T15:04:11.812Z","rid":"9f3c...","method":"PUT","path":"/api/sync","status":200,"ms":143,"flow":"sync.doctor_push","actor":"a1b2c3","role":"doctor"}
```

| Field | Meaning |
|---|---|
| `t` | ISO timestamp |
| `rid` | Correlation ID — matches the `X-Request-Id` response header |
| `method`, `path` | Request line (query string stripped) |
| `status` | HTTP status |
| `ms` | Server-side latency |
| `flow` | Flow label, absent for uncounted paths |
| `actor`, `role` | Authenticated subject; absent for anonymous requests |

**Request bodies are never logged** — they carry PHI. If you need to trace a
specific clinical action, use the audit log (`/api/admin/audit`), which records
actions and target IDs with the detail column encrypted.

### Tracing one request end to end

When a user reports a failure, ask for the request ID if the UI surfaced it,
or find it by actor and time:

```bash
# Render → Logs, or for a local/Docker deploy:
docker logs oncoconnect 2>&1 | grep '"rid":"9f3c'

# All 5xx in the last log chunk
docker logs oncoconnect 2>&1 | grep '"status":5'

# Everything one doctor did
docker logs oncoconnect 2>&1 | grep '"actor":"a1b2c3"'
```

## Recommended alerts

Configure these against whatever alerting stack you run (Render notifications,
Sentry alerts, or an external prober hitting the health endpoint).

| Alert | Condition | Severity | Runbook |
|---|---|---|---|
| Service down | `/health` non-200 for 2 min | **P0** | [Incident Response](INCIDENT_RESPONSE.md) |
| Database unreachable | `/health?deep=1` returns 503 for 2 min | **P0** | [Troubleshooting](TROUBLESHOOTING.md#database-issues) |
| Doctor login failing | `flows["auth.login"].errorRate` > 0.05 over 10 min | **P0** | [Troubleshooting](TROUBLESHOOTING.md#authentication-issues) |
| Sync errors | `flows["sync.doctor_push"].errorRate` > 0.02 over 10 min | **P1** | [Troubleshooting](TROUBLESHOOTING.md#sync-issues) |
| Patient diary failing | `flows["diary.patient_push"].errorRate` > 0.05 over 15 min | **P1** | [Troubleshooting](TROUBLESHOOTING.md#sync-issues) |
| Latency regression | any flow `avgMs` > 2000 over 10 min | **P2** | [Scaling](SCALING.md) |
| Memory growth | `memory` rising steadily across 24h without restart | **P2** | [Scaling](SCALING.md) |
| Error spike | Sentry new-issue rate above baseline | **P1** | [Incident Response](INCIDENT_RESPONSE.md) |
| Backup stale | newest backup file older than 24h | **P1** | [Backup & Recovery](BACKUP_RECOVERY.md) |

### Why patient-flow thresholds are looser

`diary.patient_push` runs from patient phones on unreliable mobile networks and
retries through the offline queue. A brief elevated error rate is usually the
network, not the server. Sustained failure over 15 minutes is real — patients
losing symptom reports means clinicians lose toxicity signal.

## External uptime probe

Render's health check only removes an instance from rotation; it does not page
anyone. Add an independent prober:

```
URL:      https://oncoconnect-server.onrender.com/health?deep=1
Interval: 60s
Expect:   200 with body containing "\"db\":true"
Alert:    2 consecutive failures
```

Probe from outside your hosting provider so a provider-wide outage is detected
rather than masked.

## Sentry

Active only when `SENTRY_DSN` is set (`initSentry()` is a no-op otherwise).
Handlers are mounted so that `sentryRequestHandler()` runs before routes and
`sentryErrorHandler()` before the custom error handler.

When triaging a Sentry issue:
1. Take the correlation ID from the request context and grep the structured logs.
2. Check `actor`/`role` to see who was affected and whether it is one user or many.
3. Confirm scope in `/api/metrics` — a single stack trace with a flat `errorRate`
   is one user's edge case; a rising `errorRate` is an incident.

Sentry captures request metadata but not bodies, so PHI does not leave the
system through error reports.

## Daily check

- [ ] `/health?deep=1` returns `{"ok":true,"db":true}`
- [ ] No flow in `/api/metrics` shows `errorRate` above its alert threshold
- [ ] No unresolved P0/P1 Sentry issues from the last 24h
- [ ] Newest backup is under 24h old ([Backup & Recovery](BACKUP_RECOVERY.md))
- [ ] `memory` is within normal range for uptime

## Weekly review

- [ ] Latency trend per flow — is `avgMs` creeping up week over week?
- [ ] Audit log reviewed for unexpected admin actions ([Security](SECURITY.md))
- [ ] Alert thresholds still match observed baselines (retune after traffic growth)
- [ ] Any alert that fired without a real problem — tune it or delete it;
      alerts nobody trusts are worse than no alerts

## Related runbooks

- [Troubleshooting](TROUBLESHOOTING.md)
- [Incident Response](INCIDENT_RESPONSE.md)
- [Scaling](SCALING.md)
- [Deployment](DEPLOYMENT.md)
