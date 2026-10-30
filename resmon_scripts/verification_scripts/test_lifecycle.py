"""Corpus lifecycle: never assert what the user cannot check.

A false retraction flag is defamatory. That is not a style concern — it is the
constraint the whole feature is built around, and most of this suite exists to
hold it: every finding must carry a resolvable link to its notice, the
upstream's own wording must survive verbatim, and an expression of concern must
never be graded as a retraction.

The Crossref and bioRxiv payloads below are **real responses**, captured while
building the feature, not invented shapes. Parsing was written against them
rather than against a guess at the schema, and pinning them here means a change
in either API surfaces as a failing test instead of as silence.

One live test hits Crossref for real and is marked ``live_network`` so it stays
out of the default run.
"""

from __future__ import annotations

import json
import sqlite3
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any

import pytest

PROJECT_ROOT = Path(__file__).resolve().parent.parent.parent
sys.path.insert(0, str(PROJECT_ROOT / "resmon_scripts"))

from implementation_scripts import config, lifecycle  # noqa: E402
from implementation_scripts.database import (  # noqa: E402
    MissingNoticeError,
    get_lifecycle_for_document,
    init_db,
    insert_document,
    record_lifecycle_check,
    record_lifecycle_finding,
)

# ---------------------------------------------------------------------------
# Real captured payloads
# ---------------------------------------------------------------------------

# api.crossref.org/works/10.1016/S0140-6736(97)11096-0 — the Wakefield MMR
# paper, retracted by The Lancet in 2010 after a 2004 partial correction. Two
# updates of different severity on one work is exactly the case that must not
# be flattened into a single "retracted" badge.
WAKEFIELD = {
    "DOI": "10.1016/s0140-6736(97)11096-0",
    "title": ["RETRACTED: Ileal-lymphoid-nodular hyperplasia, non-specific "
              "colitis, and pervasive developmental disorder in children"],
    "updated-by": [
        {
            "DOI": "10.1016/s0140-6736(04)15715-2",
            "type": "correction",
            "label": "Correction",
            "source": "retraction-watch",
            "updated": {"date-parts": [[2004, 3, 6]],
                        "date-time": "2004-03-06T00:00:00Z"},
            "record-id": "17269",
        },
        {
            "DOI": "10.1016/s0140-6736(10)60175-4",
            "type": "retraction",
            "label": "Retraction",
            "source": "retraction-watch",
            "updated": {"date-parts": [[2010, 2, 6]],
                        "date-time": "2010-02-06T00:00:00Z"},
            "record-id": "4036",
        },
    ],
}

# api.biorxiv.org/details/biorxiv/10.1101/2020.02.11.944462 — a preprint that
# reached Science. ``published`` carries the journal DOI.
BIORXIV_PUBLISHED = {
    "collection": [
        {"doi": "10.1101/2020.02.11.944462", "version": "1",
         "date": "2020-02-11", "published": "10.1126/science.abb2507"},
    ],
}

# api.biorxiv.org/details/biorxiv/10.1101/2020.03.05.979500 — two versions,
# never published. ``published`` is the literal string "NA".
BIORXIV_UNPUBLISHED = {
    "collection": [
        {"doi": "10.1101/2020.03.05.979500", "version": "1",
         "date": "2020-03-06", "published": "NA"},
        {"doi": "10.1101/2020.03.05.979500", "version": "2",
         "date": "2020-03-12", "published": "NA"},
    ],
}

ARXIV_ATOM_V3 = """<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <entry>
    <id>http://arxiv.org/abs/2301.00001v3</id>
    <updated>2024-05-01T00:00:00Z</updated>
    <title>A paper</title>
  </entry>
</feed>
"""


@pytest.fixture
def conn():
    c = sqlite3.connect(":memory:")
    c.row_factory = sqlite3.Row
    init_db(conn=c)
    yield c
    c.close()


def _doc(conn, *, source="crossref", ext="1", doi=None, title="A paper"):
    return insert_document(conn, {
        "source_repository": source, "external_id": ext, "doi": doi,
        "title": title, "authors": "A. Author", "abstract": "x",
        "publication_date": "2020-01-01", "url": "https://example.org",
        "categories": "", "metadata_hash": f"h-{source}-{ext}",
    })


# ---------------------------------------------------------------------------
# The rule: never assert without a notice
# ---------------------------------------------------------------------------


def test_a_finding_without_a_notice_link_is_refused(conn):
    """The whole feature rests on this. A retraction the user cannot open is
    an accusation, not a report."""
    doc_id = _doc(conn, doi="10.1/x")

    with pytest.raises(MissingNoticeError):
        record_lifecycle_finding(
            conn, doc_id, kind="retraction", severity="critical",
            notice_key="k", notice_url="", provider="crossref",
        )

    assert get_lifecycle_for_document(conn, doc_id) == []


