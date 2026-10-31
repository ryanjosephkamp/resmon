#!/usr/bin/env python3
"""Build the collection the Atlas demos are recorded over, from scratch.

Run it with the engine's own interpreter, from anywhere:

    python resmon_scripts/frontend/demos/build_collection.py /path/to/new/folder

The folder must not exist yet. Everything resmon keeps for the collection goes
inside it -- the database, the reports, the map, the library of PDFs -- and
nothing goes anywhere else: never the person's own collection, never the
installed app's state, never the keychain, never the background service.

What it makes
-------------
Real, public papers, so the map has a true shape:

1. **Three watches**, on three related topics, as the Watch editor saves them.
2. **Their history.** Each topic's newest papers are fetched live from
   arXiv's public API through the engine's own arXiv client, and laid out as
   the daily runs that would have collected them: a watch's first run takes
   everything older than the day it was made, and each run after it takes
   what arXiv published since the run before, and the protein watch's CORE
   is recorded on each as the engine records a source with no key. The papers
   are arXiv's; the times are a reconstruction, which is why the newest papers
   are left out of it.
3. **Two searches, for real.** The engine is started headless and asked a
   Deep Sweep over several sources and a Deep Dive, so the Source wall has
   more than arXiv to show. Today is then marked as looked at.
4. **Today's runs, for real.** Each watch is run once, now. Those runs find
   the papers the history left out, so Today's new papers came from runs the
   engine really made, and the protein watch's second source, CORE, is
   recorded as the engine records a source with no API key: which is what
   the Watchdog then reports.
5. **A library** of three of the collection's own papers, as PDFs from arXiv,
   in an Evidence project, where a PDF is read: only papers whose license
   allows their pages to be shown publicly, as the demos are.
6. **The map**, fitted once, so Today opens on it.

The demos then copy this folder for every recording, so each one starts from
the same collection. See README.md beside this file.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import shutil
import signal
import socket
import subprocess
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import date, datetime, timedelta, timezone
from pathlib import Path

HERE = Path(__file__).resolve().parent
SCRIPTS = HERE.parents[1]

#: The installed app's state. Nothing here may be written there or read from it.
FORBIDDEN = Path.home() / "Library" / "Application Support" / "resmon"
#: The background service's port. The engine started here never binds or asks it.
SERVICE_PORT = 8742

#: The three watches: a name, the words they search for, and their sources.
#: The topics are related, so the map has neighbors as well as regions. Each
#: term is quoted, as a person types a phrase, because arXiv joins bare words
#: so loosely that a topic's newest few hundred papers would cover two days.
WATCHES = [
    {
        "name": "Graph neural networks", "keywords": ['"graph neural network"'],
        "sources": ["arxiv"], "cron": "0 6 * * *", "fetch": 450,
        "intent": "New architectures and training methods for learning on graphs.",
    },
    {
        "name": "Protein structure", "keywords": ['"protein structure"'],
        "sources": ["arxiv", "core"], "cron": "30 6 * * *", "fetch": 450,
        "intent": "Predicting and designing protein structures, especially with deep learning.",
    },
    {
        "name": "Diffusion models", "keywords": ['"diffusion model"'],
        "sources": ["arxiv"], "cron": "0 7 * * *", "fetch": 450,
        "intent": "Diffusion and score-based generative models, and how they are trained and sampled.",
    },
]
#: How long ago the watches were made, in days. Their first run took everything older.
HISTORY_DAYS = 18
#: Two searches made by hand. The sweep's sources answer without a key, and the
#: dive asks OpenAlex so arXiv is asked no more than the watches need.
SEARCHES = [
    {"kind": "sweep", "query": "protein language models",
     "sources": ["arxiv", "europepmc", "openalex", "crossref"], "max_results": 60},
    {"kind": "dive", "query": "equivariant graph neural networks", "sources": ["openalex"], "max_results": 80},
]
#: arXiv asks for one request every three seconds and answers a burst with 429s
#: for a while after; the pause between topics, and before the engine asks again.
ARXIV_PAUSE = 20
#: How many of the collection's papers go into the library as PDFs, and the
#: Evidence project they are read in.
LIBRARY_PAPERS = 3
EVIDENCE_PROJECT = "Reading for the watches"


def say(message: str) -> None:
    print(f"[collection] {message}", flush=True)


def isolate(root: Path) -> dict[str, str]:
    """Point every piece of state resmon keeps at ``root``, before the engine is imported."""
    state = root / "state"
    state.mkdir(parents=True)
    env = {
        "RESMON_STATE_DIR": str(state),
        "RESMON_DB_PATH": str(state / "resmon.db"),
        "RESMON_REPORTS_DIR": str(state / "reports"),
        "RESMON_PORT_FILE": str(state / "resmon.port"),
        "RESMON_SERVICE_UNIT_DIR": str(state / "service-units"),
        # Nothing is read from or written to the keychain, so no source has a key.
        "PYTHON_KEYRING_BACKEND": "keyring.backends.null.Keyring",
        # No AI command is looked for, so none can run.
        "RESMON_AI_CLI_DISCOVERY": "configured-only",
        # The engine started below never fires a schedule; its runs are asked for.
        "RESMON_DISABLE_SCHEDULER": "1",
    }
    os.environ.update(env)
    return env


def sqlite_time(moment: datetime) -> str:
    """UTC, as SQLite's ``datetime('now')`` writes it, which ``first_seen_at`` is compared in."""
    return moment.astimezone(timezone.utc).strftime("%Y-%m-%d %H:%M:%S")


