"""The reproducible search record.

Every systematic review's methods section requires the same account: what was
searched, where, on what date, with what software, how many records each
database returned, and how many were removed as duplicates. Reviewers assemble
it by hand in spreadsheets, months after the fact, from memory and browser
history — and journals increasingly ask for it because searches that cannot be
reproduced cannot be trusted.

resmon already records all of it and throws none of it away. This module is the
report format, not new data collection.

Scope, held deliberately narrow
-------------------------------
This ships the **search log**. It does not attempt screening state
(include/exclude/reason per paper), because that is a different product —
Rayyan and Covidence do screening, commercially and well. The search-and-
document half is the part nobody does, and it is the part resmon is accidentally
most of the way to serving.

The honesty problem: resmon's numbers are not PRISMA's boxes
------------------------------------------------------------
It would be easy, and wrong, to print resmon's counters under PRISMA headings
and let a reviewer assume they mean what PRISMA means. They do not, quite:

* **Records identified per database** maps cleanly. ``execution_sources``
  records exactly what each source returned, before anything was done to it.

* **Duplicate records removed** does *not* map cleanly. resmon detects the same
  paper arriving from two databases and **keeps both rows**, flagging the
  overlap rather than deleting either. So the figure reported is "records
  identified as duplicates of a record from another source", with the retention
  stated. The reviewer decides what to do about them; resmon does not decide on
  their behalf and must not imply it has.

* **Records already held from earlier runs** has no PRISMA box at all. It is a
  consequence of resmon being a *monitor* rather than a one-shot search: a
  routine that has run weekly for a year re-encounters what it already has. It
  is reported under its own heading, explicitly outside the flow diagram.

* **Records marked ineligible by automation tools** is the nearest PRISMA box
  for records resmon discarded as unusable (no title, no identifier). Reported
  as what it is — a data-quality discard, not a relevance judgement.

Each figure carries a ``prisma`` field naming its box, or ``None`` where there
is no honest match. A record that quietly mislabels its own numbers would be
worse than no record, because a reviewer would publish it.

Undermeasured history
---------------------
``cross_source`` was computed on every run since the beginning and never stored.
Runs from before that column exists report it as ``None`` — *not recorded* —
rather than as zero. "We did not measure this" and "there were none" are
different claims, and printing the second on the first's behalf is exactly the
kind of small lie that makes a methods section wrong.
"""

from __future__ import annotations

import json
import sqlite3
from datetime import datetime, timezone

from .config import APP_NAME, APP_VERSION
from .database import get_execution_sources

# PRISMA 2020 identification-stage box names, used verbatim so a reviewer can
# match them against the template without translating.
_PRISMA_IDENTIFIED = "Records identified from databases"
_PRISMA_DUPLICATES = "Duplicate records removed before screening"
_PRISMA_AUTOMATION = "Records marked as ineligible by automation tools"
_PRISMA_SCREENED = "Records screened"


def _parameters(execution: dict) -> dict:
    raw = execution.get("parameters")
    if isinstance(raw, str):
        try:
            raw = json.loads(raw)
        except (json.JSONDecodeError, TypeError):
            return {}
    return raw if isinstance(raw, dict) else {}


def _keywords(params: dict) -> list[str]:
    keywords = params.get("keywords")
    if isinstance(keywords, list):
        cleaned = [str(k).strip() for k in keywords if str(k or "").strip()]
        if cleaned:
            return cleaned
    query = params.get("query")
    return [str(query).strip()] if isinstance(query, str) and query.strip() else []


