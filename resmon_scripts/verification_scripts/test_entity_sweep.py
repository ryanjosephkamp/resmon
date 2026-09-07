"""P5 and P6 — the engine's watch branch, against a real engine and a real database.

**Real dependency, in-process.** A real `SweepEngine` over a real SQLite corpus,
with a loopback source class standing in for the network. That distinction is
the point of the file: the property is *what ends up in the database*, and a
test that stubbed the engine would be asserting its own arrangement.

The source returns a **decoy** — a paper by somebody else — on every call,
because a source's author search is a candidate generator and the whole of
decision 6 is that resmon does not take its word for it.
"""

from __future__ import annotations

import sqlite3
import sys
from pathlib import Path

import pytest

PROJECT_ROOT = Path(__file__).resolve().parent.parent.parent
sys.path.insert(0, str(PROJECT_ROOT / "resmon_scripts"))

from implementation_scripts import sweep_engine as se, watch_profiles as wp  # noqa: E402
from implementation_scripts.api_base import (  # noqa: E402
    Author, BaseAPIClient, EntityUnsupported, NormalizedResult,
)
from implementation_scripts.database import init_db  # noqa: E402
from implementation_scripts.sweep_engine import SweepEngine  # noqa: E402

ORCID = "0000-0002-1825-0097"


class _EntitySource(BaseAPIClient):
    """A source that answers an author query with the person **and a decoy**.

    The decoy is not an accident of the fixture: `au:"Doe"` on a real source
    returns everything whose author field matched the string, which includes
    other people. Any test whose fixture returned only the right answer would
    be checking that resmon can copy a list.
    """

    asked: list = []

    def get_name(self) -> str:
        return "fixture"

    def search(self, query, date_from=None, date_to=None, max_results=100, **kwargs):
        return []

    def search_entity(self, profile, date_from=None, date_to=None,
                      max_results=100, **kwargs):
        type(self).asked.append(profile)
        return [
            NormalizedResult(
                source_repository="fixture", external_id="hers",
                doi=None, title="A paper by the person watched",
                authors=[Author("Jane Doe", orcid=ORCID,
                                affiliations=("University of Somewhere",))],
                abstract="An abstract.", publication_date="2026-01-01",
                url="https://example.invalid/1", categories="cs.AI"),
            NormalizedResult(
                source_repository="fixture", external_id="decoy",
                doi=None, title="A paper by somebody else entirely",
                authors=[Author("John Smith")],
                abstract="Another abstract.", publication_date="2026-01-02",
                url="https://example.invalid/2", categories="cs.AI"),
        ]


class _CannotBeAsked(_EntitySource):
    """A source with no author query. `BaseAPIClient`'s default behaviour."""

    def search_entity(self, profile, date_from=None, date_to=None,
                      max_results=100, **kwargs):
        raise EntityUnsupported("fixture cannot be asked about a person.")


@pytest.fixture
def conn(tmp_path):
    connection = sqlite3.connect(str(tmp_path / "corpus.db"), check_same_thread=False)
    connection.row_factory = sqlite3.Row
    init_db(conn=connection)
    yield connection
    connection.close()


@pytest.fixture
def engine(conn, monkeypatch, tmp_path):
    _EntitySource.asked = []
    monkeypatch.setattr(se, "get_client", lambda _name: _EntitySource())
    monkeypatch.setattr(se, "_REQUIRED_CREDENTIALS", {})
    monkeypatch.setattr(se, "REPORTS_DIR", tmp_path / "reports")
    return SweepEngine(db_conn=conn, config={})


def _profile(conn, **overrides) -> dict:
    body = {"display_name": "Jane Doe",
            "identifiers": {"orcid": {"value": ORCID}}}
    body.update(overrides)
    return wp.create_profile(conn, body)


def _matches(conn) -> list[sqlite3.Row]:
    return conn.execute(
        "SELECT m.*, d.external_id FROM watch_profile_matches m "
        "JOIN documents d ON d.id = m.document_id").fetchall()


# ---------------------------------------------------------------------------
# P5 — only verified matches survive
# ---------------------------------------------------------------------------

def test_a_candidate_that_fails_verification_is_not_in_the_results(engine, conn):
    profile = _profile(conn)
    result = engine.execute_dive("fixture", {"entity_profile": profile,
                                             "max_results": 10})

    assert _EntitySource.asked, "the source was asked about the person"
    stored = {r["external_id"] for r in conn.execute(
        "SELECT external_id FROM documents")}
    assert stored == {"hers"}, (
        "the decoy the source volunteered must not reach the corpus")
    assert result["execution_id"]


