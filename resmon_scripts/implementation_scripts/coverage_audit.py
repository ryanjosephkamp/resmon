# resmon_scripts/implementation_scripts/coverage_audit.py
"""Is this routine finding what its owner meant, and what is it missing?

The two questions
-----------------
A routine runs a keyword string against a set of sources on a schedule, and
nobody ever checks whether the string still means what the person meant. Two
failures follow and neither is visible today:

**Off-target.** The routine returns 412 papers a week and 300 of them are about
something else, because one keyword is too broad. The owner stops reading the
report, which is the same outcome as the routine breaking.

**Missed in the corpus.** Papers this routine *should* have found are already in
resmon — another routine found them, or an earlier manual sweep did — and this
one never returned them. That is a keyword gap the owner can act on, and it is
the only kind of miss resmon is entitled to talk about.

What this refuses to claim
--------------------------
**resmon can only compare against papers it already holds.** It has no idea what
exists in the literature and is not in the corpus, and this module never implies
otherwise: "missed" here means *missed by this routine and found by something
else*, not *missed by resmon*. That sentence is returned in the payload rather
than left to the interface, so every surface says the same thing.

Distance is not relevance. A paper far from the intent vector is one this model
places elsewhere in its space; the model has not read it, does not know the
field, and is wrong sometimes. So the off-target list is a **distribution with a
cutoff drawn from the routine's own results**, not an absolute threshold, and it
is worded as a prompt to look rather than a verdict — the same grading the
watchdog uses for "looks unusual".

Where the intent comes from
---------------------------
``routines.intent`` when the owner wrote one; the keyword string otherwise. Those
are different facts and the payload says which it used (``intent_source``). A
routine whose intent is its keywords cannot be off-target *by construction* in
the way one with a stated intent can — the audit is then measuring the keywords
against themselves — and saying so is the difference between a useful reading and
a circular one.
"""

from __future__ import annotations

import json
import logging
import sqlite3
import statistics
from typing import Optional

from . import vector_index

logger = logging.getLogger(__name__)

__all__ = [
    "CANNOT_SEE",
    "MIN_RESULTS_FOR_DISTRIBUTION",
    "audit_routine",
    "intent_for",
]

# The sentence, in one place, because three surfaces render it.
CANNOT_SEE = (
    "resmon can only compare against papers it already holds. A paper missing "
    "from this list may simply never have been collected by any routine."
)

# Below this many embedded results, a distribution is not a distribution. The
# audit still runs and still reports the intent and the corpus side; it declines
# to draw a cutoff and says why. Twelve is small, and deliberately: a routine
# with fifteen results is exactly the one whose owner most wants to know.
MIN_RESULTS_FOR_DISTRIBUTION = 12

# How far out to look for papers this routine never returned. Taken from the
# routine's *own* results rather than fixed: the median distance of what it did
# return is what "on topic for this routine" means, and a corpus paper nearer
# than that is one the routine would plausibly have wanted.
_MISSED_MULTIPLIER = 1.0

# A page of them. The point is to give the owner something to read, not to
# enumerate a corpus.
_MAX_MISSED = 25
_MAX_OFF_TARGET = 25


def intent_for(routine: dict) -> tuple[str, str]:
    """``(text, source)`` — what this routine is for, and where that came from.

    ``source`` is ``"stated"`` or ``"keywords"``. The distinction is load-bearing:
    an audit that compares a routine's keywords against results those keywords
    produced is measuring a query against itself, and the interface has to be able
    to say so rather than present a circular number as a finding.
    """
    stated = str(routine.get("intent") or "").strip()
    if stated:
        return stated, "stated"

    raw = routine.get("parameters")
    if isinstance(raw, str):
        try:
            raw = json.loads(raw)
        except (json.JSONDecodeError, TypeError):
            raw = {}
    params = raw if isinstance(raw, dict) else {}

    keywords = params.get("keywords") or params.get("query") or ""
    if isinstance(keywords, list):
        keywords = " ".join(str(k) for k in keywords)
    return str(keywords).strip(), "keywords"


def _routine_document_ids(conn: sqlite3.Connection, routine_id: int) -> list[int]:
    """Every document any execution of this routine ever returned."""
    return [
        int(r[0])
        for r in conn.execute(
            "SELECT DISTINCT ed.document_id FROM execution_documents ed "
            "JOIN executions e ON e.id = ed.execution_id "
            "WHERE e.routine_id = ?",
            (routine_id,),
        )
    ]


