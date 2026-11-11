"""Analytics over the swept corpus.

Everything here reads data resmon has already stored. No network calls, no new
external dependencies: the corpus, the per-execution join table, and the
routines are enough to answer questions the app could not answer before.

Thin-corpus policy
------------------
A researcher who has run two Deep Dives must see something truthful rather than
a chart that looks broken, so this module distinguishes three things:

* **Counts** are always reported. "You have 14 papers from arXiv" is true at any
  corpus size.
* **Derived statistics** -- medians, rates, percentages -- are reported only once
  there is enough data to make them mean anything. Below the threshold the value
  is ``None`` and ``sufficient`` is ``False``, with ``sample_size`` alongside so
  the interface can say "not enough data yet (3 papers)" instead of printing a
  median of three numbers as though it were a finding.
* **Nothing is silently rounded up.** Every payload carries the sample size it
  was computed from.

The thresholds are deliberately low. They exist to stop a single data point
being presented as a trend, not to withhold information from someone with a
small corpus.

Each view reads one collection when given ``collection_id``: its papers, the
runs that put papers in it, and the watches whose papers land there.
"""

from __future__ import annotations

import calendar
import re
import sqlite3
from collections import defaultdict
from statistics import median
from typing import Optional

from .paper_collections import RUN_COLLECTION_SQL, documents_in

# Minimum papers with a usable publication date before a median discovery lag is
# reported for a source. Below this, one preprint posted late skews the answer.
MIN_SAMPLE_FOR_LAG = 5

# Minimum completed runs before a routine is described as healthy or stale.
# Two runs cannot establish a trend.
MIN_RUNS_FOR_HEALTH = 3

# Consecutive runs returning nothing new before a routine is called stale.
STALE_RUN_THRESHOLD = 3


def _dedup_key_sql(alias: str = "documents") -> str:
    """SQL for the identity of a paper across sources.

    The same paper arriving from arXiv and from OpenAlex is two rows, because
    ``documents`` is unique on (source_repository, external_id). DOI is the
    reliable identity when present; a normalized title is the fallback.
    """
    return (
        f"COALESCE(NULLIF(LOWER(TRIM({alias}.doi)), ''), LOWER(TRIM({alias}.title)))"
    )


def corpus_summary(conn: sqlite3.Connection, collection_id: Optional[int] = None) -> dict:
    """Headline counts for one collection, or the whole corpus."""
    row = conn.execute(
        f"""
        SELECT
            COUNT(*)                                            AS documents,
            COUNT(DISTINCT {_dedup_key_sql()})                  AS unique_papers,
            SUM(CASE WHEN doi IS NOT NULL AND TRIM(doi) <> ''
                     THEN 1 ELSE 0 END)                         AS with_doi,
            COUNT(DISTINCT source_repository)                   AS sources,
            MIN(first_seen_at)                                  AS first_seen,
            MAX(first_seen_at)                                  AS last_seen
        FROM {documents_in(collection_id)}
        """
    ).fetchone()

    documents = row["documents"] or 0
    with_doi = row["with_doi"] or 0

    executions = conn.execute(
        "SELECT COUNT(*) AS n FROM executions WHERE status = 'completed'"
        + ("" if collection_id is None else f" AND {RUN_COLLECTION_SQL} = {int(collection_id)}")
    ).fetchone()["n"]

    authors: set[str] = set()
    for (blob,) in conn.execute(
        f"SELECT authors FROM {documents_in(collection_id)} WHERE authors IS NOT NULL AND TRIM(authors) <> ''"
    ):
        for name in str(blob).split(","):
            name = name.strip()
            if name:
                authors.add(name)

    return {
        "documents": documents,
        "unique_papers": row["unique_papers"] or 0,
        "distinct_authors": len(authors),
        "sources": row["sources"] or 0,
        "completed_executions": executions,
        "first_seen": row["first_seen"],
        "last_seen": row["last_seen"],
        # A percentage of nothing is not zero, it is undefined.
        "doi_coverage": round(with_doi / documents, 4) if documents else None,
        "sample_size": documents,
        "sufficient": documents > 0,
    }


