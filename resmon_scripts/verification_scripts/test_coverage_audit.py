"""The coverage audit: two lists, and the one claim it is entitled to make.

**P14 is the property that keeps the second list honest.** "Missed in the corpus"
means *this routine never returned it and something else found it*. A paper the
routine did return, appearing in that list, would tell its owner to widen a query
that already covers the paper — the exact opposite of the advice. The exclusion is
a set difference over ``execution_documents``, and the mutation is to drop it.

The other half is what the audit refuses to say. resmon has no idea what exists
in the literature and is not in the corpus, so "missed" is never "missed by
resmon", and ``cannot_see`` travels in the payload rather than being left to
whichever surface renders it.

Vectors are hand-written so distances are exact and the distribution is
predictable; the real corpus is where the *feature* was exercised (see the 1.9b
handback's field-test section).
"""

from __future__ import annotations

import json
import sqlite3
import sys
from pathlib import Path

import pytest

PROJECT_ROOT = Path(__file__).resolve().parent.parent.parent
sys.path.insert(0, str(PROJECT_ROOT / "resmon_scripts"))

from implementation_scripts import coverage_audit, vector_index  # noqa: E402
from implementation_scripts.database import init_db  # noqa: E402

pytest.importorskip("sqlite_vec")

MODEL = "test-model"


@pytest.fixture
def conn(tmp_path):
    connection = sqlite3.connect(str(tmp_path / "corpus.db"))
    connection.row_factory = sqlite3.Row
    init_db(conn=connection)
    yield connection
    connection.close()


def _routine(conn, name: str, *, keywords: str = "", intent: str | None = None) -> dict:
    cursor = conn.execute(
        "INSERT INTO routines (name, schedule_cron, parameters, intent) "
        "VALUES (?, '0 9 * * *', ?, ?)",
        (name, json.dumps({"keywords": keywords}), intent),
    )
    conn.commit()
    return dict(conn.execute(
        "SELECT * FROM routines WHERE id = ?", (cursor.lastrowid,)).fetchone())


def _paper(conn, external_id: str, vector: list[float], *, title: str = "A paper") -> int:
    cursor = conn.execute(
        "INSERT INTO documents (source_repository, external_id, title, metadata_hash) "
        "VALUES ('arxiv', ?, ?, ?)", (external_id, title, f"h-{external_id}"),
    )
    doc_id = int(cursor.lastrowid)
    conn.execute(
        "INSERT INTO document_embeddings (document_id, model, dims, vector, fields) "
        "VALUES (?, ?, ?, ?, 'title+abstract')",
        (doc_id, MODEL, len(vector), vector_index.pack_vector(vector)),
    )
    conn.commit()
    return doc_id


def _returned_by(conn, routine_id: int, document_ids: list[int]) -> None:
    """Record that an execution of this routine returned these documents."""
    cursor = conn.execute(
        "INSERT INTO executions (execution_type, routine_id, parameters, start_time, "
        "status) VALUES ('automated_sweep', ?, '{}', '2026-01-01T00:00:00Z', 'completed')",
        (routine_id,),
    )
    exec_id = int(cursor.lastrowid)
    conn.executemany(
        "INSERT INTO execution_documents (execution_id, document_id, is_new) "
        "VALUES (?, ?, 1)", [(exec_id, d) for d in document_ids],
    )
    conn.commit()


def _v(*values: float) -> bytes:
    return vector_index.pack_vector(list(values))


# ---------------------------------------------------------------------------
# Where the intent comes from
# ---------------------------------------------------------------------------


def test_a_stated_intent_is_used_and_labelled_as_stated(conn):
    routine = _routine(conn, "r", keywords="graph neural networks",
                       intent="methods for irregular time series in astronomy")
    text, source = coverage_audit.intent_for(routine)
    assert text == "methods for irregular time series in astronomy"
    assert source == "stated"


def test_without_one_the_keywords_are_used_and_labelled_as_keywords(conn):
    """The distinction is load-bearing, not cosmetic.

    Comparing a routine's keywords against results those keywords produced is
    measuring a query against itself, and the interface has to be able to say so.
    """
    routine = _routine(conn, "r", keywords="graph neural networks")
    assert coverage_audit.intent_for(routine) == ("graph neural networks", "keywords")


