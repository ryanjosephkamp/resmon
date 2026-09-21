#!/usr/bin/env python3
"""Build the committed schema-21 corpus fixture by driving resmon v2.3.0's own code.

The v2.2.0 fixture's successor, made under the standing rule in
`docs/release-verification.md`: every release that ships a schema leaves behind
a corpus its own code wrote, so the *next* release can prove that a database a
released resmon actually produced survives whatever migrations it ships.

v2.3.0 is the release that took a v2.2.0 user across three schema steps at once
(18 -> 21: interrupted executions and their ownership columns at 19, one run per
routine and the missed-fire record at 20, delivery targets and deliveries at
21). Nothing migrates past 21, so the walk this fixture serves today is
21 -> 21: one `init_db` over it must change nothing at all.

Usage
-----

    python generate_corpus.py --source-tree /path/to/a/v2.3.0/checkout \\
                              --out corpus_schema_21.sql

    python generate_corpus.py --source-tree ... --check     # regenerate and diff

``--source-tree`` is the root of a checkout whose ``SCHEMA_VERSION`` is 21 and
whose ``APP_VERSION`` is 2.3.0 -- normally a disposable ``git worktree``. The
script refuses anything else, and refuses to import an ``implementation_scripts``
that is already loaded from somewhere else, because the one failure this whole
fixture exists to prevent is generating it from the current code by accident.

The tag this fixture belongs to did not exist when it was first generated
-------------------------------------------------------------------------

v2.2.0's fixture was generated after its tag, from its tag. This one could not
be at first: `test_the_release_that_shipped_this_schema_left_a_fixture` fails on
the commit that bumps ``APP_VERSION``, which is inside the release PR, and the
tag is only cut once that PR has merged. So the first commit of this fixture was
generated from the **release branch head** -- the same schema-21 code the tag
would carry, since the squash commit changes no line the dump depends on -- and
the header named that commit and said so.

The post-tag follow-up regenerated the dump from a disposable worktree of tag
``v2.3.0``, which replaced that hash and moved nothing else, and added v2.3.0 to
CI's tag-fetch loop with ``RESMON_REQUIRE_V230_TAG``. So
`test_the_committed_fixture_is_what_that_releases_own_code_produces` no longer
skips for v2.3.0 in CI: a missing tag there is a failure, and so is a fixture
that has drifted from what the tag's code writes.

Relationship to `fixtures/v2.2.0/generate_corpus.py`
---------------------------------------------------

This file is a **copy** of that one, extended. The two do not share helpers for
the same reason v2.2.0 did not share with v2.1.0: sharing would mean editing an
older generator, and the fixture an older generator writes is the one kind of
file in this repository that must not move. A copy that can be diffed against
its ancestor is the cheaper honesty. `git diff --no-index ../v2.2.0/generate_corpus.py
generate_corpus.py` is the review.

What it seeds that the schema-18 fixture could not
--------------------------------------------------

Three tables and six columns arrived between 19 and 21, enumerated from a diff
of a fresh schema-21 `init_db` against the committed schema-18 fixture rather
than from memory:

  * schema 19 rebuilt `executions` with a wider ``status`` CHECK (the fifth
    value, ``interrupted``) and five new columns -- ``owner_pid``,
    ``owner_runtime_id``, ``last_seen_at_utc``, ``interrupted_reason`` and
    ``restarted_from``. Every execution seeded here carries the first three,
    because v2.3.0's own ``insert_execution`` writes them; three carry
    ``interrupted`` with one of the three ``interrupted_reason`` values, and one
    is a restart pointing back at the row it was started from.
  * schema 20 added ``executions.request_id`` with its partial UNIQUE index, and
    `routine_missed_fires`.
  * schema 21 added `routine_delivery_targets` and `deliveries`.

Two enumerated CHECK values are deliberately **absent**, because no code in
v2.3.0 writes them and a corpus v2.3.0's own code wrote therefore cannot hold
them:

  * ``routine_missed_fires.disposition = 'skipped'``. `database.py` says so on
    the DDL itself: the value is in the vocabulary so that a later policy needs
    no migration, and "nothing writes them yet" is the comment beside it.
    ``'recorded'`` and ``'ran_late'`` are both here, written by
    ``record_missed_fire`` and ``mark_missed_fires_ran_late``.
  * ``routines.execution_location = 'cloud'``, for the reason the schema-13
    fixture carries one and this one does not: `insert_routine` refuses the
    value and `init_db` rewrites any survivor, so a row here would be a row
    today's `init_db` rewrites -- which is exactly what would make this
    fixture's no-op walk false.

Every other value of every other enumerated CHECK the schema carries is in this
fixture. `_assert_every_enumerated_check_value_is_seeded` at the end of `build`
is what establishes that, from the schema's own constraints rather than from
this paragraph, and `UNWRITTEN_CHECK_VALUES` is where the two exceptions are
named -- so "not seeded" and "not noticed" cannot look the same.

Reproducibility
---------------

The generator is deterministic modulo the clock, the identifiers **and the
process id**. Three normalisations run after seeding, and all three are
documented on the file:

  * `_freeze_clock_columns` rewrites every clock column. Schema 13's clock
    columns are SQL `datetime('now')` values; the tables added since write
    Python `datetime.now(timezone.utc).isoformat()` into `*_at_utc` columns,
    and `evidence.timestamp` accepts only six-digit UTC offsets, so the two
    families are frozen into their own shapes rather than one. Schema 19's
    `executions.last_seen_at_utc` and schema 21's four delivery timestamps are
    all `*_at_utc` and are found by that name rule without a new entry.
    `_assert_no_live_clock_values` then sweeps for either shape carrying a
    value from this run and fails if one survived.
  * `_freeze_identities` rewrites the UUID4s that Library, Evidence, the
    selected-answer lane, the assistant session store and -- new at schema 19
    and 21 -- `runtime_identity.current_runtime_id()` mint, and the vault's
    absolute `root_path`, to values derived from where they appear.
  * `_freeze_owner_pids` rewrites ``executions.owner_pid`` and
    ``deliveries.owner_pid``. Those are `os.getpid()`, written by
    `insert_execution` and by the delivery queue's claim, and a raw process id
    is both different on every run and a detail of the generating machine.
    `_assert_no_live_owner_pids` then fails if this run's own pid survived
    anywhere.
"""

from __future__ import annotations

import argparse
import datetime as _dt
import hashlib
import json
import os
import re
import sqlite3
import sys
import tempfile
from pathlib import Path

HERE = Path(__file__).resolve().parent
DEFAULT_OUT = HERE / "corpus_schema_21.sql"

# The schema this generator knows how to seed, and the release that ships it. A
# v2.3.0 tree reports exactly these; anything else is the wrong tree and the run
# stops. The version is checked as well as the schema because, unlike every
# fixture before it, this one is generated from a branch rather than from a tag
# -- and a branch that has not yet bumped `APP_VERSION` is a tree whose schema-21
# code is not yet the released schema-21 code.
EXPECTED_SCHEMA_VERSION = 21
EXPECTED_APP_VERSION = "2.3.0"

# Clock columns written explicitly by a v2.3.0 writer rather than by a column
# default, so a scan of ``dflt_value`` alone does not find them:
#   document_lifecycle_checks.checked_at  record_lifecycle_check()
#   execution_ai.ended_at                 finish_ai_lane()
# Every other explicit clock column added since schema 13 is named `*_at_utc`
# and is found by name below -- a rule that keeps finding them as tables are
# added, which a hand list does not.
_EXPLICIT_CLOCK_COLUMNS = {
    ("document_lifecycle_checks", "checked_at"),
    ("execution_ai", "ended_at"),
    # reading_queue.read_at is NULL by default and set by reading_queue's own
    # UPDATE when an entry is marked read -- the sweep below is what found it.
    ("reading_queue", "read_at"),
}