def iso_time(moment: datetime) -> str:
    """UTC, as the engine's ``now_iso`` writes a run's times."""
    return moment.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def watch_parameters(watch: dict) -> dict:
    """The parameters the Watch editor saves for a watch on words (`editor.ts`, `watchBody`)."""
    return {
        "repositories": list(watch["sources"]),
        "keywords": list(watch["keywords"]),
        "query": " ".join(watch["keywords"]),
        "date_from": "",
        "date_to": "",
        "date_window": {"since": "previous_run"},
        "max_results": 100,
    }


def run_times(cron: str, made: datetime, until: datetime) -> list[datetime]:
    """Every daily fire of ``cron`` (minute hour * * *, local time) after ``made`` and before ``until``."""
    minute, hour = (int(part) for part in cron.split()[:2])
    local = made.astimezone()
    day = local.replace(hour=hour, minute=minute, second=0, microsecond=0)
    if day <= local:
        day += timedelta(days=1)
    times = []
    while day < until:
        times.append(day)
        day += timedelta(days=1)
    return times


def fetch_topic(query: str, count: int) -> list:
    """The newest ``count`` arXiv papers for ``query``, through the engine's own client."""
    from implementation_scripts.api_arxiv import ArxivClient

    for attempt in range(3):
        results = ArxivClient().search(query, max_results=count)
        if len(results) >= count * 0.9:
            return results
        say(f"arXiv returned {len(results)} of {count} for {query!r}; asking again")
        time.sleep(10 * (attempt + 1))
    raise SystemExit(f"arXiv did not return enough papers for {query!r}; try again later.")


def published(result) -> date:
    return date.fromisoformat((result.publication_date or "1970-01-01")[:10])