def source_contribution(conn: sqlite3.Connection, collection_id: Optional[int] = None) -> dict:
    """Per source: how many papers it delivered, and how many nothing else found.

    This is the question "which of my 15 repositories actually earn their
    place?". A source whose every paper also arrives from somewhere else costs
    time and API quota on every sweep and contributes nothing.
    """
    key = _dedup_key_sql()
    rows = conn.execute(
        f"""
        WITH keyed AS (
            SELECT id, source_repository, {key} AS k FROM {documents_in(collection_id)}
        ),
        key_spread AS (
            SELECT k, COUNT(DISTINCT source_repository) AS n_sources
            FROM keyed GROUP BY k
        )
        SELECT
            keyed.source_repository                                     AS source,
            COUNT(*)                                                    AS total,
            SUM(CASE WHEN key_spread.n_sources = 1 THEN 1 ELSE 0 END)   AS unique_papers
        FROM keyed
        JOIN key_spread ON key_spread.k = keyed.k
        GROUP BY keyed.source_repository
        ORDER BY unique_papers DESC, total DESC
        """
    ).fetchall()

    sources = []
    for r in rows:
        total = r["total"] or 0
        uniq = r["unique_papers"] or 0
        sources.append({
            "source": r["source"],
            "total": total,
            "unique_papers": uniq,
            "duplicated": total - uniq,
            # Share of this source's own haul that nothing else supplied.
            "unique_share": round(uniq / total, 4) if total else None,
        })

    return {
        "sources": sources,
        "sample_size": sum(s["total"] for s in sources),
        "sufficient": len(sources) > 1,
        "insufficient_reason": (
            None if len(sources) > 1
            else "Overlap needs at least two sources to compare."
        ),
    }


def discovery_lag(conn: sqlite3.Connection, collection_id: Optional[int] = None) -> dict:
    """Median days between a paper's publication date and resmon first seeing it.

    resmon is unusually placed to answer this: it stamps ``first_seen_at`` itself,
    so it knows how long each source took to surface a paper *to this user*. A
    source with a two-week median does not justify an hourly routine.
    """
    # Only a date that is a whole calendar day can be measured from. SQLite's
    # julianday reads a year alone ("2023") as a Julian day number, which made
    # a lag of millions of days, and a month alone ("2025-01") as nothing; a
    # paper dated that coarsely is left out, and counted as left out.
    rows = conn.execute(
        f"""
        SELECT source_repository AS source,
               publication_date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]*' AS whole_day,
               julianday(first_seen_at) - julianday(publication_date) AS lag_days
        FROM {documents_in(collection_id)}
        WHERE publication_date IS NOT NULL
          AND TRIM(publication_date) <> ''
          AND first_seen_at IS NOT NULL
        """
    ).fetchall()

    by_source: dict[str, list[float]] = defaultdict(list)
    not_a_day: dict[str, int] = defaultdict(int)
    for r in rows:
        lag = r["lag_days"]
        if not r["whole_day"] or lag is None:
            not_a_day[r["source"]] += 1
            continue
        # Negative lags are real: preprint servers publish dates that postdate
        # the posting, and some sources report a future issue date. Keep them --
        # the median is robust, and silently dropping them would flatter the
        # source.
        by_source[r["source"]].append(float(lag))

    sources = []
    for source in sorted(set(by_source) | set(not_a_day)):
        lags = by_source.get(source, [])
        n = len(lags)
        enough = n >= MIN_SAMPLE_FOR_LAG
        sources.append({
            "source": source,
            "sample_size": n,
            "sufficient": enough,
            "median_days": round(median(lags), 1) if enough else None,
            "fastest_days": round(min(lags), 1) if enough else None,
            "slowest_days": round(max(lags), 1) if enough else None,
            # Papers whose stated date is not a whole day, left out of the lag.
            "not_a_day": not_a_day.get(source, 0),
        })

    sources.sort(key=lambda s: (s["median_days"] is None, s["median_days"] or 0))
    reported = [s for s in sources if s["sufficient"]]
    return {
        "sources": sources,
        "sample_size": sum(len(lags) for lags in by_source.values()),
        "not_a_day": sum(not_a_day.values()),
        "sufficient": bool(reported),
        "minimum_sample": MIN_SAMPLE_FOR_LAG,
        "insufficient_reason": (
            None if reported
            else f"Needs at least {MIN_SAMPLE_FOR_LAG} dated papers from a source."
        ),
    }