def build(conn: sqlite3.Connection, execution_id: int) -> dict:
    """Assemble the complete, dated account of one search."""
    row = conn.execute(
        """
        SELECT e.*, r.name AS routine_name, r.schedule_cron AS routine_schedule,
               c.name AS configuration_name
        FROM executions e
        LEFT JOIN routines r ON r.id = e.routine_id
        LEFT JOIN saved_configurations c ON c.id = e.saved_configuration_id
        WHERE e.id = ?
        """,
        (int(execution_id),),
    ).fetchone()
    if row is None:
        raise LookupError(f"No execution with id {execution_id}")
    execution = dict(row)
    params = _parameters(execution)

    sources = get_execution_sources(conn, execution_id)
    identified_total = sum(int(s["result_count"] or 0) for s in sources)

    # Sources that were selected but returned nothing usable are as much a part
    # of the record as the productive ones: a reviewer reading "we searched
    # NASA ADS" needs to know it answered with an error every time.
    per_source = [
        {
            "source": s["source"],
            "records_identified": int(s["result_count"] or 0),
            "status": s["status"],
            "note": _source_note(s),
        }
        for s in sources
    ]

    dedup = _dedup_block(execution)

    return {
        "record_type": "resmon_search_record",
        "record_version": 1,
        "generated_at": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "software": {
            "name": APP_NAME,
            "version": APP_VERSION,
            # Named so a methods section can cite the tool that ran the search.
            "citation": f"{APP_NAME} {APP_VERSION}",
        },
        "search": {
            "execution_id": execution["id"],
            "execution_type": execution["execution_type"],
            "run_at": execution["start_time"],
            "completed_at": execution.get("end_time"),
            "status": execution["status"],
            "keywords": _keywords(params),
            "query_as_sent": params.get("query"),
            "date_from": params.get("date_from"),
            "date_to": params.get("date_to"),
            "max_results_per_source": params.get("max_results"),
            "routine_name": execution.get("routine_name"),
            "routine_schedule": execution.get("routine_schedule"),
            "configuration_name": execution.get("configuration_name"),
        },
        "sources": per_source,
        "identification": {
            "records_identified": identified_total,
            "sources_searched": len(per_source),
            "sources_that_answered": sum(
                1 for s in per_source if s["status"] == "ok"),
            "prisma": _PRISMA_IDENTIFIED,
        },
        "deduplication": dedup,
        # Stated in the payload rather than left to the reader to infer, and
        # carried into the Markdown so it cannot be separated from the numbers.
        "caveats": _caveats(dedup, per_source),
    }


def _source_note(source: dict) -> str | None:
    status = source["status"]
    if status == "ok":
        return None
    if status == "skipped_missing_key":
        return (
            "Selected, but the API key it requires was not configured, so this "
            "source returned nothing. It did not contribute to the search."
        )
    if status == "error":
        return (
            "Selected, but the query failed: "
            f"{source.get('error_message') or 'unknown error'}. This source did "
            "not contribute to the search."
        )
    if status == "cancelled":
        return "The run was cancelled while this source was being queried."
    return None


def _dedup_block(execution: dict) -> dict:
    """The deduplication figures, each labeled with the box it belongs in."""
    cross_source = execution.get("dedup_cross_source")
    return {
        "records_processed": execution.get("dedup_total"),
        "cross_source_duplicates": {
            "count": cross_source,
            "recorded": cross_source is not None,
            "prisma": _PRISMA_DUPLICATES,
            "meaning": (
                "Records identified as the same paper as a record from a "
                "different source. resmon flags these and keeps both rows — it "
                "does not remove either, so this is a count of duplicates "
                "found, not of duplicates deleted."
            ),
            "not_recorded_reason": (
                None if cross_source is not None else
                "This run predates the version that stored this figure. It was "
                "computed at the time but not kept. Not recorded is not zero."
            ),
        },
        "already_held": {
            "count": execution.get("dedup_duplicates"),
            # No PRISMA box: this is an artefact of monitoring over time, not a
            # step in a one-shot systematic search.
            "prisma": None,
            "meaning": (
                "Records this search returned that were already in the corpus "
                "from an earlier run. This has no equivalent in a PRISMA flow "
                "diagram, which describes a single search rather than a "
                "repeating one, and is reported separately for that reason."
            ),
        },
        "discarded_unusable": {
            "count": execution.get("dedup_invalid"),
            "prisma": _PRISMA_AUTOMATION,
            "meaning": (
                "Records discarded because they lacked a title or a usable "
                "identifier. This is a data-quality discard, not a relevance "
                "judgement — nothing was excluded here on its subject matter."
            ),
        },
        "records_added": {
            "count": execution.get("dedup_new"),
            "prisma": _PRISMA_SCREENED,
            "meaning": (
                "Records newly added to the corpus by this search, and "
                "therefore available for screening."
            ),
        },
    }


def _caveats(dedup: dict, sources: list[dict]) -> list[str]:
    caveats = [
        "resmon retains cross-source duplicates rather than removing them. The "
        "duplicate figure is a count of overlap found, and both copies remain "
        "in the corpus for you to resolve.",
        "This record covers one execution. A review that searched on several "
        "dates needs the record from each of them.",
        "resmon does not record screening decisions. Inclusion and exclusion "
        "happen outside it, and no figure here should be presented as a "
        "screening outcome.",
    ]
    if not dedup["cross_source_duplicates"]["recorded"]:
        caveats.insert(0, (
            "The cross-source duplicate count was not recorded for this run. It "
            "is absent, not zero — do not report it as a measured zero."
        ))
    unproductive = [s for s in sources if s["status"] != "ok"]
    if unproductive:
        names = ", ".join(s["source"] for s in unproductive)
        caveats.append(
            f"{len(unproductive)} of the {len(sources)} sources selected did not "
            f"contribute records ({names}). A search strategy that lists them as "
            "searched would be overstating its coverage."
        )
    return caveats