def test_a_finding_without_a_stable_key_is_refused(conn):
    """Otherwise every re-check would duplicate it."""
    doc_id = _doc(conn, doi="10.1/x")
    with pytest.raises(MissingNoticeError):
        record_lifecycle_finding(
            conn, doc_id, kind="retraction", severity="critical",
            notice_key="", notice_url="https://doi.org/10.1/n",
            provider="crossref",
        )


def test_a_crossref_update_with_no_doi_is_dropped_not_asserted(conn):
    findings = lifecycle.findings_from_crossref({
        "DOI": "10.1/x",
        "updated-by": [{"type": "retraction", "label": "Retraction"}],
    })
    assert findings == []


def test_rechecking_does_not_duplicate_or_reset_the_first_sighting(conn):
    """"resmon told me three weeks ago" is a different fact from "resmon told
    me just now", and the interface distinguishes them."""
    doc_id = _doc(conn, doi="10.1/x")
    for _ in range(3):
        record_lifecycle_finding(
            conn, doc_id, kind="retraction", severity="critical",
            notice_key="10.1/n", notice_url="https://doi.org/10.1/n",
            provider="crossref",
        )
    events = get_lifecycle_for_document(conn, doc_id)
    assert len(events) == 1

    first_seen = events[0]["first_seen_at"]
    record_lifecycle_finding(
        conn, doc_id, kind="retraction", severity="critical",
        notice_key="10.1/n", notice_url="https://doi.org/10.1/n",
        provider="crossref",
    )
    assert get_lifecycle_for_document(conn, doc_id)[0]["first_seen_at"] == first_seen


# ---------------------------------------------------------------------------
# Crossref parsing, against the real payload
# ---------------------------------------------------------------------------


def test_two_updates_of_different_severity_are_not_flattened():
    findings = lifecycle.findings_from_crossref(WAKEFIELD)
    by_kind = {f.kind: f for f in findings}

    assert set(by_kind) == {"retraction", "correction"}
    assert by_kind["retraction"].severity == "critical"
    # A correction is normal scholarly upkeep. Coloring it like a retraction
    # would train users to ignore the color.
    assert by_kind["correction"].severity == "informational"


def test_the_upstream_wording_survives_verbatim():
    """resmon does not paraphrase a publisher's claim."""
    findings = lifecycle.findings_from_crossref(WAKEFIELD)
    labels = {f.label for f in findings}
    assert labels == {"Retraction", "Correction"}


def test_every_finding_carries_a_resolvable_notice():
    for finding in lifecycle.findings_from_crossref(WAKEFIELD):
        assert finding.notice_url.startswith("https://doi.org/")
        assert finding.notice_doi


def test_who_registered_the_notice_is_recorded():
    """Crossref distinguishes Retraction Watch from the publisher, and a reader
    weighing a claim should know its origin."""
    findings = lifecycle.findings_from_crossref(WAKEFIELD)
    assert {f.provider_source for f in findings} == {"retraction-watch"}


def test_notice_dates_are_read_from_crossrefs_date_parts():
    by_kind = {f.kind: f for f in lifecycle.findings_from_crossref(WAKEFIELD)}
    assert by_kind["retraction"].notice_date == "2010-02-06"
    assert by_kind["correction"].notice_date == "2004-03-06"


def test_an_expression_of_concern_is_weaker_than_a_retraction():
    """Crossref's coverage of non-retraction update types is less
    comprehensive, so this must never be graded as a withdrawal."""
    findings = lifecycle.findings_from_crossref({
        "DOI": "10.1/x",
        "updated-by": [{
            "DOI": "10.1/eoc", "type": "expression_of_concern",
            "label": "Expression of concern", "source": "publisher",
            "updated": {"date-parts": [[2024, 1, 1]]},
        }],
    })
    assert findings[0].severity == "caution"
    assert findings[0].kind == "expression_of_concern"


@pytest.mark.parametrize("update_type,severity", [
    ("retraction", "critical"),
    ("Retraction", "critical"),
    ("withdrawal", "critical"),
    ("removal", "critical"),
    ("partial_retraction", "critical"),
    ("expression-of-concern", "caution"),
    ("Expression of Concern", "caution"),
    ("correction", "informational"),
    ("corrigendum", "informational"),
    ("erratum", "informational"),
])
def test_update_types_map_to_the_intended_severity(update_type, severity):
    findings = lifecycle.findings_from_crossref({
        "updated-by": [{"DOI": "10.1/n", "type": update_type}],
    })
    assert findings[0].severity == severity


