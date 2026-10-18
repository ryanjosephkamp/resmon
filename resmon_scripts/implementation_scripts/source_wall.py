"""The source wall: every source's recorded answer to every recent run.

``execution_sources`` has held one row per source per execution since schema
6, and ``source_coverage.outcome`` has classified one of those rows since 2.1.
What has never existed is a reader that puts the classification *across* runs:
every surface reads one execution at a time, so a source that quietly stopped
answering three runs ago is visible only to someone who opens three runs and
compares them by hand. That is the gap this module closes, and it closes it
with no new recording, no migration and no second copy of the classification.

**This module classifies nothing.** ``zero_reason.answered`` and
``source_coverage.outcome`` decide what a recorded row means, and they are
called, not re-implemented. A sixth copy of that decision is exactly the
defect that put a green tick on the seven sources that have no author query
(fixed in "One source of truth for 'did not answer' in the renderer"). What
this module adds is a *projection*: the three categories plus the flags that
``outcome`` already returns, folded into the five states a wall can draw, and
a sentence saying what the wall adds up to.

The five states, and what each one is allowed to mean:

``answered``
    The source replied and returned records. Includes a reply whose records
    resmon could not keep -- see the note on ``rights_filtered`` below.
``answered_empty``
    The source replied and genuinely had nothing. A quiet field, not a fault.
``could_not_be_asked``
    resmon never got a question to this source, or the source cannot express
    the question: no key, retired, no author query, a window it cannot answer.
``failed``
    The source was asked and the exchange broke -- an upstream failure, a
    reply resmon could not read, a recorded query error.
``not_recorded``
    resmon did not observe an outcome. **Never rendered as either success or
    failure**, and never inferred into one of the others.
``not_selected``
    This run's saved selection did not name this source, so nothing was asked
    of it. A silence the user chose, which is a different fact from a silence
    in the record, and the sixth state exists to keep them apart.

Three collapses are deliberate and are the honest reading of what is stored,
rather than places where the data ran out:

* A zero whose reason is ``rights_filtered`` or ``records_unusable`` is
  ``answered``. The source replied *and returned records*; resmon declined to
  store them. Calling it ``answered_empty`` would state that the field was
  quiet, which is a claim about someone else's corpus that the row disproves.
  The cell's own note carries the matched/kept pair.
* A ``cancelled`` row is ``not_recorded``. The user stopped the run; resmon
  observed its own cancellation, not an outcome from the source. Drawing it as
  ``failed`` would blame the source for the user's keystroke.
* A source with no row for a run whose saved selection *cannot be read* is
  ``not_recorded``, not ``not_selected``. An unreadable selection is not
  evidence that the user declined to ask: turning it into one would invent a
  choice nobody made, which is the same move as inventing a zero reason.
"""

from __future__ import annotations

import sqlite3

from . import repo_catalog, source_coverage, zero_reason

# The wall's vocabulary, in severity order -- answered first, the states that
# say nothing last. The renderer draws this order and holds no copy of it.
#
# Five of these were the approved concept. ``not_selected`` is the sixth and
# it is here because the stored data distinguished something the concept did
# not: a run's saved selection says which sources the user asked, so "I did
# not ask this source" and "I asked and do not know what happened" are both
# on disk and they are not the same silence. The first is a choice the user
# made; the second is a hole in the record. Collapsing them is the same
# compression as calling a 503 an empty field, one level down.
WALL_STATES: tuple[str, ...] = (
    "answered",
    "answered_empty",
    "could_not_be_asked",
    "failed",
    "not_recorded",
    "not_selected",
)

