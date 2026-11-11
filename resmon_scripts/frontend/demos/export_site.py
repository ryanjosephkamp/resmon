#!/usr/bin/env python3
"""Write the site's home-page data from the demo collection.

Run it with the engine's own interpreter, after ``build_collection.py``:

    python resmon_scripts/frontend/demos/export_site.py /path/to/collection

It copies the collection's state into a temporary folder, starts the engine
headless over the copy (the collection itself is never written), and saves the
engine's own answers, unedited, beside the site's other data:

- ``site/src/data/plate.json``: ``GET /api/map`` and ``GET /api/today``, the
  two answers Today is drawn from. The site draws its plate from them with the
  app's own map model.
- ``site/src/data/run-record.json``: ``GET /api/coverage/source-wall`` over the
  collection's last runs, with each run's own record: the searches and each watch's run of the day,
  which ``build_collection.py`` made for real, after the history it laid out.
- ``site/src/data/papers.json``: ``GET /api/documents/{id}`` for every paper on
  the plate, the few fields its hover, its paper panel, and its find read:
  title, authors, source, dates, and the paper's own link.
- ``site/src/data/facets.json``: ``GET /api/map/facets``, what the map's filters
  and colors read: each paper's source, dates, and watches.

Each file carries a ``provenance`` line, printed under what the site draws.
"""

from __future__ import annotations

import argparse
import json
import shutil
import sys
import tempfile
import time
from datetime import datetime, timezone
from pathlib import Path
from zoneinfo import ZoneInfo

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
from build_collection import FORBIDDEN, SEARCHES, WATCHES, Engine  # noqa: E402

SITE_DATA = HERE.parents[2] / "site" / "src" / "data"
#: The runs ``build_collection.py`` made for real, last: its searches, then one run of each watch.
REAL_RUNS = len(SEARCHES) + len(WATCHES)
#: A run record's fields the Source wall already holds, that only the run's own page needs, or that
#: name the temporary copy the engine ran over.
RECORD_SKIP = {"coverage", "identity", "progress_events", "source_outcomes", "ai_lanes",
               "log_path", "result_path", "owner_pid", "owner_runtime_id", "last_seen_at_utc"}


def say(message: str) -> None:
    print(f"[site] {message}", flush=True)


def spoken_day(iso: str) -> str:
    """The saved run's day in New York, the Source wall's displayed time zone."""
    moment = datetime.fromisoformat(iso.replace("Z", "+00:00"))
    if moment.tzinfo is None:
        moment = moment.replace(tzinfo=timezone.utc)
    moment = moment.astimezone(ZoneInfo('America/New_York'))
    return f"{moment:%B} {moment.day}, {moment.year}"


def words(n: int) -> str:
    """A small count in words, as the provenance line says it."""
    return ["no", "one", "two", "three", "four", "five", "six"][n] if n < 7 else str(n)


#: The columns of ``papers.json``'s rows, in order.
PAPER_FIELDS = ["id", "title", "authors", "source", "published", "collected", "link"]


def paper_row(doc: dict) -> list:
    """One paper as its hover and panel say it and the map's find reads it: all
    its authors, since the find matches any of them, as the engine's does."""
    url = doc.get("url") or ""
    link = url if url.startswith(("http://", "https://")) else (f"https://doi.org/{doc['doi']}" if doc.get("doi") else None)
    return [doc["id"], doc["title"], doc.get("authors") or None, doc["source_repository"],
            doc.get("publication_date"), doc.get("first_seen_at"), link]


def write(name: str, data: dict) -> None:
    path = SITE_DATA / name
    path.write_text(json.dumps(data, indent=1, ensure_ascii=False) + "\n")
    say(f"wrote {path} ({path.stat().st_size // 1024} KB)")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("collection", type=Path, help="a folder build_collection.py made")
    args = parser.parse_args()
    root = args.collection.expanduser().resolve()
    if root == FORBIDDEN or FORBIDDEN in root.parents:
        raise SystemExit("That is the installed app's own state. Give the demo collection's folder.")
    if not (root / "state" / "resmon.db").exists():
        raise SystemExit(f"{root} holds no collection; run build_collection.py first.")

    with tempfile.TemporaryDirectory(prefix="resmon-site-") as scratch:
        state = Path(scratch) / "state"
        shutil.copytree(root / "state", state)
        env = {
            "RESMON_STATE_DIR": str(state),
            "RESMON_DB_PATH": str(state / "resmon.db"),
            "RESMON_REPORTS_DIR": str(state / "reports"),
            "RESMON_PORT_FILE": str(state / "resmon.port"),
            "RESMON_SERVICE_UNIT_DIR": str(state / "service-units"),
            "RESMON_SERVICE_LABEL": "com.resmon.demo",
            "RESMON_LAUNCHCTL": str(Path(__file__).resolve().parents[2] / "verification_scripts" / "fixtures" / "fake_launchctl.py"),
            "PYTHON_KEYRING_BACKEND": "keyring.backends.null.Keyring",
            "RESMON_AI_CLI_DISCOVERY": "configured-only",
            "RESMON_DISABLE_SCHEDULER": "1",
        }
        engine = Engine(env, sys.executable, Path(scratch) / "engine.log")
        try:
            deadline = time.monotonic() + 300
            plate = engine.call("GET", "/api/map")
            while plate.get("state") != "ready" and time.monotonic() < deadline:
                time.sleep(2)
                plate = engine.call("GET", "/api/map")
            if plate.get("state") != "ready":
                raise SystemExit(f"The map is {plate.get('state')!r}, not ready; nothing was written.")
            today = engine.call("GET", "/api/today")
            wall = engine.call("GET", f"/api/coverage/source-wall?limit={REAL_RUNS}")
            # Each run's own record, for what it asked and what it found; the
            # per-source detail the wall already carries is left out.
            runs = [
                {k: v for k, v in engine.call("GET", f"/api/executions/{run['execution_id']}").items() if k not in RECORD_SKIP}
                for run in wall["runs"]
            ]
            papers = [paper_row(engine.call("GET", f"/api/documents/{doc_id}")) for doc_id in plate["points"]["id"]]
            facets = engine.call("GET", "/api/map/facets")
        finally:
            engine.stop()

    # An export can happen days after collection. Date the collection from
    # its saved runs, in the same zone the site's Source wall uses.
    day = spoken_day(wall["runs"][0]["started_at"])
    write("plate.json", {
        "provenance": (
            f"Drawn from the engine's own map and Today, exported unedited from a collection built on {day}: "
            f"{words(len(WATCHES))} watches' papers from arXiv, and {words(len(SEARCHES))} searches' from the "
            "sources they asked. The papers and the day's runs are real. For the watches' earlier papers, the day "
            "each was collected, and so how bright it is drawn, is set from its publication date."
        ),
        "map": plate,
        "today": today,
    })
    write("run-record.json", {
        "provenance": (
            f"The Source wall of the same collection on {day}, exported unedited: {words(len(SEARCHES))} searches "
            "and each watch's run of the day, every one asked of the public sources for real."
        ),
        "wall": wall,
        "runs": runs,
    })
    write("papers.json", {
        "provenance": (
            f"Every paper on the plate, {len(papers):,} of them, from the engine's own record of each: its title, "
            "its authors, its source, its dates, and its link."
        ),
        "fields": PAPER_FIELDS,
        "papers": papers,
    })
    write("facets.json", {
        "provenance": "The engine's own facets of the same collection, exported unedited: what the map's filters and colors read.",
        "facets": facets,
    })


if __name__ == "__main__":
    main()