def test_a_keyword_list_is_joined_rather_than_stringified(conn):
    cursor = conn.execute(
        "INSERT INTO routines (name, schedule_cron, parameters) VALUES ('r', '0 9 * * *', ?)",
        (json.dumps({"keywords": ["graph", "neural"]}),),
    )
    conn.commit()
    routine = dict(conn.execute(
        "SELECT * FROM routines WHERE id = ?", (cursor.lastrowid,)).fetchone())
    assert coverage_audit.intent_for(routine)[0] == "graph neural"


def test_unparseable_parameters_yield_no_intent_rather_than_raising(conn):
    cursor = conn.execute(
        "INSERT INTO routines (name, schedule_cron, parameters) "
        "VALUES ('r', '0 9 * * *', 'not json')")
    conn.commit()
    routine = dict(conn.execute(
        "SELECT * FROM routines WHERE id = ?", (cursor.lastrowid,)).fetchone())
    assert coverage_audit.intent_for(routine) == ("", "keywords")


# ---------------------------------------------------------------------------
# P14 — the missed list excludes what the routine returned
# ---------------------------------------------------------------------------


@pytest.fixture
def seeded(conn):
    """A routine that returned four on-topic papers and missed two more.

    All six are near the intent; the two the routine never returned are the
    answer, and the four it did are the trap.
    """
    routine = _routine(conn, "astro", keywords="irregular time series",
                       intent="irregular astronomical time series")
    returned = [_paper(conn, f"got-{i}", [1.0, i * 0.01, 0.0, 0.0], title=f"Returned {i}")
                for i in range(4)]
    missed = [_paper(conn, f"miss-{i}", [1.0, i * 0.005, 0.0, 0.0], title=f"Missed {i}")
              for i in range(2)]
    far = [_paper(conn, "far", [0.0, 0.0, 1.0, 0.0], title="Soil microbes")]
    vector_index.rebuild(conn, MODEL)
    _returned_by(conn, int(routine["id"]), returned)
    return {"routine": routine, "returned": returned, "missed": missed, "far": far}


def test_the_missed_list_contains_only_papers_the_routine_never_returned(conn, seeded):
    """P14.

    **Mutation:** delete the ``if doc_id not in returned_set`` clause in
    ``audit_routine``. This test then finds the routine's own results in its
    "missed" list and fails.
    """
    audit = coverage_audit.audit_routine(
        conn, seeded["routine"], MODEL, _v(1.0, 0.0, 0.0, 0.0))
    missed_ids = {row["id"] for row in audit["missed_in_corpus"]}

    assert missed_ids, "nothing was found as missed; the test cannot establish its point"
    assert missed_ids.isdisjoint(set(seeded["returned"])), (
        "a paper this routine returned appeared in its missed list"
    )
    assert set(seeded["missed"]) <= missed_ids


def test_a_paper_returned_by_a_different_routine_still_counts_as_missed(conn, seeded):
    """The exclusion is per routine, not corpus-wide.

    "Another routine found it and this one did not" is precisely the actionable
    case; excluding anything any routine ever returned would empty the list.
    """
    other = _routine(conn, "other", keywords="anything")
    _returned_by(conn, int(other["id"]), seeded["missed"])
    audit = coverage_audit.audit_routine(
        conn, seeded["routine"], MODEL, _v(1.0, 0.0, 0.0, 0.0))
    assert set(seeded["missed"]) <= {r["id"] for r in audit["missed_in_corpus"]}


def test_a_paper_returned_by_an_older_execution_of_this_routine_is_excluded(conn, seeded):
    """"Ever returned", not "returned by the latest run"."""
    extra = _paper(conn, "old", [1.0, 0.001, 0.0, 0.0], title="Found long ago")
    vector_index.rebuild(conn, MODEL)
    _returned_by(conn, int(seeded["routine"]["id"]), [extra])
    audit = coverage_audit.audit_routine(
        conn, seeded["routine"], MODEL, _v(1.0, 0.0, 0.0, 0.0))
    assert extra not in {r["id"] for r in audit["missed_in_corpus"]}