# What each state is called and what it means, served with the grid.
#
# **The backend owns this vocabulary and the renderer takes it.** Two of these
# words are ``source_coverage.outcome``'s own labels and are asserted equal to
# them by ``test_the_legend_word_for_a_state_is_the_backend_s_own_word``: a
# quiet field is called *answered, zero* here because that is what every other
# surface in resmon calls it, not *answered, nothing new*, which was a phrase
# from a brief. The renderer keeping its own name for a state is the defect
# that was fixed in "One source of truth for 'did not answer' in the
# renderer", and a legend is that same copy wearing a different hat. If the
# word reads badly it is changed here, once, and every surface picks it up.
STATE_LEGEND: tuple[dict[str, str], ...] = (
    {"state": "answered", "label": "answered",
     "meaning": "The source replied and returned records."},
    {"state": "answered_empty", "label": "answered, zero",
     "meaning": "The source replied and genuinely had nothing. A quiet field, not a fault."},
    {"state": "could_not_be_asked", "label": "could not be asked",
     "meaning": "No key, retired, no author query, or a window the source cannot answer."},
    {"state": "failed", "label": "failed",
     "meaning": "The source was asked and the exchange broke."},
    {"state": "not_recorded", "label": "outcome not recorded",
     "meaning": "resmon did not observe an outcome. This is not a success and not a failure."},
    {"state": "not_selected", "label": "not asked on this run",
     "meaning": "This run's saved selection did not name this source. Nothing was asked of it."},
)

# Which wall state each *non-answer* reason draws as.
#
# The keys are exactly ``zero_reason.DID_NOT_ANSWER`` and
# ``test_source_wall.py`` asserts that equality, so a reason added to the
# backend's non-answer set turns the suite red here rather than arriving at a
# user as an unmapped cell. The split is between "the question never reached
# the source, or the source cannot express it" and "the exchange broke".
STATE_FOR_NON_ANSWER: dict[str, str] = {
    "missing_key": "could_not_be_asked",
    "retired": "could_not_be_asked",
    "window_unanswerable": "could_not_be_asked",
    "entity_unsupported": "could_not_be_asked",
    "upstream_failure": "failed",
    "parse_failure": "failed",
}

# The states that mean the source did get a question answered. Used by the
# verdict to decide whether a source has *stopped* answering, which needs
# evidence that it once did.
_ANSWERING = frozenset({"answered", "answered_empty"})

# The states that want the user's attention.
_ATTENTION = frozenset({"could_not_be_asked", "failed"})

# The two states that are not a verdict. Neither may be read as a source's
# current condition: one is a hole in the record and the other is a run the
# user chose not to put the source in.
_SILENT = frozenset({"not_recorded", "not_selected"})

# How many runs a single request may ask for. The wall is a scanning
# instrument, not an archive: twelve columns fit a laptop window at the cell
# size this screen uses, and fifty is the point past which the grid stops
# being readable before it starts being slow.
DEFAULT_RUNS = 12
MAX_RUNS = 50


def state_for(outcome: dict) -> str:
    """Project one ``source_coverage.outcome`` dict onto a wall state.

    ``outcome`` is taken whole rather than re-derived from the row: its
    ``category``, ``genuine_empty`` and ``status`` are the facts this function
    is allowed to read, and it reads nothing else about the row.
    """
    category = outcome.get("category")
    if category == "answered":
        # ``genuine_empty`` is the backend's own name for the one zero that is
        # a real answer: status ``ok``, count 0, reason ``answered_empty``.
        return "answered_empty" if outcome.get("genuine_empty") else "answered"
    if category != "non_answer":
        # ``unknown`` -- a malformed row, a status this build does not know, a
        # zero with no reason on record. All of it is "resmon does not know".
        return "not_recorded"

    status = outcome.get("status")
    if status == "cancelled":
        return "not_recorded"
    mapped = STATE_FOR_NON_ANSWER.get(outcome.get("zero_reason") or "")
    if mapped:
        return mapped
    if status == "skipped_missing_key":
        # The row predates ``zero_reason`` or was written without one; the
        # status itself is the fact, and it is a question never asked.
        return "could_not_be_asked"
    if status == "error":
        return "failed"
    # A non-answer this projection has no rule for. It fails towards "resmon
    # does not know" rather than towards a verdict, and the mapping test above
    # is what stops this branch from being reachable in practice.
    return "not_recorded"


def _display_names() -> dict[str, str]:
    """Slug to catalog display name, for the axis labels only.

    Deliberately not used inside any sentence: ``source_coverage`` builds its
    notes from the slug, and two different names for one source in one cell
    would be worse than one plain one.
    """
    return {entry.slug: entry.name for entry in repo_catalog.REPOSITORY_CATALOG}


