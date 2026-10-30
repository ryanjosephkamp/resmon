# resmon_scripts/implementation_scripts/today.py
"""Today: the papers resmon collected since the person last looked, by watch.

What "new" means here
---------------------
A paper is new on Today when resmon first collected it after the person last
looked (``documents.first_seen_at``). That is a fact about this database, not
about the paper: a paper published years ago and found last night is new; a
paper published last night that resmon already had is not.

"Last looked" is a moment the person records (``POST /api/today/looked``, the
interface's Mark all read), kept in ``app_settings`` so it survives a restart
and Reset settings clears it. Opening Today records nothing: an accidental
open must not empty tomorrow's list. With none recorded, Today shows the last
:data:`FIRST_LOOK_DAYS` days and says so, rather than inventing a visit.

What a watch is here
--------------------
A watch is a routine. A paper belongs to every watch whose runs returned it, so
one paper can sit in two. A paper no routine returned came from the person's own
searches (Deep Dive, Deep Sweep) and is counted as such.

What it does not say
--------------------
No summary. resmon keeps model-written summaries only inside run reports, not
per paper, so Today offers the abstract's opening, and the interface labels it
as the abstract. A watch's next run is given only as the job store records it;
whether anything will fire it is ``/api/scheduler/status``'s question, and the
interface asks it there.
"""

from __future__ import annotations

import json
import re
import sqlite3
from datetime import datetime, timedelta, timezone
from typing import Optional

from implementation_scripts import reading_queue, repo_catalog, source_coverage
from implementation_scripts.api_registry import RETIRED_NAMES
from implementation_scripts.database import get_setting, set_setting

LOOKED_KEY = "today_looked_at"
FIRST_LOOK_DAYS = 7
#: Today lists at most this many papers, newest first, and says how many more
#: there are. A month away can mean thousands; the plate still shows them all.
PAPER_LIMIT = 1_000
LEDE_CHARS = 320
#: How many papers one ``/api/documents/briefs`` request may ask about.
BRIEF_LIMIT = 200

_SQLITE_FORMAT = "%Y-%m-%d %H:%M:%S"


def _to_sqlite(moment: datetime) -> str:
    """The form ``datetime('now')`` writes ``first_seen_at`` in, so the two compare as text."""
    return moment.astimezone(timezone.utc).strftime(_SQLITE_FORMAT)


def _iso(value: Optional[str]) -> Optional[str]:
    """``2026-10-28 06:05:00`` (UTC, as SQLite writes it) to ``2026-10-28T06:05:00Z``."""
    if not value:
        return None
    try:
        moment = datetime.strptime(value[:19], _SQLITE_FORMAT).replace(tzinfo=timezone.utc)
    except ValueError:
        try:
            moment = datetime.fromisoformat(value.replace("Z", "+00:00"))
        except ValueError:
            return None
        if moment.tzinfo is None:
            moment = moment.replace(tzinfo=timezone.utc)
    return moment.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def looked_at(conn: sqlite3.Connection) -> Optional[str]:
    """When Today was last looked at, as SQLite-format UTC, or None if never."""
    value = get_setting(conn, LOOKED_KEY)
    if not value:
        return None
    try:
        datetime.strptime(value, _SQLITE_FORMAT)
    except ValueError:
        return None  # a value resmon did not write is no record of a visit
    return value


def mark_looked(conn: sqlite3.Connection, now: Optional[datetime] = None) -> str:
    """Record that Today was looked at now. Returns the moment, as ISO 8601 UTC."""
    moment = _to_sqlite(now or datetime.now(timezone.utc))
    set_setting(conn, LOOKED_KEY, moment)
    return _iso(moment) or moment


_SENTENCE_END = re.compile(r"(?<=[.!?])\s+")