def test_the_rejection_is_counted_in_the_run_rather_than_silently_dropped(engine, conn):
    profile = _profile(conn)
    exec_id = engine.execute_dive("fixture", {"entity_profile": profile})["execution_id"]
    row = conn.execute("SELECT log_path FROM executions WHERE id = ?",
                       (exec_id,)).fetchone()
    log = Path(row["log_path"]).read_text(encoding="utf-8")
    assert "did not survive verification" in log
    assert "1 of 2" in log


def test_the_match_row_carries_the_basis_the_evidence_supports(engine, conn):
    profile = _profile(conn)
    engine.execute_dive("fixture", {"entity_profile": profile})
    rows = _matches(conn)
    assert len(rows) == 1
    assert rows[0]["basis"] == "identifier"
    assert rows[0]["matched_author"] == "Jane Doe"
    assert ORCID in rows[0]["evidence"]


def test_a_profile_with_no_orcid_gets_the_weaker_basis_on_the_same_paper(engine, conn):
    """The same record, the same source, a different profile — a different claim."""
    profile = _profile(conn, identifiers={})
    engine.execute_dive("fixture", {"entity_profile": profile})
    rows = _matches(conn)
    assert len(rows) == 1
    assert rows[0]["basis"] == "name_only"


def test_an_affiliation_lifts_the_basis_without_an_identifier(engine, conn):
    profile = _profile(conn, identifiers={},
                       affiliations=["University of Somewhere"])
    engine.execute_dive("fixture", {"entity_profile": profile})
    assert _matches(conn)[0]["basis"] == "name+affiliation"


def test_a_second_run_keeps_first_seen_and_can_improve_the_basis(engine, conn):
    """A paper first matched by name and later by identifier should say so.

    `INSERT OR REPLACE` with `first_seen_at` preserved: the better claim is
    still true, and "when did this appear" must not move because the evidence
    improved.
    """
    weak = _profile(conn, identifiers={})
    engine.execute_dive("fixture", {"entity_profile": weak})
    first = _matches(conn)[0]
    assert first["basis"] == "name_only"

    strong = wp.update_profile(conn, weak["id"], {
        "display_name": "Jane Doe", "identifiers": {"orcid": {"value": ORCID}}})
    engine.execute_dive("fixture", {"entity_profile": strong})
    second = _matches(conn)[0]
    assert second["basis"] == "identifier"
    assert second["first_seen_at"] == first["first_seen_at"]


def test_a_paper_already_in_the_corpus_still_produces_a_match(engine, conn):
    """A watch routine that only surfaced brand-new documents would go quiet.

    Someone whose work you already collect is exactly the person you are most
    likely to watch, and dedup recognising their paper is not a reason to stop
    telling you it is theirs.
    """
    profile = _profile(conn)
    engine.execute_dive("fixture", {"entity_profile": profile})
    conn.execute("DELETE FROM watch_profile_matches")
    conn.commit()

    engine.execute_dive("fixture", {"entity_profile": profile})
    assert len(_matches(conn)) == 1, (
        "the document was a duplicate this time and is still her paper")


# ---------------------------------------------------------------------------
# The tenth zero reason
# ---------------------------------------------------------------------------

def test_a_source_that_cannot_be_asked_records_entity_unsupported(
    conn, monkeypatch, tmp_path,
):
    monkeypatch.setattr(se, "get_client", lambda _name: _CannotBeAsked())
    monkeypatch.setattr(se, "_REQUIRED_CREDENTIALS", {})
    monkeypatch.setattr(se, "REPORTS_DIR", tmp_path / "reports")
    engine = SweepEngine(db_conn=conn, config={})

    profile = _profile(conn)
    exec_id = engine.execute_dive(
        "fixture", {"entity_profile": profile})["execution_id"]

    row = conn.execute(
        "SELECT zero_reason FROM execution_sources WHERE execution_id = ?",
        (exec_id,)).fetchone()
    assert row["zero_reason"] == "entity_unsupported"

    log = Path(conn.execute(
        "SELECT log_path FROM executions WHERE id = ?", (exec_id,)
    ).fetchone()["log_path"]).read_text(encoding="utf-8")
    assert "no way to be asked" in log


def test_entity_unsupported_counts_as_not_answering():
    """A watch routine that listed the source as searched would overstate itself."""
    from implementation_scripts.zero_reason import DID_NOT_ANSWER, ZERO_REASONS

    assert "entity_unsupported" in ZERO_REASONS
    assert "entity_unsupported" in DID_NOT_ANSWER


