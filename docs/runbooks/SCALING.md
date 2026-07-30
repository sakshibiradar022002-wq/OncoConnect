# Scaling Runbook

Grow OncoConnect from pilot to multi-clinic deployment.

## Current architecture and its limits

OncoConnect is a single stateless Node process serving both the API and static
frontend, backed by SQLite (local file or Turso). This is deliberate — it keeps
a pilot deployable on a free tier with no infrastructure work — and it holds up
further than you might expect. Know the actual limits before optimising.

| Constraint | Where it binds | Symptom when reached |
|---|---|---|
| Single writer (SQLite) | Concurrent `PUT /api/sync` | `SQLITE_BUSY` / `database is locked` |
| Full-keyspace sync | `GET /api/sync` decrypts every key for that doctor | `sync.doctor_pull` latency climbing |
| In-memory metrics | Per-instance, reset on restart | Metrics meaningless across replicas |
| In-memory rate limits | Per-instance counters | Effective limits multiply by replica count |
| Local file DB | Cannot be shared between instances | Blocks horizontal scaling entirely |

## Know your numbers first

Do not scale on intuition. Pull the actual figures:

```bash
# Latency and error rate per flow (admin session required)
curl -s $BASE/api/metrics | jq '.flows, .memory, .uptimeSec'

# Keys per doctor — the driver of sync cost
sqlite3 $DB "SELECT owner_id, COUNT(*) AS keys
             FROM kv_store GROUP BY owner_id ORDER BY keys DESC LIMIT 10;"

# Total scale
sqlite3 $DB "SELECT COUNT(*) FROM users WHERE active = 1;"
sqlite3 $DB "SELECT COUNT(*) FROM kv_store;"
```

Load-test against realistic numbers rather than guessing:
```bash
npm run load-test              # baseline
npm run load-test:peak         # 20 VUs, 60s
npm run load-test:stress       # 50 VUs, 120s
```
See [`LOAD_TESTING.md`](../../LOAD_TESTING.md) for interpreting results.

## Scaling stages

### Stage 1 — Single clinic (current design)

Roughly: up to ~20 concurrent doctors, a few hundred patients.

The default deployment handles this. Actions:
- Move to **Turso** rather than a file backend — better write concurrency and
  removes the disk dependency
- Enable alerting ([Monitoring](MONITORING.md))
- Verify backups restore ([Backup & Recovery](BACKUP_RECOVERY.md))

No architectural change needed. Resist adding infrastructure you do not yet need.

### Stage 2 — Vertical scaling

When `avgMs` rises but error rates stay flat, the process is CPU or
memory-bound, not contended.

- Move off Render's free plan (it sleeps on idle and has tight CPU limits)
- Increase instance size before increasing instance count — vertical scaling
  requires no code change, horizontal scaling does

Watch `memory` in `/api/metrics` across a full day. Steady growth without
restart indicates a leak worth diagnosing before adding capacity to mask it.

### Stage 3 — Reduce sync cost

This is usually the highest-value change, and it is a code change rather than an
infrastructure one.

`GET /api/sync` returns and decrypts a doctor's **entire** keyspace on every
pull. A doctor with 5,000 keys pays for all 5,000 to fetch one new lab result.

The `idx_kv_owner_updated` index (`owner_id, updated_at DESC`) already exists to
support the fix: accept a `?since=<timestamp>` parameter and return only keys
modified after it, with the client merging deltas. This turns routine syncs into
near-constant-cost operations.

Lower-effort mitigations available today:
- Reduce client sync frequency
- Archive completed patients out of the active keyspace

### Stage 4 — Horizontal scaling

Only once vertical scaling and sync optimisation are exhausted. Three things
must change first, or multiple replicas will misbehave:

1. **Database must be Turso** (or another shared backend). A local SQLite file
   cannot be shared between instances — this is non-negotiable.

2. **Rate limiting must move to shared state.** `express-rate-limit` defaults to
   an in-memory store, so each replica counts independently: three replicas
   means an attacker gets three times the configured attempts. Move to a Redis
   store before adding the second instance.

3. **Metrics must move to a shared store.** `/api/metrics` reports only the
   instance that served the request, so with replicas you get a random sample
   rather than a system view. Export to Prometheus/OpenTelemetry — the
   `metricsSnapshot()` shape maps cleanly onto a scrape endpoint.

Sessions are already safe to scale: they live in the database, not in process
memory, so any replica can validate and revoke any session.

## What not to do

**Do not remove rate limits to improve throughput.** They protect credential
endpoints. If limits are hit legitimately — a whole clinic behind one NAT — raise
the limit deliberately or key it on something better than IP.

**Do not disable lab-value validation for speed.** `validateLabSubmission()` is
a patient-safety control, and the cost is negligible relative to the encryption
work in the same request.

**Do not cache decrypted PHI in memory** to avoid decryption cost. It defeats
encryption at rest and widens exposure in a memory-disclosure bug.

**Do not add replicas before the three prerequisites above.** Split rate limits
and split metrics are worse than a single slower instance.

## Cost notes

The pilot configuration is free: Render free plan plus Turso free tier. The
first paid step is Render's Starter plan, needed when free-plan idle sleep
becomes unacceptable for clinical users — a doctor waiting 30 seconds for a cold
start during a consultation is a real problem, not a cosmetic one.

Turso's free tier is generous; database cost is unlikely to bind before compute.

## Related runbooks

- [Monitoring](MONITORING.md) — the metrics that tell you when to scale
- [Database](DATABASE.md) — schema, indexes, concurrency
- [Deployment](DEPLOYMENT.md)
- [LOAD_TESTING.md](../../LOAD_TESTING.md)
