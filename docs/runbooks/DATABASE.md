# Database Management Runbook

Understand, maintain, and safely modify the OncoConnect database.

## Backends

One adapter (`src/db/adapter.js`) fronts three backends, selected automatically:

| Backend | Selected when | Notes |
|---|---|---|
| **libsql / Turso** | `TURSO_DATABASE_URL` (or `LIBSQL_URL`) is set | Remote HTTP; also accepts a `file:` URL. Required on serverless hosts |
| **better-sqlite3** | Local file, native binding available | Fastest; an `optionalDependency` |
| **node:sqlite** | Local file, Node >= 22, no native build | Zero build step fallback |

All methods are async regardless of backend, so route code is identical across
them. `activeImpl()` reports which is in use — `scripts/backup.js` uses it to
refuse running against Turso.

Serverless hosts (Vercel, Netlify, Lambda) **cannot** use a file backend — the
filesystem is read-only and ephemeral. The adapter detects this and throws a
clear error rather than crashing natively.

## Schema

Created idempotently by `initSchema()` on every startup from
`src/db/schema.sql`. All statements are `CREATE TABLE IF NOT EXISTS` /
`CREATE INDEX IF NOT EXISTS`, so startup is safe to repeat and deploys need no
separate migration step.

| Table | Purpose | Encrypted columns |
|---|---|---|
| `users` | Doctor/admin/lab accounts | `name_enc`, `meta_enc`, `totp_enc` |
| `sessions` | Server-side session records (enables revocation) | — |
| `kv_store` | The EMR itself — per-owner encrypted key-value store | `v_enc` |
| `audit_log` | Append-only action trail | `detail_enc` |
| `push_subs` | Web push subscriptions | `sub_enc` |
| `email_otps` | Pending registration OTPs (hashed) | — |
| `team_members` | Team membership and roles | — |
| `team_invites` | Outstanding invitations | — |
| `patient_access` | Per-patient sharing grants | — |

### `kv_store` is the clinical data

Everything a doctor sees lives here as encrypted JSON under `(owner_id, k)`.
Key families follow strict naming that the sync layer relies on for isolation:

| Pattern | Contents |
|---|---|
| `pat_<mrn>` | Patient demographics and credentials |
| `log_<mrn>_<date>`, `medlog_<mrn>_<date>` | Symptom and medication diaries |
| `lab_subs_<docId>` | Lab submissions |
| `pat_tokens_<docId>` | Lab task tokens |
| `alerts_<docId>_<mrn>` | Triage alerts |
| `doc_<docId>` | Doctor profile |
| `lab_<docId>_<labId>` | Lab account record |

`patientOwnsKey()` in `src/routes/sync.js` enforces which keys a patient session
may read or write, by **exact pattern rather than substring**. Substring matching
would let a patient with MRN `001` write into `0012`'s records. Never relax this
to `includes()`.

### Indexes

`kv_store` carries four, because it is the hot table:
- `idx_kv_key` — cross-owner lookups by key (patient/lab login)
- `idx_kv_owner_key` — the primary access path
- `idx_kv_owner_updated` — ordered by `updated_at DESC`, for incremental sync
- `idx_kv_pattern` — `COLLATE NOCASE`, for `LIKE` scans

## Routine inspection

For file-backed deploys:

```bash
DB=/var/data/chemocure.db

# Table sizes
sqlite3 $DB "SELECT 'users', COUNT(*) FROM users
             UNION ALL SELECT 'kv_store', COUNT(*) FROM kv_store
             UNION ALL SELECT 'audit_log', COUNT(*) FROM audit_log
             UNION ALL SELECT 'sessions', COUNT(*) FROM sessions;"

# Integrity
sqlite3 $DB "PRAGMA integrity_check;"     # → ok

# On-disk size
ls -lh $DB $DB-wal 2>/dev/null
```

For Turso:
```bash
turso db shell oncoconnect "SELECT COUNT(*) FROM kv_store;"
turso db show oncoconnect
```

> Query the database read-only for diagnostics. Writing directly bypasses
> encryption, validation, and the audit trail — use the API wherever possible.