def test_a_paper_far_from_the_intent_is_not_reported_as_missed(conn, seeded):
    """The list is "close and not returned", not "everything not returned"."""
    audit = coverage_audit.audit_routine(
        conn, seeded["routine"], MODEL, _v(1.0, 0.0, 0.0, 0.0))
    assert seeded["far"][0] not in {r["id"] for r in audit["missed_in_corpus"]}


# ---------------------------------------------------------------------------
# The off-target distribution
# ---------------------------------------------------------------------------


def test_the_cutoff_comes_from_the_routines_own_results(conn):
    """Not an absolute distance: a fixed radius means different things per model."""
    routine = _routine(conn, "r", intent="on topic")
    close = [_paper(conn, f"c{i}", [1.0, i * 0.001, 0.0, 0.0]) for i in range(12)]
    drifting = [_paper(conn, f"d{i}", [1.0, 0.5 + i * 0.1, 0.0, 0.0]) for i in range(4)]
    vector_index.rebuild(conn, MODEL)
    _returned_by(conn, int(routine["id"]), close + drifting)

    audit = coverage_audit.audit_routine(conn, routine, MODEL, _v(1.0, 0.0, 0.0, 0.0))
    dist = audit["distribution"]
    assert dist["count"] == 16
    assert dist["min"] < dist["median"] < dist["p75_cutoff"] <= dist["max"]
    off = {r["id"] for r in audit["off_target"]}
    assert off, "a quartile of sixteen results must be non-empty"
    assert off <= set(drifting), "the furthest results are the drifting ones"


def test_too_few_results_declines_to_draw_a_cutoff_and_says_why(conn):
    """A quartile of nine numbers is a number pretending to be a measurement."""
    routine = _routine(conn, "r", intent="on topic")
    papers = [_paper(conn, f"p{i}", [1.0, i * 0.01, 0.0, 0.0]) for i in range(5)]
    vector_index.rebuild(conn, MODEL)
    _returned_by(conn, int(routine["id"]), papers)

    audit = coverage_audit.audit_routine(conn, routine, MODEL, _v(1.0, 0.0, 0.0, 0.0))
    assert audit["distribution"] is None
    assert audit["off_target"] == []
    assert "at least 12" in audit["reason"]
    # The rest of the audit still ran.
    assert audit["results"] == 5 and audit["results_embedded"] == 5


# ---------------------------------------------------------------------------
# What it cannot see
# ---------------------------------------------------------------------------


def test_every_audit_carries_the_sentence_about_what_resmon_cannot_see(conn, seeded):
    """One sentence, in the payload, so three surfaces cannot each invent one."""
    audit = coverage_audit.audit_routine(
        conn, seeded["routine"], MODEL, _v(1.0, 0.0, 0.0, 0.0))
    assert audit["cannot_see"] == coverage_audit.CANNOT_SEE
    assert "only compare against papers it already holds" in audit["cannot_see"]


def test_a_routine_with_no_results_says_so_rather_than_reporting_perfection(conn):
    """Zero off-target because there is nothing to be off-target is not a clean bill."""
    routine = _routine(conn, "new", intent="something")
    audit = coverage_audit.audit_routine(conn, routine, MODEL, _v(1.0, 0.0, 0.0, 0.0))
    assert audit["results"] == 0
    assert "has not returned any papers yet" in audit["reason"]
    assert audit["off_target"] == [] and audit["missed_in_corpus"] == []


def test_results_that_are_not_embedded_are_reported_as_such(conn):
    """"We could not measure this" and "there is nothing wrong" are different."""
    routine = _routine(conn, "r", intent="something")
    cursor = conn.execute(
        "INSERT INTO documents (source_repository, external_id, title, metadata_hash) "
        "VALUES ('arxiv', 'unembedded', 'No vector', 'h')")
    conn.commit()
    _returned_by(conn, int(routine["id"]), [int(cursor.lastrowid)])
    # An index exists for the model, but this paper is not in it.
    _paper(conn, "other", [1.0, 0, 0, 0])
    vector_index.rebuild(conn, MODEL)

    audit = coverage_audit.audit_routine(conn, routine, MODEL, _v(1.0, 0, 0, 0))
    assert audit["results"] == 1
    assert audit["results_embedded"] == 0
    assert "are embedded yet" in audit["reason"]