def test_an_unrecognised_update_type_is_informational_and_kept_verbatim():
    """A new Crossref type must not silently become a retraction, and must not
    be discarded either — the label still tells the user something."""
    findings = lifecycle.findings_from_crossref({
        "updated-by": [{"DOI": "10.1/n", "type": "something_new",
                        "label": "Something New"}],
    })
    assert findings[0].severity == "informational"
    assert findings[0].kind == "other_update"
    assert findings[0].label == "Something New"


# ---------------------------------------------------------------------------
# bioRxiv
# ---------------------------------------------------------------------------


def test_a_preprint_that_reached_a_journal_is_reported_with_the_published_doi():
    findings = lifecycle.findings_from_biorxiv(BIORXIV_PUBLISHED)
    assert len(findings) == 1
    assert findings[0].kind == "preprint_published"
    assert findings[0].notice_doi == "10.1126/science.abb2507"
    assert findings[0].notice_url == "https://doi.org/10.1126/science.abb2507"
    assert "peer reviewed" in findings[0].detail


def test_the_literal_string_NA_is_not_mistaken_for_a_doi():
    """bioRxiv writes "NA" rather than null. Treating that as a DOI would
    produce a link to https://doi.org/NA on every unpublished preprint."""
    assert lifecycle.findings_from_biorxiv(BIORXIV_UNPUBLISHED) == []


def test_a_newer_preprint_version_is_reported_against_the_one_held():
    findings = lifecycle.findings_from_biorxiv(
        BIORXIV_UNPUBLISHED, stored_version=1)
    assert len(findings) == 1
    assert findings[0].kind == "new_version"
    assert findings[0].severity == "informational"
    assert "version 1" in findings[0].detail
    assert "version 2" in findings[0].detail


def test_holding_the_latest_version_produces_nothing():
    assert lifecycle.findings_from_biorxiv(
        BIORXIV_UNPUBLISHED, stored_version=2) == []


def test_an_empty_biorxiv_response_is_not_an_error():
    assert lifecycle.findings_from_biorxiv({"collection": []}) == []
    assert lifecycle.findings_from_biorxiv({}) == []


# ---------------------------------------------------------------------------
# arXiv
# ---------------------------------------------------------------------------


@pytest.mark.parametrize("external_id,base,version", [
    ("2604.12345v1", "2604.12345", 1),
    ("2604.12345v12", "2604.12345", 12),
    ("cond-mat/0211034v2", "cond-mat/0211034", 2),
    ("2604.12345", "2604.12345", None),
    ("", "", None),
])
def test_the_version_a_user_holds_is_already_on_disk(external_id, base, version):
    """The arXiv client keeps the id exactly as the Atom feed gives it, so no
    extra request is needed to learn which version the user has."""
    assert lifecycle.arxiv_version(external_id) == (base, version)


def test_a_newer_arxiv_version_is_reported():
    findings = lifecycle.findings_from_arxiv(
        ARXIV_ATOM_V3, base_id="2301.00001", stored_version=1)
    assert len(findings) == 1
    assert findings[0].notice_url == "https://arxiv.org/abs/2301.00001v3"
    assert findings[0].label == "Version 3 posted"


def test_the_same_arxiv_version_produces_nothing():
    assert lifecycle.findings_from_arxiv(
        ARXIV_ATOM_V3, base_id="2301.00001", stored_version=3) == []


def test_an_arxiv_entry_for_a_different_paper_is_ignored():
    """A mismatched id in the feed must not be read as this paper's version."""
    assert lifecycle.findings_from_arxiv(
        ARXIV_ATOM_V3, base_id="9999.99999", stored_version=1) == []


# ---------------------------------------------------------------------------
# Orchestration
# ---------------------------------------------------------------------------


class _FakeCrossref:
    """Returns canned works, keyed lowercase like the real API does."""

    def __init__(self, works: dict, fail: bool = False):
        self.works = works
        self.fail = fail
        self.calls: list[list[str]] = []

    def fetch(self, dois):
        self.calls.append(list(dois))
        if self.fail:
            raise RuntimeError("crossref unavailable")
        return {
            doi.lower(): self.works[doi.lower()]
            for doi in dois if doi.lower() in self.works
        }


class _NoProvider:
    def fetch(self, *args, **kwargs):
        raise AssertionError("should not be called")


def test_a_doi_with_capitals_still_matches_crossrefs_lowercased_reply(conn):
    """Elsevier DOIs carry capitals and Crossref lowercases them. Matching on
    the stored casing silently found nothing at all."""
    doc_id = _doc(conn, doi="10.1016/S0140-6736(97)11096-0")
    crossref = _FakeCrossref({"10.1016/s0140-6736(97)11096-0": WAKEFIELD})

    lifecycle.check_corpus(conn, crossref=crossref,
                           biorxiv=_NoProvider(), arxiv=_NoProvider())

    kinds = {e["kind"] for e in get_lifecycle_for_document(conn, doc_id)}
    assert kinds == {"retraction", "correction"}