## Maintenance

### Prune expired sessions

`sessions` grows with every login and is never cleaned automatically.

```bash
sqlite3 $DB "DELETE FROM sessions WHERE expires_at < datetime('now');"
```
Safe at any time — deleting an expired session only forces a re-login that would
have been required anyway. Run monthly, or when the table exceeds ~50k rows.

### Prune expired OTPs

```bash
sqlite3 $DB "DELETE FROM email_otps WHERE expires_at < datetime('now');"
```
The verify path already deletes on success and on exhausted attempts, so this
only cleans abandoned requests.

### Prune expired invites

```bash
sqlite3 $DB "DELETE FROM team_invites
             WHERE accepted_at IS NULL AND expires_at < datetime('now');"
```
Keep accepted invites — they are part of the access-grant record.

### Reclaim space

After large deletions the file does not shrink on its own:
```bash
sqlite3 $DB "VACUUM;"
```
This rewrites the whole file and takes an exclusive lock. Run it during a
maintenance window, and take a backup first.

### Do not prune `audit_log`

It is the compliance record. Retention is governed by DPDP obligations, not
disk convenience — see `docs/HIPAA_COMPLIANCE_GUIDE.md` and `GOVERNANCE.md`
before deleting anything. If size is a genuine problem, archive to cold storage
rather than dropping rows.

## Changing the schema

1. **Add to `src/db/schema.sql`** using `CREATE TABLE IF NOT EXISTS` or, for a
   new column on an existing table, an additive `ALTER TABLE` guarded so reruns
   are safe. `initSchema()` runs on every boot — statements must be idempotent.

2. **Additive only.** Dropping or renaming a column breaks running instances
   during a rolling deploy, when old and new code briefly coexist. To remove a
   column: stop writing it, ship, then drop it in a later release.

3. **New encrypted column?** Add it to `TARGETS` in
   `scripts/rotate-phi-key.js`, or key rotation will silently skip it and leave
   that column encrypted under the old key — unreadable after the old key is retired.
   Current targets:
   ```javascript
   ['users',      'id',       ['name_enc', 'meta_enc', 'totp_enc']],
   ['audit_log',  'id',       ['detail_enc']],
   ['push_subs',  'endpoint', ['sub_enc']],
   ```

4. **Test on a copy** before shipping:
   ```bash
   cp $DB /tmp/schema-test.db
   DB_PATH=/tmp/schema-test.db npm start
   ```

5. **Back up production** before the deploy that carries the change
   ([Backup & Recovery](BACKUP_RECOVERY.md)).

## Direct data fixes

When a fix genuinely cannot go through the API:

1. **Back up first** — always:
   ```bash
   npm run backup -- /data/backups
   ```
2. **Write the query as a `SELECT` first** and check the row count it matches.
   An `UPDATE` without a `WHERE` clause against `kv_store` destroys every
   patient record in the instance.
3. **Wrap in a transaction** so you can abort:
   ```sql
   BEGIN;
   UPDATE ...;
   SELECT changes();   -- confirm the expected count
   COMMIT;             -- or ROLLBACK;
   ```
4. **Never hand-edit `_enc` columns.** They are `v1.<iv>.<tag>.<ciphertext>`
   AES-256-GCM blobs; any edit fails authentication and the value becomes
   permanently unreadable. Copy them verbatim between databases only when both
   use the same `PHI_ENCRYPTION_KEY`.
5. **Record what you did** — direct writes leave no audit entry, so the change
   is invisible unless you log it in the incident record.

## Concurrency

SQLite permits one writer at a time. Under concurrent doctor syncs you may see
`SQLITE_BUSY` / `database is locked`. Writes are queued rather than lost, and it
resolves as load drops. If it becomes routine, move to Turso — see
[Scaling](SCALING.md).

## Related runbooks

- [Backup & Recovery](BACKUP_RECOVERY.md)
- [Security](SECURITY.md) — PHI key rotation
- [Scaling](SCALING.md)
- [Troubleshooting](TROUBLESHOOTING.md#database-issues)