def audit_routine(
    conn: sqlite3.Connection,
    routine: dict,
    model: str,
    intent_vector: bytes,
    *,
    max_missed: int = _MAX_MISSED,
    max_off_target: int = _MAX_OFF_TARGET,
) -> dict:
    """The two lists, plus what the audit could not see.

    *intent_vector* is supplied by the caller. This module knows about the corpus
    and nothing about lanes, settings or credentials — the same division
    ``explorer.py`` keeps.
    """
    intent_text, intent_source = intent_for(routine)
    payload: dict = {
        "routine_id": routine.get("id"),
        "routine_name": routine.get("name"),
        "intent": intent_text,
        "intent_source": intent_source,
        "model": model,
        "cannot_see": CANNOT_SEE,
        "results": 0,
        "results_embedded": 0,
        "off_target": [],
        "missed_in_corpus": [],
        "distribution": None,
        "reason": None,
    }

    returned = _routine_document_ids(conn, int(routine["id"]))
    payload["results"] = len(returned)
    if not returned:
        payload["reason"] = (
            "This routine has not returned any papers yet, so there is nothing to "
            "compare against its intent."
        )
        return payload

    if vector_index.load_extension(conn) is None:
        payload["reason"] = (
            "The coverage audit needs the vector index, and this build cannot load it."
        )
        return payload

    # Distances for the routine's own results. ``within_ids`` keeps the ranking
    # inside the routine, and ``k`` covers all of them so nothing is silently
    # truncated out of the distribution.
    ranked = vector_index.nearest(
        conn, model, intent_vector, k=max(1, len(returned)), within_ids=returned
    )
    payload["results_embedded"] = len(ranked)
    if not ranked:
        payload["reason"] = (
            "None of this routine's papers are embedded yet, so resmon cannot say how "
            "close they are to its intent. Run the backfill in Settings → AI."
        )
        return payload

    distances = [d for _, d in ranked]
    if len(distances) < MIN_RESULTS_FOR_DISTRIBUTION:
        # Reported, not hidden: the intent and the counts are still useful, and
        # a cutoff drawn from nine numbers would be a number pretending to be a
        # measurement.
        payload["reason"] = (
            f"Only {len(distances)} of this routine's papers are embedded. resmon "
            f"needs at least {MIN_RESULTS_FOR_DISTRIBUTION} before a distribution "
            "means anything, so no off-target cutoff is drawn."
        )
    else:
        median = statistics.median(distances)
        # The cutoff is the third quartile: the quarter of this routine's own
        # results that sit furthest from its intent. An absolute distance would
        # mean different things on different models and different subjects; a
        # quantile of the routine's own output is comparable to itself, which is
        # the only comparison being made.
        cutoff = statistics.quantiles(distances, n=4)[2]
        payload["distribution"] = {
            "count": len(distances),
            "min": round(min(distances), 4),
            "median": round(median, 4),
            "p75_cutoff": round(cutoff, 4),
            "max": round(max(distances), 4),
        }
        far = [(doc_id, d) for doc_id, d in ranked if d > cutoff]
        payload["off_target"] = _rows(conn, far[-max_off_target:][::-1])

    # --- missed in corpus ---------------------------------------------------
    # Papers at least as close to the intent as this routine's own median, that
    # no execution of it ever returned. The median rather than a fixed radius,
    # for the same reason as the cutoff above.
    reference = statistics.median(distances)
    # Over-fetch, because the returned set is excluded afterwards and would
    # otherwise eat the whole budget on a routine that dominates the corpus.
    neighbours = vector_index.nearest(
        conn, model, intent_vector, k=max_missed + len(returned) + 50
    )
    returned_set = set(returned)
    missed = [
        (doc_id, d) for doc_id, d in neighbours
        if doc_id not in returned_set and d <= reference
    ][:max_missed]
    payload["missed_in_corpus"] = _rows(conn, missed)
    payload["missed_reference_distance"] = round(reference, 4)
    return payload


def _rows(conn: sqlite3.Connection, pairs: list[tuple[int, float]]) -> list[dict]:
    """Document metadata for ``(id, distance)`` pairs, in the order given."""
    if not pairs:
        return []
    ids = [doc_id for doc_id, _ in pairs]
    placeholders = ",".join("?" for _ in ids)
    found = {
        int(r["id"]): dict(r)
        for r in conn.execute(
            f"SELECT id, title, source_repository, publication_date, doi, url "
            f"FROM documents WHERE id IN ({placeholders})",
            ids,
        )
    }
    return [
        {
            "id": doc_id,
            "distance": round(float(distance), 4),
            "title": found[doc_id]["title"],
            "source_repository": found[doc_id]["source_repository"],
            "publication_date": found[doc_id]["publication_date"],
            "doi": found[doc_id]["doi"],
            "url": found[doc_id]["url"],
        }
        for doc_id, distance in pairs
        if doc_id in found
    ]


def summary_line(audit: dict) -> Optional[str]:
    """One sentence for a list view or an MCP payload, or ``None``.

    Never a bare pair of numbers: the counts mean nothing without the fact that
    they are drawn from the routine's own distribution, and a caller that
    rendered "300 off target" as a verdict would be overclaiming on resmon's
    behalf.
    """
    off = len(audit.get("off_target") or [])
    missed = len(audit.get("missed_in_corpus") or [])
    reason = audit.get("reason")

    # A reason and a finding are not mutually exclusive, and treating them as
    # such lost real information: a routine with too few embedded results to draw
    # an off-target cutoff can still have papers it missed, and an earlier version
    # of this function reported only the reason and silently dropped them. The
    # reason explains the half that could not be measured; the other half still
    # has an answer.
    if not off and not missed:
        if reason:
            return reason
        return (
            "Nothing stands out: no result sits unusually far from this routine's "
            "intent, and nothing in the corpus close to it was missed."
        )

    parts = []
    if off:
        parts.append(
            f"{off} result{'s' if off != 1 else ''} sit furthest from the intent"
        )
    if missed:
        parts.append(
            f"{missed} paper{'s' if missed != 1 else ''} already in the corpus "
            f"look{'' if missed != 1 else 's'} close to it and "
            f"{'were' if missed != 1 else 'was'} never returned"
        )
    line = " and ".join(parts).capitalize() + ". "
    if reason:
        line += reason + " "
    return line + CANNOT_SEE
