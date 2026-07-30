# Deployment Runbook

Deploy OncoConnect to production or staging.

## Overview

OncoConnect deploys as a single Node service (`node src/server.js`) that serves
both the API and the static frontend from `public/`. There is no build step.

Supported targets:
- **Render.com blueprint** (`render.yaml`) — primary, documented below
- **Vercel serverless** (`vercel.json` + `api/index.js`) — see `DEPLOY_VERCEL.md`
- **Docker** (`Dockerfile`) — self-hosted

Database backends (selected by environment, see `src/config.js`):
| Backend | Env vars | Persistence | Use for |
|---|---|---|---|
| Turso (libsql) | `TURSO_DATABASE_URL`, `TURSO_AUTH_TOKEN` | Durable, managed | **Production** |
| SQLite file | `DB_PATH` (default `./chemocure.db`) | Needs a mounted disk | Self-hosted / Docker |
| Ephemeral | `DB_EPHEMERAL=true` | In-memory, lost on restart | Preview only — never production |

## Prerequisites

- Push access to `sakshibiradar022002-wq/OncoConnect`
- Render.com account with the repo connected
- A Turso database (free tier) for production persistence
- Node.js >= 20 locally (see `engines` in `package.json`)

## Environment variables

Required in production (the app **exits at startup** if these are missing —
see `required()` in `src/config.js`):

| Variable | Purpose | Notes |
|---|---|---|
| `NODE_ENV` | Must be `production` | Enables hard-fail on missing secrets |
| `JWT_SECRET` | Signs session JWTs | Render auto-generates via `generateValue: true` |
| `PHI_ENCRYPTION_KEY` | AES-256-GCM master key for PHI at rest | 64 hex chars preferred; any string >= 16 chars is SHA-256 derived |

Optional:

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `3000` | Listen port |
| `SESSION_TTL_MIN` | `120` | Session lifetime in minutes |
| `REQUIRE_DOCTOR_APPROVAL` | unset (false) | New doctors start deactivated pending admin approval |
| `TURSO_DATABASE_URL` / `TURSO_AUTH_TOKEN` | — | Turso backend |
| `DB_PATH` | `./chemocure.db` | SQLite file path |
| `DB_EPHEMERAL` | — | `true` for in-memory DB |
| `GMAIL_USER` / `GMAIL_APP_PASSWORD` | — | SMTP sender; without these OTP falls back to on-screen `devCode` |
| `SENTRY_DSN` | — | Error tracking; no-op if unset |
| `VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY` | — | Web push; `/api/push/*` returns 503 if unset |

> **Never** rotate `PHI_ENCRYPTION_KEY` by simply changing the env var —
> existing ciphertext becomes unreadable. Use the rotation procedure in
> [SECURITY.md](SECURITY.md).

## First deployment (Render blueprint)

1. **Create the Turso database**:
   ```bash
   turso db create oncoconnect
   turso db show oncoconnect --url      # → libsql://oncoconnect-xyz.turso.io
   turso db tokens create oncoconnect   # → auth token
   ```

2. **Deploy the blueprint**:
   - Render dashboard → **New → Blueprint**
   - Connect the repo; Render reads `render.yaml`
   - When prompted, paste `TURSO_DATABASE_URL` and `TURSO_AUTH_TOKEN`
     (both are `sync: false`, so Render asks rather than storing them in git)
   - `JWT_SECRET` and `PHI_ENCRYPTION_KEY` auto-generate — **record them in your
     secret manager immediately**; you cannot recover encrypted PHI without the key
   - Click **Apply**

3. **Wait for first boot.** `initSchema()` runs on startup and creates all tables.
   Render polls `healthCheckPath: /health` before routing traffic.

4. **Promote the first admin**:
   Register a doctor account through the UI, then from a Render shell:
   ```bash
   npm run make-admin -- your@email.com admin
   ```