def test_the_two_kinds_of_not_asked_have_different_sentences():
    """"We checked and it cannot" and "we could not check" are different facts.

    Only the first is about the source, and telling a user their source cannot
    do something when the truth is that resmon has no key for it would be a
    false statement about somebody else's API.
    """
    from implementation_scripts.zero_reason import sentence

    cannot = sentence("bioRxiv", "entity_unsupported", {})
    unknown = sentence("CORE", "entity_unsupported", {"detail": "unestablished"})
    assert "no way to be asked" in cannot
    assert "has not established" in unknown
    assert cannot != unknown


def test_a_keyword_sweep_is_untouched_by_any_of_this(engine, conn):
    """No `entity_profile`, no entity branch. The ordinary path is the default."""
    engine.execute_dive("fixture", {"query": "gravity", "max_results": 5})
    assert _EntitySource.asked == []
    assert conn.execute(
        "SELECT COUNT(*) FROM watch_profile_matches").fetchone()[0] == 0


# ---------------------------------------------------------------------------
# P6 — retractions are a join, and never a claim of resmon's own
# ---------------------------------------------------------------------------

def _seed_paper(conn, external_id: str, title: str) -> int:
    conn.execute(
        "INSERT INTO documents (source_repository, external_id, title, "
        "metadata_hash) VALUES ('fixture', ?, ?, ?)",
        (external_id, title, external_id))
    return conn.execute("SELECT id FROM documents WHERE external_id = ?",
                        (external_id,)).fetchone()["id"]


def _seed_finding(conn, document_id: int, **overrides) -> None:
    row = {"kind": "retraction", "severity": "critical",
           "notice_key": f"n{document_id}", "label": "Retraction",
           "notice_doi": "10.1/notice", "notice_url": "https://doi.org/10.1/notice",
           "notice_date": "2026-02-02", "detail": None,
           "provider": "crossref", "provider_source": "Retraction Watch"}
    row.update(overrides)
    conn.execute(
        "INSERT INTO document_lifecycle (document_id, kind, severity, notice_key, "
        " label, notice_doi, notice_url, notice_date, detail, provider, "
        " provider_source) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        (document_id, row["kind"], row["severity"], row["notice_key"], row["label"],
         row["notice_doi"], row["notice_url"], row["notice_date"], row["detail"],
         row["provider"], row["provider_source"]))
    conn.commit()


def test_retractions_are_only_findings_on_this_profile_s_papers(conn):
    profile = _profile(conn)
    other = wp.create_profile(conn, {"display_name": "Somebody Else"})

    hers = _seed_paper(conn, "hers", "Her paper")
    theirs = _seed_paper(conn, "theirs", "Their paper")
    conn.execute(
        "INSERT INTO watch_profile_matches (document_id, profile_id, basis, "
        "matched_author) VALUES (?, ?, 'identifier', 'Jane Doe')",
        (hers, profile["id"]))
    conn.execute(
        "INSERT INTO watch_profile_matches (document_id, profile_id, basis, "
        "matched_author) VALUES (?, ?, 'name_only', 'Somebody Else')",
        (theirs, other["id"]))
    conn.commit()
    _seed_finding(conn, hers)
    _seed_finding(conn, theirs)

    result = wp.profile_lifecycle_findings(conn, profile["id"])
    assert [f["title"] for f in result["findings"]] == ["Her paper"]


def test_every_finding_keeps_its_notice_link_and_its_provenance(conn):
    """`lifecycle.py`'s rule, at the point where breaking it would be worst.

    A false retraction attached to a named person is defamatory, so this join
    surfaces the notice resmon already holds and adds nothing to it — the label
    verbatim, the link resolvable, the Retraction Watch provenance carried
    through rather than flattened.
    """
    profile = _profile(conn)
    doc = _seed_paper(conn, "hers", "Her paper")
    conn.execute(
        "INSERT INTO watch_profile_matches (document_id, profile_id, basis, "
        "matched_author) VALUES (?, ?, 'identifier', 'Jane Doe')",
        (doc, profile["id"]))
    conn.commit()
    _seed_finding(conn, doc)

    finding = wp.profile_lifecycle_findings(conn, profile["id"])["findings"][0]
    assert finding["notice_url"] == "https://doi.org/10.1/notice"
    assert finding["label"] == "Retraction"
    assert finding["provider_source"] == "Retraction Watch"


