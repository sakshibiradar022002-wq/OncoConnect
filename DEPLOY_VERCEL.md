# Deploying OncoConnect to Vercel

## Why you saw the "serverless" message

Vercel runs your code as **serverless functions** on an **ephemeral, read-only
filesystem**. A local SQLite file (`chemocure.db`) cannot be written or kept
there, so OncoConnect deliberately refuses to start and prints:

> This is a serverless deployment but no `TURSO_DATABASE_URL` is set…

That is a guardrail, not a failure. The fix is to give it a cloud database
(**Turso**, free) and set four environment variables. Turso *is* libsql/SQLite —
your schema and code do not change at all.

---

## Option A — Vercel + Turso (5 minutes)

### 1. Create a free Turso database
```bash
# install the CLI (macOS/Linux)
curl -sSfL https://get.tur.so/install.sh | bash
turso auth signup            # opens the browser once

turso db create oncoconnect
turso db show oncoconnect --url        # -> libsql://oncoconnect-<you>.turso.io
turso db tokens create oncoconnect     # -> eyJ...  (the auth token)
```

### 2. Generate the two app secrets
```bash
node -e "console.log('JWT_SECRET='+require('crypto').randomBytes(32).toString('hex'))"
node -e "console.log('PHI_ENCRYPTION_KEY='+require('crypto').randomBytes(32).toString('hex'))"
```

### 3. Set all four in Vercel
Vercel dashboard → your project → **Settings → Environment Variables**
(add each for **Production** — and Preview if you want preview deploys):

| Name | Value |
|---|---|
| `TURSO_DATABASE_URL` | `libsql://oncoconnect-<you>.turso.io` (from step 1) |
| `TURSO_AUTH_TOKEN`   | `eyJ...` (from step 1) |
| `JWT_SECRET`         | the hex string from step 2 |
| `PHI_ENCRYPTION_KEY` | the **64-hex-char** string from step 2 |

Optional (email verification codes + reminders):
`GMAIL_USER`, `GMAIL_APP_PASSWORD` (a Gmail **App Password**, not your login).

> ⚠️ Back up `PHI_ENCRYPTION_KEY`. If it is lost, all encrypted patient data
> is unrecoverable.

### 4. Deploy
```bash
npm i -g vercel
vercel            # first run links the project
vercel --prod
```
Or connect the GitHub repo in the Vercel dashboard and it deploys on every push
to the branch. No build step is needed — the schema auto-creates on first boot
(`CREATE TABLE IF NOT EXISTS`, idempotent).

### 5. Verify
- `https://<your-app>.vercel.app/health?deep=1` → `{"ok":true,"db":true}`
- Open `/` (doctor app) and register an account.

The repo is already Vercel-ready: `vercel.json` routes everything to
`api/index.js` (the Express app as one function) and bundles `public/**` +
`src/**`.

---

## Option B — a host with a persistent disk (no Turso needed)

If you would rather keep a plain SQLite **file**, deploy to a host that gives
the process a persistent disk. Then Turso is not required — just set
`JWT_SECRET` and `PHI_ENCRYPTION_KEY` (and optionally `DB_PATH`).

- **Render** – uses the included `render.yaml`; add a disk mounted where
  `DB_PATH` points.
- **Fly.io** – `fly volumes create oncoconnect_data --size 1`, mount at `/data`,
  set `DB_PATH=/data/chemocure.db`.
- **Railway** – add a volume and set `DB_PATH` onto it.

This is the simplest path if you don't want to manage a second service, and it
is what the live demo runs on.

---

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| "serverless deployment but no TURSO_DATABASE_URL" | Turso vars not set on Vercel | Add `TURSO_DATABASE_URL` + `TURSO_AUTH_TOKEN` |
| "[FATAL] Missing required environment variable: JWT_SECRET" | Secrets not set | Add `JWT_SECRET` and `PHI_ENCRYPTION_KEY` |
| "PHI_ENCRYPTION_KEY must be 64 hex chars" | Wrong length | Regenerate with the step-2 command (32 bytes → 64 hex) |
| Data resets between requests | Using a SQLite file on Vercel | Switch to Turso (Option A) |
| Login works then 401 on next request | Cookie not sent | Use the same `https://` origin; don't mix apex/preview domains |