def test_a_paper_crossref_has_no_record_of_is_still_marked_checked(conn):
    """Crossref not *knowing* a DOI and Crossref not *answering* are different
    facts. Conflating them was a livelock: one unknown DOI would have been
    re-selected on every run and the check would never have advanced."""
    _doc(conn, doi="10.9999/unknown")
    crossref = _FakeCrossref({})

    first = lifecycle.check_corpus(conn, crossref=crossref,
                                   biorxiv=_NoProvider(), arxiv=_NoProvider())
    assert first["checked_now"] == 1
    assert first["remaining"] == 0

    second = lifecycle.check_corpus(conn, crossref=crossref,
                                    biorxiv=_NoProvider(), arxiv=_NoProvider())
    assert second["checked_now"] == 0


def test_a_failed_crossref_batch_leaves_papers_unchecked(conn):
    """Not cleared — skipped. Recording them as checked would make the coverage
    figure say the corpus was looked at when it was not."""
    _doc(conn, doi="10.1/a")
    crossref = _FakeCrossref({}, fail=True)

    summary = lifecycle.check_corpus(conn, crossref=crossref,
                                     biorxiv=_NoProvider(), arxiv=_NoProvider())

    assert summary["checked_now"] == 0
    assert summary["remaining"] == 1
    assert summary["coverage"]["checked"] == 0


def test_a_paper_with_no_usable_identifier_is_recorded_as_such(conn):
    """Not "clean" — never looked at."""
    _doc(conn, source="dblp", doi=None)
    summary = lifecycle.check_corpus(conn, crossref=_FakeCrossref({}),
                                     biorxiv=_NoProvider(), arxiv=_NoProvider())

    assert summary["coverage"]["no_identifier"] == 1
    assert summary["coverage"]["checked"] == 0


def test_dois_are_sent_in_batches_not_one_request_per_paper(conn):
    for i in range(95):
        _doc(conn, ext=str(i), doi=f"10.1/{i}")
    crossref = _FakeCrossref({})

    lifecycle.check_corpus(conn, crossref=crossref, biorxiv=_NoProvider(),
                           arxiv=_NoProvider())

    assert len(crossref.calls) == 3  # 40 + 40 + 15
    assert all(len(c) <= lifecycle.CROSSREF_BATCH for c in crossref.calls)


def test_the_check_is_bounded_and_resumable(conn):
    for i in range(10):
        _doc(conn, ext=str(i), doi=f"10.1/{i}")
    crossref = _FakeCrossref({})

    first = lifecycle.check_corpus(conn, limit=4, crossref=crossref,
                                   biorxiv=_NoProvider(), arxiv=_NoProvider())
    assert first["checked_now"] == 4
    assert first["remaining"] == 6

    second = lifecycle.check_corpus(conn, limit=4, crossref=crossref,
                                    biorxiv=_NoProvider(), arxiv=_NoProvider())
    assert second["checked_now"] == 4
    assert second["remaining"] == 2


def test_a_recently_checked_paper_is_not_asked_about_again(conn):
    doc_id = _doc(conn, doi="10.1/a")
    record_lifecycle_check(conn, doc_id, status="ok", providers=["crossref"])

    assert lifecycle.documents_due(conn) == []


def test_a_provider_failure_on_one_paper_is_recorded_not_swallowed(conn):
    class _Boom:
        def fetch(self, *a, **k):
            raise RuntimeError("biorxiv down")

    _doc(conn, source="biorxiv", doi="10.1101/x", ext="x")
    summary = lifecycle.check_corpus(
        conn, crossref=_FakeCrossref({}), biorxiv=_Boom(), arxiv=_NoProvider())

    assert summary["coverage"]["errored"] == 1
    assert summary["errors"][0]["error"] == "biorxiv down"


# ---------------------------------------------------------------------------
# Running to completion (1.7.1)
# ---------------------------------------------------------------------------


class _CountingArxiv:
    """Records how many requests the batched provider actually makes."""

    def __init__(self):
        self.calls: list[list[str]] = []

    def fetch_many(self, base_ids):
        self.calls.append(list(base_ids))
        return ARXIV_ATOM_V3

    def fetch(self, base_id):
        return self.fetch_many([base_id])


def test_arxiv_version_checks_are_batched_not_one_per_paper(conn):
    """At one request per paper a 5,000-paper arXiv corpus was 5,000 requests,
    which is what made covering a real corpus impractical."""
    for i in range(120):
        _doc(conn, source="arxiv", ext=f"2301.{i:05d}v1", doi=None)
    arxiv = _CountingArxiv()

    lifecycle.check_corpus(conn, crossref=_FakeCrossref({}),
                           biorxiv=_NoProvider(), arxiv=arxiv)

    assert len(arxiv.calls) == 3  # 50 + 50 + 20
    assert all(len(c) <= lifecycle.ARXIV_BATCH for c in arxiv.calls)