def test_no_extension_is_reported_rather_than_an_empty_audit(conn, seeded, monkeypatch):
    monkeypatch.setattr(vector_index, "load_extension", lambda _c: None)
    audit = coverage_audit.audit_routine(
        conn, seeded["routine"], MODEL, _v(1.0, 0, 0, 0))
    assert audit["off_target"] == [] and audit["missed_in_corpus"] == []
    assert "cannot load it" in audit["reason"]


# ---------------------------------------------------------------------------
# The summary sentence
# ---------------------------------------------------------------------------


def test_the_summary_never_states_a_count_without_the_caveat(conn, seeded):
    """A harness pasting "300 off target" as a verdict is the overclaim risk."""
    audit = coverage_audit.audit_routine(
        conn, seeded["routine"], MODEL, _v(1.0, 0.0, 0.0, 0.0))
    assert audit["missed_in_corpus"], "the fixture must produce a finding"
    line = coverage_audit.summary_line(audit)
    assert coverage_audit.CANNOT_SEE in line


def test_a_finding_survives_a_reason_that_only_covers_the_other_half(conn, seeded):
    """The bug this test was written for.

    ``seeded`` has four embedded results — too few for an off-target cutoff — and
    two papers the routine missed. An earlier ``summary_line`` returned only the
    "too few results" reason and silently dropped the missed papers, which are
    the actionable half. Both are reported now.
    """
    audit = coverage_audit.audit_routine(
        conn, seeded["routine"], MODEL, _v(1.0, 0.0, 0.0, 0.0))
    assert audit["distribution"] is None and audit["reason"]
    assert len(audit["missed_in_corpus"]) == 2

    line = coverage_audit.summary_line(audit)
    assert "2 papers already in the corpus" in line   # the finding
    assert "at least 12" in line                      # and why the other half is absent
    assert coverage_audit.CANNOT_SEE in line


def test_a_clean_routine_is_described_as_nothing_standing_out(conn):
    routine = _routine(conn, "r", intent="on topic")
    papers = [_paper(conn, f"p{i}", [1.0, 0.0, 0.0, 0.0]) for i in range(12)]
    vector_index.rebuild(conn, MODEL)
    _returned_by(conn, int(routine["id"]), papers)
    audit = coverage_audit.audit_routine(conn, routine, MODEL, _v(1.0, 0, 0, 0))
    assert "Nothing stands out" in coverage_audit.summary_line(audit)


def test_the_summary_of_an_unmeasurable_routine_is_its_reason(conn):
    routine = _routine(conn, "new", intent="something")
    audit = coverage_audit.audit_routine(conn, routine, MODEL, _v(1.0, 0, 0, 0))
    assert coverage_audit.summary_line(audit) == audit["reason"]


# ---------------------------------------------------------------------------
# Both lists are a page, and the payload says how big the whole is
# ---------------------------------------------------------------------------


def test_the_off_target_total_counts_every_result_beyond_the_cutoff(conn):
    """R2. The list stops at ``max_off_target``; the total does not.

    A routine with 300 off-target results shows 25 of them, and a reader given
    25 rows and no count reads that as "25 results are off target" — a number
    resmon never measured. **Mutation:** set ``off_target_total`` to
    ``len(payload["off_target"])`` and this fails, because the two are
    deliberately different.
    """
    routine = _routine(conn, "r", intent="on topic")
    close = [_paper(conn, f"c{i}", [1.0, i * 0.0001, 0.0, 0.0]) for i in range(12)]
    drifting = [_paper(conn, f"d{i}", [1.0, 0.5 + i * 0.01, 0.0, 0.0]) for i in range(8)]
    vector_index.rebuild(conn, MODEL)
    _returned_by(conn, int(routine["id"]), close + drifting)

    audit = coverage_audit.audit_routine(
        conn, routine, MODEL, _v(1.0, 0.0, 0.0, 0.0), max_off_target=3)
    assert len(audit["off_target"]) == 3, "the page is capped"
    assert audit["off_target_total"] == 5, "the quartile of twenty is five"


