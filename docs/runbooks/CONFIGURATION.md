# Configuration Reference

Every environment variable OncoConnect reads, and what happens when it is wrong.

Configuration is centralised in [`src/config.js`](../../src/config.js). Secrets
come from the environment only — never hard-code them.

## Behaviour by environment

`NODE_ENV=production` changes how missing secrets are handled:

| | Development | Production |
|---|---|---|
| Missing `JWT_SECRET` | Ephemeral one generated, warning logged | **Process exits** |
| Missing `PHI_ENCRYPTION_KEY` | Ephemeral one generated, warning logged | **Process exits** |
| Consequence | Sessions and encrypted data reset on restart | Fails fast rather than silently losing data |

The dev auto-generation exists so the app boots with zero setup. It also means
**anything encrypted in dev is unreadable after a restart** — expected, and the
reason it hard-fails in production instead.

## Core

| Variable | Default | Description |
|---|---|---|
| `NODE_ENV` | — | Set to `production` in any real deployment |
| `PORT` | `3000` | Listen port |
| `SESSION_TTL_MIN` | `120` | Session lifetime in minutes |

## Secrets

| Variable | Required in prod | Description |
|---|---|---|
| `JWT_SECRET` | **Yes** | Signs session JWTs. Changing it logs everyone out; no data loss |
| `PHI_ENCRYPTION_KEY` | **Yes** | AES-256-GCM master key for PHI at rest |

### `PHI_ENCRYPTION_KEY` format

Accepted forms, in order of preference:

1. **64 hex characters** — used verbatim as the 32-byte key. Preferred, because
   the mapping from value to key is exact and stable.
   ```bash
   node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
   ```
2. **Any string >= 16 characters** — a 32-byte key is derived deterministically
   via SHA-256. This lets managed hosts auto-generate the secret with no format
   constraints. The same input always yields the same key, so data survives restarts.
3. **Under 16 characters** — rejected; the process exits.

> Changing this value makes all existing PHI unreadable. To change it safely,
> use the re-encryption procedure in [Security](SECURITY.md#rotating-the-phi-encryption-key)
> — never edit the variable directly on a database that holds data.

## Database

Exactly one backend is selected, in this precedence order:

| Variable | Default | Description |
|---|---|---|
| `TURSO_DATABASE_URL` / `LIBSQL_URL` | — | Turso cloud SQLite. **Recommended for production.** Takes precedence over file settings |
| `TURSO_AUTH_TOKEN` | — | Turso auth token; pairs with the URL |
| `DB_EPHEMERAL` | — | `true` uses `:memory:`. **Preview only — all data is lost on restart** |
| `DB_PATH` | `./chemocure.db` | SQLite file path. Requires a persistent mounted disk |

Serverless hosts (Vercel, Netlify, Lambda) **must** use Turso — the adapter
detects these environments and throws a clear error if no Turso URL is set,
because their filesystems are read-only and ephemeral.

## Access control

| Variable | Default | Description |
|---|---|---|
| `REQUIRE_DOCTOR_APPROVAL` | unset (false) | `true` makes every account after the first start deactivated pending admin approval |

**Set this to `true` in production.** Without it, anyone who can reach the
registration endpoint gets a working clinical account. The first account is
always auto-approved so the instance owner cannot lock themselves out.

## Email

| Variable | Description |
|---|---|
| `GMAIL_USER` | SMTP sender address |
| `GMAIL_APP_PASSWORD` | Gmail **app-specific** password — not the account password |

Gmail requires 2FA on the sending account before an app password can be minted.

When unset, `/api/email/otp` returns the code in the response as `devCode`
instead of emailing it. That is the intended development fallback — in
production it means registration codes are being handed to the client rather
than delivered privately. Check `GET /api/email/status` to confirm which mode
an instance is in.

## Push notifications

| Variable | Description |
|---|---|
| `VAPID_PUBLIC_KEY` | Web push public key |
| `VAPID_PRIVATE_KEY` | Web push private key |

Generate a pair:
```bash
node -e "console.log(require('web-push').generateVAPIDKeys())"
```

When unset, `/api/push/*` returns 503 `Push not configured` — the rest of the
app is unaffected. Changing the keys invalidates every existing subscription;
all clients must re-subscribe.

## Error tracking

| Variable | Description |
|---|---|
| `SENTRY_DSN` | Sentry project DSN |

`initSentry()` is a no-op when unset, so Sentry is entirely optional. Request
metadata is captured; request bodies are not, so PHI does not leave the system
through error reports.

## Minimal production configuration

```bash
NODE_ENV=production
JWT_SECRET=<64 hex chars>
PHI_ENCRYPTION_KEY=<64 hex chars>
TURSO_DATABASE_URL=libsql://oncoconnect-xyz.turso.io
TURSO_AUTH_TOKEN=<token>
REQUIRE_DOCTOR_APPROVAL=true
```

Everything else is optional and degrades gracefully: no email means on-screen
OTP codes, no VAPID means no push, no Sentry means no error aggregation.

## Verifying configuration

```bash
BASE=https://oncoconnect-server.onrender.com

# Database reachable with current credentials
curl -s "$BASE/health?deep=1"        # → {"ok":true,"db":true,...}

# Email configured?
curl -s $BASE/api/email/status       # → {"configured":true,"provider":"..."}

# Push configured?
curl -s $BASE/api/push/vapid-public-key   # 503 → not configured
```

Startup logs surface misconfiguration directly — `[dev]` warnings mean an
ephemeral secret was generated, `[FATAL]` means the process refused to start.

## Related runbooks

- [Deployment](DEPLOYMENT.md)
- [Security](SECURITY.md)
- [Database](DATABASE.md)
- [Troubleshooting](TROUBLESHOOTING.md)