def test_run_until_done_covers_the_whole_corpus_in_one_call(conn):
    """The fix for the real defect: at the old default a 15,000-paper corpus
    needed seventy-nine presses of the button."""
    for i in range(25):
        _doc(conn, ext=str(i), doi=f"10.1/{i}")

    summary = lifecycle.check_corpus(
        conn, limit=5, run_until_done=True, crossref=_FakeCrossref({}),
        biorxiv=_NoProvider(), arxiv=_NoProvider())

    assert summary["checked_now"] == 25
    assert summary["remaining"] == 0


def test_a_single_pass_is_still_the_default(conn):
    for i in range(25):
        _doc(conn, ext=str(i), doi=f"10.1/{i}")

    summary = lifecycle.check_corpus(
        conn, limit=5, crossref=_FakeCrossref({}),
        biorxiv=_NoProvider(), arxiv=_NoProvider())

    assert summary["checked_now"] == 5
    assert summary["remaining"] == 20


def test_a_run_can_be_stopped_and_keeps_what_it_checked(conn):
    """Cooperative: papers already checked keep their results, and the rest stay
    unchecked rather than being recorded as clean."""
    for i in range(40):
        _doc(conn, ext=str(i), doi=f"10.1/{i}")
    passes = {"n": 0}

    def should_stop():
        passes["n"] += 1
        return passes["n"] >= 2

    summary = lifecycle.check_corpus(
        conn, limit=5, run_until_done=True, should_stop=should_stop,
        crossref=_FakeCrossref({}), biorxiv=_NoProvider(), arxiv=_NoProvider())

    assert 0 < summary["checked_now"] < 40
    assert summary["remaining"] > 0
    assert summary["coverage"]["checked"] == summary["checked_now"]


def test_run_until_done_stops_rather_than_spinning_on_papers_it_cannot_advance(conn):
    """A pass that checks nothing must end the run. Without this guard a corpus
    whose remaining papers all fail would loop forever."""
    _doc(conn, ext="1", doi="10.1/a")
    summary = lifecycle.check_corpus(
        conn, limit=5, run_until_done=True,
        crossref=_FakeCrossref({}, fail=True),
        biorxiv=_NoProvider(), arxiv=_NoProvider())

    assert summary["checked_now"] == 0
    assert summary["remaining"] == 1


def test_the_default_limit_is_workable_on_a_real_corpus(conn):
    """15,645 papers at the old default of 200 was 79 presses."""
    assert lifecycle.DEFAULT_LIMIT >= 1000


# ---------------------------------------------------------------------------
# What a run could not do
# ---------------------------------------------------------------------------


class _FailingArxiv:
    def fetch_many(self, base_ids):
        raise RuntimeError("arXiv refused the connection")

    def fetch(self, base_id):
        return self.fetch_many([base_id])


def test_an_arxiv_paper_crossref_did_not_answer_for_is_left_unchecked(conn):
    """Retractions come from Crossref. An arXiv paper with a DOI whose batch
    failed was recorded as checked against Crossref, and not asked about again
    for thirty days."""
    doc_id = _doc(conn, source="arxiv", ext="2301.00001v1", doi="10.1/a")

    summary = lifecycle.check_corpus(
        conn, crossref=_FakeCrossref({}, fail=True), biorxiv=_NoProvider(),
        arxiv=_CountingArxiv())

    assert summary["checked_now"] == 0
    assert summary["coverage"]["unchecked"] == 1
    assert summary["unanswered"] == [{
        "service": "crossref", "name": "Crossref", "papers": 1,
        "reason": "crossref unavailable"}]
    assert lifecycle.documents_due(conn)[0]["id"] == doc_id

    # Crossref back: the paper is checked by both, and no longer unanswered.
    again = lifecycle.check_corpus(
        conn, crossref=_FakeCrossref({}), biorxiv=_NoProvider(),
        arxiv=_CountingArxiv())
    assert again["checked_now"] == 1
    assert again["unanswered"] == []
    providers = conn.execute(
        "SELECT providers FROM document_lifecycle_checks WHERE document_id = ?",
        (doc_id,)).fetchone()[0]
    assert json.loads(providers) == ["crossref", "arxiv"]


