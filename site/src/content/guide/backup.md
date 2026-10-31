---
title: "Backup and restore"
summary: "Local backup and restore, and keeping a backup in Google Drive."
order: 13
readmeLines:
  - "1469-1510"
---
## Backup and Restore

**Settings → Storage → Backup and restore.** A backup is one folder holding everything resmon keeps for you locally, and a restore puts it back — on this machine or another one.

A backup (`resmon-backup-<UTC stamp>/`) contains:

* `resmon.db` — your database, produced with the SQLite backup API from the live connection rather than copied. resmon runs SQLite in WAL mode, so a file copy would miss whatever is still in `resmon.db-wal`; the snapshot is consistent by construction and has no sidecars.
* `vault/` — every byte in your Library vault, plus its `vault.json` marker. Each file is re-hashed on the way out and compared with the hash the catalog recorded. **A file that no longer matches stops the backup**, naming the file: the database and the vault are a pair, and a backup that certified a corrupt vault would be worse than no backup.
* `reports/` — the report tree, if you leave the checkbox on.
* `manifest.json` — the app and database-schema versions that wrote it, the vault id, a row count per table, every file with its size and SHA-256, and the list of what was deliberately left out.

**What a backup does not contain:** no credential value, ever. Not your SMTP password, not a provider API key, not a webhook signing secret. The manifest records their *names* so that after a restore resmon can tell you exactly which ones to enter again; the values stay in your OS keyring and nowhere else. The daemon lock, the port file and the API token are not in a backup either — they describe a running process, not your work.

**Restoring takes a restart.** *Restore from backup…* checks a folder — every hash recomputed, the schema version compared with this app's, the vault compared with the one you have — and shows you the report. Only if you then choose *Restore on next start* is anything scheduled, and even then nothing changes until a backend next starts. The page says which start that is: quitting resmon and opening it again, or, when the background service holds your database, restarting the service, since reopening the window leaves the service running. It says how on your platform. On that start, before the database is opened, resmon moves your current database aside into `restore-undo/` (it is kept until you delete it yourself, from Settings → Storage — nothing removes it on its own, and taking another backup does not), puts the backup's database in place, restores the vault bytes, resets the rows that describe a process that no longer exists, rebuilds the search index, runs any migrations the backup needs, and checks integrity. A Library vault the restore replaces is moved into that same folder rather than deleted, so **any failure puts your old database and your old vault back** — both halves of the pair, and one *Delete undo copies* removes both. Where there was no vault at the destination, a failed restore removes the one it had just written, so the folder you chose is left as empty as it was found. The single exception is a copy between drives interrupted while it was removing the original: resmon then keeps the complete copy it had made, says where it is, and leaves it for you rather than deleting it — so after a failed restore, read what Settings shows before you delete an undo copy. A vault on a different drive from resmon's state folder is copied rather than moved, which needs room for a second copy of your retained files while the restore runs.

The verify report says where your Library vault would go — the folder the backup's own database recorded — and whether that folder exists and is writable on this machine. It usually is not, on a different machine, so *Restore the vault somewhere else…* lets you choose a folder here instead; resmon puts the vault under it, keeping the `resmon-library-<id>` name, and updates the database to match. It refuses a folder that is missing, is a file, cannot be written to, is inside the backup itself, or already holds a different vault, and it refuses it while you are still choosing rather than on the next start.

resmon refuses, with the reason: a backup whose files do not match its manifest; a backup written by a newer resmon than the one you are running (update first); and a vault directory that belongs to a *different* vault — it will not overwrite someone else's retained files.

If your database contains references to rows that are not there, the backup **still runs** and records them in the manifest; the verify report lists them and asks you to tick *Restore anyway, keeping these rows as they are* before the restore can be staged. The count is of references rather than rows, because that is what SQLite's own check reports — one row with two broken links is counted twice — and the row count is shown beside it, so you can see how many rows that actually is. A backup taken by an earlier resmon has no row count in it, and resmon shows the reference count alone rather than inventing one. Refusing to back such a database up would leave you with no backup at all, which is the worse failure.

A backup from an older resmon restores too: the migrations run on the restored database before anything else touches it, so a backup written by v2.2.0 comes forward to today's schema on the way in.

After a restore, Settings → Storage shows a one-time card listing the credentials the backup recorded and this machine does not have. Webhook signing secrets are bound to a delivery target's row id, so a target that came back under a different id has no secret until you set one; the card says so.

The backup format is documented in [`docs/backup.md`](docs/backup.md) for anyone restoring by hand.

## Google Drive Backup

resmon does not sign in to Google and sends nothing to Drive itself. To keep a backup in Google Drive, install Google Drive for desktop and choose the folder it keeps on this computer as the folder backups go to (**Settings → Storage**, the export location): on a Mac that is `~/Library/CloudStorage/GoogleDrive-<your account>/My Drive`, which Finder lists as Google Drive; on Windows, the `My Drive` folder on the drive it adds. Each *Back up now* then writes its backup there, and Google Drive for desktop uploads it. resmon can say it wrote the backup; it cannot see the upload, and it does not say the upload happened. Any folder a sync client keeps works the same way — iCloud Drive, Dropbox, OneDrive. Google offers no Drive client for Linux.

Until October 30, 2026 resmon had its own Google sign-in, under **Settings → Cloud Storage**, which uploaded the reports folder (never the database) on demand or after each run. It needed an OAuth client registered in Google Cloud Console, and it was removed. If you had the upload after each run switched on, nothing is uploaded now. A sign-in it stored is no longer read, and you can remove resmon's access in your Google Account.
