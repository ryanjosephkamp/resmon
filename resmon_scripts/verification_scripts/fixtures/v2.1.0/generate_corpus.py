#!/usr/bin/env python3
"""Build the committed schema-13 corpus fixture by driving resmon v2.1.0's own code.

Every other upgrade fixture in this directory tree is the schema of the step
just before the one under test. This one is different in two ways, and both
matter for what it is for.

It carries **data**, not just DDL, because v2.2.0 is the first release that
walks a real user's database across five schema steps at once (13 -> 18, 17
PRs). "The tables end up the right shape" was already proven step by step; what
was never proven is that the rows a released resmon wrote survive the whole
walk.

And it is written by **v2.1.0's own code**, out of process, rather than by hand.
The schema-13 migration itself shipped broken on existing corpora because a
hand-reasoned idea of "what an older database looks like" left out a column.
A fixture the old code produced is the only kind that catches that.

Usage
-----

    python generate_corpus.py --source-tree /path/to/a/v2.1.0/checkout \\
                              --out corpus_schema_13.sql

    python generate_corpus.py --source-tree ... --check     # regenerate and diff

``--source-tree`` is the root of a checkout of tag ``v2.1.0`` -- normally a
disposable ``git worktree``. The script refuses to run against anything whose
``SCHEMA_VERSION`` is not 13, and refuses to import an
``implementation_scripts`` that is already loaded from somewhere else, because
the one failure this whole fixture exists to prevent is generating it from the
current code by accident.

Reproducibility
---------------

The generator is deterministic **modulo the clock**. Roughly twenty columns
across the schema default to ``datetime('now')`` or are written with it
explicitly, so a raw dump would differ on every run and the fixture could never
be diffed. After seeding, ``_freeze_clock_columns`` rewrites exactly those
columns to values derived from each row's rowid -- preserving NULL where the
column was NULL, because "not ended" and "ended at some time" are different
facts. ``_assert_no_live_clock_values`` then sweeps every text column in the
database for a timestamp at or after the moment the run started, and fails if
one is left: that is what stops a newly added clock column from silently making
the fixture unreproducible.
"""

from __future__ import annotations

import argparse
import datetime as _dt
import json
import re
import sqlite3
import sys
import tempfile
from pathlib import Path

HERE = Path(__file__).resolve().parent
DEFAULT_OUT = HERE / "corpus_schema_13.sql"

# The schema this generator knows how to seed. A v2.1.0 tree reports exactly
# this; anything else is the wrong tree and the run stops.
EXPECTED_SCHEMA_VERSION = 13

# Clock columns written explicitly by a v2.1.0 writer rather than by a column
# default, so a scan of ``dflt_value`` alone does not find them:
#   document_lifecycle_checks.checked_at  record_lifecycle_check()
#   execution_ai.ended_at                 finish_ai_lane()
_EXPLICIT_CLOCK_COLUMNS = {
    ("document_lifecycle_checks", "checked_at"),
    ("execution_ai", "ended_at"),
}

_TIMESTAMP_RE = re.compile(r"^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$")


# ---------------------------------------------------------------------------
# Loading v2.1.0's code
# ---------------------------------------------------------------------------