def test_an_arxiv_paper_arxiv_did_not_answer_for_is_not_recorded_as_unidentifiable(conn):
    """It was recorded as carrying no identifier at all, which is a statement
    about the paper, when the fact was about arXiv. A paper that really has
    none is recorded as such, and the run's outcomes keep the two apart from a
    paper that was looked at."""
    _doc(conn, source="arxiv", ext="2301.00001v1", doi=None)
    _doc(conn, source="dblp", ext="d1", doi=None)

    summary = lifecycle.check_corpus(
        conn, crossref=_NoProvider(), biorxiv=_NoProvider(), arxiv=_FailingArxiv())

    assert summary["coverage"]["no_identifier"] == 1
    assert summary["coverage"]["unchecked"] == 1
    assert summary["checked_now"] == 1
    assert summary["outcomes"] == {"ok": 0, "no_identifier": 1, "error": 0}
    assert summary["unanswered"] == [{
        "service": "arxiv", "name": "arXiv", "papers": 1,
        "reason": "arXiv refused the connection"}]


def test_a_stop_part_way_through_a_pass_asks_nothing_more(conn):
    """A pass is up to a thousand papers. The stop is honored before the next
    request, the answers already in are kept, and what was never asked about
    stays unchecked and is counted."""
    for i in range(100):
        _doc(conn, ext=str(i), doi=f"10.1/{i}")
    crossref = _FakeCrossref({})
    asked = {"n": 0}

    def should_stop():
        asked["n"] += 1
        return asked["n"] > 1

    summary = lifecycle.check_corpus(
        conn, should_stop=should_stop, crossref=crossref,
        biorxiv=_NoProvider(), arxiv=_NoProvider())

    assert len(crossref.calls) == 1
    assert summary["stopped"] is True
    assert summary["checked_now"] == lifecycle.CROSSREF_BATCH
    assert summary["not_asked"] == 100 - lifecycle.CROSSREF_BATCH
    assert summary["coverage"]["unchecked"] == 100 - lifecycle.CROSSREF_BATCH
    assert summary["unanswered"] == []


def test_a_run_nobody_stopped_says_so(conn):
    _doc(conn, doi="10.1/a")
    summary = lifecycle.check_corpus(
        conn, should_stop=lambda: False, crossref=_FakeCrossref({}),
        biorxiv=_NoProvider(), arxiv=_NoProvider())

    assert summary["stopped"] is False
    assert summary["not_asked"] == 0


# ---------------------------------------------------------------------------
# On loopback: the shipped providers, pointed at an authored server
# ---------------------------------------------------------------------------


class _Authored:
    """Crossref, bioRxiv and arXiv on loopback, each answering as authored.

    Real sockets and the shipped providers, so ``safe_request``, the status
    check and the parsers all run as they do against the real services; only
    the address changes, the way a source client's is changed for a test.
    ``hold`` keeps the first Crossref request waiting until ``release``.
    """

    def __init__(self, *, crossref: tuple[int, Any], biorxiv: tuple[int, Any] = (200, {}),
                 arxiv: tuple[int, str] = (200, ""), hold: bool = False) -> None:
        self.replies = {"/works": crossref, "/details": biorxiv, "/api/query": arxiv}
        self.requests: list[str] = []
        self.gate = threading.Event()
        if not hold:
            self.gate.set()

    def __enter__(self) -> "_Authored":
        authored = self

        class Handler(BaseHTTPRequestHandler):
            def do_GET(self) -> None:  # noqa: N802 - the stdlib's name
                authored.requests.append(self.path)
                prefix = next(p for p in authored.replies if self.path.startswith(p))
                if prefix == "/works":
                    authored.gate.wait(10)
                status, body = authored.replies[prefix]
                data = (body if isinstance(body, str) else json.dumps(body)).encode()
                self.send_response(status)
                self.send_header("Content-Length", str(len(data)))
                self.end_headers()
                self.wfile.write(data)

            def log_message(self, *_args: Any) -> None:
                pass

        self.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.base = f"http://127.0.0.1:{self.server.server_address[1]}"
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        return self

    def point(self, monkeypatch) -> None:
        monkeypatch.setattr(lifecycle, "_CROSSREF_URL", f"{self.base}/works")
        monkeypatch.setattr(lifecycle, "_BIORXIV_URL", f"{self.base}/details")
        monkeypatch.setattr(lifecycle, "_ARXIV_URL", f"{self.base}/api/query")

    def __exit__(self, *_exc: Any) -> None:
        self.gate.set()
        self.server.shutdown()
        self.server.server_close()
        self.thread.join()


