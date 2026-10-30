# resmon_scripts/implementation_scripts/map_facets.py
"""What the map's filters, colors and find read about each paper.

The collection map (``collection_map``) says only where a paper sits. Lighting
some papers and dimming the rest, or coloring them by watch, source or age,
needs a few more facts per paper, and this module serves them as columns, the
way the map serves its points: at 100,000 papers one object per paper would be
several times the size.

Each fact is what the database holds, nothing inferred:

- the source a paper came from (its slug);
- the publication date as the source gave it, as the first day of the period
  it names: a date given only as a year or a month counts from that year's or
  month's first day, and anything that is not a date is ``None``;
- when resmon first collected it, as Unix seconds, so the interface can count
  days in the person's own time zone;
- whether it is in the reading queue, and read;
- whether it is new on Today, by Today's own definition (``today``);
- every watch whose runs returned it.

Find is a substring of a title or of the authors as stored, case-insensitive
for ASCII letters (SQLite's ``LIKE``), newest first.

A map's view (which filters, which colors) is remembered in ``app_settings``,
one key per map, so it survives the renderer's origin changing every launch.
"""

from __future__ import annotations

import json
import re
import sqlite3
from datetime import date, datetime, timezone
from typing import Optional

from implementation_scripts import today
from implementation_scripts.database import get_setting, set_setting

#: The maps a view is remembered for: Today's, and one for every run's map.
VIEW_NAMES = ("today", "run")
COLORS = ("region", "watch", "source", "age")
DATE_BASES = ("found", "published")
STATES = ("any", "saved", "to_read", "read", "new")
#: The shortest find the engine runs: one letter matches most of a collection.
FIND_MIN_CHARS = 2

_EPOCH = date(1970, 1, 1)
_PUBLISHED = re.compile(r"^\s*(\d{4})(?:-(\d{1,2})(?:-(\d{1,2}))?)?")
_DAY = re.compile(r"^\d{4}-\d{2}-\d{2}$")


def published_day(value: Optional[str]) -> Optional[int]:
    """Days since 1970-01-01 of the first day the publication date names, or None."""
    match = _PUBLISHED.match(value or "")
    if not match:
        return None
    year, month, day = int(match.group(1)), int(match.group(2) or 1), int(match.group(3) or 1)
    try:
        return (date(year, month, day) - _EPOCH).days
    except ValueError:
        return None


def _seconds(value: Optional[str]) -> Optional[int]:
    """``first_seen_at`` (UTC, as SQLite writes it) as Unix seconds."""
    if not value:
        return None
    try:
        moment = datetime.strptime(value[:19], "%Y-%m-%d %H:%M:%S").replace(tzinfo=timezone.utc)
    except ValueError:
        return None
    return int(moment.timestamp())


def facets(conn: sqlite3.Connection, now: Optional[datetime] = None) -> dict:
    """Every paper's facts, as columns in id order, with the watches' members."""
    ids: list[int] = []
    source: list[int] = []
    published: list[Optional[int]] = []
    found: list[Optional[int]] = []
    slugs: dict[str, int] = {}
    for doc_id, slug, publication_date, first_seen_at in conn.execute(
            "SELECT id, source_repository, publication_date, first_seen_at FROM documents ORDER BY id"):
        ids.append(int(doc_id))
        source.append(slugs.setdefault(slug or "", len(slugs)))
        published.append(published_day(publication_date))
        found.append(_seconds(first_seen_at))

    saved: list[int] = []
    read: list[int] = []
    for doc_id, status in conn.execute("SELECT document_id, status FROM reading_queue ORDER BY document_id"):
        (read if status == "read" else saved).append(int(doc_id))

    # "New" is Today's window: after the last look, or the last seven days when
    # none is recorded, which the interface then says.
    window = today.new_window(conn, now)
    new = [int(r[0]) for r in conn.execute(
        "SELECT id FROM documents WHERE first_seen_at > ? ORDER BY id", (window["floor"],))]

    members: dict[int, list[int]] = {}
    for routine_id, doc_id in conn.execute(
            "SELECT DISTINCT e.routine_id, ed.document_id FROM execution_documents ed "
            "JOIN executions e ON e.id = ed.execution_id WHERE e.routine_id IS NOT NULL "
            "ORDER BY e.routine_id, ed.document_id"):
        members.setdefault(int(routine_id), []).append(int(doc_id))
    watches = [{
        "id": int(r["id"]), "name": r["name"], "is_active": bool(r["is_active"]),
        "members": members.get(int(r["id"]), []),
    } for r in conn.execute("SELECT id, name, is_active FROM routines ORDER BY name COLLATE NOCASE, id")]

    return {
        "ids": ids,
        "source": source,
        "sources": list(slugs),
        "published_day": published,
        "found_at": found,
        "saved": saved,
        "read": read,
        "since": window["since"],
        "window": window["window"],
        "new": new,
        "watches": watches,
    }


def find(conn: sqlite3.Connection, query: str) -> list[int]:
    """Papers whose title or authors contain ``query``, newest first.

    ``%`` and ``_`` in the query are matched literally. A query shorter than
    :data:`FIND_MIN_CHARS` after trimming finds nothing.
    """
    text = " ".join((query or "").split())
    if len(text) < FIND_MIN_CHARS:
        return []
    pattern = "%" + text.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_") + "%"
    return [int(r[0]) for r in conn.execute(
        "SELECT id FROM documents WHERE title LIKE ? ESCAPE '\\' OR authors LIKE ? ESCAPE '\\' "
        "ORDER BY first_seen_at DESC, id DESC", (pattern, pattern))]


DEFAULT_VIEW = {
    "color": "region", "watches": [], "sources": [], "dates": "found",
    "date_from": None, "date_to": None, "state": "any",
}


def _key(name: str) -> str:
    return f"map_view_{name}"


def clean_view(value: object) -> dict:
    """A stored view as the interface may read it: anything unknown, or of the
    wrong shape, falls back to the default for that field rather than reaching
    the interface as something it has to parse."""
    raw = value if isinstance(value, dict) else {}
    view = dict(DEFAULT_VIEW)
    if raw.get("color") in COLORS:
        view["color"] = raw["color"]
    if raw.get("dates") in DATE_BASES:
        view["dates"] = raw["dates"]
    if raw.get("state") in STATES:
        view["state"] = raw["state"]
    watches = raw.get("watches")
    if isinstance(watches, list):
        view["watches"] = sorted({int(w) for w in watches if isinstance(w, int) and not isinstance(w, bool)})
    sources = raw.get("sources")
    if isinstance(sources, list):
        view["sources"] = sorted({s for s in sources if isinstance(s, str) and s})
    for field in ("date_from", "date_to"):
        day = raw.get(field)
        if isinstance(day, str) and _DAY.match(day):
            try:
                date.fromisoformat(day)
                view[field] = day
            except ValueError:
                pass
    return view


def read_view(conn: sqlite3.Connection, name: str) -> dict:
    try:
        stored = json.loads(get_setting(conn, _key(name)) or "null")
    except ValueError:
        stored = None
    return clean_view(stored)


def write_view(conn: sqlite3.Connection, name: str, view: dict) -> dict:
    cleaned = clean_view(view)
    set_setting(conn, _key(name), json.dumps(cleaned, sort_keys=True))
    return cleaned