def _run_label(row: dict, routine_names: dict[int, str]) -> str:
    """What the column header says. A run is identified by when it ran."""
    kind = {
        "deep_dive": "Deep Dive",
        "deep_sweep": "Deep Sweep",
        "automated_sweep": "Routine",
    }.get(str(row.get("execution_type")), str(row.get("execution_type") or "Run"))
    routine = routine_names.get(row.get("routine_id")) if row.get("routine_id") else None
    return f"{kind} — {routine}" if routine else kind


def _unrecorded_cell(execution_id: int, in_selection: bool | None) -> dict:
    """A cell for a source this run has no row for -- one of the two silences.

    ``in_selection`` is what separates them, and it comes from
    ``source_coverage.selection`` rather than from the rows that happen to
    exist, because a selection inferred from the outcomes recorded would make
    a source that was asked and lost indistinguishable from one that was never
    asked -- which is the distinction this branch exists to draw.
    """
    if in_selection is False:
        state, label = "not_selected", "not asked on this run"
        note = (
            "This source is not in this run's saved selection, so it was not "
            "asked. This is a choice recorded on the run, not a gap in what "
            "resmon observed."
        )
    elif in_selection:
        state, label = "not_recorded", "outcome not recorded"
        note = (
            "This source was part of this run's saved selection and resmon "
            "recorded no outcome for it. No attempt, failure or empty answer "
            "can be inferred."
        )
    else:
        state, label = "not_recorded", "outcome not recorded"
        note = (
            "This run's saved source selection is unknown and no outcome was "
            "recorded for this source. Nothing can be inferred -- in "
            "particular, not that you chose not to ask it."
        )
    return {
        "execution_id": execution_id,
        "state": state,
        "label": label,
        "note": note,
        "result_count": None,
        "status": None,
        "zero_reason": None,
        "partial": False,
        "outcome_recorded": False,
        "in_selection": in_selection,
    }


def _cell(execution_id: int, row: dict, in_selection: bool | None) -> dict:
    outcome = source_coverage.outcome(row)
    return {
        "execution_id": execution_id,
        "state": state_for(outcome),
        # ``source_coverage``'s own label and sentence, unedited. The wall adds
        # a state; it does not get to re-word what happened.
        "label": outcome["label"],
        "note": outcome["note"],
        "result_count": outcome["result_count"],
        "status": outcome["status"],
        "zero_reason": outcome["zero_reason"],
        "partial": bool(outcome.get("partial")),
        "outcome_recorded": True,
        "in_selection": in_selection,
    }


def _latest_known_state(cells: list[dict]) -> str | None:
    """The newest run this source's condition can be read from.

    Runs are ordered oldest first, so this walks backwards. ``not_recorded``
    is skipped rather than returned: a string of blank columns at the
    right-hand edge is the absence of a fact, and reading it as the source's
    current condition would be the inference this whole module refuses. A
    row that *exists* and classifies to ``not_recorded`` -- a cancelled query,
    a zero with no reason on file -- is skipped for the same reason, because
    what resmon recorded there is that it does not know.
    """
    for cell in reversed(cells):
        if cell["state"] not in _SILENT:
            return cell["state"]
    return None


def _join(names: list[str]) -> str:
    if len(names) == 1:
        return names[0]
    return f"{', '.join(names[:-1])} and {names[-1]}"