# `2026-02-01 05:00:00` -- SQLite's own `datetime('now')` shape.
_TIMESTAMP_RE = re.compile(r"^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$")
# `2026-02-01T05:00:00.000000+00:00` -- `datetime.now(timezone.utc).isoformat()`,
# which `evidence.timestamp` requires at exactly six-digit precision.
_ISO_RE = re.compile(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?\+00:00$")
_UUID_RE = re.compile(
    r"\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b")

# Where the vault's absolute path is rewritten to. `library.vault_row` requires
# the directory's basename to be `resmon-library-<vault_id>`, so the fixture
# keeps that relationship rather than blanking the column.
_VAULT_PARENT = "/does/not/exist/library"


# ---------------------------------------------------------------------------
# Loading v2.3.0's code
# ---------------------------------------------------------------------------


def load_v230(source_tree: Path):
    """Import v2.3.0's backend modules from ``source_tree`` and sanity-check them."""
    already = sorted(n for n in sys.modules if n.split(".")[0] == "implementation_scripts")
    if already:
        raise RuntimeError(
            "implementation_scripts is already imported from "
            f"{sys.modules[already[0]].__file__!r}. This generator must load "
            "v2.3.0's copy and nothing else; run it in a fresh interpreter."
        )
    scripts = (source_tree / "resmon_scripts").resolve()
    if not scripts.is_dir():
        raise SystemExit(f"{scripts} is not a directory -- is --source-tree a resmon checkout?")
    sys.path.insert(0, str(scripts))

    from implementation_scripts import (assistant_choices, assistant_store, config,
                                        database, delivery, evidence, evidence_reader,
                                        library, reading_queue, watch_profiles)

    if database.SCHEMA_VERSION != EXPECTED_SCHEMA_VERSION:
        raise SystemExit(
            f"{scripts} reports SCHEMA_VERSION = {database.SCHEMA_VERSION}, "
            f"expected {EXPECTED_SCHEMA_VERSION}. Point --source-tree at a "
            "v2.3.0 checkout."
        )
    if config.APP_VERSION != EXPECTED_APP_VERSION:
        raise SystemExit(
            f"{scripts} reports APP_VERSION = {config.APP_VERSION}, expected "
            f"{EXPECTED_APP_VERSION}. A tree at schema 21 that has not bumped "
            "the version is the release branch before its first commit, not the "
            "release."
        )
    if not str(Path(database.__file__).resolve()).startswith(str(scripts)):
        raise SystemExit(
            f"database was imported from {database.__file__}, not from {scripts}."
        )
    return _Modules(database=database, watch_profiles=watch_profiles,
                    assistant_store=assistant_store, assistant_choices=assistant_choices,
                    reading_queue=reading_queue, library=library, evidence=evidence,
                    evidence_reader=evidence_reader, delivery=delivery)


class _Modules:
    """v2.3.0's writers, held together so `seed` takes one argument, not nine."""

    def __init__(self, **modules):
        self.__dict__.update(modules)


# ---------------------------------------------------------------------------
# The rows
# ---------------------------------------------------------------------------

# Synthetic throughout. Nothing here is read from, copied from or derived from
# any real corpus: the fixture ships in a public repository.
#
# The rows are chosen to be awkward on purpose -- a migration that rebuilds a
# table is most likely to lose exactly these:
#   * non-Latin and combining-character author and title text (a rebuild that
#     round-trips through a non-UTF-8 assumption mangles them),
#   * NULLs in every column v2.3.0 allows one in (a rebuild with a NOT NULL
#     default silently fills them),
#   * one paper seen by two sources under different external ids (dedup and
#     the cross-source counters read this pair),
#   * an execution where one source failed and another was skipped for a
#     missing key (the zero-reason channel),
#   * one row at every value of every CHECK-constrained column, so the
#     upgraded database's CHECKs are exercised against data that exists rather
#     than against data the test invents.

DOCUMENTS = [
    # (source_repository, external_id, doi, title, authors, abstract,
    #  publication_date, url, categories, metadata_hash)
    ("arxiv", "2401.00001", "10.48550/arXiv.2401.00001",
     "Diffusion models for turbulent flow reconstruction",
     "Ada Lovelace, Alan Turing, Grace Hopper",
     "A study of diffusion models applied to turbulence.",
     "2026-01-15", "https://example.org/arxiv/2401.00001", "cs.LG, physics.flu-dyn",
     "hash-arxiv-0001"),
    # The same paper, from a second source, under that source's own id. The
    # cross-source dedup counters are computed from pairs exactly like this.
    ("openalex", "W4391000001", "10.48550/arXiv.2401.00001",
     "Diffusion models for turbulent flow reconstruction",
     "Ada Lovelace, Alan Turing, Grace Hopper",
     "A study of diffusion models applied to turbulence.",
     "2026-01-15", "https://example.org/openalex/W4391000001", "cs.LG",
     "hash-arxiv-0001"),
    # Non-Latin script in title and authors, and an affiliation that carries a
    # comma -- the comma is why schema 13 added structured authors at all.
    ("pubmed", "39000001", "10.1000/pubmed.39000001",
     "タンパク質折りたたみの速度論",
     "山田 太郎, Ana María Ñúñez-Olivér, Дмитрий Иванов",
     "折りたたみ速度の測定。",
     "2025-11-02", "https://example.org/pubmed/39000001", "q-bio.BM",
     "hash-pubmed-0001"),
    # Combining characters that are not in NFC: a naive round-trip normalises
    # them and the stored string stops matching what the source sent.
    ("crossref", "10.1000/xyz123", "10.1000/xyz123",
     "Ångström-scale imaging of catalytic surfaces",
     "José González, Björn Östergaard",
     None,  # the source gave no abstract; NULL, not an empty string
     "2024-06-30", "https://example.org/doi/10.1000/xyz123", "cond-mat.mtrl-sci",
     "hash-crossref-0001"),
    # Every nullable column at once. v2.3.0 accepts this row; a migration that
    # rebuilds documents with a NOT NULL default would quietly change it.
    ("zenodo", "10012345", None,
     "Dataset: soil moisture readings, uncurated",
     None, None, None, None, None,
     "hash-zenodo-0001"),
    ("doaj", "article-0001", "10.1000/doaj.0001",
     "Open access publishing in the global south",
     "Chimamanda Okeke, Ngũgĩ wa Thiong'o",
     "A survey of open access mandates.",
     "2023-03-14", "https://example.org/doaj/article-0001", "soc",
     "hash-doaj-0001"),
    ("europepmc", "PMC9000001", None,
     "Retraction-prone preprints: a cohort study",
     "Grace Hopper",
     "A cohort study of preprints later retracted.",
     "2022-08-01", "https://example.org/europepmc/PMC9000001", "q-bio.OT, stat.AP",
     "hash-europepmc-0001"),
    ("semantic_scholar", "corpusid:1751762", "10.1000/s2.1751762",
     "Attention over sparse graphs",
     "Ada Lovelace",
     "Sparse attention for graph learning.",
     "2026-02-20", "https://example.org/s2/1751762", "cs.LG",
     "hash-s2-0001"),
    ("biorxiv", "2025.04.01.000001", "10.1101/2025.04.01.000001",
     "A quote in the title: \"folding\" revisited, and a semicolon; too",
     "O'Neill, Seán; D'Arcy, Máire",
     "Punctuation that a naive SQL literal would break.",
     "2025-04-01", "https://example.org/biorxiv/2025.04.01.000001", "q-bio.BM",
     "hash-biorxiv-0001"),
    ("inspire_hep", "2700001", None,
     "Constraints on axion-like particles",
     "Lise Meitner, Chien-Shiung Wu",
     None,  # abstract withheld on licence grounds -- indexed without one
     "2021-12-25", "https://example.org/inspire/2700001", "hep-ex",
     "hash-inspire-0001"),
    ("dryad", "doi:10.5061/dryad.0001", "10.5061/dryad.0001",
     "Supporting data for: axion constraints",
     "Lise Meitner",
     "Raw counts.",
     None,  # undated: the row pagination used to lose
     "https://example.org/dryad/0001", None,
     "hash-dryad-0001"),
    ("osf", "preprint-0001", None,
     "Preregistration and the replication rate",
     "Barbara McClintock, 山田 花子",
     "Preregistered studies replicate more often.",
     "2020-05-05", "https://example.org/osf/preprint-0001", "psy, stat.AP",
     "hash-osf-0001"),
]

# Author rows with identifiers, keyed by external_id. Schema 13's whole point:
# an ORCID that a source actually supplied, and NULL everywhere it did not.
# NULL means "the source did not say", never "this person has no ORCID".
STRUCTURED_AUTHORS = {
    "2401.00001": [
        ("Ada Lovelace", "0000-0002-1825-0097", "Analytical Engine Group, London", "arxiv:1"),
        ("Alan Turing", None, "National Physical Laboratory", None),
        ("Grace Hopper", None, None, None),
    ],
    "39000001": [
        ("山田 太郎", "0000-0001-5109-3700", "東京大学, 理学部", "pubmed:11"),
        ("Ana María Ñúñez-Olivér", None, "Universidad de Chile", "pubmed:12"),
        ("Дмитрий Иванов", None, None, None),
    ],
}

# The three media types `library.MEDIA` admits, one file each. The PDF carries
# the `%PDF-` envelope `library.Import.finish` insists on and nothing more: no
# page tree, because nothing in the upgrade walk renders it and a fixture is
# not the place for a binary nobody can review.
LIBRARY_FILES = [
    ("turbulence-notes.txt", b"Reading notes on turbulence closures.\nLine two.\n"),
    ("axion-summary.md", "# Axion constraints\n\n*Meitner and Wu*, 2021 — 主要な結果。\n".encode()),
    ("supporting-data.pdf", b"%PDF-1.7\n% a synthetic envelope, not a renderable document\n"),
]


def seed(m, conn, vault_parent: Path) -> None:
    """Fill a fresh schema-21 database through v2.3.0's own write functions.

    Where v2.3.0 has no writer a generator can reach -- the selected-answer
    lane runs a real assistant process and cannot be driven from here -- the
    SQL is the statement its owning module issues, and a comment says which
    module that is. The point of the exercise is that every row passes
    v2.3.0's own constraints and lands in v2.3.0's own column layout, not that
    it travelled through a Python function on the way.
    """
    database = m.database
    delivery = m.delivery

    # --- settings -----------------------------------------------------------
    for key, value in [
        ("email_enabled", "0"),
        ("email_address", "someone@example.org"),
        ("ai_provider", "anthropic"),
        ("default_max_results", "50"),
        ("theme", "dark"),
        # A value with a newline and a quote in it, because app_settings is
        # free text and a migration that rebuilds it must not re-escape.
        ("export_footer", "Compiled by resmon.\nDon't edit by hand."),
        # Schema 15 reads these three when a conversation is bound without an
        # explicit choice: they are what makes a `settings_default` basis real
        # rather than a value the generator asserted.
        ("assistant_runtime", "claude_cli"),
        ("assistant_model", "claude-sonnet-4-5"),
        ("assistant_effort", "high"),
    ]:
        database.set_setting(conn, key, value)

    # --- documents and their facets ----------------------------------------
    doc_ids: dict[str, int] = {}
    for row in DOCUMENTS:
        doc = dict(zip(
            ("source_repository", "external_id", "doi", "title", "authors",
             "abstract", "publication_date", "url", "categories", "metadata_hash"),
            row,
        ))
        structured = STRUCTURED_AUTHORS.get(doc["external_id"])
        if structured:
            # v2.3.0's index_document_facets takes api_base.Author objects. A
            # tiny stand-in with the same three attributes keeps the generator
            # from importing the HTTP stack just to build a name.
            doc["structured_authors"] = [_Author(*a) for a in structured]
        doc_id = database.insert_document(conn, doc)
        assert doc_id, f"v2.3.0 refused the document {doc['external_id']}"
        doc_ids[doc["external_id"]] = doc_id

    # A re-insert of a document already present: INSERT OR IGNORE, no new row.
    # The fixture records the state a re-sweep leaves, which is the common case.
    again = dict(zip(
        ("source_repository", "external_id", "doi", "title", "authors",
         "abstract", "publication_date", "url", "categories", "metadata_hash"),
        DOCUMENTS[0],
    ))
    assert database.insert_document(conn, again) is None

    # --- saved configurations ----------------------------------------------
    # One at each value of saved_configurations.config_type.
    config_ids = {}
    for name, config_type, params in [
        ("Weekly turbulence dive", "manual_dive",
         json.dumps({"keywords": "diffusion turbulence", "sources": ["arxiv"]})),
        ("Broad sweep", "manual_sweep",
         json.dumps({"keywords": "protein folding", "sources": ["pubmed", "europepmc"]})),
        ("Nightly routine config", "routine",
         json.dumps({"keywords": "axion", "sources": ["inspire_hep"]})),
    ]:
        config_ids[config_type] = database.insert_configuration(
            conn, {"name": name, "config_type": config_type, "parameters": params})

    # --- routines -----------------------------------------------------------
    # The schema-13 fixture also carries a routine at execution_location =
    # 'cloud', written the way 2.0 wrote it, to keep `init_db`'s rewrite under
    # test. It is absent here on purpose: v2.3.0's own `insert_routine` refuses
    # that value and its own `init_db` rewrites any survivor, so a corpus
    # v2.3.0 wrote cannot hold one -- and a row today's `init_db` would rewrite
    # is precisely what would make this fixture's no-op walk false.
    routine_ids = []
    for name, cron, params, intent, active in [
        ("Turbulence watch", "0 7 * * 1",
         json.dumps({"keywords": "diffusion turbulence", "sources": ["arxiv", "openalex"]}),
         "Anything new on learned turbulence closures.", 1),
        ("Retraction watch", "0 8 * * *",
         json.dumps({"keywords": "retraction", "sources": ["europepmc"]}),
         None, 1),   # intent NULL: the user never wrote one
        ("Dormant sweep", "30 3 1 * *",
         json.dumps({"keywords": "soil moisture", "sources": ["zenodo", "dryad"]}),
         "Datasets only.", 0),
    ]:
        routine_ids.append(database.insert_routine(conn, {
            "name": name, "schedule_cron": cron, "parameters": params,
            "intent": intent, "is_active": active, "email_enabled": 1 - active,
            "ai_enabled": active, "notify_on_complete": 1,
            "ai_settings": json.dumps({"lanes": ["subscription"]}) if active else None,
            "storage_settings": None,
        }))
    # Delete one so sqlite_sequence.seq runs ahead of max(id). An AUTOINCREMENT
    # sequence that a migration's table rebuild resets would hand the next
    # routine an id that a deleted one already used, and nothing about the row
    # counts would show it.
    database.delete_routine(conn, routine_ids.pop())

    # --- executions ---------------------------------------------------------
    # One at each value of executions.execution_type x a spread of statuses.
    exec_ids = {}
    plan = [
        ("deep_dive", "completed", routine_ids[0]),
        ("deep_sweep", "failed", None),
        ("automated_sweep", "completed", routine_ids[1]),
        ("deep_dive", "cancelled", None),
        ("deep_sweep", "running", None),
    ]
    for i, (kind, status, routine_id) in enumerate(plan):
        exec_id = database.insert_execution(conn, {
            "execution_type": kind,
            "routine_id": routine_id,
            "saved_configuration_id": config_ids["manual_dive"] if i == 0 else None,
            "parameters": json.dumps({"keywords": "diffusion", "index": i}),
            "start_time": f"2026-02-{i + 1:02d}T06:00:00",
        })
        exec_ids[(kind, status)] = exec_id
        if status == "running":
            database.update_current_stage(conn, exec_id, "querying sources")
            continue
        database.update_execution_status(
            conn, exec_id, status,
            end_time=f"2026-02-{i + 1:02d}T06:12:00",
            result_count=12 + i,
            new_result_count=3 + i,
            log_path=f"/does/not/exist/run-{i}.log",
            result_path=f"/does/not/exist/run-{i}.json",
            error_message="Upstream returned HTTP 503" if status == "failed" else None,
            cancel_reason="user cancelled from the Dashboard" if status == "cancelled" else None,
        )
    database.save_progress_events(conn, exec_ids[("deep_dive", "completed")], [
        {"stage": "search", "source": "arxiv", "count": 9},
        {"stage": "search", "source": "openalex", "count": 3},
        {"stage": "dedup", "removed": 1},
    ])

    # dedup_* have no writer in v2.3.0's database.py -- sweep_engine issues this
    # UPDATE. dedup_cross_source stays NULL on the older run on purpose: "we did
    # not measure it" and "there were none" are different claims.
    conn.execute(
        "UPDATE executions SET dedup_total = ?, dedup_new = ?, dedup_duplicates = ?, "
        "dedup_invalid = ?, dedup_cross_source = ? WHERE id = ?",
        (12, 9, 2, 1, 1, exec_ids[("deep_dive", "completed")]),
    )
    conn.execute(
        "UPDATE executions SET dedup_total = ?, dedup_new = ?, dedup_duplicates = ?, "
        "dedup_invalid = ?, dedup_cross_source = NULL WHERE id = ?",
        (7, 7, 0, 0, exec_ids[("automated_sweep", "completed")]),
    )
    conn.commit()
    database.set_execution_saved_configuration(
        conn, exec_ids[("deep_sweep", "failed")], config_ids["manual_sweep"])

    # --- per-source outcomes: one row at each execution_sources.status --------
    done = exec_ids[("deep_dive", "completed")]
    database.record_execution_source(conn, done, "arxiv", "ok", result_count=9)
    database.record_execution_source(conn, done, "openalex", "ok", result_count=3)
    database.record_execution_source(
        conn, done, "semantic_scholar", "error", result_count=0,
        error_message="HTTP 503 from the upstream",
        zero_reason="upstream_error", zero_detail="503 after 3 retries")
    database.record_execution_source(
        conn, done, "ieee", "skipped_missing_key", result_count=0,
        credential_name="IEEE_API_KEY",
        zero_reason="missing_credential",
        zero_detail="no key configured for this source")
    database.record_execution_source(
        conn, exec_ids[("deep_dive", "cancelled")], "pubmed", "cancelled",
        result_count=0, zero_reason="cancelled", zero_detail="cancelled mid-query")
    database.record_execution_source(
        conn, exec_ids[("automated_sweep", "completed")], "europepmc", "ok",
        result_count=7)

    for external_id, is_new in [("2401.00001", True), ("W4391000001", False),
                                ("corpusid:1751762", True)]:
        database.link_execution_document(conn, done, doc_ids[external_id], is_new)
    database.link_execution_document(
        conn, exec_ids[("automated_sweep", "completed")], doc_ids["PMC9000001"], True)

    # --- AI lanes: one row at each lane_kind and each outcome ----------------
    lanes = [
        (0, "Claude subscription", "subscription", "anthropic", "claude-3-5-sonnet",
         None, "ok", 9, 9, None, None, None),
        (1, "OpenAI key", "api_key", "openai", "gpt-4o-mini", "work-key",
         "partial", 9, 6, "content_filter", 200, "3 abstracts were refused"),
        (2, "Local model", "local", "ollama", "llama3", None,
         "failed", 9, 0, "connection_refused", None, "no local runtime listening"),
        (3, "Spare key", "api_key", "openai", None, "spare-key",
         "skipped", 0, 0, None, None, None),
    ]
    for (idx, label, kind, provider, model, alias, outcome,
         attempted, succeeded, error_kind, http_status, safe_message) in lanes:
        database.start_ai_lane(conn, done, idx, lane_label=label, lane_kind=kind,
                               provider=provider, model=model, credential_alias=alias)
        database.finish_ai_lane(conn, done, idx, outcome=outcome,
                                docs_attempted=attempted, docs_succeeded=succeeded,
                                error_kind=error_kind, http_status=http_status,
                                safe_message=safe_message)
    # A lane left at 'running' -- the fifth outcome value, and a real state: it
    # is what a process killed mid-run leaves behind.
    database.start_ai_lane(conn, exec_ids[("deep_sweep", "running")], 0,
                           lane_label="Claude subscription", lane_kind="subscription",
                           provider="anthropic", model="claude-3-5-sonnet")

    # --- lifecycle: one row at each severity and each check status ----------
    database.record_lifecycle_finding(
        conn, doc_ids["PMC9000001"], kind="retraction", severity="critical",
        notice_key="crossref:10.1000/retraction.1",
        notice_url="https://example.org/notice/retraction-1",
        label="Retracted", notice_doi="10.1000/retraction.1",
        notice_date="2023-01-09",
        detail="Retracted by the publisher.", provider="crossref",
        provider_source="crossref-update-feed")
    database.record_lifecycle_finding(
        conn, doc_ids["PMC9000001"], kind="expression_of_concern", severity="caution",
        notice_key="crossref:10.1000/eoc.1",
        notice_url="https://example.org/notice/eoc-1",
        label="Expression of concern", notice_doi=None, notice_date=None,
        detail=None, provider="crossref", provider_source=None)
    database.record_lifecycle_finding(
        conn, doc_ids["10.1000/xyz123"], kind="correction", severity="informational",
        notice_key="crossref:10.1000/correction.1",
        notice_url="https://example.org/notice/correction-1",
        label="Correction", notice_doi="10.1000/correction.1",
        notice_date="2024-09-01", detail="Figure 2 axis label.",
        provider="crossref", provider_source=None)
    database.record_lifecycle_check(conn, doc_ids["PMC9000001"], status="ok",
                                    providers=["crossref", "europepmc"])
    database.record_lifecycle_check(conn, doc_ids["10012345"], status="no_identifier",
                                    providers=[])
    database.record_lifecycle_check(conn, doc_ids["2700001"], status="error",
                                    providers=["crossref"],
                                    error_message="HTTP 429 from the notice provider")

    # --- watch profiles: one at each kind, plus a group with members --------
    watch_profiles = m.watch_profiles
    person = watch_profiles.create_profile(conn, {
        "kind": "person", "display_name": "Ada Lovelace",
        "names": [{"value": "Ada Lovelace", "script": "Latin"},
                  {"value": "A. Lovelace", "script": "Latin"}],
        "identifiers": {"orcid": {"value": "0000-0002-1825-0097",
                                  "cited": "https://example.org/orcid-page"}},
        "affiliations": ["Analytical Engine Group"],
        "field_hints": ["machine learning"],
        "notes": "Watched since the corpus was started.",
    })
    person_jp = watch_profiles.create_profile(conn, {
        "kind": "person", "display_name": "山田 太郎",
        "names": [{"value": "山田 太郎", "script": "Han"},
                  {"value": "Taro Yamada", "script": "Latin"}],
        "identifiers": {},   # no identifier at all: name-only matching
        "affiliations": ["東京大学"],
        "field_hints": [],
        "notes": None,
    })
    institution = watch_profiles.create_profile(conn, {
        "kind": "institution", "display_name": "National Physical Laboratory",
        "names": [{"value": "National Physical Laboratory", "script": "Latin"}],
        "identifiers": {"ror": {"value": "https://ror.org/02mhbdp94",
                                "cited": "https://example.org/ror-page"}},
        "affiliations": [], "field_hints": [], "notes": None,
    })
    group = watch_profiles.create_profile(conn, {
        "kind": "group", "display_name": "Turbulence reading group",
        "names": [{"value": "Turbulence reading group", "script": "Latin"}],
        "identifiers": {}, "affiliations": [], "field_hints": [], "notes": None,
    })

    # watch_profile_members has no writer in v2.3.0's database.py; the API
    # layer issues this INSERT when a group's membership is saved.
    conn.executemany(
        "INSERT OR IGNORE INTO watch_profile_members (profile_id, member_profile_id) "
        "VALUES (?, ?)",
        [(group["id"], person["id"]), (group["id"], person_jp["id"])],
    )
    # watch_profile_matches is written by sweep_engine. One row at each basis.
    conn.executemany(
        "INSERT OR IGNORE INTO watch_profile_matches "
        "(document_id, profile_id, basis, matched_author, evidence) VALUES (?, ?, ?, ?, ?)",
        [
            (doc_ids["2401.00001"], person["id"], "identifier", "Ada Lovelace",
             json.dumps({"orcid": "0000-0002-1825-0097"})),
            (doc_ids["39000001"], person_jp["id"], "name+affiliation", "山田 太郎",
             json.dumps({"affiliation": "東京大学"})),
            (doc_ids["corpusid:1751762"], person["id"], "name_only", "Ada Lovelace",
             None),
            (doc_ids["2401.00001"], institution["id"], "name+affiliation", "Alan Turing",
             json.dumps({"affiliation": "National Physical Laboratory"})),
        ],
    )
    conn.commit()

    # --- embeddings and near-duplicate links --------------------------------
    # embedding_job writes document_embeddings; near_duplicates writes
    # document_links. Vectors are short and synthetic: the migration walk does
    # not read them, and the point is that the BLOB comes back byte-identical.
    conn.executemany(
        "INSERT OR REPLACE INTO document_embeddings "
        "(document_id, model, dims, vector, fields) VALUES (?, ?, ?, ?, ?)",
        [
            (doc_ids["2401.00001"], "all-MiniLM-L6-v2", 4,
             bytes([0x00, 0x01, 0xFE, 0xFF, 0x10, 0x20, 0x30, 0x40,
                    0x00, 0x00, 0x00, 0x00, 0x7F, 0x80, 0x81, 0x82]),
             "title+abstract"),
            (doc_ids["W4391000001"], "all-MiniLM-L6-v2", 4,
             bytes([0x00, 0x01, 0xFE, 0xFF, 0x10, 0x20, 0x30, 0x41,
                    0x00, 0x00, 0x00, 0x00, 0x7F, 0x80, 0x81, 0x82]),
             "title+abstract"),
            (doc_ids["39000001"], "all-MiniLM-L6-v2", 4,
             bytes(range(16)), "title"),
            # A second model over the same document: the PK is (document_id, model).
            (doc_ids["39000001"], "bge-small-en", 4,
             bytes(range(16, 32)), "title+abstract"),
        ],
    )
    a, b = sorted((doc_ids["2401.00001"], doc_ids["W4391000001"]))
    c, d = sorted((doc_ids["2401.00001"], doc_ids["corpusid:1751762"]))
    conn.executemany(
        "INSERT OR IGNORE INTO document_links "
        "(document_a, document_b, kind, score, method) VALUES (?, ?, ?, ?, ?)",
        [
            (a, b, "near_duplicate", 0.9912109375, "cosine"),
            (a, b, "same_doi", 1.0, "doi"),
            # score NULL: the method does not produce one.
            (c, d, "shared_author", None, "author_overlap"),
        ],
    )
    conn.commit()

    # --- watchdog mutes -----------------------------------------------------
    conn.executemany(
        "INSERT OR IGNORE INTO watchdog_mutes (finding_key, note) VALUES (?, ?)",
        [("source_silent:zenodo", "Known: we stopped watching datasets."),
         ("routine_never_fired:3", None)],
    )

    # --- cloud_sync: one row at each sync_status ----------------------------
    # The Google Drive backup table -- not the deleted microservice.
    conn.executemany(
        "INSERT INTO cloud_sync (provider, account_info, is_linked, "
        "auto_backup_enabled, last_sync_at, sync_status) VALUES (?, ?, ?, ?, ?, ?)",
        [
            ("google_drive", json.dumps({"email": "someone@example.org"}), 1, 1,
             "2026-02-01T05:00:00", "idle"),
            ("google_drive", None, 0, 0, None, "syncing"),
            ("google_drive", None, 0, 0, None, "error"),
        ],
    )
    conn.commit()

    # --- assistant sessions and messages: one at each role ------------------
    assistant_store = m.assistant_store
    session = assistant_store.create_session(
        conn, runtime="claude_cli", cli_session_id="11111111-2222-3333-4444-555555555555",
        model="claude-3-5-sonnet", title="What is new on turbulence?")
    assistant_store.add_message(conn, session, role="system",
                                content="You are resmon's assistant.")
    assistant_store.add_message(conn, session, role="user",
                                content="What is new on turbulence closures?",
                                input_tokens=41)
    assistant_store.add_message(
        conn, session, role="assistant",
        content="Three papers arrived this week — の詳細は以下。",
        tool_calls=[{"name": "search_corpus", "input": {"query": "turbulence"}}],
        tool_results=[{"name": "search_corpus", "count": 3}],
        input_tokens=41, output_tokens=180, cost_usd=0.0123)
    empty_session = assistant_store.create_session(conn, runtime="api_key")
    assert empty_session  # a session with no messages and every optional column NULL

    # ======================================================================
    # Schema 14 -- the reading queue
    # ======================================================================
    # One row at each `reading_queue.status`, through the module's own writers
    # so the compound CHECK tying `read_at` to `status` is satisfied the way
    # the app satisfies it rather than by the generator filling both columns.
    reading_queue = m.reading_queue
    reading_queue.save(conn, doc_ids["2401.00001"])          # to_read, read_at NULL
    reading_queue.save(conn, doc_ids["39000001"])
    reading_queue.set_status(conn, doc_ids["39000001"], "read")
    reading_queue.save(conn, doc_ids["10012345"])
    # Saved and then taken back off the queue: the sequence a user performs,
    # and the state the table is left in has no row at all for that document.
    reading_queue.save(conn, doc_ids["2700001"])
    reading_queue.remove(conn, doc_ids["2700001"])
    conn.commit()

    # ======================================================================
    # Schema 15 -- the assistant's recorded connection, model and effort choice
    # ======================================================================
    # `assistant_session_choices` is one row per session, so covering its five
    # enumerated CHECK columns takes five bound conversations. `resolve` is the
    # only thing that decides a basis, so each row below is a *reachable*
    # combination rather than one the generator asserted: an explicit choice
    # gives `explicit`, an omitted one falls to the settings default, and an
    # API connection reports `not_supported` for effort because that adapter
    # has none.
    choices = m.assistant_choices
    settings = dict(conn.execute("SELECT key, value FROM app_settings"))

    # 1. Everything chosen explicitly, at the lowest effort.
    bound = choices.resolve(settings, {"version": 1, "runtime": "claude_cli",
                                       "provider": "claude_code",
                                       "model": "claude-opus-4-1", "effort": "low"})
    explicit = assistant_store.create_bound_session(conn, bound, "Explicit everything")
    # A turn admitted and answered: `assistant_turn_choices` carries the
    # request as it was made and the assistant message it produced.
    # A continuation is admitted against the *stored* binding, exactly as
    # `resmon.py` does: `admit_turn` compares the row it reads back with what
    # it was handed and refuses anything else, so passing `bound` here would be
    # the generator asserting a shape the app never uses.
    stored = assistant_store.get_choices(conn, explicit)
    admitted = assistant_store.admit_turn(
        conn, explicit, "Summarise the turbulence papers.", stored)
    assistant_store.finish_turn(
        conn, explicit, admitted["user_message_id"],
        content="Two of the three are the same paper under two ids.",
        tool_calls=None, tool_results=None,
        input_tokens=120, output_tokens=64, cost_usd=0.0041)
    # A turn admitted and never answered -- `assistant_message_id` NULL, which
    # is what a process killed mid-answer leaves behind.
    assistant_store.admit_turn(conn, explicit, "And the retractions?", stored)

    # 2. Nothing chosen: both bases fall to the settings defaults seeded above.
    defaulted = choices.resolve(settings)
    assert defaulted["model_basis"] == "settings_default"
    assert defaulted["effort_basis"] == "settings_default"
    assistant_store.create_bound_session(conn, defaulted, "Settings defaults")

    # 3. An explicit choice of *nothing*: the runtime's own defaults, both bases.
    runtime_default = choices.resolve(settings, {"version": 1, "runtime": "claude_cli",
                                                 "provider": "claude_code",
                                                 "model": None, "effort": None})
    assert runtime_default["model_basis"] == "runtime_default"
    assert runtime_default["effort_basis"] == "runtime_default"
    assistant_store.create_bound_session(conn, runtime_default, "Runtime defaults")

    # 4. An API connection: effort is not supported there, and the table's
    #    compound CHECK requires `requested_effort` to be NULL for it.
    api = choices.resolve(settings, {"version": 1, "runtime": "api_key",
                                     "provider": "openai",
                                     "model": "gpt-4o-mini", "effort": None})
    assert api["effort_basis"] == "not_supported" and api["requested_effort"] is None
    assistant_store.create_bound_session(conn, api, "An API connection")

    # 5. A conversation that predates schema 15 and was confirmed on reopening:
    #    `binding_basis = 'legacy_confirmed'`, which only `legacy=True` reaches.
    legacy_session = assistant_store.create_session(
        conn, runtime="claude_cli", model=None, title="From before the choice was recorded")
    assistant_store.add_message(conn, legacy_session, role="user",
                                content="An older question.")
    legacy = choices.resolve(settings, {"version": 1, "runtime": "claude_cli",
                                        "provider": "claude_code",
                                        "model": "claude-sonnet-4-5", "effort": "max"},
                             legacy=True)
    assert legacy["binding_basis"] == "legacy_confirmed"
    assistant_store.admit_turn(conn, legacy_session, "Still the same question?",
                               legacy, legacy=True)

    # The three remaining effort values have no session of their own -- the
    # column is one row per conversation and five conversations is already the
    # whole basis matrix. They are carried in `assistant_turn_choices`, whose
    # `requested_json` is what the app reads back, so every value of
    # `CLAUDE_EFFORT_LEVELS` appears in a row v2.3.0 wrote.
    for effort in ("medium", "high", "xhigh"):
        turn_binding = choices.resolve(settings, {"version": 1, "runtime": "claude_cli",
                                                  "provider": "claude_code",
                                                  "model": "claude-opus-4-1",
                                                  "effort": effort})
        session_id = assistant_store.create_bound_session(
            conn, turn_binding, f"Effort {effort}")
        assistant_store.admit_turn(conn, session_id, f"A question at {effort}.",
                                   assistant_store.get_choices(conn, session_id))
    conn.commit()

    # ======================================================================
    # Schema 16 -- the Library vault and its retained files
    # ======================================================================
    library = m.library
    library.create_vault(conn, str(vault_parent))
    vault_id = library.vault_row(conn)["vault_id"]

    file_rows = {}
    for index, (filename, payload) in enumerate(LIBRARY_FILES):
        # The first file is linked to a corpus document as it is imported; the
        # second is linked afterwards through `add_link`. Both paths write
        # `library_file_documents`, and only one of them is exercised by an
        # import.
        document_id = doc_ids["2401.00001"] if index == 0 else None
        with library.Import(conn, vault_id, filename, document_id=document_id) as upload:
            upload.write(payload)
            result = upload.finish()
        file_rows[filename] = result["file"]
    library.add_link(conn, vault_id, file_rows["axion-summary.md"]["file_id"],
                     doc_ids["2700001"])
    # A second document on the same file: the table's PK is the pair.
    library.add_link(conn, vault_id, file_rows["axion-summary.md"]["file_id"],
                     doc_ids["10.1000/xyz123"])
    conn.commit()

    # ======================================================================
    # Schema 17 -- Evidence projects, their files and their notes
    # ======================================================================
    evidence = m.evidence
    project = evidence.create_project(conn, vault_id, "Turbulence closures")["project"]
    project_id = project["project_id"]
    # A second project holding nothing: an empty collection is a state the user
    # reaches on the first click, and a rebuild that requires a member loses it.
    evidence.create_project(conn, vault_id, "空のプロジェクト")

    def revision() -> int:
        return conn.execute("SELECT revision FROM evidence_projects WHERE project_id=?",
                            (project_id,)).fetchone()[0]

    for filename in ("turbulence-notes.txt", "supporting-data.pdf"):
        row = file_rows[filename]
        evidence.add_file(conn, vault_id, project_id, revision(),
                          row["file_id"], row["version_id"])

    text_file = file_rows["turbulence-notes.txt"]
    # kind = 'note': free text, every anchor column NULL.
    evidence.create_note(conn, vault_id, project_id, revision(),
                         text_file["file_id"], text_file["version_id"],
                         "note", "Compare with the 2021 closure paper — 要確認。")
    # kind = 'passage': the exact-quote basis, computed from the retained bytes
    # through the reader rather than asserted. The compound CHECK requires the
    # offsets, the page hash and the quote length to agree, and
    # `create_note` re-reads the file and refuses a quote that does not match.
    page = m.evidence_reader.read_text(conn, vault_id, project_id, text_file["file_id"],
                                       text_file["version_id"], 1)
    quote = "turbulence closures"
    start = page["text"].index(quote)
    evidence.create_note(
        conn, vault_id, project_id, revision(),
        text_file["file_id"], text_file["version_id"], "passage", "",
        anchor={"page_number": 1,
                "extraction_contract": page["extraction_contract"],
                "page_text_sha256": page["page_text_sha256"],
                "start_codepoint": start,
                "end_codepoint": start + len(quote),
                "quote": quote})
    conn.commit()

    # ======================================================================
    # Schema 18 -- saved selected-evidence answers
    # ======================================================================
    # `evidence_answers` has no writer a generator can reach: the rows are
    # written by `selected_evidence_runtime.Lane`, which admits a preview,
    # starts a real assistant process and publishes events as it streams. The
    # INSERT below is that module's own statement (`Lane.send`, and the
    # `_publish` UPDATEs that follow it), and every row passes v2.3.0's own
    # CHECKs -- including the two compound ones that tie `finished_at_utc` and
    # `result_json` to the state.
    #
    # One row at each of the seven `state` values, both `mode` values and all
    # four `cleanup_state` values.
    answers = [
        # (state, mode, cleanup_state, has_result, partial, error)
        ("admitted", "question", "not_started", False, "", None),
        ("running", "briefing", "pending", False, "Working through the first note", None),
        ("succeeded", "question", "confirmed", True, "", None),
        ("refused", "briefing", "confirmed", True, "", None),
        ("failed", "question", "unknown", False, "", ("runtime_error", "The assistant process exited before answering.")),
        ("cancelled", "briefing", "confirmed", False, "Partial text kept from the cancelled run", None),
        ("interrupted", "question", "unknown", False, "", ("interrupted", "resmon closed while the answer was streaming.")),
    ]
    for index, (state, mode, cleanup, has_result, partial, error) in enumerate(answers):
        request = json.dumps({"version": 1, "mode": mode,
                              "selection": {"note_ids": [index]},
                              "question": "What do these notes establish?"},
                             ensure_ascii=False, sort_keys=True, separators=(",", ":"))
        finished = None if state in ("admitted", "running") else \
            f"2026-03-0{index + 1}T07:30:00.000000+00:00"
        conn.execute(
            "INSERT INTO evidence_answers (answer_id, preview_id, vault_id, project_id, "
            "project_revision, mode, state, request_json, request_sha256, "
            "private_binding_json, private_native_session_id, owner_runtime_id, "
            "partial_text, result_json, reports_json, usage_json, error_code, "
            "error_message, cleanup_state, created_at_utc, started_at_utc, "
            "finished_at_utc) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, "
            "?, ?, ?, ?, ?, ?)",
            (
                _fixed_uuid(200 + index * 3), _fixed_uuid(201 + index * 3),
                vault_id, project_id, revision(), mode, state, request,
                hashlib.sha256(request.encode("utf-8")).hexdigest(),
                json.dumps({"version": 1, "runtime": "claude_cli",
                            "provider": "claude_code",
                            "requested_model": "claude-opus-4-1"},
                           sort_keys=True, separators=(",", ":")),
                _fixed_uuid(202 + index * 3), _fixed_uuid(300),
                partial,
                json.dumps({"text": "Both notes point at the same 2021 result.",
                            "citations": [{"note_index": index}]},
                           ensure_ascii=False, sort_keys=True, separators=(",", ":"))
                if has_result else None,
                json.dumps([{"source": "claude_system_init_model",
                             "model": "claude-opus-4-1"}],
                           sort_keys=True, separators=(",", ":")) if index else "[]",
                json.dumps({"input_tokens": 900 + index, "output_tokens": 120},
                           sort_keys=True, separators=(",", ":")) if has_result else None,
                error[0] if error else None,
                error[1] if error else None,
                cleanup,
                f"2026-03-0{index + 1}T07:00:00.000000+00:00",
                None if state == "admitted" else f"2026-03-0{index + 1}T07:01:00.000000+00:00",
                finished,
            ),
        )
    conn.commit()

    # ======================================================================
    # Schema 19 -- interrupted executions and the four ownership columns
    # ======================================================================
    # Every execution above already carries `owner_pid`, `owner_runtime_id` and
    # `last_seen_at_utc`: v2.3.0's own `insert_execution` writes all three on
    # every row, which is the point of the column set -- a row with no owner is
    # a row the next start cannot reason about. What the rows above do not
    # carry is the fifth `status` value and the reason beside it.
    #
    # `interrupted` is the word schema 19 added for a run that was neither
    # observed to fail nor still running: the backend was stopped under it.
    # `interrupted_reason` carries how resmon found out, and its CHECK
    # enumerates exactly three values, so there are three rows here.
    interrupted_ids = {}
    for offset, reason in enumerate(database.INTERRUPTED_REASONS):
        exec_id = database.insert_execution(conn, {
            "execution_type": "automated_sweep",
            "routine_id": routine_ids[1],
            "parameters": json.dumps({"keywords": "retraction", "reason": reason}),
            "start_time": f"2026-02-1{offset}T04:00:00",
        })
        database.update_execution_status(
            conn, exec_id, "interrupted",
            end_time=f"2026-02-1{offset}T04:05:00",
            result_count=0,
            interrupted_reason=reason,
        )
        interrupted_ids[reason] = exec_id

    # A restart: a new run started from one of those, with `restarted_from`
    # pointing back at it. The source row is never edited -- the history stays
    # as it happened -- so the pair is what a rebuild of `executions` has to
    # bring across, and a self-referencing foreign key is exactly the shape a
    # table rebuild is most likely to leave dangling.
    restart_id = database.insert_execution(conn, {
        "execution_type": "automated_sweep",
        "routine_id": routine_ids[1],
        "parameters": json.dumps({"keywords": "retraction", "restart": True}),
        "start_time": "2026-02-13T04:30:00",
        "restarted_from": interrupted_ids["owner_dead"],
    })
    database.update_execution_status(
        conn, restart_id, "completed",
        end_time="2026-02-13T04:41:00", result_count=4, new_result_count=1)

    # One execution deleted, so `sqlite_sequence.executions` runs ahead of
    # max(id) -- the same reason the routines section above deletes a routine,
    # and now needed for this table too. Schema 19 *rebuilds* `executions`, and
    # a rebuild is the one migration shape that resets an AUTOINCREMENT mark
    # while leaving every row count perfectly intact; reusing an id would hand a
    # deleted run's `execution_documents` to a new one. Neither released fixture
    # before this carried such a row, so a walk over them could not tell a
    # preserved mark from a reset one -- established by removing the
    # restoration from `_migrate_executions_interrupted` and watching the whole
    # cumulative file stay green.
    #
    # The DELETE is `resmon.py`'s own statement (the Results page's delete
    # button); `database.py` has no `delete_execution`.
    doomed = database.insert_execution(conn, {
        "execution_type": "deep_dive",
        "parameters": json.dumps({"keywords": "deleted before the dump"}),
        "start_time": "2026-02-14T05:00:00",
    })
    conn.execute("DELETE FROM executions WHERE id = ?", (int(doomed),))
    conn.commit()
    highest = conn.execute("SELECT MAX(id) FROM executions").fetchone()[0]
    mark = conn.execute(
        "SELECT seq FROM sqlite_sequence WHERE name='executions'").fetchone()[0]
    if not mark > highest:
        raise RuntimeError(
            f"executions sequence is {mark} and the highest id is {highest}; the "
            "fixture would not be able to tell a preserved mark from a reset one")

    # ======================================================================
    # Schema 20 -- one run per submission, and the missed-fire record
    # ======================================================================
    # `executions.request_id` has no writer in database.py: `resmon.py` reserves
    # it with the UPDATE below (`_reserve_request_id`), and the partial UNIQUE
    # index is what makes "one run per submission" a fact the database enforces
    # rather than a check the application hoped it won because it looked first.
    # One row carries an id and every other row leaves it NULL, which is the
    # state the partial index exists for -- a plain UNIQUE would refuse the
    # second NULL in some dialects, and a rebuild that writes one would break
    # every run that was not submitted with an idempotency key.
    conn.execute("UPDATE executions SET request_id = ? WHERE id = ?",
                 ("11111111-2222-4333-8444-555555555555", restart_id))
    conn.commit()

    # `routine_missed_fires`: one row per scheduled fire whose time had already
    # passed when resmon next started. Written through the module's own
    # writers, so the idempotence on (routine_id, due_at_utc) and the
    # disposition transition are both the app's and not the generator's.
    #
    # `disposition = 'skipped'` is deliberately absent. It is in the CHECK's
    # vocabulary so that a later policy needs no migration, and database.py
    # says on the DDL itself that nothing writes it yet -- so a corpus v2.3.0's
    # own code wrote cannot contain one, and inventing a row here would make
    # this fixture claim a state the release cannot produce.
    for day in (5, 6):
        database.record_missed_fire(
            conn, routine_ids[0], f"2026-02-0{day}T07:00:00+00:00",
            observed_at_utc=f"2026-02-0{day}T09:12:00+00:00")
    # The user ran the routine by hand afterwards: both rows above become
    # 'ran_late', which is the only other value anything writes.
    moved = database.mark_missed_fires_ran_late(conn, routine_ids[0])
    if moved != 2:
        raise RuntimeError(f"expected 2 missed fires to move to ran_late, moved {moved}")
    # And one that has not been dispositioned, on the other routine.
    database.record_missed_fire(
        conn, routine_ids[1], "2026-02-07T08:00:00+00:00",
        observed_at_utc="2026-02-07T10:30:00+00:00")

    # ======================================================================
    # Schema 21 -- delivery targets and the delivery record
    # ======================================================================
    # `routine_delivery_targets`: one target at each of the four channels
    # `delivery.SHIPPED_CHANNELS` names, both `mode` values, and both values of
    # `enabled`. `add_target` is the app's own writer and validates the
    # destination, so the webhook URL below is one resmon would actually accept
    # and the folder and feed destinations are paths that cannot exist on any
    # machine -- a fixture that shipped a real directory would publish the
    # generating machine's layout.
    targets = {}
    for routine_index, channel, destination, mode, enabled in [
        (0, "email", "", "automatic", True),
        (0, "folder", "/does/not/exist/reports", "automatic", True),
        (0, "webhook", "https://example.org/resmon-receiver", "review", True),
        (0, "feed", "/does/not/exist/feeds", "automatic", False),
        (1, "feed", "/does/not/exist/feeds/retractions", "automatic", True),
        (1, "folder", "/does/not/exist/reports/retractions", "review", True),
        (1, "webhook", "http://127.0.0.1:9099/hook", "automatic", True),
    ]:
        targets[(routine_index, channel)] = delivery.add_target(
            conn, routine_ids[routine_index], channel=channel, target=destination,
            mode=mode, enabled=enabled)

    # `email_enabled` is still the routine-level switch the Routines page
    # toggles, and `enqueue_for_execution` reads it: a routine with it off does
    # not queue its email target at all. Both routines seeded above have it
    # off, so turning it on for the first is what puts an email delivery in the
    # record.
    database.update_routine(conn, routine_ids[0], {"email_enabled": 1})

    # `deliveries`: queued by the app's own `enqueue_for_execution`, one per
    # enabled target, with `awaiting_review` for a target in review mode and
    # `queued` for the rest. The disabled feed target is not queued, which is
    # what disabling one means.
    done_exec = database.get_execution_by_id(conn, exec_ids[("deep_dive", "completed")])
    queued_first = delivery.enqueue_for_execution(
        conn, done_exec, database.get_routine_by_id(conn, routine_ids[0]))
    if len(queued_first) != 3:
        raise RuntimeError(
            f"expected 3 deliveries for the first routine, queued {len(queued_first)}")
    swept_exec = database.get_execution_by_id(conn, exec_ids[("automated_sweep", "completed")])
    queued_second = delivery.enqueue_for_execution(
        conn, swept_exec, database.get_routine_by_id(conn, routine_ids[1]))
    if len(queued_second) != 3:
        raise RuntimeError(
            f"expected 3 deliveries for the second routine, queued {len(queued_second)}")

    # The remaining four `state` values are reached the way the drain reaches
    # them. `DeliveryQueue` cannot be driven here -- delivering a report means
    # sending mail, writing into a folder and POSTing to a receiver -- so these
    # are that class's own statements, exactly as the schema-18 section above
    # uses `selected_evidence_runtime.Lane`'s. Each is copied from the method
    # named beside it.
    by_channel = {
        (row["target_id"], row["channel"]): row["id"]
        for row in delivery.list_deliveries_for_execution(conn, done_exec["id"])
    }
    email_delivery = by_channel[(targets[(0, "email")], "email")]
    folder_delivery = by_channel[(targets[(0, "folder")], "folder")]

    # `DeliveryQueue._claim` then `_deliver`'s success branch: claimed, sent,
    # owner released. `artifact_sha256` is `report_sha256(execution)` on a run
    # with no report file, which is a fixed synthetic digest here.
    conn.execute(
        "UPDATE deliveries SET state = 'delivering', attempts = attempts + 1, "
        "owner_pid = ?, owner_runtime_id = ? WHERE id = ? AND state = ?",
        (os.getpid(), "00000000-0000-4000-8000-000000000999", email_delivery, "queued"))
    conn.execute(
        "UPDATE deliveries SET state = 'delivered', delivered_at_utc = ?, "
        "next_attempt_at_utc = NULL, last_error = NULL, artifact_sha256 = ?, "
        "owner_pid = NULL, owner_runtime_id = NULL WHERE id = ?",
        ("2026-03-01T09:00:00.000000+00:00", "b" * 64, email_delivery))

    # `_claim` then `_record_failure`: one attempt made, a reason kept visible
    # and a backoff time to try again at. The error text is one `_scrub` would
    # leave alone -- it names no address, no URL and no path.
    conn.execute(
        "UPDATE deliveries SET state = 'delivering', attempts = attempts + 1, "
        "owner_pid = ?, owner_runtime_id = ? WHERE id = ? AND state = ?",
        (os.getpid(), "00000000-0000-4000-8000-000000000998", folder_delivery, "queued"))
    conn.execute(
        "UPDATE deliveries SET state = 'failed', last_error = ?, "
        "next_attempt_at_utc = ?, owner_pid = NULL, owner_runtime_id = NULL "
        "WHERE id = ?",
        ("The destination folder is not mounted.",
         "2026-03-01T09:01:00.000000+00:00", folder_delivery))
    conn.commit()

    # The second routine's three: one left `queued`, one `skipped` by the user
    # through `delivery.skip`, and one left mid-flight in `delivering` with its
    # owner still recorded -- which is the row `requeue_orphaned` exists for and
    # the one state a table rebuild would most like to lose the owner of.
    second = {
        (row["target_id"], row["channel"]): row["id"]
        for row in delivery.list_deliveries_for_execution(conn, swept_exec["id"])
    }
    if not delivery.skip(conn, second[(targets[(1, "folder")], "folder")]):
        raise RuntimeError("the review-mode folder delivery did not move to skipped")
    conn.execute(
        "UPDATE deliveries SET state = 'delivering', attempts = attempts + 1, "
        "owner_pid = ?, owner_runtime_id = ? WHERE id = ? AND state = ?",
        (os.getpid(), "00000000-0000-4000-8000-000000000997",
         second[(targets[(1, "feed")], "feed")], "queued"))
    conn.commit()


class _Author:
    """The three attributes ``index_document_facets`` reads off an api_base.Author."""

    def __init__(self, name, orcid, affiliation, source_id):
        self.name = name
        self.orcid = orcid
        self.affiliations = [affiliation] if affiliation else []
        self.source_ids = [tuple(source_id.split(":", 1))] if source_id else []


def _fixed_uuid(n: int) -> str:
    """A canonical UUID derived from ``n``.

    `library.identity` and `evidence.identity` require a value that round-trips
    through ``uuid.UUID``, so the placeholders the identity freeze writes -- and
    the ones the hand-written selected-answer rows start from -- have to be
    real UUIDs rather than readable strings.
    """
    return "00000000-0000-4000-8000-{:012d}".format(n)


def _frozen_uuid(n: int) -> str:
    """The replacement a minted UUID is rewritten to.

    A namespace of its own, so a placeholder written by hand above can never
    collide with one the identity freeze hands out.
    """
    return "00000000-0000-4000-8001-{:012d}".format(n)


# ---------------------------------------------------------------------------
# Making the result reproducible
# ---------------------------------------------------------------------------


def clock_columns(conn: sqlite3.Connection) -> list[tuple[str, str, str]]:
    """Every (table, column) whose value comes from the wall clock, and its shape.

    Two families, and they are not interchangeable. Schema 13's columns default
    to SQLite's ``datetime('now')`` and are found by reading the schema. The
    tables added since write Python's ``datetime.now(timezone.utc).isoformat()``
    into columns named ``*_at_utc``; those have no default to read, and
    ``evidence.timestamp`` refuses anything but a six-digit UTC offset, so
    freezing them into the SQL shape would corrupt the very records the fixture
    exists to carry. The name rule keeps finding them as tables are added,
    which a hand list does not.
    """
    found = {(table, column, "sql") for table, column in _EXPLICIT_CLOCK_COLUMNS}
    for (table,) in conn.execute(
        "SELECT name FROM sqlite_master WHERE type='table' AND sql IS NOT NULL"
    ).fetchall():
        if table.startswith("sqlite_") or table.startswith("documents_fts"):
            continue
        for row in conn.execute(f'PRAGMA table_info("{table}")'):
            column, default = row[1], (row[4] or "")
            if column.endswith("_at_utc"):
                found.add((table, column, "iso"))
            elif "datetime('now')" in default.replace('"', "'"):
                found.add((table, column, "sql"))
    return sorted(found)


def _freeze_clock_columns(conn: sqlite3.Connection) -> list[tuple[str, str, str]]:
    """Rewrite clock columns to values derived from the row, not the clock.

    ``WHERE ... IS NOT NULL`` matters: ``execution_ai.ended_at`` is NULL on a
    lane still running and ``evidence_answers.finished_at_utc`` is NULL on one
    still admitted, and both are states this fixture is here to carry.
    """
    frozen = clock_columns(conn)
    for table, column, shape in frozen:
        if shape == "sql":
            value = ("strftime('%Y-%m-%d %H:%M:%S', '2026-02-01 05:00:00', "
                     "'+' || ((rowid * 37) % 2880) || ' minutes')")
        else:
            # The six-digit fraction is the rowid, so two rows of one table
            # never collapse onto the same instant.
            value = ("strftime('%Y-%m-%dT%H:%M:%S', '2026-03-01 07:00:00', "
                     "'+' || ((rowid * 37) % 2880) || ' minutes') || '.' || "
                     "substr('000000' || (rowid % 1000000), -6, 6) || '+00:00'")
        conn.execute(
            f'UPDATE "{table}" SET "{column}" = {value} WHERE "{column}" IS NOT NULL')
    conn.commit()
    return frozen


def _assert_no_live_clock_values(conn: sqlite3.Connection, started: str,
                                 started_iso: str) -> None:
    """Fail if any text value is a timestamp from this run.

    The freeze pass works from the schema and from a column-name rule, so it
    cannot know about a value some writer formatted itself. This sweep is what
    turns that from a silent reproducibility bug -- a fixture that differs on
    every regeneration, which nobody can review -- into a failed generation.
    """
    offenders = []
    for (table,) in conn.execute(
        "SELECT name FROM sqlite_master WHERE type='table' AND sql IS NOT NULL"
    ).fetchall():
        if table.startswith("sqlite_") or table.startswith("documents_fts"):
            continue
        columns = [r[1] for r in conn.execute(f'PRAGMA table_info("{table}")')]
        for row in conn.execute(f'SELECT * FROM "{table}"'):
            for name, value in zip(columns, row):
                if not isinstance(value, str):
                    continue
                if _TIMESTAMP_RE.match(value) and value >= started:
                    offenders.append(f"{table}.{name} = {value!r}")
                elif _ISO_RE.match(value) and value >= started_iso:
                    offenders.append(f"{table}.{name} = {value!r}")
    if offenders:
        raise RuntimeError(
            "These values came from this run's clock and would make the fixture "
            "differ on every regeneration. Add the column to "
            "_EXPLICIT_CLOCK_COLUMNS, or give it an `*_at_utc` name:\n  "
            + "\n  ".join(sorted(set(offenders)))
        )


def _freeze_identities(conn: sqlite3.Connection) -> int:
    """Rewrite every minted UUID to one derived from where it first appears.

    Library, Evidence, the selected-answer lane and the assistant session store
    all mint ``uuid.uuid4()``. Left alone they would make the fixture differ on
    every regeneration, which is the same failure the clock freeze exists to
    prevent -- and `library_vault.root_path` would additionally carry the
    generating machine's directory layout into a public repository.

    The scan order is fixed (table name, then rowid, then column order), so the
    same seed always produces the same mapping. Substitution is textual and
    covers every TEXT column, because these identifiers also travel inside
    JSON and inside `library_files.relative_path`.
    """
    tables = _app_tables(conn)
    mapping: dict[str, str] = {}
    for table in tables:
        columns = [r[1] for r in conn.execute(f'PRAGMA table_info("{table}")')]
        for row in conn.execute(
            'SELECT {} FROM "{}" ORDER BY rowid'.format(
                ", ".join(f'"{c}"' for c in columns), table)
        ):
            for value in row:
                if isinstance(value, str):
                    for found in _UUID_RE.findall(value):
                        mapping.setdefault(found, _frozen_uuid(len(mapping) + 1))

    # These identifiers are foreign keys as well as values -- `evidence_notes`
    # points at `library_files`, which points at `library_vault` -- so a parent
    # cannot be rewritten while the constraint is live. Foreign keys go off for
    # the substitution and `PRAGMA foreign_key_check` afterwards proves the
    # rewrite left no dangling reference, rather than the generator promising it.
    conn.commit()
    conn.execute("PRAGMA foreign_keys=OFF")
    for table in tables:
        columns = [r[1] for r in conn.execute(f'PRAGMA table_info("{table}")')]
        for rowid, *values in conn.execute(
            'SELECT rowid, {} FROM "{}"'.format(
                ", ".join(f'"{c}"' for c in columns), table)
        ).fetchall():
            for column, value in zip(columns, values):
                if not isinstance(value, str):
                    continue
                replaced = _UUID_RE.sub(lambda hit: mapping[hit.group(0)], value)
                if replaced != value:
                    conn.execute(
                        f'UPDATE "{table}" SET "{column}" = ? WHERE rowid = ?',
                        (replaced, rowid))

    # The vault's root is an absolute path on the generating machine.
    # `library.vault_row` refuses a vault whose directory basename is not
    # `resmon-library-<vault_id>`, so the relationship is kept and only the
    # parent is replaced.
    conn.execute(
        "UPDATE library_vault SET root_path = ? || '/resmon-library-' || vault_id",
        (_VAULT_PARENT,))
    conn.commit()
    conn.execute("PRAGMA foreign_keys=ON")
    dangling = conn.execute("PRAGMA foreign_key_check").fetchall()
    if dangling:
        raise RuntimeError(
            f"the identity freeze broke {len(dangling)} foreign key(s): {dangling[:5]}")
    return len(mapping)


def _freeze_owner_pids(conn: sqlite3.Connection) -> list[tuple[str, str]]:
    """Rewrite every ``owner_pid`` to a value derived from the row.

    Schema 19 gave `executions` an ``owner_pid`` and schema 21 gave `deliveries`
    one; both are ``os.getpid()``, written by `insert_execution` and by the
    delivery queue's claim. A raw process id is different on every run -- which
    would make this fixture undiffable, the failure the clock freeze exists to
    prevent -- and it is a detail of the generating machine that has no business
    in a published file. The replacement is a five-digit number derived from the
    rowid, which is still a plausible pid and still not anyone's.

    Found by column name across the whole schema rather than from a list of two
    tables, for the same reason the clock sweep is: the next table to carry an
    owner will be found without anyone remembering this function.
    """
    frozen = []
    for table in _app_tables(conn):
        for row in conn.execute(f'PRAGMA table_info("{table}")'):
            if row[1] != "owner_pid":
                continue
            conn.execute(
                f'UPDATE "{table}" SET "owner_pid" = 10000 + ((rowid * 7) % 50000) '
                f'WHERE "owner_pid" IS NOT NULL')
            frozen.append((table, row[1]))
    conn.commit()
    return sorted(frozen)


def _assert_no_live_owner_pids(conn: sqlite3.Connection, pid: int) -> None:
    """Fail if this run's own process id survived into any column."""
    offenders = []
    for table in _app_tables(conn):
        columns = [r[1] for r in conn.execute(f'PRAGMA table_info("{table}")')]
        for row in conn.execute(f'SELECT * FROM "{table}"'):
            for name, value in zip(columns, row):
                if isinstance(value, int) and not isinstance(value, bool) and value == pid:
                    offenders.append(f"{table}.{name} = {value}")
    if offenders:
        raise RuntimeError(
            "These values are this run's process id and would make the fixture "
            "differ on every regeneration. Give the column an `owner_pid` name, "
            "or freeze it explicitly:\n  " + "\n  ".join(sorted(set(offenders))))


_ENUMERATED_CHECK = re.compile(
    r"CHECK\s*\(\s*\"?(\w+)\"?\s+IN\s*\(([^)]*)\)\s*\)", re.IGNORECASE)

#: Values that are in an enumerated CHECK's vocabulary and that no writer in
#: v2.3.0 produces, with the reason. A corpus this release's own code wrote
#: cannot hold one, so the sweep below expects them to be missing rather than
#: failing on them -- and naming them here is what stops "not seeded" and "not
#: noticed" looking the same.
UNWRITTEN_CHECK_VALUES = {
    ("routine_missed_fires", "disposition", "skipped"):
        "in the vocabulary so a later policy needs no migration; database.py "
        "says on the DDL that nothing writes it yet.",
    ("routines", "execution_location", "cloud"):
        "`insert_routine` and `update_routine` both refuse it and `init_db` "
        "rewrites any survivor to 'local', so no corpus this release wrote can "
        "hold one. The schema-13 fixture carries such a row on purpose, which "
        "is what keeps that rewrite under test; putting one here would instead "
        "make this fixture's no-op walk false.",
}


def _assert_every_enumerated_check_value_is_seeded(conn: sqlite3.Connection) -> int:
    """Every `CHECK(col IN (...))` value either appears in a row, or is excused.

    The claim this fixture makes is that it holds a row at every value of every
    enumerated CHECK the schema carries. That claim was a paragraph in the
    v2.2.0 generator's docstring and nothing checked it, so a value added by a
    migration after the generator was written would have gone unseeded and
    unremarked. The denominator is the schema's own constraints, read back out
    of `sqlite_master`.
    """
    missing = []
    seeded = 0
    for name, sql in conn.execute(
        "SELECT name, sql FROM sqlite_master WHERE type='table' AND sql IS NOT NULL"
    ).fetchall():
        if name.startswith("sqlite_") or name.startswith("documents_fts"):
            continue
        for column, values in _ENUMERATED_CHECK.findall(sql):
            for value in (v.strip().strip("'") for v in values.split(",")):
                present = conn.execute(
                    f'SELECT 1 FROM "{name}" WHERE "{column}" = ? LIMIT 1', (value,)
                ).fetchone()
                if present:
                    seeded += 1
                elif (name, column, value) not in UNWRITTEN_CHECK_VALUES:
                    missing.append(f"{name}.{column} = {value!r}")
    if missing:
        raise RuntimeError(
            "These enumerated CHECK values have no row in the fixture. Seed one "
            "through the writer that produces it, or add it to "
            "UNWRITTEN_CHECK_VALUES with the reason:\n  " + "\n  ".join(sorted(missing)))
    return seeded


def _assert_no_machine_paths(conn: sqlite3.Connection, *needles: str) -> None:
    """Fail if a temporary directory from this run survived into the database.

    The fixture is published. A path that leaks here is both a reproducibility
    bug and something nobody meant to publish, so it stops the generation
    rather than being cleaned up quietly.
    """
    offenders = []
    for table in _app_tables(conn):
        columns = [r[1] for r in conn.execute(f'PRAGMA table_info("{table}")')]
        for row in conn.execute(f'SELECT * FROM "{table}"'):
            for name, value in zip(columns, row):
                if isinstance(value, str) and any(n in value for n in needles if n):
                    offenders.append(f"{table}.{name} = {value!r}")
    if offenders:
        raise RuntimeError(
            "These values name a directory from this run:\n  "
            + "\n  ".join(sorted(set(offenders))))


def _app_tables(conn: sqlite3.Connection) -> list[str]:
    """Application tables: everything SQLite and fts5 did not make for themselves."""
    shadow = fts_shadow_names("documents_fts")
    return sorted(
        r[0] for r in conn.execute(
            "SELECT name FROM sqlite_master WHERE type='table' AND sql IS NOT NULL")
        if r[0] not in shadow and not r[0].startswith("sqlite_")
        and r[0] != "documents_fts"
    )


# ---------------------------------------------------------------------------
# The dump
# ---------------------------------------------------------------------------


def fts_shadow_names(prefix: str) -> set[str]:
    """The tables fts5 creates for itself, derived rather than pattern-matched.

    The reading-queue fixture lost the three ``documents_fts_*`` **triggers**
    the first time, because they were excluded by a name prefix along with the
    shadow tables -- and those triggers are resmon's own DDL and the whole
    reason the search index stays in step with the corpus. Ask fts5 what it
    makes instead of guessing.
    """
    probe = sqlite3.connect(":memory:")
    try:
        before = {r[0] for r in probe.execute("SELECT name FROM sqlite_master")}
        probe.execute("CREATE VIRTUAL TABLE _probe USING fts5(a)")
        after = {r[0] for r in probe.execute("SELECT name FROM sqlite_master")}
        return {name.replace("_probe", prefix) for name in after - before - {"_probe"}}
    finally:
        probe.close()


def _literal(value) -> str:
    if value is None:
        return "NULL"
    if isinstance(value, bool):
        return str(int(value))
    if isinstance(value, int):
        return str(value)
    if isinstance(value, float):
        return repr(value)
    if isinstance(value, bytes):
        return "X'" + value.hex().upper() + "'"
    return "'" + str(value).replace("'", "''") + "'"


def dump(conn: sqlite3.Connection, header: str) -> str:
    """A deterministic, replayable SQL text dump of the application's own objects.

    Order is load-bearing. Every ``CREATE`` comes first, in the order SQLite
    recorded them, so the three FTS triggers exist before the first document is
    inserted and the external-content index is rebuilt by the same triggers
    that filled it here -- the fixture never has to carry an fts5 shadow blob,
    which is not reviewable and not portable across fts5 versions.

    ``sqlite_sequence`` is written at the end rather than left to the inserts:
    a table whose rows were deleted has a sequence ahead of its highest id, and
    preserving that is the only way an upgrade that resets AUTOINCREMENT shows
    up as a difference instead of as nothing at all.
    """
    shadow = fts_shadow_names("documents_fts")
    lines = [header.rstrip("\n"), "", "PRAGMA foreign_keys=OFF;", "BEGIN TRANSACTION;", ""]

    objects = conn.execute(
        "SELECT type, name, sql FROM sqlite_master WHERE sql IS NOT NULL ORDER BY rowid"
    ).fetchall()
    data_tables = []
    for obj_type, name, sql in objects:
        if name in shadow or name.startswith("sqlite_"):
            continue
        lines.append(sql.rstrip().rstrip(";") + ";")
        if obj_type == "table":
            data_tables.append(name)

    lines.append("")
    for table in data_tables:
        if table == "documents_fts":
            continue  # rebuilt by the triggers above from the documents rows
        # table_info omits VIRTUAL generated columns -- documents.pub_sort is
        # one, and naming it in an INSERT is an error.
        columns = [r[1] for r in conn.execute(f'PRAGMA table_info("{table}")')]
        rows = conn.execute(
            'SELECT {} FROM "{}" ORDER BY rowid'.format(
                ", ".join(f'"{c}"' for c in columns), table)
        ).fetchall()
        if not rows:
            continue
        collist = ", ".join(f'"{c}"' for c in columns)
        lines.append(f"-- {table}: {len(rows)} row(s)")
        for row in rows:
            values = ", ".join(_literal(v) for v in row)
            lines.append(f'INSERT INTO "{table}" ({collist}) VALUES ({values});')
        lines.append("")

    sequences = conn.execute(
        "SELECT name, seq FROM sqlite_sequence ORDER BY name").fetchall()
    if sequences:
        lines.append("-- AUTOINCREMENT high-water marks. Restored explicitly because")
        lines.append("-- a deleted row leaves the sequence above the highest surviving id.")
        for name, seq in sequences:
            lines.append(
                f"UPDATE sqlite_sequence SET seq = {int(seq)} "
                f"WHERE name = {_literal(name)};"
            )
        lines.append("")

    lines.append("COMMIT;")
    return "\n".join(lines) + "\n"


HEADER = """\
-- A resmon corpus at schema 21, written by resmon v2.3.0's own code.
--
-- Source: tag v2.3.0, commit {commit}
-- Generated by: fixtures/v2.3.0/generate_corpus.py (committed beside this file)
-- Regenerate:   python generate_corpus.py --source-tree <v2.3.0 checkout>
-- Verify:       python generate_corpus.py --source-tree <v2.3.0 checkout> --check
--
-- The first commit of this file, in the release pull request, was generated
-- from that branch's head rather than from the tag: the test that calls in a
-- schema's fixture debt fails on the commit that bumps APP_VERSION, which is
-- inside the release PR, and the tag is only cut once that PR has merged. The
-- post-tag follow-up regenerated the dump from a disposable worktree of the
-- tag itself and replaced the hash above. Nothing else in the file moved,
-- which is what "the squash commit and the tag carry the same schema-21 code"
-- was worth only once it had been checked. CI now fetches v2.3.0 beside the
-- other released tags and sets RESMON_REQUIRE_V230_TAG, so a drift between
-- this file and the tag's own output fails the Backend jobs rather than
-- skipping past them.
--
-- The standing rule in docs/release-verification.md: every release that ships
-- a schema leaves a corpus its own code wrote, so the next release can prove
-- that a database a *released* resmon produced survives the migrations it
-- ships. v2.3.0 shipped schema 21 and nothing migrates past it yet, so the
-- walk this file serves today is 21 -> 21: one `init_db` over it must change
-- no row, no object and no schema marker. `test_cumulative_upgrade.py`
-- executes this file and checks exactly that, the way a user's first launch
-- after an update does. The same file's 18 -> 21 walk -- the one a v2.2.0 user
-- actually takes -- runs over the v2.2.0 fixture, which is untouched here.
--
-- Everything here is synthetic. No row is read from, copied from or derived
-- from any real corpus.
--
-- What is deliberately not in this file:
--   * the fts5 shadow tables (`documents_fts_{{config,content,data,docsize,idx}}`)
--     and `sqlite_sequence`'s CREATE -- SQLite makes both for itself. The
--     three `documents_fts_insert/_delete/_update` triggers ARE resmon's and
--     are here; they are what repopulates the search index when the documents
--     below are inserted.
--   * live timestamps. Clock columns are rewritten from each row's rowid --
--     in SQLite's `datetime('now')` shape for schema 13's columns and in the
--     six-digit UTC shape `evidence.timestamp` requires for the `*_at_utc`
--     columns added since -- and the generator then fails if any value from
--     the run's own clock survives.
--   * the UUID4s Library, Evidence, the selected-answer lane, the assistant
--     session store and `runtime_identity` mint, and the vault's absolute
--     path. Both are rewritten to values derived from where they appear, so a
--     regeneration can be diffed and no directory from the generating machine
--     is published.
--   * process ids. `executions.owner_pid` and `deliveries.owner_pid` are the
--     generating process's, and are rewritten from each row's rowid.
--   * `routine_missed_fires.disposition = 'skipped'`. The value is in the
--     CHECK's vocabulary and nothing in v2.3.0 writes it, so no corpus this
--     release wrote can hold one.
"""


def build(source_tree: Path, workspace: Path) -> sqlite3.Connection:
    """Create and seed a schema-21 database under ``workspace``. Returns the connection."""
    started = _dt.datetime.now(_dt.timezone.utc)
    started_sql = started.strftime("%Y-%m-%d %H:%M:%S")
    started_iso = started.isoformat()
    m = load_v230(source_tree)
    # `library.directory` walks the path one component at a time with
    # O_NOFOLLOW, and on macOS a temporary directory sits under `/var`, which
    # is a symlink. Hand it the resolved path; the unresolved one is still
    # swept for below, because that is the string that would leak.
    given, workspace = workspace, Path(workspace).resolve()
    db_path = workspace / "corpus.db"
    vault_parent = workspace / "library"
    vault_parent.mkdir()
    m.database.init_db(str(db_path))
    conn = m.database.get_connection(str(db_path))
    seed(m, conn, vault_parent)
    assert m.database.get_schema_version(conn) == EXPECTED_SCHEMA_VERSION
    _freeze_clock_columns(conn)
    _assert_no_live_clock_values(conn, started_sql, started_iso)
    _freeze_identities(conn)
    _freeze_owner_pids(conn)
    _assert_no_live_owner_pids(conn, os.getpid())
    _assert_no_machine_paths(conn, str(workspace), str(given), str(vault_parent))
    _assert_every_enumerated_check_value_is_seeded(conn)
    conn.commit()
    return conn


def _commit_of(source_tree: Path) -> str:
    import subprocess
    try:
        out = subprocess.run(
            ["git", "-C", str(source_tree), "rev-parse", "HEAD"],
            capture_output=True, text=True, check=True)
        return out.stdout.strip()
    except Exception:
        return "unknown (source tree is not a git checkout)"


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--source-tree", required=True, type=Path,
                        help="root of a v2.3.0 checkout (SCHEMA_VERSION 21, APP_VERSION 2.3.0)")
    parser.add_argument("--out", type=Path, default=DEFAULT_OUT)
    parser.add_argument("--check", action="store_true",
                        help="regenerate and diff against --out instead of writing it")
    args = parser.parse_args(argv)

    with tempfile.TemporaryDirectory() as tmp:
        conn = build(args.source_tree, Path(tmp))
        text = dump(conn, HEADER.format(commit=_commit_of(args.source_tree)))
        conn.close()

    if not args.check:
        args.out.write_text(text, encoding="utf-8")
        print(f"wrote {args.out} ({len(text.splitlines())} lines)")
        return 0

    existing = args.out.read_text(encoding="utf-8") if args.out.exists() else ""
    if existing == text:
        print(f"{args.out} matches a fresh generation from {args.source_tree}")
        return 0
    import difflib
    sys.stdout.writelines(difflib.unified_diff(
        existing.splitlines(keepends=True), text.splitlines(keepends=True),
        fromfile=str(args.out), tofile="regenerated"))
    print(f"\n{args.out} does NOT match a fresh generation", file=sys.stderr)
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