def load_v210(source_tree: Path):
    """Import v2.1.0's backend modules from ``source_tree`` and sanity-check them."""
    already = sorted(n for n in sys.modules if n.split(".")[0] == "implementation_scripts")
    if already:
        raise RuntimeError(
            "implementation_scripts is already imported from "
            f"{sys.modules[already[0]].__file__!r}. This generator must load "
            "v2.1.0's copy and nothing else; run it in a fresh interpreter."
        )
    scripts = (source_tree / "resmon_scripts").resolve()
    if not scripts.is_dir():
        raise SystemExit(f"{scripts} is not a directory -- is --source-tree a resmon checkout?")
    sys.path.insert(0, str(scripts))

    from implementation_scripts import assistant_store, database, watch_profiles

    if database.SCHEMA_VERSION != EXPECTED_SCHEMA_VERSION:
        raise SystemExit(
            f"{scripts} reports SCHEMA_VERSION = {database.SCHEMA_VERSION}, "
            f"expected {EXPECTED_SCHEMA_VERSION}. Point --source-tree at a "
            "checkout of tag v2.1.0."
        )
    if not str(Path(database.__file__).resolve()).startswith(str(scripts)):
        raise SystemExit(
            f"database was imported from {database.__file__}, not from {scripts}."
        )
    return database, watch_profiles, assistant_store


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
#   * NULLs in every column v2.1.0 allows one in (a rebuild with a NOT NULL
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
     "José González, Björn Östergaard",
     None,  # the source gave no abstract; NULL, not an empty string
     "2024-06-30", "https://example.org/doi/10.1000/xyz123", "cond-mat.mtrl-sci",
     "hash-crossref-0001"),
    # Every nullable column at once. v2.1.0 accepts this row; a migration that
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


def seed(database, watch_profiles, assistant_store, conn) -> None:
    """Fill a fresh schema-13 database through v2.1.0's own write functions.

    Where v2.1.0 has no writer for a table, the SQL here is the statement its
    owning module issues, and a comment says which module that is. The point of
    the exercise is that every row passes v2.1.0's own constraints and lands in
    v2.1.0's own column layout -- not that it travelled through a Python
    function on the way.
    """
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
            # v2.1.0's index_document_facets takes api_base.Author objects. A
            # tiny stand-in with the same three attributes keeps the generator
            # from importing the HTTP stack just to build a name.
            doc["structured_authors"] = [_Author(*a) for a in structured]
        doc_id = database.insert_document(conn, doc)
        assert doc_id, f"v2.1.0 refused the document {doc['external_id']}"
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

    # routines.execution_location = 'cloud' cannot be written by v2.1.0:
    # insert_routine raises ValueError on anything but 'local', because
    # cloud-scheduled routines went away with the cloud service. The CHECK
    # still admits it and a database written by resmon 2.0 can still hold one,
    # so the fixture carries the row that only history could have produced --
    # written the way 2.0's insert_routine wrote it.
    conn.execute(
        "INSERT INTO routines (name, schedule_cron, parameters, intent, is_active, "
        "email_enabled, email_ai_summary_enabled, ai_enabled, ai_settings, "
        "storage_settings, notify_on_complete, execution_location) "
        "VALUES (?, ?, ?, ?, 0, 0, 0, 0, NULL, NULL, 0, 'cloud')",
        ("Legacy cloud routine", "0 4 * * 0",
         json.dumps({"keywords": "legacy", "sources": []}),
         "Left over from 2.0; resmon no longer runs it."),
    )
    conn.commit()

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

    # dedup_* have no writer in v2.1.0's database.py -- sweep_engine issues this
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

    # watch_profile_members has no writer in v2.1.0's database.py; the API
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


class _Author:
    """The three attributes ``index_document_facets`` reads off an api_base.Author."""

    def __init__(self, name, orcid, affiliation, source_id):
        self.name = name
        self.orcid = orcid
        self.affiliations = [affiliation] if affiliation else []
        self.source_ids = [tuple(source_id.split(":", 1))] if source_id else []


# ---------------------------------------------------------------------------
# Making the result reproducible
# ---------------------------------------------------------------------------


def clock_columns(conn: sqlite3.Connection) -> list[tuple[str, str]]:
    """Every (table, column) whose value comes from the wall clock.

    Derived from the schema rather than listed, so a column added to a future
    fixture generation is found instead of quietly making the dump unstable.
    The two columns written with an explicit ``datetime('now')`` by a v2.1.0
    writer are added by name -- they have no default to read.
    """
    found = set(_EXPLICIT_CLOCK_COLUMNS)
    for (table,) in conn.execute(
        "SELECT name FROM sqlite_master WHERE type='table' AND sql IS NOT NULL"
    ).fetchall():
        if table.startswith("sqlite_") or table.startswith("documents_fts"):
            continue
        for row in conn.execute(f'PRAGMA table_info("{table}")'):
            default = (row[4] or "")
            if "datetime('now')" in default.replace('"', "'"):
                found.add((table, row[1]))
    return sorted(found)