def test_the_whole_check_runs_against_a_loopback_endpoint(conn, monkeypatch):
    """Every service the check asks is reached through a module-level address,
    so a test, or the app's own end-to-end suite, can answer for it."""
    retracted = _doc(conn, ext="w", doi="10.1016/S0140-6736(97)11096-0")
    preprint = _doc(conn, source="biorxiv", ext="b", doi="10.1101/2020.02.11.944462")
    versioned = _doc(conn, source="arxiv", ext="2301.00001v1", doi=None)

    with _Authored(crossref=(200, {"status": "ok", "message": {"items": [WAKEFIELD]}}),
                   biorxiv=(200, BIORXIV_PUBLISHED),
                   arxiv=(200, ARXIV_ATOM_V3)) as authored:
        authored.point(monkeypatch)
        summary = lifecycle.check_corpus(conn)

    assert {r.split("?")[0] for r in authored.requests} == {
        "/works", "/details/biorxiv/10.1101/2020.02.11.944462", "/api/query"}
    assert summary["checked_now"] == 3
    assert summary["unanswered"] == []
    kinds = {doc: {e["kind"] for e in get_lifecycle_for_document(conn, doc)}
             for doc in (retracted, preprint, versioned)}
    assert kinds == {retracted: {"retraction", "correction"},
                     preprint: {"preprint_published"},
                     versioned: {"new_version"}}


def test_a_service_that_answers_an_error_status_is_not_a_clean_result(conn, monkeypatch):
    """The status decides, not the body. An arXiv 503 page holds no entries and
    read as "no newer version"; a Crossref error body with no items would have
    read as "Crossref knows none of these DOIs". Either one recorded every
    paper in the batch as checked and clear. The bodies here are authored."""
    monkeypatch.setattr(config, "DEFAULT_MAX_RETRIES", 0)
    _doc(conn, ext="c", doi="10.1/a")
    _doc(conn, source="arxiv", ext="2301.00001v1", doi=None)

    with _Authored(crossref=(503, {"status": "error", "message": {"items": []}}),
                   arxiv=(503, "<html>Service Unavailable</html>")) as authored:
        authored.point(monkeypatch)
        summary = lifecycle.check_corpus(conn)

    assert summary["checked_now"] == 0
    assert summary["coverage"]["checked"] == 0
    assert summary["coverage"]["unchecked"] == 2
    assert summary["sufficient"] is False
    assert summary["unanswered"] == [
        {"service": "arxiv", "name": "arXiv", "papers": 1, "reason": "arXiv answered HTTP 503"},
        {"service": "crossref", "name": "Crossref", "papers": 1,
         "reason": "Crossref answered HTTP 503"},
    ]


# ---------------------------------------------------------------------------
# Reporting
# ---------------------------------------------------------------------------


def test_an_unchecked_corpus_is_not_reported_as_clean(conn):
    """"No retractions found" means nothing if nobody has looked."""
    _doc(conn, doi="10.1/a")
    payload = lifecycle.report(conn)

    assert payload["sufficient"] is False
    assert payload["findings"] == []
    assert payload["coverage"]["unchecked"] == 1


def test_coverage_accounts_for_every_paper(conn):
    _doc(conn, ext="1", doi="10.1/a")
    _doc(conn, ext="2", doi=None, source="dblp")
    _doc(conn, ext="3", doi="10.1/c")
    lifecycle.check_corpus(conn, limit=2, crossref=_FakeCrossref({}),
                           biorxiv=_NoProvider(), arxiv=_NoProvider())

    coverage = lifecycle.report(conn)["coverage"]
    total = (coverage["checked"] + coverage["no_identifier"]
             + coverage["errored"] + coverage["unchecked"])
    assert total == coverage["corpus"] == 3


def test_findings_are_ordered_most_serious_first(conn):
    doc_id = _doc(conn, doi="10.1/a")
    record_lifecycle_finding(
        conn, doc_id, kind="correction", severity="informational",
        notice_key="c", notice_url="https://doi.org/10.1/c", provider="crossref")
    record_lifecycle_finding(
        conn, doc_id, kind="retraction", severity="critical",
        notice_key="r", notice_url="https://doi.org/10.1/r", provider="crossref")
    record_lifecycle_check(conn, doc_id, status="ok")

    severities = [f["severity"] for f in lifecycle.report(conn)["findings"]]
    assert severities == ["critical", "informational"]


# ---------------------------------------------------------------------------
# Endpoints
# ---------------------------------------------------------------------------


def _client():
    import resmon as resmon_mod
    resmon_mod._db_path = ":memory:"
    resmon_mod._shared_conn = None
    resmon_mod._db_initialized = False
    from fastapi.testclient import TestClient
    from resmon import app
    return TestClient(app), resmon_mod


def test_the_report_endpoint_answers_on_an_unchecked_corpus():
    client, _ = _client()
    body = client.get("/api/lifecycle").json()

    assert body["sufficient"] is False
    assert body["coverage"]["checked"] == 0