def test_a_finding_carries_the_basis_of_the_match_it_arrived_through(conn):
    """A retraction on a `name_only` match is a finding about a *name*.

    Presenting it as this person's retraction would be the single worst thing
    this phase could do, so the basis rides on the finding and the interface
    has it to print.
    """
    profile = wp.create_profile(conn, {"display_name": "John Smith"})
    doc = _seed_paper(conn, "maybe", "A paper by some John Smith")
    conn.execute(
        "INSERT INTO watch_profile_matches (document_id, profile_id, basis, "
        "matched_author) VALUES (?, ?, 'name_only', 'John Smith')",
        (doc, profile["id"]))
    conn.commit()
    _seed_finding(conn, doc)

    finding = wp.profile_lifecycle_findings(conn, profile["id"])["findings"][0]
    assert finding["basis"] == "name_only"


def test_nothing_checked_is_reported_separately_from_nothing_found(conn):
    """"No retractions" and "nobody looked" are different facts."""
    profile = _profile(conn)
    doc = _seed_paper(conn, "hers", "Her paper")
    conn.execute(
        "INSERT INTO watch_profile_matches (document_id, profile_id, basis, "
        "matched_author) VALUES (?, ?, 'identifier', 'Jane Doe')",
        (doc, profile["id"]))
    conn.commit()

    result = wp.profile_lifecycle_findings(conn, profile["id"])
    assert result["findings"] == []
    assert result["matched_documents"] == 1
    assert result["checked_documents"] == 0
    assert "have not been looked at" in result["coverage_note"]

    conn.execute(
        "INSERT INTO document_lifecycle_checks (document_id, checked_at, status) "
        "VALUES (?, datetime('now'), 'ok')", (doc,))
    conn.commit()
    assert wp.profile_lifecycle_findings(conn, profile["id"])["checked_documents"] == 1


def test_the_join_invents_no_finding_of_its_own(conn):
    """The mutation the brief names: drop the profile join.

    With the join gone this returns every finding in the corpus for every
    profile, which is the shape of "resmon asserted a retraction about someone".
    """
    profile = _profile(conn)
    theirs = _seed_paper(conn, "theirs", "Somebody else's retracted paper")
    _seed_finding(conn, theirs)
    assert wp.profile_lifecycle_findings(conn, profile["id"])["findings"] == []


@pytest.mark.parametrize("name,orcid,affiliation,expected,evidence", [
    ("Jane Doe", "0000-0001-5109-3700", "MIT", "name_only", "conflicting ORCID"),
    ("Plato", None, "MIT", "name_only", "ambiguous single-token name"),
    ("Jane Doe", None, "Summit Institute", "name_only", "exact name"),
    ("Jane Doe", None, "MIT", "name+affiliation", "affiliation"),
    ("J. Doe", None, "", "name_only", "initials only"),
])
def test_corrected_evidence_survives_the_actual_sweep_and_storage(
        engine, conn, monkeypatch, name, orcid, affiliation, expected, evidence):
    profile = _profile(conn, names=["Jane Doe", "Plato"], affiliations=["MIT"])

    def candidates(self, *args, **kwargs):
        return [NormalizedResult(source_repository="fixture", external_id="trust",
                title="Synthetic trust candidate", doi=None, abstract=None, publication_date=None, url=None, authors=[Author(name, orcid=orcid,
                affiliations=(affiliation,))])]

    monkeypatch.setattr(_EntitySource, "search_entity", candidates)
    engine.execute_dive("fixture", {"entity_profile": profile})
    rows = _matches(conn)
    assert len(rows) == 1
    assert rows[0]["basis"] == expected
    assert evidence in rows[0]["evidence"]
    assert rows[0]["evidence"].startswith("Matching policy 2026-09-07: ")



def test_new_sweep_does_not_rewrite_or_delete_a_rejected_historical_match(engine, conn, monkeypatch):
    profile = _profile(conn, names=["B. Smith"])
    doc = conn.execute("INSERT INTO documents (source_repository,external_id,title,metadata_hash) VALUES ('fixture','historical','Old candidate','old-hash')").lastrowid
    conn.execute("INSERT INTO watch_profile_matches (document_id,profile_id,basis,matched_author,evidence) VALUES (?,?,'name_only','A. Smith','old policy evidence')", (doc, profile["id"]))
    conn.commit()
    before = tuple(conn.execute("SELECT * FROM watch_profile_matches").fetchone())

    def candidates(self, *args, **kwargs):
        return [NormalizedResult(source_repository="fixture", external_id="historical",
                title="Old candidate", doi=None, abstract=None, publication_date=None,
                url=None, authors=[Author("A. Smith")])]

    monkeypatch.setattr(_EntitySource, "search_entity", candidates)
    engine.execute_dive("fixture", {"entity_profile": profile})
    assert tuple(conn.execute("SELECT * FROM watch_profile_matches").fetchone()) == before
    assert conn.execute("SELECT count(*) FROM documents").fetchone()[0] == 1