def _verdict(sources: list[dict], run_count: int) -> dict:
    """The sentence at the top of the wall, built from the cells below it.

    It is built here and not in the renderer for the reason
    ``zero_reason.sentence`` lives in the backend: one place to be wrong, and
    one place to fix. The wording avoids *intact*, *healthy* and *verified* --
    the wall can say what the last runs recorded and nothing beyond it.
    """
    if not sources:
        return {
            "level": "empty",
            "headline": "No runs are recorded yet, so there is nothing to check.",
            "detail": [],
        }

    stopped: list[str] = []
    silent: list[str] = []
    unobserved: list[str] = []
    unasked: list[str] = []
    answering = 0
    for source in sources:
        latest = _latest_known_state(source["cells"])
        if latest is None:
            # A source with nothing but silence behind it: say which silence.
            # "You never asked this one" and "resmon lost track of this one"
            # want different things from the reader.
            if all(cell["state"] == "not_selected" for cell in source["cells"]):
                unasked.append(source["name"])
            else:
                unobserved.append(source["name"])
            continue
        if latest in _ANSWERING:
            answering += 1
            continue
        if any(cell["state"] in _ANSWERING for cell in source["cells"]):
            stopped.append(source["name"])
        else:
            silent.append(source["name"])

    total = len(sources)
    runs = f"{run_count} run{'s' if run_count != 1 else ''}"
    detail: list[str] = []
    if unobserved:
        detail.append(
            f"{len(unobserved)} of {total} sources recorded no outcome in these "
            f"{runs}; resmon cannot say whether they answered."
        )
    if unasked:
        detail.append(
            f"{len(unasked)} of {total} sources were not in any of these "
            f"{runs}' saved selections, so nothing was asked of them."
        )

    if stopped:
        if len(stopped) <= 3:
            verb = "has" if len(stopped) == 1 else "have"
            headline = f"{_join(sorted(stopped))} {verb} stopped answering."
        else:
            headline = f"{len(stopped)} of {total} sources have stopped answering."
        detail.insert(
            0,
            "Each of these answered earlier in this window and did not answer "
            "the last time resmon recorded an outcome for it.",
        )
        return {"level": "attention", "headline": headline, "detail": detail}

    if silent:
        if len(silent) <= 3:
            verb = "has" if len(silent) == 1 else "have"
            headline = (
                f"{_join(sorted(silent))} {verb} not answered in the last {runs}."
            )
        else:
            headline = (
                f"{len(silent)} of {total} sources have not answered in the "
                f"last {runs}."
            )
        return {"level": "attention", "headline": headline, "detail": detail}

    if answering == 0:
        return {
            "level": "unknown",
            "headline": (
                f"resmon recorded no source outcomes in the last {runs}, so it "
                "cannot say whether your coverage held."
            ),
            "detail": detail,
        }

    return {
        "level": "ok",
        "headline": (
            f"All {answering} of {total} sources answered the last time resmon "
            "asked them."
        ),
        "detail": detail,
    }