5. **Verify** (see [Verification](#verification) below).

## Rolling update

Render auto-deploys on push to the default branch.

1. Merge the PR to the default branch.
2. Watch Render dashboard: **Building → Live** (typically 1–2 min; `npm install` only, no build step).
3. Run the verification checks below.
4. Watch logs and Sentry for 15 minutes.

Because `initSchema()` is idempotent and additive, ordinary deploys need no
migration step or downtime window.

## Verification

```bash
BASE=https://oncoconnect-server.onrender.com

# 1. Shallow health (what Render's load balancer polls)
curl -s $BASE/health
# → {"ok":true,"ts":"..."}

# 2. Deep health — actually queries the database
curl -s "$BASE/health?deep=1"
# → {"ok":true,"db":true,"ts":"..."}
# A 503 with "database unreachable" means the DB is down or credentials are wrong.

# 3. API docs render (confirms the app booted fully)
curl -s -o /dev/null -w '%{http_code}\n' $BASE/api/docs
# → 200

# 4. Frontend serves
curl -s -o /dev/null -w '%{http_code}\n' $BASE/
# → 200
```

Then smoke-test in a browser:
- [ ] Doctor login succeeds and the dashboard loads patients
- [ ] Patient login (MRN + password) succeeds
- [ ] Lab portal login succeeds
- [ ] Admin panel lists users and shows audit entries
- [ ] No new errors in Sentry

## Rollback

The app is stateless; rolling back code is safe as long as the schema hasn't
changed in a destructive way (it currently never does — `initSchema()` only adds).

**Option A — Render dashboard (fastest):**
Service → **Events** → find the last known-good deploy → **Rollback to this deploy**.

**Option B — git revert:**
```bash
git log --oneline -10          # find the bad commit
git revert <bad-commit-sha>
git push origin <default-branch>
```
Render redeploys automatically.

After rollback, re-run the [verification](#verification) checks.

For data rollback (as opposed to code), see [BACKUP_RECOVERY.md](BACKUP_RECOVERY.md).

## Docker deployment

```bash
docker build -t oncoconnect:latest .

docker run -d --name oncoconnect \
  -p 3000:3000 \
  -e NODE_ENV=production \
  -e JWT_SECRET="$(openssl rand -hex 32)" \
  -e PHI_ENCRYPTION_KEY="$(openssl rand -hex 32)" \
  -e DB_PATH=/var/data/chemocure.db \
  -v oncoconnect-data:/var/data \
  oncoconnect:latest

docker logs -f oncoconnect
curl localhost:3000/health?deep=1
```

The volume mount is mandatory — without it the SQLite file lives in the
container layer and is destroyed on every `docker run`.

## Pre-deployment checklist

- [ ] `npm test` passes locally
- [ ] `npm run audit` reports no high/critical production vulnerabilities
- [ ] PR reviewed and approved
- [ ] No secrets in the diff (`git diff --staged` reviewed)
- [ ] Backup taken if the change touches schema or data ([BACKUP_RECOVERY.md](BACKUP_RECOVERY.md))
- [ ] Team notified if a maintenance window is needed

## Common deployment failures

### App exits immediately with `[FATAL] Missing required environment variable`

`NODE_ENV=production` forces `JWT_SECRET` and `PHI_ENCRYPTION_KEY` to be set.
Add them in Render → Service → **Environment**, then redeploy.

### `/health?deep=1` returns 503 `database unreachable`

The process is up but cannot reach the database.
1. Confirm `TURSO_DATABASE_URL` and `TURSO_AUTH_TOKEN` are present and unexpired
   (`turso db tokens create oncoconnect` mints a fresh one).
2. Check Turso status: `turso db show oncoconnect`.
3. For file-backed deploys, confirm the disk is mounted at `DB_PATH`'s directory.

### Doctors can log in but see no data after a redeploy

Almost always `DB_EPHEMERAL=true` left set from preview testing — the in-memory
database resets on every restart. Remove the variable, configure Turso, redeploy.
Data written while ephemeral is unrecoverable.

### All PHI reads fail or return garbage

`PHI_ENCRYPTION_KEY` changed. Restore the previous key value immediately — the
data is intact, only the key is wrong. If the key is genuinely lost, the
encrypted columns cannot be recovered; see [BACKUP_RECOVERY.md](BACKUP_RECOVERY.md).

### Health check passes but the UI is blank

Static assets are served from `public/` by `express.static`. Confirm the deploy
included that directory and that the SPA fallback (`app.get('*')`) is reached —
a 404 on `/` means the build shipped without `public/index.html`.

## Related runbooks

- [Backup & Recovery](BACKUP_RECOVERY.md)
- [Monitoring](MONITORING.md)
- [Troubleshooting](TROUBLESHOOTING.md)
- [Incident Response](INCIDENT_RESPONSE.md)
- [Security](SECURITY.md)
