"""The source wall: one source's answer to one run, across runs.

`execution_sources` has held these rows since schema 6 and nothing has ever
read them across executions. These cases are about the reader, and about the
one thing a coverage wall must never do: turn an outcome resmon did not
observe into either a tick or a cross.

The denominators here come from the code on both sides --
`zero_reason.ZERO_REASONS`, `zero_reason.DID_NOT_ANSWER` and
`source_wall.WALL_STATES` -- so a reason added to the backend turns this file
red rather than arriving at a user as a cell with no rule.

What this file cannot see: what the wall looks like. Every assertion here is
about the served payload; whether five states are distinguishable to a person
looking at the screen is not a thing a pytest run can establish.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from implementation_scripts import database as db  # noqa: E402
from implementation_scripts import source_coverage as coverage  # noqa: E402
from implementation_scripts import source_wall, zero_reason  # noqa: E402
import resmon as resmon_mod  # noqa: E402


@pytest.fixture
def conn(tmp_path):
    """A real file-backed corpus that `resmon._get_db()` also opens."""
    resmon_mod._db_path = str(tmp_path / "corpus.db")
    resmon_mod._shared_conn = None
    resmon_mod._db_initialized = False
    connection = resmon_mod._get_db()
    try:
        yield connection
    finally:
        resmon_mod._close_db(connection)
        resmon_mod._db_path = None
        resmon_mod._shared_conn = None
        resmon_mod._db_initialized = False


@pytest.fixture
def client(conn):
    from fastapi.testclient import TestClient

    with TestClient(resmon_mod.app) as c:
        yield c


def make_run(conn, *, started: str, repositories=None, status: str = "completed") -> int:
    params = {"keywords": ["x"]}
    if repositories is not None:
        params["repositories"] = list(repositories)
    cursor = conn.execute(
        """
        INSERT INTO executions (execution_type, parameters, start_time, status)
        VALUES ('deep_sweep', ?, ?, ?)
        """,
        (json.dumps(params), started, status),
    )
    conn.commit()
    return int(cursor.lastrowid)


def record(conn, exec_id, source, status="ok", *, count=0, reason=None, detail=None):
    db.record_execution_source(
        conn, exec_id, source, status,
        result_count=count, zero_reason=reason,
        zero_detail=json.dumps(detail) if detail is not None else None,
    )


def cell_for(wall, slug, index=-1):
    source = next(s for s in wall["sources"] if s["slug"] == slug)
    return source["cells"][index]


# ---------------------------------------------------------------------------
# The vocabulary, with its denominator taken from the backend
# ---------------------------------------------------------------------------


def test_the_non_answer_map_covers_exactly_the_backend_non_answer_set():
    """A reason added to `DID_NOT_ANSWER` must turn this red, not ship.

    The sixth copy of this classification is the defect that put a tick on
    sources that could not be asked. This wall does not keep a list of
    non-answer reasons; it keeps a list of *states* for the backend's list,
    and the two sets are asserted equal rather than reviewed by eye.
    """
    assert set(source_wall.STATE_FOR_NON_ANSWER) == set(zero_reason.DID_NOT_ANSWER)
    assert set(source_wall.STATE_FOR_NON_ANSWER.values()) == {
        "could_not_be_asked", "failed",
    }


@pytest.mark.parametrize("reason", zero_reason.ZERO_REASONS)
def test_every_recorded_reason_reaches_exactly_one_wall_state(reason):
    mapped = source_wall.mapped_reasons()
    assert reason in mapped, f"{reason} has no wall state"
    assert mapped[reason] in source_wall.WALL_STATES
    assert set(mapped) == set(zero_reason.ZERO_REASONS)


def test_the_states_are_the_six_the_screen_draws():
    """Five were approved; the sixth is here because the data had it.

    `not_selected` and `not_recorded` are both silences and they are not the
    same silence: one is a choice the user made and the other is a hole in the
    record. Collapsing them is the same compression as calling a 503 an empty
    field, one level down.
    """
    assert source_wall.WALL_STATES == (
        "answered", "answered_empty", "could_not_be_asked", "failed",
        "not_recorded", "not_selected",
    )


def test_the_legend_word_for_a_state_is_the_backend_s_own_word():
    """The renderer holds no copy of this vocabulary, and neither does a brief.

    A zero that is a real answer is called *answered, zero* by
    `source_coverage.outcome`, and the legend on the wall has to call it that
    too. The renderer was burned this week by keeping its own copy of exactly
    this vocabulary; the fix direction is that the backend owns the word and
    every surface takes it, not that the backend is edited to match a screen.
    """
    legend = {entry["state"]: entry["label"] for entry in source_wall.STATE_LEGEND}
    assert [entry["state"] for entry in source_wall.STATE_LEGEND] == list(source_wall.WALL_STATES)

    quiet = coverage.outcome({"source": "x", "status": "ok", "result_count": 0,
                              "zero_reason": "answered_empty"})
    assert legend["answered_empty"] == quiet["label"] == "answered, zero"

    got = coverage.outcome({"source": "x", "status": "ok", "result_count": 3,
                            "zero_reason": None})
    assert legend["answered"] == got["label"] == "answered"

    for entry in source_wall.STATE_LEGEND:
        assert entry["label"] and entry["meaning"]


# ---------------------------------------------------------------------------
# One cell per source per run, classified by the backend that already does it
# ---------------------------------------------------------------------------


def test_each_of_the_six_states_is_reachable_from_stored_rows(conn):
    """Rows a real sweep can write, and six distinct cells out."""
    slugs = ["arxiv", "biorxiv", "crossref", "doaj", "europe_pmc"]
    run = make_run(conn, started="2026-10-01T09:00:00", repositories=slugs)
    record(conn, run, "arxiv", count=7)
    record(conn, run, "biorxiv", count=0, reason="answered_empty")
    record(conn, run, "crossref", status="skipped_missing_key", reason="missing_key")
    record(conn, run, "doaj", count=0, reason="upstream_failure",
           detail={"status": 503, "attempts": 3})
    record(conn, run, "europe_pmc", count=0, reason=None)

    wall = source_wall.build(conn)

    assert cell_for(wall, "arxiv")["state"] == "answered"
    assert cell_for(wall, "biorxiv")["state"] == "answered_empty"
    assert cell_for(wall, "crossref")["state"] == "could_not_be_asked"
    assert cell_for(wall, "doaj")["state"] == "failed"
    assert cell_for(wall, "europe_pmc")["state"] == "not_recorded"
    # The sixth comes from a row recorded outside this run's saved selection,
    # which gives the grid a source the run never asked.
    record(conn, run, "zenodo", count=1)
    later = make_run(conn, started="2026-10-02T09:00:00", repositories=slugs)
    record(conn, later, "arxiv", count=1)
    wall = source_wall.build(conn)
    assert cell_for(wall, "zenodo", 0)["state"] == "answered"
    assert cell_for(wall, "zenodo", 1)["state"] == "not_selected"
    assert {c["state"] for s in wall["sources"] for c in s["cells"]} == set(
        source_wall.WALL_STATES
    )
    # The cell carries the backend's own sentence; no consumer re-words it.
    assert "503" in cell_for(wall, "doaj", 0)["note"]


@pytest.mark.parametrize("reason", ["rights_filtered", "records_unusable"])
def test_a_reply_whose_records_resmon_could_not_keep_is_not_a_quiet_field(conn, reason):
    """The source answered *with records*. Drawing a quiet field would lie.

    `answered_empty` means the field had nothing. A rights-filtered zero means
    the field had something and resmon declined to store it, which is a
    statement about resmon, not about the literature.
    """
    run = make_run(conn, started="2026-10-01T09:00:00", repositories=["ndl"])
    record(conn, run, "ndl", count=0, reason=reason,
           detail={"matched": 12, "kept": 0, "rights": 9, "incomplete": 3})

    cell = cell_for(source_wall.build(conn), "ndl")

    assert cell["state"] == "answered"
    assert cell["state"] != "answered_empty"
    assert "12" in cell["note"]


@pytest.mark.parametrize("row", [
    {"status": "ok", "count": 0, "reason": None},
    {"status": "ok", "count": 0, "reason": "not_recorded"},
    {"status": "cancelled", "count": 0, "reason": None},
])
def test_an_unobserved_outcome_is_never_drawn_as_success_or_failure(conn, row):
    run = make_run(conn, started="2026-10-01T09:00:00", repositories=["arxiv"])
    record(conn, run, "arxiv", row["status"], count=row["count"], reason=row["reason"])

    wall = source_wall.build(conn)
    cell = cell_for(wall, "arxiv")

    assert cell["state"] == "not_recorded"
    assert wall["totals"]["answered"] == 0
    assert wall["totals"]["failed"] == 0
    assert wall["verdict"]["level"] == "unknown"
    assert "cannot say" in wall["verdict"]["headline"]


def test_the_two_silences_are_drawn_apart(conn):
    """"I did not ask" and "I asked and do not know" are different marks.

    The first is a choice the user made; the second is a hole in the record.
    Both used to draw as `not_recorded` with different hover text, which put
    the whole distinction behind a mouse.
    """
    run = make_run(conn, started="2026-10-01T09:00:00", repositories=["arxiv", "doaj"])
    record(conn, run, "arxiv", count=4)
    record(conn, run, "pubmed", count=2)  # recorded, outside the saved selection
    second = make_run(conn, started="2026-10-02T09:00:00", repositories=["arxiv"])
    record(conn, second, "arxiv", count=5)

    wall = source_wall.build(conn)

    asked_and_unknown = cell_for(wall, "doaj", 0)
    assert asked_and_unknown["state"] == "not_recorded"
    assert asked_and_unknown["outcome_recorded"] is False
    assert asked_and_unknown["in_selection"] is True
    assert "recorded no outcome" in asked_and_unknown["note"]

    never_asked = cell_for(wall, "doaj", 1)
    assert never_asked["state"] == "not_selected"
    assert never_asked["in_selection"] is False
    assert "not asked" in never_asked["note"]

    # The source outside the selection still has a row: it was recorded.
    assert cell_for(wall, "pubmed", 0)["state"] == "answered"
    assert cell_for(wall, "pubmed", 0)["in_selection"] is False


def test_an_unknown_saved_selection_is_not_turned_into_a_choice(conn):
    """No usable selection means resmon cannot say the source was not asked."""
    run = make_run(conn, started="2026-10-01T09:00:00", repositories=None)
    record(conn, run, "arxiv", count=4)
    later = make_run(conn, started="2026-10-02T09:00:00", repositories=None)
    record(conn, later, "doaj", count=1)

    wall = source_wall.build(conn)

    silent = cell_for(wall, "arxiv", 1)
    assert silent["state"] == "not_recorded"
    assert silent["in_selection"] is None
    assert "unknown" in silent["note"]


def test_a_source_dropped_from_the_selection_keeps_its_row(conn):
    """Its disappearance is the thing the user came to the wall to see."""
    first = make_run(conn, started="2026-10-01T09:00:00", repositories=["arxiv", "doaj"])
    record(conn, first, "arxiv", count=4)
    record(conn, first, "doaj", count=2)
    second = make_run(conn, started="2026-10-02T09:00:00", repositories=["arxiv"])
    record(conn, second, "arxiv", count=5)

    wall = source_wall.build(conn)

    assert [s["slug"] for s in wall["sources"]] == ["arxiv", "doaj"]
    doaj = next(s for s in wall["sources"] if s["slug"] == "doaj")
    assert [c["state"] for c in doaj["cells"]] == ["answered", "not_selected"]
    assert doaj["cells"][1]["in_selection"] is False


def test_runs_read_oldest_to_newest_and_sources_hold_their_position(conn):
    older = make_run(conn, started="2026-10-01T09:00:00", repositories=["zenodo"])
    newer = make_run(conn, started="2026-10-05T09:00:00", repositories=["arxiv"])
    record(conn, older, "zenodo", count=1)
    record(conn, newer, "arxiv", count=1)

    wall = source_wall.build(conn)

    assert [r["execution_id"] for r in wall["runs"]] == [older, newer]
    # Alphabetical by display name, and every cell names the run it belongs to.
    assert [s["name"] for s in wall["sources"]] == sorted(
        (s["name"] for s in wall["sources"]), key=str.lower
    )
    for source in wall["sources"]:
        assert [c["execution_id"] for c in source["cells"]] == [older, newer]


# ---------------------------------------------------------------------------
# The verdict, in words
# ---------------------------------------------------------------------------


def test_a_source_that_stopped_answering_is_named_rather_than_counted(conn):
    for day, count in ((1, 9), (2, 7)):
        run = make_run(conn, started=f"2026-10-0{day}T09:00:00", repositories=["arxiv"])
        record(conn, run, "arxiv", count=count)
    broken = make_run(conn, started="2026-10-03T09:00:00", repositories=["arxiv"])
    record(conn, broken, "arxiv", count=0, reason="upstream_failure",
           detail={"status": 500, "attempts": 2})

    verdict = source_wall.build(conn)["verdict"]

    assert verdict["level"] == "attention"
    assert verdict["headline"] == "arXiv has stopped answering."


def test_the_verdict_partitions_every_state_it_can_meet(conn):
    """The verdict's own three buckets, checked against the state list.

    A state that belongs to none of them falls through to whichever branch
    happens to catch it, and the branch that catches an unclassified state is
    the one that says *stopped answering*. That is how a wall ends up blaming
    a source for something the source did not do, so the partition is
    asserted rather than reviewed.
    """
    buckets = (source_wall._ANSWERING | source_wall._ATTENTION | source_wall._SILENT)
    assert buckets == set(source_wall.WALL_STATES)
    assert not (source_wall._ANSWERING & source_wall._ATTENTION)
    assert not (source_wall._ANSWERING & source_wall._SILENT)
    assert not (source_wall._ATTENTION & source_wall._SILENT)


def test_deselecting_a_source_is_never_reported_as_the_source_failing(conn):
    """The one sentence the whole screen exists to produce, guarded.

    A user who unticks DOAJ has not been let down by DOAJ. `failed` must not
    blame a source for a keystroke and neither must the headline, which is the
    same rule one level up and in the place where it is read first. Removing
    `not_selected` from the verdict's silent set turns this red; until it
    existed, that change passed the whole file.
    """
    first = make_run(conn, started="2026-10-01T09:00:00", repositories=["arxiv", "doaj"])
    record(conn, first, "arxiv", count=4)
    record(conn, first, "doaj", count=6)
    for day in (2, 3):
        later = make_run(conn, started=f"2026-10-0{day}T09:00:00", repositories=["arxiv"])
        record(conn, later, "arxiv", count=5)

    wall = source_wall.build(conn)
    verdict = wall["verdict"]

    assert "DOAJ" not in verdict["headline"]
    assert "stopped answering" not in verdict["headline"]
    assert verdict["level"] == "ok"
    # It answered the last time resmon asked it, which is what the sentence says.
    assert verdict["headline"] == (
        "All 2 of 2 sources answered the last time resmon asked them."
    )
    # And the deselection is still reported -- quietly, as a fact, not an alarm.
    assert any("no longer in the most recent run" in line for line in verdict["detail"])


def test_a_source_deselected_after_it_broke_is_still_reported_as_broken(conn):
    """Unticking a source does not launder its last recorded failure.

    The mirror of the case above, and the reason the fix is "read past the
    silence" rather than "ignore a source that was deselected".
    """
    first = make_run(conn, started="2026-10-01T09:00:00", repositories=["arxiv", "doaj"])
    record(conn, first, "arxiv", count=4)
    record(conn, first, "doaj", count=3)
    broke = make_run(conn, started="2026-10-02T09:00:00", repositories=["arxiv", "doaj"])
    record(conn, broke, "arxiv", count=4)
    record(conn, broke, "doaj", count=0, reason="upstream_failure",
           detail={"status": 503, "attempts": 2})
    after = make_run(conn, started="2026-10-03T09:00:00", repositories=["arxiv"])
    record(conn, after, "arxiv", count=4)

    verdict = source_wall.build(conn)["verdict"]

    assert verdict["headline"] == "DOAJ has stopped answering."


def test_a_source_that_never_answered_in_the_window_is_not_called_stopped(conn):
    run = make_run(conn, started="2026-10-01T09:00:00", repositories=["ieee"])
    record(conn, run, "ieee", status="error", reason="retired",
           detail={"detail": "IEEE Xplore was withdrawn on its terms."})

    verdict = source_wall.build(conn)["verdict"]

    assert verdict["level"] == "attention"
    assert "stopped answering" not in verdict["headline"]
    assert "not answered in the last 1 run" in verdict["headline"]


def test_an_all_clear_verdict_carries_its_denominator(conn):
    run = make_run(conn, started="2026-10-01T09:00:00", repositories=["arxiv", "biorxiv"])
    record(conn, run, "arxiv", count=3)
    record(conn, run, "biorxiv", count=0, reason="answered_empty")

    verdict = source_wall.build(conn)["verdict"]

    assert verdict["level"] == "ok"
    assert verdict["headline"] == (
        "All 2 of 2 sources answered the last time resmon asked them."
    )
    # The product's banned words, checked rather than trusted.
    for word in ("intact", "healthy", "verified", "fully"):
        assert word not in verdict["headline"].lower()


def test_an_empty_corpus_says_so_rather_than_claiming_an_all_clear(conn):
    wall = source_wall.build(conn)

    assert wall["sources"] == [] and wall["runs"] == []
    assert wall["verdict"]["level"] == "empty"
    assert wall["totals"] == {state: 0 for state in source_wall.WALL_STATES}


def test_a_trailing_unrecorded_run_does_not_erase_the_last_known_outcome(conn):
    """The newest column being blank is the absence of a fact, not a fact."""
    first = make_run(conn, started="2026-10-01T09:00:00", repositories=["arxiv"])
    record(conn, first, "arxiv", count=0, reason="upstream_failure",
           detail={"status": 503, "attempts": 1})
    make_run(conn, started="2026-10-02T09:00:00", repositories=["arxiv"])

    wall = source_wall.build(conn)
    arxiv = next(s for s in wall["sources"] if s["slug"] == "arxiv")

    assert [c["state"] for c in arxiv["cells"]] == ["failed", "not_recorded"]
    assert "not_selected" not in [c["state"] for c in arxiv["cells"]]
    assert arxiv["latest_known_state"] == "failed"
    assert wall["verdict"]["level"] == "attention"


# ---------------------------------------------------------------------------
# The bound
# ---------------------------------------------------------------------------


def test_the_window_is_bounded_and_says_what_it_left_out(conn):
    """A corpus of many runs reads the same number of rows as a small one."""
    for n in range(60):
        run = make_run(conn, started=f"2026-08-{(n % 28) + 1:02d}T{n % 24:02d}:00:00",
                       repositories=["arxiv"])
        record(conn, run, "arxiv", count=1)

    default = source_wall.build(conn)
    assert len(default["runs"]) == source_wall.DEFAULT_RUNS == 12
    assert default["window"]["runs_available"] == 60
    assert default["window"]["max"] == source_wall.MAX_RUNS

    assert len(source_wall.build(conn, limit=3)["runs"]) == 3
    # Out-of-range values are clamped rather than honored: the grid is the
    # bound, and a caller that asks for everything gets the maximum.
    assert len(source_wall.build(conn, limit=10_000)["runs"]) == source_wall.MAX_RUNS
    assert len(source_wall.build(conn, limit=0)["runs"]) == 1
    for source in default["sources"]:
        assert len(source["cells"]) == len(default["runs"])


# ---------------------------------------------------------------------------
# The endpoint
# ---------------------------------------------------------------------------


def test_the_endpoint_serves_a_classified_grid(conn, client):
    run = make_run(conn, started="2026-10-01T09:00:00", repositories=["arxiv", "doaj"])
    record(conn, run, "arxiv", count=5)
    record(conn, run, "doaj", count=0, reason="parse_failure")

    response = client.get("/api/coverage/source-wall")
    assert response.status_code == 200
    body = response.json()

    assert body["states"] == list(source_wall.WALL_STATES)
    # The legend travels with the grid, so the renderer keeps no copy of it.
    assert [e["state"] for e in body["state_legend"]] == list(source_wall.WALL_STATES)
    assert len(body["runs"]) == 1
    # Every cell arrives classified. Nothing downstream has to look at a
    # status and a reason and decide again what they mean.
    for source in body["sources"]:
        for cell in source["cells"]:
            assert cell["state"] in source_wall.WALL_STATES
            assert cell["note"]
            assert cell["label"]
    assert body["verdict"]["headline"]


def test_the_endpoint_rejects_a_window_outside_its_bound(client):
    assert client.get("/api/coverage/source-wall?limit=0").status_code == 422
    assert client.get(
        f"/api/coverage/source-wall?limit={source_wall.MAX_RUNS + 1}"
    ).status_code == 422
    assert client.get(
        f"/api/coverage/source-wall?limit={source_wall.MAX_RUNS}"
    ).status_code == 200
