---
title: "Backup and restore"
summary: "Local backup and restore, and the optional Google Drive backup."
order: 13
readmeLines:
  - "1469-1510"
---
## Backup and Restore

**Settings → Storage → Backup and restore.** A backup is one folder holding everything resmon keeps for you locally, and a restore puts it back — on this machine or another one.

A bundle (`resmon-backup-<UTC stamp>/`) contains:

* `resmon.db` — your database, produced with the SQLite backup API from the live connection rather than copied. resmon runs SQLite in WAL mode, so a file copy would miss whatever is still in `resmon.db-wal`; the snapshot is consistent by construction and has no sidecars.
* `vault/` — every byte in your Library vault, plus its `vault.json` marker. Each file is re-hashed on the way out and compared with the hash the catalog recorded. **A file that no longer matches stops the backup**, naming the file: the database and the vault are a pair, and a bundle that certified a corrupt vault would be worse than no bundle.
* `reports/` — the report tree, if you leave the checkbox on.
* `manifest.json` — the app and database-schema versions that wrote it, the vault id, a row count per table, every file with its size and SHA-256, and the list of what was deliberately left out.

**What a backup does not contain:** no credential value, ever. Not your SMTP password, not a provider API key, not a webhook signing secret, not the Google Drive token. The manifest records their *names* so that after a restore resmon can tell you exactly which ones to enter again; the values stay in your OS keyring and nowhere else. The daemon lock, the port file and the API token are not in a backup either — they describe a running process, not your work.

**Restoring takes a restart.** *Restore from backup…* checks a folder — every hash recomputed, the schema version compared with this app's, the vault compared with the one you have — and shows you the report. Only if you then choose *Restart to restore* is anything scheduled, and even then nothing changes until resmon next starts. On that start, before the database is opened, resmon moves your current database aside into `restore-undo/` (it is kept until you delete it yourself, from Settings → Storage — nothing removes it on its own, and taking another backup does not), puts the bundle's database in place, restores the vault bytes, resets the rows that describe a process that no longer exists, rebuilds the search index, runs any migrations the bundle needs, and checks integrity. A Library vault the restore replaces is moved into that same folder rather than deleted, so **any failure puts your old database and your old vault back** — both halves of the pair, and one *Delete undo copies* removes both. Where there was no vault at the destination, a failed restore removes the one it had just written, so the folder you chose is left as empty as it was found. The single exception is a copy between drives interrupted while it was removing the original: resmon then keeps the complete copy it had made, says where it is, and leaves it for you rather than deleting it — so after a failed restore, read what Settings shows before you delete an undo copy. A vault on a different drive from resmon's state folder is copied rather than moved, which needs room for a second copy of your retained files while the restore runs.

The verify report says where your Library vault would go — the folder the backup's own database recorded — and whether that folder exists and is writable on this machine. It usually is not, on a different machine, so *Restore the vault somewhere else…* lets you choose a folder here instead; resmon puts the vault under it, keeping the `resmon-library-<id>` name, and updates the database to match. It refuses a folder that is missing, is a file, cannot be written to, is inside the backup itself, or already holds a different vault, and it refuses it while you are still choosing rather than on the next start.

resmon refuses, with the reason: a bundle whose files do not match its manifest; a bundle written by a newer resmon than the one you are running (update first); and a vault directory that belongs to a *different* vault — it will not overwrite someone else's retained files.

If your database contains references to rows that are not there, the backup **still runs** and records them in the manifest; the verify report lists them and asks you to tick *Restore anyway, keeping these rows as they are* before the restore can be staged. The count is of references rather than rows, because that is what SQLite's own check reports — one row with two broken links is counted twice — and the row count is shown beside it, so you can see how many rows that actually is. A backup taken by an earlier resmon has no row count in it, and resmon shows the reference count alone rather than inventing one. Refusing to back such a database up would leave you with no backup at all, which is the worse failure.

A backup from an older resmon restores too: the migrations run on the restored database before anything else touches it, so a bundle written by v2.2.0 comes forward to today's schema on the way in.

After a restore, Settings → Storage shows a one-time card listing the credentials the backup recorded and this machine does not have. Webhook signing secrets are bound to a delivery target's row id, so a target that came back under a different id has no secret until you set one; the card says so.

The bundle format is documented in [`docs/backup.md`](docs/backup.md) for anyone restoring by hand.

## Google Drive Backup

resmon has exactly one way to send data off the machine, and it is off until the user turns it on: optional Google Drive backup of the report tree, under **Settings → Cloud Storage**. It is not the backup described above: it uploads `resmon_reports/` only, and has no restore counterpart.

This surface is a thin wrapper over the Drive v3 API using the least-privilege `drive.file` OAuth 2.0 scope, meaning resmon can only see files it created itself. The OAuth client secrets are user-supplied and live in `credentials.json` at the project root (gitignored).

1. Create an OAuth 2.0 client of type **Desktop app** in Google Cloud Console, enable the Drive API, and download the client secrets JSON to the project root as `credentials.json`.
2. Open **Settings → Cloud Storage** (`#/settings/cloud`).
3. Click **Link Google Drive**. The frontend issues `POST /api/cloud/link`; the backend runs the OAuth installed-app flow (`google-auth-oauthlib`), prompts for consent in the default browser, receives the access + refresh tokens, and stores them in the OS keyring. `GET /api/cloud/status` then returns `{ is_linked: true, api_ok: true }`.
4. Toggle **Auto-backup** to persist `cloud_auto_backup` through `PUT /api/settings/cloud`. When on, `SweepEngine._maybe_auto_backup` uploads the execution bundle to the linked Drive folder at the end of every fire.
5. Click **Back up now** (`POST /api/cloud/backup`) for an ad-hoc backup. The response `{ uploaded, total_files, folder_name, web_view_link }` powers the banner and the "open in Drive" link.
6. Click **Unlink** (`POST /api/cloud/unlink`) to revoke the stored token.

Drive API errors are surfaced with targeted hints via `API_REASON_HINTS` for `accessNotConfigured`, `insufficientPermissions`, and `no_token`, so the user can resolve Google Cloud Console / scope-consent issues directly from the panel.