def build(conn: sqlite3.Connection, limit: int = DEFAULT_RUNS) -> dict:
    """The whole grid for the last ``limit`` executions.

    **Bounded by ``limit``, not by the corpus.** The execution window is one
    indexed ``ORDER BY ... LIMIT`` over ``executions``; the cells are one
    query over ``execution_sources`` restricted to those ids by primary key.
    A corpus with 50,000 executions reads the same ``limit`` rows and the same
    ``limit × sources`` cells as a corpus with twelve. The only unbounded read
    is ``COUNT(*)`` over ``executions``, which the window is reported against.

    Runs come back **oldest first**, so the newest column is the right-hand
    edge and the grid reads as a timeline. Sources are alphabetical by display
    name and stay in that position between polls: a wall whose rows reorder
    when something breaks is a wall you cannot learn.
    """
    limit = max(1, min(int(limit), MAX_RUNS))
    runs_available = int(
        conn.execute("SELECT COUNT(*) FROM executions").fetchone()[0]
    )
    execution_rows = [
        dict(row)
        for row in conn.execute(
            """
            SELECT id, execution_type, status, start_time, end_time,
                   routine_id, parameters
            FROM executions
            ORDER BY start_time DESC, id DESC
            LIMIT ?
            """,
            (limit,),
        ).fetchall()
    ]
    execution_rows.reverse()
    exec_ids = [int(row["id"]) for row in execution_rows]

    routine_names: dict[int, str] = {}
    wanted = {int(r["routine_id"]) for r in execution_rows if r.get("routine_id")}
    if wanted:
        placeholders = ",".join("?" for _ in wanted)
        routine_names = {
            int(row["id"]): str(row["name"])
            for row in conn.execute(
                f"SELECT id, name FROM routines WHERE id IN ({placeholders})",
                sorted(wanted),
            ).fetchall()
        }

    recorded: dict[int, dict[str, dict]] = {i: {} for i in exec_ids}
    if exec_ids:
        placeholders = ",".join("?" for _ in exec_ids)
        for row in conn.execute(
            f"""
            SELECT execution_id, source, status, result_count, error_message,
                   zero_reason, zero_detail, recorded_at
            FROM execution_sources
            WHERE execution_id IN ({placeholders})
            """,
            exec_ids,
        ).fetchall():
            recorded[int(row["execution_id"])][str(row["source"])] = dict(row)

    # Each run's saved selection, where it is knowable. ``source_coverage``
    # owns that reading too -- a selection guessed from the rows that happen to
    # exist would make a source that was never asked indistinguishable from one
    # that was asked and lost.
    selections: dict[int, list[str] | None] = {}
    selection_notes: list[str] = []
    unknown_selection = 0
    for row in execution_rows:
        selected, _provenance = source_coverage.selection(row.get("parameters"))
        selections[int(row["id"])] = selected
        if selected is None:
            unknown_selection += 1

    names = _display_names()
    # The source axis is the union of every source this window either selected
    # or recorded. A source that was dropped from the selection partway through
    # the window keeps its row, which is the whole point: its disappearance is
    # the thing the user came here to see.
    slugs: set[str] = set()
    for exec_id in exec_ids:
        slugs.update(recorded[exec_id])
        for slug in selections[exec_id] or []:
            slugs.add(slug)

    runs = [
        {
            "execution_id": int(row["id"]),
            "execution_type": row["execution_type"],
            "status": row["status"],
            "started_at": row["start_time"],
            "ended_at": row["end_time"],
            "label": _run_label(row, routine_names),
        }
        for row in execution_rows
    ]

    sources: list[dict] = []
    for slug in sorted(slugs, key=lambda s: (names.get(s, s).lower(), s)):
        cells: list[dict] = []
        for exec_id in exec_ids:
            selected = selections[exec_id]
            in_selection = None if selected is None else slug in selected
            row = recorded[exec_id].get(slug)
            cells.append(
                _cell(exec_id, row, in_selection) if row
                else _unrecorded_cell(exec_id, in_selection)
            )
        sources.append({
            "slug": slug,
            "name": names.get(slug, slug),
            "in_catalog": slug in names,
            "cells": cells,
            "counts": {
                state: sum(cell["state"] == state for cell in cells)
                for state in WALL_STATES
            },
            "latest_known_state": _latest_known_state(cells),
        })

    totals = {
        state: sum(source["counts"][state] for source in sources)
        for state in WALL_STATES
    }

    notes = [
        "Every cell is one source's recorded answer to one run. Nothing here "
        "is inferred: a run with no row for a source reads as not recorded.",
        "A source that answered and whose records resmon could not store reads "
        "as answered, because the source did reply with records. The cell's "
        "note carries how many were matched and how many were kept.",
        "A cancelled run reads as not recorded for every source it was still "
        "querying: resmon observed its own cancellation, not an answer.",
        "Not asked and not recorded are different marks. The first is a choice "
        "saved on the run; the second is a gap in what resmon observed.",
    ]
    if unknown_selection:
        notes.append(
            f"{unknown_selection} of {len(runs)} runs have no usable saved "
            "source selection, so for those runs a source with no recorded "
            "outcome reads as not recorded rather than not asked: resmon "
            "cannot tell which it was and will not guess."
        )
    notes.extend(selection_notes)

    return {
        "runs": runs,
        "sources": sources,
        "states": list(WALL_STATES),
        # Served, not transcribed. The renderer draws a glyph per state and
        # takes every word from here.
        "state_legend": [dict(entry) for entry in STATE_LEGEND],
        "totals": totals,
        "verdict": _verdict(sources, len(runs)),
        "window": {
            "requested": limit,
            "returned": len(runs),
            "max": MAX_RUNS,
            "runs_available": runs_available,
        },
        "notes": notes,
    }


def mapped_reasons() -> dict[str, str]:
    """Every reason in ``zero_reason.ZERO_REASONS`` and the state it reaches.

    Exported so the conformance test takes its denominator from the code on
    both sides rather than from a list written out in the test.
    """
    out: dict[str, str] = {}
    for reason in zero_reason.ZERO_REASONS:
        if reason in STATE_FOR_NON_ANSWER:
            out[reason] = STATE_FOR_NON_ANSWER[reason]
        elif reason == "not_recorded":
            out[reason] = "not_recorded"
        elif reason == "answered_empty":
            out[reason] = "answered_empty"
        else:
            # ``rights_filtered`` and ``records_unusable``: the source answered.
            out[reason] = "answered"
    return out
