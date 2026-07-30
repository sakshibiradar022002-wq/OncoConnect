# Backup & Recovery Runbook

Protect and restore OncoConnect patient data.

## Overview

OncoConnect stores all PHI encrypted at rest (AES-256-GCM). This has a critical
consequence for backups:

> **A backup is useless without `PHI_ENCRYPTION_KEY`, and the key is useless
> without a backup. Store them separately. Losing either means permanent,
> unrecoverable loss of all patient data.**

Backup strategy depends on the database backend:

| Backend | Backup method | Tool |
|---|---|---|
| SQLite file / Docker | `VACUUM INTO` snapshot | `npm run backup` |
| Turso (libsql) | Turso point-in-time restore | `turso db shell ... .dump` |
| Ephemeral | **None possible** | n/a — never use in production |

## Backing up a file-backed database

`scripts/backup.js` takes a WAL-safe online snapshot — no downtime, no need to
stop the service.

```bash
npm run backup                    # writes to ./backups
npm run backup -- /data/backups   # custom output directory
```

Output: `oncoconnect-2026-07-30T15-04-11.db`

The script automatically **prunes to the 30 most recent backups** in the target
directory. If you need longer retention, copy snapshots off-box before pruning
kicks in (see [Offsite copies](#offsite-copies)).

### Scheduled backups

Daily at 02:00 via cron:

```cron
0 2 * * * cd /app && node scripts/backup.js /data/backups >> /var/log/oncoconnect-backup.log 2>&1
```

Verify the cron is actually producing files — a silent backup failure is the
most common way teams discover they have no backups during an incident:

```bash
ls -lht /data/backups | head -5
```

If the newest file is older than 24h, investigate before doing anything else.

### Offsite copies

Backups on the same host as the database do not protect against host loss.
Sync to object storage after each run:

```bash
npm run backup -- /data/backups && \
  aws s3 sync /data/backups s3://your-bucket/oncoconnect/ --exclude '*' --include '*.db'
```

Encrypt in transit and at rest on the destination. Do **not** store
`PHI_ENCRYPTION_KEY` in the same bucket.

## Backing up Turso

`npm run backup` deliberately refuses to run against Turso and exits with a
pointer — `VACUUM INTO` cannot write to a remote libsql database.

Use Turso's own mechanisms:

```bash
# Logical dump
turso db shell oncoconnect .dump > oncoconnect-$(date +%F).sql

# Turso also keeps automatic point-in-time restore on its managed tier
turso db show oncoconnect
```

Turso's point-in-time restore covers accidental deletes and corruption without
any action on your part, but a periodic logical dump is still worth keeping —
it survives account-level problems that PITR does not.

## Restoring

### Restore a file-backed database

1. **Stop the service** so nothing writes during the swap:
   ```bash
   docker stop oncoconnect       # or: systemctl stop oncoconnect
   ```

2. **Preserve the current file** rather than deleting it — it may still hold
   data written after the backup:
   ```bash
   mv /var/data/chemocure.db /var/data/chemocure.db.pre-restore-$(date +%s)
   ```
   Also move the `-wal` and `-shm` sidecar files if present; a stale WAL against
   a restored database causes corruption.
   ```bash
   mv /var/data/chemocure.db-wal /var/data/chemocure.db-wal.old 2>/dev/null
   mv /var/data/chemocure.db-shm /var/data/chemocure.db-shm.old 2>/dev/null
   ```

3. **Put the snapshot in place**:
   ```bash
   cp /data/backups/oncoconnect-2026-07-30T15-04-11.db /var/data/chemocure.db
   ```

4. **Confirm `PHI_ENCRYPTION_KEY` matches the key in use when the backup was
   taken.** If it does not, PHI reads will fail — restore the matching key value
   before starting.

5. **Start the service and verify**:
   ```bash
   docker start oncoconnect
   curl -s "http://localhost:3000/health?deep=1"
   ```

6. **Verify data, not just health** — see [Verifying a restore](#verifying-a-restore).

### Restore Turso

```bash
# Point-in-time (preferred — no data reload)
turso db restore oncoconnect --timestamp 2026-07-30T14:00:00Z

# Or from a logical dump into a fresh database
turso db create oncoconnect-restored
turso db shell oncoconnect-restored < oncoconnect-2026-07-30.sql
# then repoint TURSO_DATABASE_URL at the restored database and redeploy
```

## Verifying a restore

A green health check only proves the database opened. Confirm the data is
actually readable and decryptable:

1. **Row counts are non-zero** — from a shell on the host:
   ```bash
   sqlite3 /var/data/chemocure.db \
     "SELECT 'users', COUNT(*) FROM users
      UNION ALL SELECT 'kv_store', COUNT(*) FROM kv_store
      UNION ALL SELECT 'audit_log', COUNT(*) FROM audit_log;"
   ```

2. **PHI decrypts** — the decisive check. Log into the doctor app and confirm
   patient names render as text rather than blank or garbled. Names live in
   encrypted columns, so a readable name proves the key matches the ciphertext.

3. **Audit log continuity** — check the newest audit entry timestamp in the
   admin panel. The gap between it and now is your actual data-loss window.
   Record this number; it belongs in the incident report.

4. **Logins work for each role** — doctor, patient (MRN), and lab.

## Recovery scenarios

### Accidental data deletion by a user

Scope first — a single deleted patient does not justify restoring the whole
database and discarding everyone else's work since the backup.

1. Identify what was deleted and when, from the admin audit log
   (`/api/admin/audit`, filter by `action` and `actorId`).
2. Restore the backup to a **separate** location, not over production:
   ```bash
   cp /data/backups/oncoconnect-<pre-deletion>.db /tmp/recovery.db
   ```
3. Extract just the affected rows from `/tmp/recovery.db` and re-insert them
   into production. PHI columns are ciphertext — copy them verbatim; do not
   attempt to decrypt and re-encrypt, and confirm both databases used the same
   `PHI_ENCRYPTION_KEY`.

### Database corruption

1. Confirm corruption rather than assuming it:
   ```bash
   sqlite3 /var/data/chemocure.db "PRAGMA integrity_check;"
   ```
   `ok` means the file is fine and the problem is elsewhere.
2. If corrupt, follow [Restore a file-backed database](#restore-a-file-backed-database)
   with the newest snapshot that passes `integrity_check`.
3. Work backwards through snapshots until one passes — corruption is often
   present in several recent backups before anyone notices.

### Host loss

1. Provision a replacement host or Render service.
2. Set `JWT_SECRET` and `PHI_ENCRYPTION_KEY` to the **original** values from
   your secret manager. A fresh `JWT_SECRET` only invalidates active sessions
   (users log in again); a wrong `PHI_ENCRYPTION_KEY` makes all PHI unreadable.
3. Restore the most recent offsite backup.
4. Verify per [Verifying a restore](#verifying-a-restore).

### Lost encryption key

There is no recovery path. AES-256-GCM without the key is not brute-forceable.
Encrypted columns (`name_enc`, `meta_enc`, `totp_enc`, `v_enc`, `detail_enc`)
are permanently lost. Non-encrypted columns — emails, roles, timestamps, IDs —
remain readable, so accounts can be re-created but clinical data cannot.

This is why the key belongs in a secret manager with its own backup, recorded
at the moment Render generates it during first deploy.

## Backup health checklist

Run monthly:

- [ ] Newest backup is less than 24 hours old
- [ ] Backup file size is in line with previous runs (a sudden drop means truncation)
- [ ] Offsite copy exists and is current
- [ ] `PHI_ENCRYPTION_KEY` is in the secret manager, stored separately from backups
- [ ] A **test restore** into a scratch environment succeeded within the last quarter
- [ ] `PRAGMA integrity_check` returns `ok` on the newest backup

An untested backup is a hypothesis, not a backup. Schedule the quarterly test
restore and treat a failure as a P1.

## Related runbooks

- [Deployment](DEPLOYMENT.md)
- [Database Management](DATABASE.md)
- [Security](SECURITY.md) — key rotation
- [Incident Response](INCIDENT_RESPONSE.md)