def routine_health(conn: sqlite3.Connection, collection_id: Optional[int] = None) -> dict:
    """Per routine: new results per run, and whether it has gone quiet.

    The actionable question is "is this routine still worth running?". A routine
    that has returned nothing new for several runs is either too narrow, or its
    field has gone quiet, and either way the user should know.

    ``status`` is ``healthy`` (a run recorded a new paper within the last
    ``STALE_RUN_THRESHOLD`` runs), ``stale`` (that many runs in a row recorded
    none), ``not_recorded`` (neither can be said, because some of those runs
    did not record a count), or ``insufficient_data`` (too few runs).
    """
    routines = conn.execute(
        "SELECT id, name, schedule_cron, is_active FROM routines"
        + ("" if collection_id is None else f" WHERE COALESCE(collection_id, 1) = {int(collection_id)}")
        + " ORDER BY name"
    ).fetchall()

    out = []
    for r in routines:
        runs = conn.execute(
            """
            SELECT id, start_time, new_result_count, result_count
            FROM executions
            WHERE routine_id = ? AND status = 'completed'
            ORDER BY start_time ASC
            """,
            (r["id"],),
        ).fetchall()

        # Each run carries its id, so a chart's mark for it can open that run.
        # A count the run did not record stays None: "nothing new" is a claim
        # the run never made, and a chart that drew it as 0 would make it.
        series = [
            {
                "execution_id": run["id"],
                "start_time": run["start_time"],
                "new_results": run["new_result_count"],
                "total_results": run["result_count"],
            }
            for run in runs
        ]

        # Trailing runs that recorded nothing new. A run that recorded no count
        # ends the streak rather than lengthening it: it may have found papers.
        runs_since_new = 0
        for run in reversed(series):
            if run["new_results"] != 0:
                break
            runs_since_new += 1

        n = len(series)
        recent = series[-STALE_RUN_THRESHOLD:]
        if n < MIN_RUNS_FOR_HEALTH:
            status = "insufficient_data"
        elif runs_since_new >= STALE_RUN_THRESHOLD:
            status = "stale"
        elif any((run["new_results"] or 0) > 0 for run in recent):
            status = "healthy"
        else:
            # Neither: none of the latest runs recorded a new paper, and not
            # all of them recorded a count, so there is nothing to judge by.
            status = "not_recorded"

        last_new = next(
            (run["start_time"] for run in reversed(series) if (run["new_results"] or 0) > 0),
            None,
        )

        # Fires that did not run: those that came due while resmon was not
        # running, and those refused because the routine's previous run was
        # still going. A routine can look perfectly healthy by every measure
        # above -- it returns new results whenever it runs -- while quietly
        # running a third as often as the user believes it does, and only this
        # column says so. It is a total; the Routines page is where the two
        # causes are told apart, via ``missed_fire_summary``.
        missed = conn.execute(
            "SELECT COUNT(*) AS n, MAX(due_at_utc) AS last_due "
            "FROM routine_missed_fires WHERE routine_id = ?",
            (r["id"],),
        ).fetchone()

        out.append({
            "routine_id": r["id"],
            "name": r["name"],
            "missed_fires": int(missed["n"] or 0),
            "last_missed_fire_at": missed["last_due"],
            "schedule_cron": r["schedule_cron"],
            "is_active": bool(r["is_active"]),
            "runs": n,
            "series": series,
            "runs_since_new": runs_since_new,
            "last_new_result_at": last_new,
            # Over the runs that recorded a count; ``unrecorded_runs`` says how many did not.
            "total_new": sum(run["new_results"] or 0 for run in series),
            "unrecorded_runs": sum(1 for run in series if run["new_results"] is None),
            "status": status,
            "sample_size": n,
            "sufficient": n >= MIN_RUNS_FOR_HEALTH,
        })

    return {
        "routines": out,
        "minimum_runs": MIN_RUNS_FOR_HEALTH,
        "stale_after": STALE_RUN_THRESHOLD,
        "sample_size": len(out),
        "sufficient": bool(out),
        "insufficient_reason": None if out else "No watches yet.",
    }


