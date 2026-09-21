# The backup bundle format

For someone restoring a resmon backup by hand, or writing a tool that reads one. The
user-facing account is the *Backup and Restore* section of the README; this is the file
layout and the manifest.

A bundle is an ordinary directory. Nothing is compressed and nothing is encrypted, so
every part of it can be read with the tools already on the machine — which is the point:
a backup you cannot open without the application that wrote it is a hostage, not a backup.

## Layout

```
resmon-backup-<UTC stamp>/      e.g. resmon-backup-20260922T134501Z
├── resmon.db                   the database, snapshotted
├── vault/                      present only when the database has a Library vault
│   ├── vault.json              {"version": 1, "vault_id": "<uuid>"}
│   └── files/<file_id>/<version_id>.<ext>
├── reports/                    present only if the reports checkbox was on
└── manifest.json
```

`resmon.db` is written with `sqlite3.Connection.backup` from the live connection, not
copied. resmon runs SQLite in WAL mode and never checkpoints, so a file copy of
`resmon.db` alone is missing whatever is still in `resmon.db-wal`. The backup API reads
through the WAL and produces one self-contained file; **there are deliberately no
`-wal`/`-shm` files in a bundle**, and a bundle that had them would be suspect.

`vault/` mirrors the vault root exactly, relative path for relative path, including the
`vault.json` marker. Every retained file is re-hashed while it is copied and compared
with the `sha256` in `library_files`; a mismatch aborts the whole backup. The vault
directory's own name is not carried — it is `resmon-library-<vault_id>` by construction,
and the restore rebuilds it from `library_vault.root_path` in the restored database.

## manifest.json

```jsonc
{
  "manifest_version": 1,          // this document describes version 1
  "app_version": "2.2.0",
  "schema_version": 21,           // database schema; a restore into an OLDER app is refused
  "created_at_utc": "2026-09-22T13:45:01.123456+00:00",
  "elapsed_seconds": 4.117,
  "vault_id": "1f8a…" ,           // null when the database has no vault
  "includes_reports": true,
  "table_counts": { "documents": 18243, "executions": 61, … },
  "table_count_denominator": 34,  // how many application tables were counted
  "fk_violations": [             // orphan rows PRAGMA foreign_key_check found, capped at 100
    { "table": "library_file_documents", "rowid": 4, "parent": "documents", "fkid": 0 }
  ],
  "fk_violations_total": 1,      // the uncapped count
  "files": [                      // every file in the bundle except manifest.json itself
    { "path": "resmon.db", "size": 214958080, "sha256": "…" },
    { "path": "vault/vault.json", "size": 61, "sha256": "…" },
    …
  ],
  "excluded": {
    "credentials": ["smtp_password", "openai_api_key", "webhook_secret_3"],
    "process_state": ["daemon.lock", "resmon.port", "api-token-<port>"],
    "state_dir": "/Users/…/Library/Application Support/resmon",
    "note": "…"
  }
}
```

`files[].path` is relative to the bundle root and is what a verifier re-hashes.
`manifest.json` is not in its own list; the pointer a staged restore writes records the
manifest's own SHA-256 separately, so a manifest edited after staging is caught.

`fk_violations` is measured on the bundle's own database, not on the live one. A corpus can
carry a row whose parent is missing — `foreign_key_check` is a check, not a constraint on rows
that already exist — and resmon opens such a database quite happily. The backup records what it
finds and **still writes the bundle**: refusing here is what once left a user with a backup that
verified and could never be restored. Verify reports the rows, and the restore is staged only
when the request carries `accept_fk_violations: true`. The pragma answers **per constraint, not
per row**, so one row with two unsatisfied foreign keys appears twice — `fk_violations_total`
is therefore a count of unsatisfied *references*, not of rows, and resmon's own wording says
"references" for that reason.

**`excluded.credentials` holds names, never values.** No credential value is written into
a bundle under any circumstance. The names are there so that a restore can tell the user
which keyring entries they must re-enter on the machine they restored onto. Webhook
signing secrets are named `webhook_secret_<row id>` after a `routine_delivery_targets`
row, so a target that comes back under a different id has no secret bound to it.

## Restoring by hand

1. Verify first. Recompute the SHA-256 of every file in `manifest.files` and compare.
2. Stop resmon. The database must not be open by any process.
3. Move your current `resmon.db`, `resmon.db-wal` and `resmon.db-shm` somewhere safe.
   Do not delete them until the restore has proved itself.
4. Copy the bundle's `resmon.db` into place.
5. If the bundle has a `vault/`, read `library_vault.root_path` out of the restored
   database and copy `vault/` there, as `resmon-library-<vault_id>`, mode `0700`. Remove
   any `.import.lock`: it has no automatic stale-lock recovery, and one left behind makes
   the vault permanently busy.
6. Start resmon once, or otherwise run the migrations, **before** the statements below. An older
   bundle does not have the tables and columns they name — a v2.2.0-era database has no
   `deliveries` table at all — and running them first is how resmon itself got this wrong.
7. Reset the rows that describe a process that no longer exists. `awaiting_review` deliveries are
   deliberately left alone: they describe a decision the user has not made, not a process.

   ```sql
   UPDATE executions SET status='interrupted', interrupted_reason='unknown',
          owner_pid=NULL, owner_runtime_id=NULL WHERE status='running';
   UPDATE executions SET owner_pid=NULL, owner_runtime_id=NULL;
   UPDATE deliveries SET state='queued', owner_pid=NULL, owner_runtime_id=NULL
          WHERE state='delivering';
   UPDATE deliveries SET owner_pid=NULL, owner_runtime_id=NULL;
   INSERT INTO documents_fts(documents_fts) VALUES ('rebuild');
   ```

   The full-text index is derived and is not rebuilt for you by opening the database.
8. Check `PRAGMA integrity_check`, and `PRAGMA foreign_key_check` against
   `manifest.fk_violations` — rows already listed there were orphaned before the backup and are
   not caused by the restore.
9. Re-enter every credential `manifest.excluded.credentials` names.

The application does all of this for you, in this order, on the start after you stage a
restore in Settings → Storage. Doing it by hand is for the case where you no longer have
an application to ask.