def test_the_per_document_endpoint_distinguishes_clean_from_unchecked():
    client, resmon_mod = _client()
    db = resmon_mod._get_db()
    doc_id = _doc(db, doi="10.1/a")

    body = client.get(f"/api/documents/{doc_id}/lifecycle").json()
    # An empty list alone is ambiguous; the check status disambiguates it.
    assert body["events"] == []
    assert body["checked_at"] is None
    assert body["check_status"] is None

    record_lifecycle_check(db, doc_id, status="ok", providers=["crossref"])
    body = client.get(f"/api/documents/{doc_id}/lifecycle").json()
    assert body["check_status"] == "ok"
    assert body["checked_at"]


def test_the_per_document_endpoint_404s_on_an_unknown_paper():
    client, _ = _client()
    assert client.get("/api/documents/424242/lifecycle").status_code == 404


def _settled(client, timeout: float = 15.0) -> dict:
    """``GET /api/lifecycle`` once the background check has finished."""
    deadline = time.monotonic() + timeout
    while True:
        body = client.get("/api/lifecycle").json()
        if not body["run"]["running"]:
            return body
        assert time.monotonic() < deadline, "the check did not finish"
        time.sleep(0.05)


def test_the_run_says_which_service_did_not_answer(monkeypatch):
    """What the Watchdog screen reads after a check: an unchecked corpus that
    Crossref did not answer for, said as that, and never as nothing found."""
    monkeypatch.setattr(config, "DEFAULT_MAX_RETRIES", 0)
    client, resmon_mod = _client()
    db = resmon_mod._get_db()
    for i in range(3):
        _doc(db, ext=str(i), doi=f"10.1/{i}")

    with _Authored(crossref=(503, "Service Unavailable")) as authored:
        authored.point(monkeypatch)
        assert client.post("/api/lifecycle/check", json={}).json()["status"] == "started"
        body = _settled(client)

    assert body["run"]["error"] is None
    assert body["run"]["last"]["checked_now"] == 0
    assert body["run"]["last"]["stopped"] is False
    assert body["run"]["last"]["unanswered"] == [{
        "service": "crossref", "name": "Crossref", "papers": 3,
        "reason": "Crossref answered HTTP 503"}]
    assert body["sufficient"] is False
    assert body["coverage"]["unchecked"] == 3


def test_a_stop_pressed_while_a_request_is_out_keeps_its_answer(monkeypatch):
    """The stop route, as the screen uses it: pressed while Crossref is still
    answering. That answer is kept; the arXiv request after it is never made,
    and the arXiv paper stays unchecked, counted as not asked."""
    client, resmon_mod = _client()
    db = resmon_mod._get_db()
    retracted = _doc(db, ext="w", doi="10.1016/S0140-6736(97)11096-0")
    _doc(db, source="arxiv", ext="2301.00001v1", doi=None)

    with _Authored(crossref=(200, {"status": "ok", "message": {"items": [WAKEFIELD]}}),
                   arxiv=(200, ARXIV_ATOM_V3), hold=True) as authored:
        authored.point(monkeypatch)
        client.post("/api/lifecycle/check", json={})
        deadline = time.monotonic() + 10
        while not authored.requests:
            assert time.monotonic() < deadline, "Crossref was never asked"
            time.sleep(0.02)
        assert client.post("/api/lifecycle/stop").json() == {"status": "stopping"}
        authored.gate.set()
        body = _settled(client)

    assert [r.split("?")[0] for r in authored.requests] == ["/works"]
    last = body["run"]["last"]
    assert (last["stopped"], last["checked_now"], last["not_asked"]) == (True, 1, 1)
    assert last["outcomes"] == {"ok": 1, "no_identifier": 0, "error": 0}
    assert body["coverage"]["checked"] == 1
    assert body["coverage"]["unchecked"] == 1
    assert {f["document_id"] for f in body["findings"]} == {retracted}
    assert client.post("/api/lifecycle/stop").json() == {"status": "idle"}


# ---------------------------------------------------------------------------
# Live
# ---------------------------------------------------------------------------


@pytest.mark.live_network
def test_crossref_still_reports_the_wakefield_retraction():
    """Pins the contract against the real API.

    If Crossref renames ``updated-by``, changes its ``type`` vocabulary, or
    stops carrying the notice DOI, this fails and the hermetic tests above —
    which run against a captured copy of that shape — become a lie.
    """
    provider = lifecycle.CrossrefLifecycleProvider()
    works = provider.fetch(["10.1016/S0140-6736(97)11096-0"])

    work = works.get("10.1016/s0140-6736(97)11096-0")
    assert work is not None, "Crossref no longer returns this DOI"

    findings = lifecycle.findings_from_crossref(work)
    retractions = [f for f in findings if f.severity == "critical"]
    assert retractions, f"no retraction found; got {[f.kind for f in findings]}"
    assert retractions[0].notice_url.startswith("https://doi.org/")