def _freeze_clock_columns(conn: sqlite3.Connection) -> list[tuple[str, str]]:
    """Rewrite clock columns to values derived from the row, not the clock.

    ``WHERE ... IS NOT NULL`` matters: ``execution_ai.ended_at`` is NULL on a
    lane still running, and a lane that is still running is one of the states
    this fixture is here to carry.
    """
    frozen = clock_columns(conn)
    for table, column in frozen:
        conn.execute(
            f'UPDATE "{table}" SET "{column}" = '
            f"strftime('%Y-%m-%d %H:%M:%S', '2026-02-01 05:00:00', "
            f"'+' || ((rowid * 37) % 2880) || ' minutes') "
            f'WHERE "{column}" IS NOT NULL'
        )
    conn.commit()
    return frozen


def _assert_no_live_clock_values(conn: sqlite3.Connection, started: str) -> None:
    """Fail if any text value is a timestamp from this run.

    The freeze pass works from the schema, so it cannot know about a value some
    writer formatted itself. This sweep is what turns that from a silent
    reproducibility bug -- a fixture that differs on every regeneration, which
    nobody can review -- into a failed generation.
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
                if isinstance(value, str) and _TIMESTAMP_RE.match(value) and value >= started:
                    offenders.append(f"{table}.{name} = {value!r}")
    if offenders:
        raise RuntimeError(
            "These values came from this run's clock and would make the fixture "
            "differ on every regeneration. Add the column to "
            "_EXPLICIT_CLOCK_COLUMNS:\n  " + "\n  ".join(sorted(set(offenders)))
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
-- A resmon corpus at schema 13, written by resmon v2.1.0's own code.
--
-- Source: tag v2.1.0, commit {commit}
-- Generated by: fixtures/v2.1.0/generate_corpus.py (committed beside this file)
-- Regenerate:   python generate_corpus.py --source-tree <v2.1.0 checkout>
-- Verify:       python generate_corpus.py --source-tree <v2.1.0 checkout> --check
--
-- v2.2.0 is the first release that upgrades a real user across five schema
-- steps in one launch (13 -> 18). Every step has its own test, each starting
-- from the step before it; none of them starts from a database a *released*
-- resmon wrote. `test_cumulative_upgrade.py` executes this file and then calls
-- today's `init_db` once, the way a user's first launch after updating does.
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
--   * live timestamps. About twenty columns default to `datetime('now')`, so
--     the generator rewrites them from each row's rowid and then fails if any
--     value from the run's own clock survives. That is the one documented
--     normalisation between a regeneration and this file.
"""


def build(source_tree: Path, db_path: Path) -> sqlite3.Connection:
    """Create and seed a schema-13 database at ``db_path``. Returns the connection."""
    started = _dt.datetime.now(_dt.timezone.utc).strftime("%Y-%m-%d %H:%M:%S")
    database, watch_profiles, assistant_store = load_v210(source_tree)
    database.init_db(str(db_path))
    conn = database.get_connection(str(db_path))
    seed(database, watch_profiles, assistant_store, conn)
    assert database.get_schema_version(conn) == EXPECTED_SCHEMA_VERSION
    _freeze_clock_columns(conn)
    _assert_no_live_clock_values(conn, started)
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
                        help="root of a checkout of tag v2.1.0")
    parser.add_argument("--out", type=Path, default=DEFAULT_OUT)
    parser.add_argument("--check", action="store_true",
                        help="regenerate and diff against --out instead of writing it")
    args = parser.parse_args(argv)

    with tempfile.TemporaryDirectory() as tmp:
        conn = build(args.source_tree, Path(tmp) / "corpus.db")
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