def lede(abstract: Optional[str]) -> Optional[str]:
    """The abstract's opening: whole sentences up to :data:`LEDE_CHARS`, or the
    first sentence cut at a word with an ellipsis when that alone is longer."""
    text = " ".join((abstract or "").split())
    if not text:
        return None
    out = ""
    for sentence in _SENTENCE_END.split(text):
        candidate = f"{out} {sentence}".strip()
        if len(candidate) > LEDE_CHARS:
            break
        out = candidate
    if out:
        return out
    cut = text[:LEDE_CHARS].rsplit(" ", 1)[0].rstrip(",;:")
    return f"{cut}…"


def briefs(conn: sqlite3.Connection, ids: list[int]) -> list[dict]:
    """One line about each paper, in the order asked, for ids in the corpus."""
    wanted = list(dict.fromkeys(int(i) for i in ids))[:BRIEF_LIMIT]
    if not wanted:
        return []
    marks = ",".join("?" * len(wanted))
    found = {int(r["id"]): r for r in conn.execute(
        f"SELECT id, title, authors, source_repository, publication_date, first_seen_at "
        f"FROM documents WHERE id IN ({marks})", wanted)}
    return [{
        "id": doc_id,
        "title": found[doc_id]["title"],
        "authors": found[doc_id]["authors"],
        "source": found[doc_id]["source_repository"],
        "publication_date": found[doc_id]["publication_date"],
        "first_seen_at": _iso(found[doc_id]["first_seen_at"]),
    } for doc_id in wanted if doc_id in found]


def _last_run(conn: sqlite3.Connection, routine_id: int) -> Optional[dict]:
    row = conn.execute(
        "SELECT * FROM executions WHERE routine_id = ? ORDER BY start_time DESC, id DESC LIMIT 1",
        (routine_id,),
    ).fetchone()
    if row is None:
        return None
    execution = dict(row)
    # The sentences name each source as the person knows it ("DBLP"), not by
    # its slug ("dblp"); the slug stays the key the interface links on.
    names = {entry.slug: entry.name for entry in repo_catalog.REPOSITORY_CATALOG}
    sources = []
    for r in conn.execute(
            "SELECT * FROM execution_sources WHERE execution_id = ? ORDER BY source", (execution["id"],)):
        named = dict(r)
        named["source"] = names.get(named["source"], named["source"])
        sources.append(named)
    params = execution.get("parameters")
    try:
        parsed = json.loads(params) if isinstance(params, str) else (params or {})
    except ValueError:
        parsed = {}
    if isinstance(parsed, dict) and isinstance(parsed.get("repositories"), list):
        parsed = {**parsed, "repositories": [names.get(slug, slug) for slug in parsed["repositories"]]}
        execution = {**execution, "parameters": json.dumps(parsed)}
    coverage = source_coverage.build(execution, sources)
    slug_of = {name: slug for slug, name in names.items()}
    # Only the sources that did not answer, or whose answer is unknown: on
    # Today the healthy ones recede, and a problem sits with the watch it hurt.
    # ``name`` is what the person knows the source as, a withdrawn one too,
    # whose slug the catalog no longer lists.
    problems = []
    for s in coverage["sources"]:
        if s["category"] == "answered":
            continue
        slug = slug_of.get(s["source"], s["source"])
        problems.append({
            "source": slug,
            "name": names.get(slug) or RETIRED_NAMES.get(slug) or slug,
            "category": s["category"],
            "label": s["label"],
            "note": s["note"],
        })
    answered = sum(s["category"] == "answered" for s in coverage["sources"])
    return {
        "execution_id": int(execution["id"]),
        "status": execution["status"],
        "started_at": _iso(execution.get("start_time")),
        "ended_at": _iso(execution.get("end_time")),
        "result_count": int(execution.get("result_count") or 0),
        "new_result_count": int(execution.get("new_result_count") or 0),
        "sources_total": len(coverage["sources"]),
        "sources_answered": answered,
        "sources_not_answered": problems,
    }


