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
"""

from __future__ import annotations

import sqlite3
from collections import defaultdict
from statistics import median

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


def corpus_summary(conn: sqlite3.Connection) -> dict:
    """Headline counts for the whole corpus."""
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
        FROM documents
        """
    ).fetchone()

    documents = row["documents"] or 0
    with_doi = row["with_doi"] or 0

    executions = conn.execute(
        "SELECT COUNT(*) AS n FROM executions WHERE status = 'completed'"
    ).fetchone()["n"]

    authors: set[str] = set()
    for (blob,) in conn.execute(
        "SELECT authors FROM documents WHERE authors IS NOT NULL AND TRIM(authors) <> ''"
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


def source_contribution(conn: sqlite3.Connection) -> dict:
    """Per source: how many papers it delivered, and how many nothing else found.

    This is the question "which of my 15 repositories actually earn their
    place?". A source whose every paper also arrives from somewhere else costs
    time and API quota on every sweep and contributes nothing.
    """
    key = _dedup_key_sql()
    rows = conn.execute(
        f"""
        WITH keyed AS (
            SELECT id, source_repository, {key} AS k FROM documents
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


def discovery_lag(conn: sqlite3.Connection) -> dict:
    """Median days between a paper's publication date and resmon first seeing it.

    resmon is unusually placed to answer this: it stamps ``first_seen_at`` itself,
    so it knows how long each source took to surface a paper *to this user*. A
    source with a two-week median does not justify an hourly routine.
    """
    rows = conn.execute(
        """
        SELECT source_repository AS source,
               julianday(first_seen_at) - julianday(publication_date) AS lag_days
        FROM documents
        WHERE publication_date IS NOT NULL
          AND TRIM(publication_date) <> ''
          AND first_seen_at IS NOT NULL
        """
    ).fetchall()

    by_source: dict[str, list[float]] = defaultdict(list)
    for r in rows:
        lag = r["lag_days"]
        if lag is None:
            continue
        # Negative lags are real: preprint servers publish dates that postdate
        # the posting, and some sources report a future issue date. Keep them --
        # the median is robust, and silently dropping them would flatter the
        # source.
        by_source[r["source"]].append(float(lag))

    sources = []
    for source, lags in sorted(by_source.items()):
        n = len(lags)
        enough = n >= MIN_SAMPLE_FOR_LAG
        sources.append({
            "source": source,
            "sample_size": n,
            "sufficient": enough,
            "median_days": round(median(lags), 1) if enough else None,
            "fastest_days": round(min(lags), 1) if enough else None,
            "slowest_days": round(max(lags), 1) if enough else None,
        })

    sources.sort(key=lambda s: (s["median_days"] is None, s["median_days"] or 0))
    reported = [s for s in sources if s["sufficient"]]
    return {
        "sources": sources,
        "sample_size": len(rows),
        "sufficient": bool(reported),
        "minimum_sample": MIN_SAMPLE_FOR_LAG,
        "insufficient_reason": (
            None if reported
            else f"Needs at least {MIN_SAMPLE_FOR_LAG} dated papers from a source."
        ),
    }


def routine_health(conn: sqlite3.Connection) -> dict:
    """Per routine: new results per run, and whether it has gone quiet.

    The actionable question is "is this routine still worth running?". A routine
    that has returned nothing new for several runs is either too narrow, or its
    field has gone quiet, and either way the user should know.
    """
    routines = conn.execute(
        "SELECT id, name, schedule_cron, is_active FROM routines ORDER BY name"
    ).fetchall()

    out = []
    for r in routines:
        runs = conn.execute(
            """
            SELECT start_time, new_result_count, result_count
            FROM executions
            WHERE routine_id = ? AND status = 'completed'
            ORDER BY start_time ASC
            """,
            (r["id"],),
        ).fetchall()

        series = [
            {
                "start_time": run["start_time"],
                "new_results": run["new_result_count"] or 0,
                "total_results": run["result_count"] or 0,
            }
            for run in runs
        ]

        # Trailing runs that found nothing new.
        runs_since_new = 0
        for run in reversed(series):
            if run["new_results"] > 0:
                break
            runs_since_new += 1

        n = len(series)
        if n < MIN_RUNS_FOR_HEALTH:
            status = "insufficient_data"
        elif runs_since_new >= STALE_RUN_THRESHOLD:
            status = "stale"
        else:
            status = "healthy"

        last_new = next(
            (run["start_time"] for run in reversed(series) if run["new_results"] > 0),
            None,
        )

        out.append({
            "routine_id": r["id"],
            "name": r["name"],
            "schedule_cron": r["schedule_cron"],
            "is_active": bool(r["is_active"]),
            "runs": n,
            "series": series,
            "runs_since_new": runs_since_new,
            "last_new_result_at": last_new,
            "total_new": sum(run["new_results"] for run in series),
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
        "insufficient_reason": None if out else "No routines created yet.",
    }


def publication_volume(
    conn: sqlite3.Connection,
    group_by: str = "source",
    months: int = 12,
) -> dict:
    """Papers per publication month, split by source or by subject category.

    ``months`` bounds the window to the most recent N months *that contain data*
    rather than the last N calendar months, so a corpus of older papers still
    renders instead of showing an empty axis.
    """
    if group_by not in ("source", "category"):
        raise ValueError("group_by must be 'source' or 'category'")

    rows = conn.execute(
        """
        SELECT substr(publication_date, 1, 7) AS month,
               source_repository              AS source,
               categories                     AS categories
        FROM documents
        WHERE publication_date IS NOT NULL AND length(publication_date) >= 7
        """
    ).fetchall()

    counts: dict[str, dict[str, int]] = defaultdict(lambda: defaultdict(int))
    for r in rows:
        month = r["month"]
        if not month:
            continue
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
        "sample_size": len(rows),
        "sufficient": len(series) > 0,
        "insufficient_reason": (
            None if series
            else "No papers with a usable publication date yet."
        ),
    }


def overview(conn: sqlite3.Connection) -> dict:
    """Everything the Analytics page needs, in one round trip."""
    return {
        "summary": corpus_summary(conn),
        "source_contribution": source_contribution(conn),
        "discovery_lag": discovery_lag(conn),
        "routine_health": routine_health(conn),
        "publication_volume": publication_volume(conn),
    }
