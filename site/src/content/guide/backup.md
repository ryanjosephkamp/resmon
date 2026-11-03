---
title: "Backup and restore"
summary: "What a backup holds and leaves out, where it goes, restoring it on this computer or another, and keeping a copy in Google Drive."
order: 13
readmeLines: []
---
**Settings › Backup** writes one folder holding everything resmon keeps for you locally, and restores it on this computer or another.

## What a backup holds

A backup is a folder named `resmon-backup-` followed by a UTC time stamp. It holds:

- `resmon.db`, your database, written with SQLite's backup interface from the live connection, not copied. resmon runs SQLite in WAL mode, so a file copy would miss whatever is still in the write-ahead log. The snapshot is consistent and has no sidecar files.
- `vault/`, every byte in your Library, with its `vault.json` marker. Each file is hashed again as it is copied and compared with the hash the database recorded. **A file that no longer matches stops the backup**, naming the file. The database and the Library are a pair, and a backup that certified a corrupt Library would be worse than none.
- `reports/`, the reports folder, if **Include the reports folder** is ticked. It is ticked by default.
- `manifest.json`, naming the app and database versions that wrote it, the Library's id, a row count per table, every file with its size and SHA-256, and what was deliberately left out.

**No credential value is ever written into a backup.** Not your email password, not a provider key or a source key, not a webhook secret. The manifest records their names, so that after a restore resmon can list the ones to enter again. The values stay in your operating system's keychain. The daemon lock, the port file, and the API token describe a running process, not your work, and are not in a backup either.

The collection map and the shared-wording scan are derived from your papers and kept beside the database. They are not backed up: after a restore the map is fitted again, and shared wording is scanned again when you ask.

The bundle is an ordinary folder, uncompressed and unencrypted, so it can be read with tools already on your computer. [`docs/backup.md`](docs/backup.md) documents the layout for anyone restoring by hand or writing a tool.

## Where backups go

**Where backups go** is a folder you choose with **Choose a folder**. If none is chosen, a backup goes into the system's temporary folder, which the system may empty, and the page says so. Choose a folder you keep.

**Back up now** writes the bundle and says where. The line above the button says when the last one was written, how many files it holds, and whether it included the reports. A restored database holds no record of the backup it came from, and the page says that instead of "none written".

## Keeping a copy in Google Drive

resmon does not sign in to Google and sends nothing to Drive itself. To keep a backup in Google Drive, install Google Drive for desktop and choose the folder it keeps on this computer as **Where backups go**. On a Mac that is under `~/Library/CloudStorage/GoogleDrive-` followed by your account, in `My Drive`. On Windows it is the `My Drive` folder on the drive it adds. Each **Back up now** then writes its backup there, and Google Drive for desktop uploads it.

resmon can say it wrote the backup. It cannot see the upload, and it does not say it happened.

## Restoring

**Restore from a backup…** asks for a backup folder and checks it first. It recomputes every hash, compares the database's schema version with this app's, and shows a report. Only if the report is clean can you press **Stage this restore**.

Staging changes nothing yet. The restore runs the next time resmon starts, before anything opens the database. When the window's own engine is the one that will apply it, **Restart resmon now** quits and opens the app again, which is that start. A search running then is stopped. When the background service holds your database, the restore runs when the service next starts, and the page says which start that is. **Cancel it** forgets a staged restore; nothing had been moved.

resmon refuses, with the reason:

- a backup whose files do not match its manifest;
- a backup written by a newer resmon than the one you are running (update first; an older resmon cannot read a newer database);
- a Library folder that belongs to a different Library, because resmon will not overwrite someone else's retained files.

If your database has references to rows that are not there, the backup still runs and records them. The report lists the count and asks you to tick **Restore it with its (N) references to a missing row** before the restore can be staged. The count is of references, because that is what SQLite's own check reports.

The Library goes back where the backup's database recorded it. A Library already there is moved aside, not deleted. The database being replaced is also set aside, in an undo copy, and nothing removes the undo copy on its own. After a restore, the page says what was kept and where. **Delete what the last restore replaced** removes it, after a warning that it is the only copy of what was there and the last way back.

After a restore, a one-time card lists the credentials the backup recorded and this computer does not have, by name, until you press **Got it**. Webhook secrets are bound to a destination's row, so a destination that came back under a different id has no secret until you set one.