def seed_history(db_path: str, now: datetime) -> dict[str, int]:
    """The watches, and the daily runs that collected each topic's papers up to yesterday."""
    from implementation_scripts.database import (
        get_connection, get_document_by_source, init_db, insert_execution, insert_routine,
        link_execution_document, record_execution_source, update_execution_status,
    )
    from implementation_scripts.normalizer import deduplicate_batch, normalize_result, validate_result

    init_db(db_path)
    conn = get_connection(db_path)
    made = now - timedelta(days=HISTORY_DAYS)
    # The history stops before today's first fire: today's runs are made for real, later.
    today_start = now.astimezone().replace(hour=0, minute=0, second=0, microsecond=0)
    ids: dict[str, int] = {}
    for watch in WATCHES:
        parameters = watch_parameters(watch)
        routine_id = insert_routine(conn, {
            "name": watch["name"], "schedule_cron": watch["cron"], "parameters": json.dumps(parameters),
            "intent": watch["intent"], "is_active": 1,
        })
        conn.execute("UPDATE routines SET created_at = ? WHERE id = ?", (sqlite_time(made), routine_id))
        ids[watch["name"]] = routine_id
        conn.commit()

        query = parameters["query"]
        say(f"fetching the newest {watch['fetch']} arXiv papers for {query!r}")
        papers = sorted(fetch_topic(query, watch["fetch"]), key=published)
        fires = run_times(watch["cron"], made, today_start)
        # A run on day D collects what arXiv published before D, so the papers
        # of yesterday and today are left for today's real run to find.
        taken = 0
        for index, fire in enumerate(fires):
            cutoff = fire.date()
            batch = [p for p in papers[taken:] if published(p) < cutoff]
            taken += len(batch)
            started = fire + timedelta(seconds=4 + index % 5)
            exec_id = insert_execution(conn, {
                "execution_type": "automated_sweep", "routine_id": routine_id,
                "parameters": json.dumps(parameters), "start_time": iso_time(started), "status": "running",
                "last_seen_at_utc": iso_time(started),
            })
            deduplicate_batch(conn, batch)
            new = 0
            for result in batch:
                normalized = normalize_result(result)
                if not validate_result(normalized):
                    continue
                row = get_document_by_source(conn, normalized.source_repository, normalized.external_id)
                if not row:
                    continue
                fresh = row["first_seen_at"] >= sqlite_time(now - timedelta(minutes=30))
                if fresh:
                    conn.execute("UPDATE documents SET first_seen_at = ? WHERE id = ?",
                                 (sqlite_time(started), row["id"]))
                    new += 1
                link_execution_document(conn, exec_id, row["id"], is_new=fresh)
            record_execution_source(conn, exec_id, "arxiv", "ok", result_count=len(batch),
                                    zero_reason=None if batch else "answered_empty")
            if "core" in watch["sources"]:
                # What the engine records for a source that needs a key and has none:
                # the record today's real run then writes for itself.
                record_execution_source(conn, exec_id, "core", "skipped_missing_key", result_count=0,
                                        credential_name="core_api_key", zero_reason="missing_key",
                                        zero_detail=json.dumps({"credential_name": "core_api_key"}))
            duration = timedelta(seconds=6 + len(batch) // 20)
            update_execution_status(conn, exec_id, "completed", end_time=iso_time(started + duration),
                                    result_count=len(batch), new_result_count=new)
            conn.execute("UPDATE routines SET last_executed_at = ? WHERE id = ?", (iso_time(started), routine_id))
            conn.commit()
        say(f"{watch['name']}: {taken} papers over {len(fires)} runs, {published(papers[0])} to "
            f"{published(papers[-1])}; {len(papers) - taken} left for today")
        time.sleep(ARXIV_PAUSE)
    conn.close()
    return ids


def free_port() -> int:
    with socket.socket() as probe:
        probe.bind(("127.0.0.1", 0))
        port = probe.getsockname()[1]
    if port == SERVICE_PORT:
        return free_port()
    return port


class Engine:
    """The engine, headless, on a port of its own, over the collection's state only."""

    def __init__(self, env: dict[str, str], python: str, log: Path):
        self.port = free_port()
        self.log = log.open("w")
        self.process = subprocess.Popen(
            [python, str(SCRIPTS / "resmon.py"), str(self.port)],
            cwd=str(SCRIPTS), env={**os.environ, **env}, stdout=self.log, stderr=subprocess.STDOUT,
        )
        token_file = Path(env["RESMON_STATE_DIR"]) / f"api-token-{self.port}"
        deadline = time.monotonic() + 120
        while time.monotonic() < deadline:
            if self.process.poll() is not None:
                raise SystemExit(f"The engine stopped while starting; see {log}")
            if token_file.exists():
                self.token = token_file.read_text().strip()
                try:
                    self.call("GET", "/api/health")
                    return
                except (urllib.error.URLError, ConnectionError):
                    pass
            time.sleep(0.5)
        self.stop()
        raise SystemExit(f"The engine did not answer within two minutes; see {log}")

    def call(self, method: str, route: str, body=None, *, raw: bytes | None = None, headers=None):
        data = raw if raw is not None else (json.dumps(body).encode() if body is not None else None)
        request = urllib.request.Request(f"http://127.0.0.1:{self.port}{route}", data=data, method=method)
        request.add_header("Authorization", f"Bearer {self.token}")
        if body is not None:
            request.add_header("Content-Type", "application/json")
        for name, value in (headers or {}).items():
            request.add_header(name, value)
        with urllib.request.urlopen(request, timeout=120) as response:
            text = response.read().decode()
            return json.loads(text) if text else None

    def wait_for_run(self, exec_id: int, timeout: float = 600) -> dict:
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            run = self.call("GET", f"/api/executions/{exec_id}")
            if run.get("status") not in ("running", "queued", "pending"):
                return run
            time.sleep(2)
        raise SystemExit(f"Run {exec_id} did not finish within {timeout:.0f} seconds")

    def stop(self) -> None:
        if self.process.poll() is None:
            self.process.send_signal(signal.SIGTERM)
            try:
                self.process.wait(timeout=30)
            except subprocess.TimeoutExpired:
                self.process.kill()
        self.log.close()


USER_AGENT = "resmon/1.0 (+https://github.com/ryanjosephkamp/resmon)"
#: arXiv's OAI-PMH service, whose `arXiv` metadata format names each paper's license.
OAI = "https://oaipmh.arxiv.org/oai"
#: The licenses under which a paper's own pages may be shown in the demos, which are
#: public: in the repository, in the app, and on YouTube. arXiv's default license
#: lets arXiv distribute a paper and nobody else, so a paper under it is passed over.
SHOWABLE_LICENSES = {
    "http://creativecommons.org/licenses/by/4.0/": "CC BY 4.0",
    "http://creativecommons.org/licenses/by-sa/4.0/": "CC BY-SA 4.0",
    "http://creativecommons.org/publicdomain/zero/1.0/": "CC0 1.0",
}
#: The pages the Library demo films: the first, scrolled into the second, where text is selected.
FILMED_PAGES = 3
EMAIL = re.compile(r"[\w.+-]+\s*@\s*[\w-]+(?:\.[\w-]+)+")


def fetch(url: str) -> bytes | None:
    request = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
    try:
        with urllib.request.urlopen(request, timeout=120) as response:
            return response.read()
    except OSError as error:  # a refusal, a dropped connection, or a read that timed out
        say(f"could not read {url}: {error}")
        return None


def unversioned(arxiv_id: str) -> str:
    """`2610.01234` from `2610.01234v2`: the paper, not one version of it."""
    return re.sub(r"v\d+$", "", arxiv_id)


def arxiv_license(arxiv_id: str) -> str | None:
    """The license URL arXiv records for a paper, from its OAI-PMH `arXiv` metadata."""
    body = fetch(f"{OAI}?verb=GetRecord&identifier=oai:arXiv.org:{unversioned(arxiv_id)}&metadataPrefix=arXiv")
    found = re.search(rb"<license>([^<]+)</license>", body or b"")
    return found.group(1).decode().strip() if found else None


def emails_on_first_pages(pdf: Path) -> bool:
    """Whether the pages the demo films show anything that reads as an email address."""
    from pypdf import PdfReader

    try:
        reader = PdfReader(str(pdf))
        text = " ".join((page.extract_text() or "") for page in reader.pages[:FILMED_PAGES])
    except Exception:  # noqa: BLE001 - a PDF the reader cannot parse is not chosen
        return True
    return bool(EMAIL.search(text))


def build_library(root: Path, db_path: str) -> None:
    """A vault inside the collection's folder, with a few of the collection's papers as PDFs.

    Only papers whose own license allows their pages to be shown publicly are
    chosen, and of those, papers whose filmed pages show no email address come
    first; the first file is the one the Library demo opens. What was chosen,
    and under which license, is written to `library.json` beside the state.

    Made through the library module, as the engine's own routes make it: those
    routes answer only the app's window, by its origin, and there is no window here.
    """
    from implementation_scripts import evidence, library
    from implementation_scripts.database import get_connection

    parent = root / "library"
    parent.mkdir()
    conn = get_connection(db_path)
    vault = library.create_vault(conn, str(parent))["vault"]["vault_id"]
    # Recent papers from each watch, newest first, taken in turn from each.
    per_watch = [
        conn.execute(
            """SELECT DISTINCT d.id, d.external_id, d.title, d.publication_date FROM documents d
               JOIN execution_documents ed ON ed.document_id = d.id
               JOIN executions e ON e.id = ed.execution_id
               JOIN routines r ON r.id = e.routine_id
               WHERE r.name = ? AND d.source_repository = 'arxiv'
               ORDER BY d.publication_date DESC LIMIT 40""", (watch["name"],)).fetchall()
        for watch in WATCHES
    ]
    candidates = [row for group in zip(*per_watch) for row in group]
    downloads = root / "downloads"
    downloads.mkdir()
    clean: list[dict] = []
    with_email: list[dict] = []
    for row in candidates:
        if len(clean) >= LIBRARY_PAPERS:
            break
        arxiv_id = row["external_id"]
        time.sleep(4)
        license_url = arxiv_license(arxiv_id)
        if license_url not in SHOWABLE_LICENSES:
            continue
        target = downloads / f"{arxiv_id}.pdf"
        time.sleep(4)
        body = fetch(f"https://arxiv.org/pdf/{arxiv_id}")
        if not body or not body.startswith(b"%PDF") or len(body) > 12_000_000:
            continue
        target.write_bytes(body)
        chosen = {
            "document_id": row["id"], "arxiv_id": arxiv_id, "title": row["title"],
            "url": f"https://arxiv.org/abs/{unversioned(arxiv_id)}",
            "license": SHOWABLE_LICENSES[license_url], "license_url": license_url,
            "file": target,
        }
        (with_email if emails_on_first_pages(target) else clean).append(chosen)
    picked = (clean + with_email)[:LIBRARY_PAPERS]
    if len(picked) < LIBRARY_PAPERS:
        raise SystemExit(f"Only {len(picked)} recent papers here may be shown publicly; widen the search.")
    for paper in picked:
        with library.Import(conn, vault, f"{paper['arxiv_id']}.pdf", paper["document_id"]) as upload:
            upload.write(paper["file"].read_bytes())
            upload.finish()
        say(f"library: {paper['license']}, {paper['url']}, {paper['title'][:60]}")
    shutil.rmtree(downloads)
    (root / "library.json").write_text(json.dumps(
        [{k: v for k, v in paper.items() if k != "file"} for paper in picked], indent=2) + "\n")
    # A project in Evidence holding them, which is where a PDF is read.
    project = evidence.create_project(conn, vault, EVIDENCE_PROJECT)
    revision = project["project"]["revision"]
    for file_id, version_id in conn.execute(
            "SELECT file_id, version_id FROM library_files WHERE vault_id = ? ORDER BY id", (vault,)).fetchall():
        revision = evidence.add_file(conn, vault, project["project"]["project_id"], revision,
                                     file_id, version_id)["project"]["revision"]
    conn.close()


def run_until_answered(engine: Engine, start, label: str) -> dict:
    """Start a run; if arXiv turned it away for asking too often, wait and ask again.

    A run refused that way is removed before the next try: it is a fault of this
    build's pace, not something the collection should remember.
    """
    for attempt in range(4):
        started = start()
        run = engine.wait_for_run(started["execution_id"])
        if run["status"] == "completed":
            return run
        engine.call("DELETE", f"/api/executions/{started['execution_id']}")
        say(f"{label}: {run['status']} (attempt {attempt + 1}); waiting before asking again")
        time.sleep(60 * (attempt + 1))
    raise SystemExit(f"{label} did not complete; the sources may be refusing requests. Try again later.")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("folder", type=Path, help="a folder that does not exist yet")
    args = parser.parse_args()
    root = args.folder.expanduser().resolve()
    if root.exists():
        raise SystemExit(f"{root} exists; give a folder that does not, so nothing is overwritten.")
    if root == FORBIDDEN or FORBIDDEN in root.parents:
        raise SystemExit("That is the installed app's own state. Choose any other folder.")
    sys.path.insert(0, str(SCRIPTS))
    env = isolate(root)
    now = datetime.now(timezone.utc)

    ids = seed_history(env["RESMON_DB_PATH"], now)

    time.sleep(ARXIV_PAUSE)
    from implementation_scripts.database import get_connection, set_setting
    engine = Engine(env, sys.executable, root / "engine.log")
    try:
        for search in SEARCHES:
            if search["kind"] == "sweep":
                body = {"repositories": search["sources"], "query": search["query"],
                        "max_results": search["max_results"]}
                start = lambda body=body: engine.call("POST", "/api/search/sweep", body)  # noqa: E731
            else:
                body = {"repository": search["sources"][0], "query": search["query"],
                        "max_results": search["max_results"]}
                start = lambda body=body: engine.call("POST", "/api/search/dive", body)  # noqa: E731
            run = run_until_answered(engine, start, f"{search['kind']} {search['query']!r}")
            say(f"{search['kind']} {search['query']!r}: {run.get('result_count')} found")
        # Today is looked at once the searches are read, so what is new on it
        # is what the watches' runs find next.
        conn = get_connection(env["RESMON_DB_PATH"])
        set_setting(conn, "today_looked_at", sqlite_time(datetime.now(timezone.utc)))
        set_setting(conn, "ui_theme", "light")
        conn.close()
        time.sleep(ARXIV_PAUSE)
        for name, routine_id in ids.items():
            run = run_until_answered(engine, lambda: engine.call("POST", f"/api/routines/{routine_id}/run"), name)
            say(f"{name}: today's run found {run.get('result_count')}, {run.get('new_result_count')} new")
            time.sleep(ARXIV_PAUSE)
        say("fitting the map")
        deadline = time.monotonic() + 300
        while time.monotonic() < deadline and engine.call("GET", "/api/map").get("state") != "ready":
            time.sleep(2)
    finally:
        engine.stop()

    build_library(root, env["RESMON_DB_PATH"])
    # A port or token file left by the stop would be copied into every recording.
    for leftover in (root / "state").glob("api-token-*"):
        leftover.unlink()
    port_file = root / "state" / "resmon.port"
    if port_file.exists():
        port_file.unlink()
    say(f"done: {root}")


if __name__ == "__main__":
    main()