def new_window(conn: sqlite3.Connection, now: Optional[datetime] = None) -> dict:
    """What "new" counts from: ``floor`` (SQLite-format UTC, compared with
    ``first_seen_at`` as text), ``since`` (the same moment as ISO 8601), and
    ``window``, which says whether a look is recorded or the first look's seven
    days stand in for one."""
    now = now or datetime.now(timezone.utc)
    since = looked_at(conn)
    floor = since or _to_sqlite(now - timedelta(days=FIRST_LOOK_DAYS))
    return {
        "window": "since_last_look" if since else "first_look",
        "floor": floor,
        "since": _iso(floor),
    }


def build(conn: sqlite3.Connection, next_fire: dict[str, Optional[float]],
          now: Optional[datetime] = None) -> dict:
    """Today's papers and watches. ``next_fire`` is ``{routine id: epoch seconds}``
    from the job store (absent or None where no job is held)."""
    now = now or datetime.now(timezone.utc)
    span = new_window(conn, now)
    window = span["window"]
    floor = span["floor"]

    total = int(conn.execute(
        "SELECT COUNT(*) FROM documents WHERE first_seen_at > ?", (floor,)).fetchone()[0])
    rows = [dict(r) for r in conn.execute(
        "SELECT id, title, authors, source_repository, publication_date, first_seen_at, "
        "abstract, url, doi FROM documents WHERE first_seen_at > ? "
        "ORDER BY first_seen_at DESC, id DESC LIMIT ?", (floor, PAPER_LIMIT))]
    ids = [int(r["id"]) for r in rows]

    # Every watch whose runs returned each paper, counted over all the new
    # papers rather than the listed page, so a watch's count is not capped.
    watches_of: dict[int, list[int]] = {}
    counts: dict[int, int] = {}
    for doc_id, routine_id in conn.execute(
            "SELECT DISTINCT ed.document_id, e.routine_id FROM execution_documents ed "
            "JOIN executions e ON e.id = ed.execution_id "
            "JOIN documents d ON d.id = ed.document_id "
            "WHERE d.first_seen_at > ? AND e.routine_id IS NOT NULL", (floor,)):
        watches_of.setdefault(int(doc_id), []).append(int(routine_id))
        counts[int(routine_id)] = counts.get(int(routine_id), 0) + 1
    from_searches = total - len(watches_of)

    saved = reading_queue.statuses_for(conn, ids)
    papers = [{
        "id": int(r["id"]),
        "title": r["title"],
        "authors": r["authors"],
        "source": r["source_repository"],
        "publication_date": r["publication_date"],
        "first_seen_at": _iso(r["first_seen_at"]),
        "abstract_lede": lede(r["abstract"]),
        "url": r["url"],
        "doi": r["doi"],
        "watches": sorted(watches_of.get(int(r["id"]), [])),
        "queue_status": saved.get(int(r["id"])),
    } for r in rows]

    # Every paper each watch has ever returned, for its outline on the plate.
    members: dict[int, list[int]] = {}
    for routine_id, doc_id in conn.execute(
            "SELECT DISTINCT e.routine_id, ed.document_id FROM execution_documents ed "
            "JOIN executions e ON e.id = ed.execution_id WHERE e.routine_id IS NOT NULL "
            "ORDER BY e.routine_id, ed.document_id"):
        members.setdefault(int(routine_id), []).append(int(doc_id))

    watches = []
    for routine in conn.execute("SELECT id, name, is_active FROM routines ORDER BY name COLLATE NOCASE, id"):
        rid = int(routine["id"])
        if not routine["is_active"] and rid not in counts:
            continue  # an inactive watch with nothing new has nothing to say today
        fire = next_fire.get(str(rid))
        watches.append({
            "id": rid,
            "name": routine["name"],
            "is_active": bool(routine["is_active"]),
            "new_count": counts.get(rid, 0),
            "last_run": _last_run(conn, rid),
            "next_fire_at": datetime.fromtimestamp(fire, timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
            if fire is not None else None,
            "members": members.get(rid, []),
        })

    return {
        "now": now.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "since": span["since"],
        "window": window,
        "total": total,
        "papers": papers,
        "from_searches": max(0, from_searches),
        "watches": watches,
    }
