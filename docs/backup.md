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
  "fk_violations_total": 1,      // the uncapped count of unsatisfied references
  "fk_violations_rows": 1,       // how many distinct rows those references come from;
                                 // absent on a bundle written before this field existed
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
"references" for that reason. `fk_violations_rows` is the same references de-duplicated by
`(table, rowid)`, so a manifest can say "2 references, from 1 row" rather than leaving a
reader to divide by an unknown.

Two caveats, both load-bearing:

* `fk_violations_rows` is **absent** on a bundle written before it existed. `manifest_version`
  stays `1`, because the field is additive and everything that reads a manifest treats its
  absence as *not measured* — never as zero. A verify report of such a bundle carries
  `fk_violations_rows: null` and its sentence reads exactly as it did before.
* `PRAGMA foreign_key_check` answers `rowid` **NULL** for a `WITHOUT ROWID` table, and two such
  references cannot be told apart — they may be one row or two. They are counted in
  `fk_violations_total` and deliberately **not** in `fk_violations_rows`, so the row count is a
  count of the rows SQLite identified and never a guess. Where every reference is of that kind,
  `fk_violations_rows` is `0` with a non-zero total and resmon says it cannot count the rows
  rather than printing "from 0 rows". resmon's own schema has no `WITHOUT ROWID` table today,
  so this is a guard rather than a case.

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

   That path names the machine the backup came from, and on another machine it often does
   not exist. Put the directory under any parent you like — the name must stay
   `resmon-library-<vault_id>`, which `library.vault_row` checks — and then rewrite the row
   to match: `UPDATE library_vault SET root_path='<parent>/resmon-library-<vault_id>' WHERE
   singleton=1;`. Do it **after** step 6, so the statement runs against today's schema. In
   the application this is the *Restore the vault somewhere else…* control on the verify
   card; the chosen parent travels in the staged pointer as `vault_parent`, and the restore
   rewrites the row itself, inside the same failure envelope as everything else.

   If a vault directory is already there, move it aside rather than deleting it — that is
   what the application does, into `restore-undo/<stamp>/vault-replaced/` beside the
   database files of the same restore, so one *Delete undo copies* removes both halves and
   a restore that fails after this point puts **both** back. Where the destination held no
   vault at all, the application removes the tree it wrote instead, so a failed restore
   leaves the folder you chose exactly as empty as it found it. A vault on a different
   volume from the state directory is copied rather than renamed, which costs a second copy
   of every retained byte; that is the right trade against deleting the only copy there is.

   There is one case the undo cannot complete by itself: a move between volumes interrupted
   while it was *removing* the original leaves the original incomplete and a whole copy in
   `restore-undo/<stamp>/vault-replaced/`. Putting that copy back automatically would be
   wrong — the other interruption, during the copy, leaves a *partial* copy beside an intact
   original — so resmon keeps it instead of deleting it with the rest of the undo directory,
   names it in `restore-last.json` as `vault_copy_kept`, and leaves it for you to put back by
   hand. **A failed restore can therefore leave an undo copy that Settings → Storage offers
   to delete;** check `restore-last.json` before you delete one.
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