# ---------------------------------------------------------------------------
# Markdown
# ---------------------------------------------------------------------------


def _n(value) -> str:
    """Render a count, keeping "not recorded" visibly distinct from zero."""
    return "not recorded" if value is None else f"{value:,}"


def to_markdown(record: dict) -> str:
    """The record as a methods-section-shaped document.

    Ordered the way PRISMA's identification stage is read: what was searched,
    what each database returned, what happened to those records, and then —
    never separated from the numbers — what the numbers do not mean.
    """
    search = record["search"]
    lines: list[str] = []

    lines.append("# Search record")
    lines.append("")
    lines.append(
        f"Generated {record['generated_at']} by "
        f"{record['software']['citation']}."
    )
    lines.append("")

    lines.append("## The search")
    lines.append("")
    lines.append(f"| Field | Value |")
    lines.append("|---|---|")
    lines.append(f"| Run at | {search['run_at']} |")
    lines.append(f"| Completed | {search.get('completed_at') or '—'} |")
    lines.append(f"| Status | {search['status']} |")
    keywords = search["keywords"]
    lines.append(
        f"| Search terms | {', '.join(f'`{k}`' for k in keywords) if keywords else '—'} |"
    )
    if search.get("query_as_sent"):
        lines.append(f"| Query as sent | `{search['query_as_sent']}` |")
    window = " to ".join(
        x for x in (search.get("date_from"), search.get("date_to")) if x
    )
    lines.append(f"| Publication window | {window or 'unbounded'} |")
    lines.append(
        f"| Per-source cap | {_n(search.get('max_results_per_source'))} |"
    )
    if search.get("routine_name"):
        lines.append(
            f"| Routine | {search['routine_name']} "
            f"(`{search.get('routine_schedule') or ''}`) |"
        )
    if search.get("configuration_name"):
        lines.append(f"| Saved configuration | {search['configuration_name']} |")
    lines.append(f"| Software | {record['software']['citation']} |")
    lines.append(f"| resmon execution id | {search['execution_id']} |")
    lines.append("")

    lines.append("## Records identified, by database")
    lines.append("")
    lines.append(f"*PRISMA: {_PRISMA_IDENTIFIED}*")
    lines.append("")
    lines.append("| Database | Records | Outcome |")
    lines.append("|---|---:|---|")
    for source in record["sources"]:
        outcome = "answered" if source["status"] == "ok" else source["status"].replace("_", " ")
        lines.append(
            f"| {source['source']} | {source['records_identified']:,} | {outcome} |"
        )
    ident = record["identification"]
    lines.append(f"| **Total** | **{ident['records_identified']:,}** | "
                 f"{ident['sources_that_answered']} of "
                 f"{ident['sources_searched']} sources answered |")
    lines.append("")

    for source in record["sources"]:
        if source["note"]:
            lines.append(f"- **{source['source']}** — {source['note']}")
    if any(s["note"] for s in record["sources"]):
        lines.append("")

    lines.append("## What happened to those records")
    lines.append("")
    dedup = record["deduplication"]
    lines.append("| Figure | Count | PRISMA box |")
    lines.append("|---|---:|---|")
    lines.append(
        f"| Records processed | {_n(dedup['records_processed'])} | — |")
    lines.append(
        f"| Duplicates of a record from another source | "
        f"{_n(dedup['cross_source_duplicates']['count'])} | "
        f"{_PRISMA_DUPLICATES} |")
    lines.append(
        f"| Discarded as unusable | {_n(dedup['discarded_unusable']['count'])} | "
        f"{_PRISMA_AUTOMATION} |")
    lines.append(
        f"| Added to the corpus | {_n(dedup['records_added']['count'])} | "
        f"{_PRISMA_SCREENED} |")
    lines.append(
        f"| Already held from an earlier run | "
        f"{_n(dedup['already_held']['count'])} | *no PRISMA equivalent* |")
    lines.append("")

    for key in ("cross_source_duplicates", "already_held", "discarded_unusable",
                "records_added"):
        block = dedup[key]
        lines.append(f"- **{key.replace('_', ' ').capitalize()}** — {block['meaning']}")
        if block.get("not_recorded_reason"):
            lines.append(f"  - {block['not_recorded_reason']}")
    lines.append("")

    lines.append("## What these numbers do not mean")
    lines.append("")
    for caveat in record["caveats"]:
        lines.append(f"- {caveat}")
    lines.append("")

    return "\n".join(lines)