_DAY = re.compile(r"^(\d{4})-(\d{2})-\d{2}")


def month_of(date: str | None) -> str | None:
    """The month (``YYYY-MM``) a stored publication date is counted in, or None.

    The month is the one whose first and last day, as the collection's date
    filter compares them (whole text, ``from <= date <= to``), take the date in:
    so "2025-01-15" is January 2025, and "2025-01" and "2023", which sort before
    the first of their month, are in none. A time on the month's last day
    ("2025-01-31T09:00") sorts after it, and is in none either.
    """
    match = _DAY.match(date or "")
    if not match:
        return None
    year, month = int(match.group(1)), int(match.group(2))
    if not 1 <= month <= 12:
        return None
    first = f"{match.group(1)}-{match.group(2)}-01"
    last = f"{match.group(1)}-{match.group(2)}-{calendar.monthrange(year, month)[1]:02d}"
    return f"{match.group(1)}-{match.group(2)}" if first <= date <= last else None


def publication_volume(
    conn: sqlite3.Connection,
    group_by: str = "source",
    months: int = 12,
    collection_id: Optional[int] = None,
) -> dict:
    """Papers per publication month, split by source or by subject category.

    ``months`` bounds the window to the most recent N months *that contain data*
    rather than the last N calendar months, so a corpus of older papers still
    renders instead of showing an empty axis.

    A paper is counted in a month only where Search › Collection's date
    filter, set to that month's first and last day, finds it (``month_of``),
    so a month's column and the papers its click opens are the same papers. A
    date that is not a whole day ("2023", "2025-01") is in no month's range,
    and ``not_a_day`` says how many were left out.
    """
    if group_by not in ("source", "category"):
        raise ValueError("group_by must be 'source' or 'category'")

    rows = conn.execute(
        f"""
        SELECT publication_date  AS date,
               source_repository AS source,
               categories        AS categories
        FROM {documents_in(collection_id)}
        WHERE publication_date IS NOT NULL AND TRIM(publication_date) <> ''
        """
    ).fetchall()

    counts: dict[str, dict[str, int]] = defaultdict(lambda: defaultdict(int))
    counted = 0
    for r in rows:
        month = month_of(r["date"])
        if month is None:
            continue
        counted += 1
        if group_by == "source":
            counts[month][r["source"]] += 1
        else:
            cats = [c.strip() for c in str(r["categories"] or "").split(",") if c.strip()]
            for cat in cats or ["(uncategorised)"]:
                counts[month][cat] += 1

    all_months = sorted(counts)
    window = all_months[-months:] if months and months > 0 else all_months

    # Keep the legend readable: the largest groups by name, everything else
    # folded into "other" rather than dropped.
    totals: dict[str, int] = defaultdict(int)
    for month in window:
        for name, n in counts[month].items():
            totals[name] += n
    top = [name for name, _ in sorted(totals.items(), key=lambda kv: -kv[1])[:8]]

    series = []
    for month in window:
        bucket = {"month": month, "total": sum(counts[month].values()), "groups": {}}
        other = 0
        for name, n in counts[month].items():
            if name in top:
                bucket["groups"][name] = n
            else:
                other += n
        if other:
            bucket["groups"]["other"] = other
        series.append(bucket)

    return {
        "group_by": group_by,
        "groups": top + (["other"] if any("other" in b["groups"] for b in series) else []),
        "series": series,
        "sample_size": counted,
        "not_a_day": len(rows) - counted,
        "sufficient": len(series) > 0,
        "insufficient_reason": (
            None if series
            else "No papers with a usable publication date yet."
        ),
    }


def overview(conn: sqlite3.Connection, collection_id: Optional[int] = None) -> dict:
    """Everything the Analytics page needs, in one round trip."""
    return {
        "summary": corpus_summary(conn, collection_id),
        "source_contribution": source_contribution(conn, collection_id),
        "discovery_lag": discovery_lag(conn, collection_id),
        "routine_health": routine_health(conn, collection_id),
        "publication_volume": publication_volume(conn, collection_id=collection_id),
    }