def test_the_missed_total_counts_every_close_paper_the_routine_never_returned(conn):
    """The same for the second list, and the same reason."""
    routine = _routine(conn, "r", intent="on topic")
    returned = [_paper(conn, f"got{i}", [1.0, 0.02 + i * 0.001, 0.0, 0.0])
                for i in range(12)]
    missed = [_paper(conn, f"miss{i}", [1.0, i * 0.0001, 0.0, 0.0]) for i in range(6)]
    vector_index.rebuild(conn, MODEL)
    _returned_by(conn, int(routine["id"]), returned)

    audit = coverage_audit.audit_routine(
        conn, routine, MODEL, _v(1.0, 0.0, 0.0, 0.0), max_missed=2)
    assert len(audit["missed_in_corpus"]) == 2
    assert audit["missed_in_corpus_total"] == len(missed)
    # The index held every candidate, so the number is a count and not a floor.
    # A flag that were always ``True`` would carry no information; this is the
    # companion to the saturated case below.
    assert audit["missed_in_corpus_total_is_lower_bound"] is False


def test_a_missed_total_the_index_query_could_not_finish_is_marked_as_a_floor(conn):
    """"25 of at least 63" when 63 is all resmon looked at.

    The missed side is a bounded KNN, not a scan: its budget is
    ``max_missed + len(returned) + 50``. When the query comes back full **and**
    its furthest row is still inside the reference distance, papers beyond the
    budget were never examined, so the total is a floor. Reporting it as an exact
    count would be a number resmon did not measure — the same class of overclaim
    as a truncated list with no caption at all.

    Eighty unreturned papers, all nearer the intent than anything the routine
    returned, against a budget of 63: the arithmetic is fixed, not incidental.
    """
    routine = _routine(conn, "r", intent="on topic")
    returned = [_paper(conn, f"got{i}", [1.0, 0.05 + i * 0.001, 0.0, 0.0])
                for i in range(12)]
    for i in range(80):
        _paper(conn, f"miss{i}", [1.0, i * 0.00001, 0.0, 0.0])
    vector_index.rebuild(conn, MODEL)
    _returned_by(conn, int(routine["id"]), returned)

    audit = coverage_audit.audit_routine(
        conn, routine, MODEL, _v(1.0, 0.0, 0.0, 0.0), max_missed=1)
    budget = 1 + len(returned) + 50
    assert audit["missed_in_corpus_total_is_lower_bound"] is True
    assert audit["missed_in_corpus_total"] == budget
    assert audit["missed_in_corpus_total"] < 80, "the floor is below the truth, as it must be"
    assert len(audit["missed_in_corpus"]) == 1


def test_the_summary_reports_the_totals_rather_than_the_page(conn):
    """A one-sentence summary saying "25" for a routine with 312 is worse than
    silence: it is precise and wrong, and the MCP surface repeats it verbatim."""
    routine = _routine(conn, "r", intent="on topic")
    close = [_paper(conn, f"c{i}", [1.0, i * 0.0001, 0.0, 0.0]) for i in range(12)]
    drifting = [_paper(conn, f"d{i}", [1.0, 0.5 + i * 0.01, 0.0, 0.0]) for i in range(8)]
    vector_index.rebuild(conn, MODEL)
    _returned_by(conn, int(routine["id"]), close + drifting)

    audit = coverage_audit.audit_routine(
        conn, routine, MODEL, _v(1.0, 0.0, 0.0, 0.0), max_off_target=3)
    line = coverage_audit.summary_line(audit)
    assert "5 results sit furthest" in line
    assert "3 results" not in line


def test_a_floor_is_worded_as_at_least(conn, seeded):
    """The summary carries the qualifier the payload carries.

    (``summary_line`` runs ``capitalize()`` over the joined clauses, so the
    sentence opens "At least"; the comparison is case-insensitive rather than
    pinning a capitalisation this test does not care about.)
    """
    audit = coverage_audit.audit_routine(
        conn, seeded["routine"], MODEL, _v(1.0, 0.0, 0.0, 0.0))
    audit["missed_in_corpus_total_is_lower_bound"] = True
    line = coverage_audit.summary_line(audit).lower()
    assert "at least 2 papers already in the corpus" in line
