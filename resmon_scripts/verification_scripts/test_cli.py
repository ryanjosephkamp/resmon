"""The ``resmon`` command line (``resmon_scripts/cli``), against real resmon processes.

Every case that talks to resmon starts a real backend over its own temporary
state folder -- ``perf.instance``'s ``isolated_env`` and ``start_backend``, with
the null keyring, which never bind or accept port 8742 -- and runs the command
with an environment naming that folder and nothing else. One is the background
service's own entry point (``implementation_scripts.daemon``, which writes
``daemon.lock`` and owns the scheduler); the other is the engine the app starts
for its window (``resmon.py``, scheduler off, which writes only a port file).
The command has to find each the way it would on a person's machine.

The corpus is seeded through the storage functions a sweep writes through, with
outcomes chosen so each kind of sentence has something to say: a source that
answered, one that genuinely had nothing, one that did not answer, and papers
from a watch and from a person's own search.

Two guards hold for the whole module: every request the command sends goes
through ``engine._send``, which is wrapped to refuse port 8742, and the process
environment's state folder points at an empty directory, so a case that forgot
to pass its own environment finds nothing rather than someone's real resmon.
"""

from __future__ import annotations

import io
import json
import os
import re
import shutil
import subprocess
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]
SCRIPTS = ROOT / "resmon_scripts"
CLI = SCRIPTS / "cli"
for _path in (SCRIPTS, CLI):
    if str(_path) not in sys.path:
        sys.path.insert(0, str(_path))

from implementation_scripts import daemon, database, normalizer  # noqa: E402
from implementation_scripts.api_base import NormalizedResult  # noqa: E402
from perf import instance  # noqa: E402
from resmon_cli import __version__  # noqa: E402
from resmon_cli import engine as cli_engine  # noqa: E402
from resmon_cli import main as cli_main  # noqa: E402
from resmon_cli import text as cli_text  # noqa: E402

SERVICE_PORT = 8742


# ---------------------------------------------------------------------------
# Guards
# ---------------------------------------------------------------------------

@pytest.fixture(autouse=True)
def _never_the_real_resmon(monkeypatch, tmp_path):
    real_send = cli_engine._send

    def guarded(port, *args, **kwargs):
        assert port != SERVICE_PORT, "a test must never reach port 8742"
        return real_send(port, *args, **kwargs)

    monkeypatch.setattr(cli_engine, "_send", guarded)
    empty = tmp_path / "process-state"
    empty.mkdir()
    monkeypatch.setenv("RESMON_STATE_DIR", str(empty))
    for name in ("RESMON_PORT", "RESMON_PORT_FILE", "RESMON_DB_PATH"):
        monkeypatch.delenv(name, raising=False)


def cli(env: dict, *argv: str) -> tuple[int, str, str]:
    out, err = io.StringIO(), io.StringIO()
    try:
        status = cli_main.main(list(argv), env=env, stdout=out, stderr=err)
    except SystemExit as exc:  # argparse's usage errors
        status = int(exc.code or 0)
    return status, out.getvalue(), err.getvalue()


def flat(text: str) -> str:
    """Output with its line wrapping undone, for phrases a wrap may split."""
    return " ".join(text.split())


def cli_env(state: Path, **extra: str) -> dict:
    """What a person's shell would hold, pointed at one test instance."""
    return {"RESMON_STATE_DIR": str(state), "COLUMNS": "100", **extra}


# ---------------------------------------------------------------------------
# The corpus
# ---------------------------------------------------------------------------

def _iso(moment: datetime) -> str:
    return moment.strftime("%Y-%m-%dT%H:%M:%SZ")


def _seed(path: Path) -> dict:
    """Four papers, a watch, and three runs. Returns the ids the cases name."""
    database.init_db(path)
    conn = database.get_connection(path)
    try:
        now = datetime.now(timezone.utc)
        normalizer.deduplicate_batch(conn, [
            NormalizedResult("arxiv", "cli-old-1", None, "An older paper about agents",
                             ["Ada Lovelace"], "Old abstract. It says little.", "2026-09-01",
                             "https://arxiv.org/abs/cli-old-1"),
            NormalizedResult("arxiv", "cli-new-1", "10.5555/cli.1", "Agents that read the literature",
                             ["Grace Hopper", "Alan Turing"],
                             "We study agents that read papers. They keep up. A third sentence.",
                             "2026-10-20", "https://arxiv.org/abs/cli-new-1"),
            NormalizedResult("arxiv", "cli-new-2", None, "A second paper on agents",
                             ["A One", "B Two", "C Three", "D Four", "E Five"], None, "2026-10",
                             "https://arxiv.org/abs/cli-new-2"),
            NormalizedResult("crossref", "cli-new-3", "10.5555/cli.3", "Protein folding at scale",
                             ["Rosalind Franklin"], "Folding, measured.", "2026-10-25",
                             "https://doi.org/10.5555/cli.3"),
        ])
        ids = {row["external_id"]: int(row["id"])
               for row in conn.execute("SELECT id, external_id FROM documents")}
        conn.execute("UPDATE documents SET first_seen_at = ? WHERE id = ?",
                     ((now - timedelta(days=20)).strftime("%Y-%m-%d %H:%M:%S"), ids["cli-old-1"]))

        routine = database.insert_routine(conn, {
            "name": "daily_agents", "schedule_cron": "0 3 1 1 *",
            "parameters": json.dumps({"query": "agents", "keywords": ["agents"],
                                      "repositories": ["arxiv", "dblp", "openalex"],
                                      "max_results": 100}),
            "is_active": 1,
        })

        def run(kind: str, params: dict, started: datetime, outcomes: list[tuple], docs: list[str],
                new: list[str], routine_id=None, status="completed") -> int:
            exec_id = database.insert_execution(conn, {
                "execution_type": kind, "routine_id": routine_id,
                "parameters": json.dumps(params), "start_time": _iso(started)})
            for source, state, n, reason in outcomes:
                database.record_execution_source(conn, exec_id, source, state,
                                                 result_count=n, zero_reason=reason)
            conn.executemany("INSERT INTO execution_documents (execution_id, document_id, is_new) "
                             "VALUES (?, ?, ?)", [(exec_id, ids[d], int(d in new)) for d in docs])
            database.update_execution_status(conn, exec_id, status,
                                             end_time=_iso(started + timedelta(seconds=75)),
                                             result_count=len(docs), new_result_count=len(new))
            return exec_id

        dive = run("deep_dive", {"query": "agents", "keywords": ["agents"], "repository": "arxiv",
                                 "max_results": 50},
                   now - timedelta(days=20), [("arxiv", "ok", 1, None)], ["cli-old-1"], ["cli-old-1"])
        watch_run = run("automated_sweep",
                        {"query": "agents", "keywords": ["agents"],
                         "repositories": ["arxiv", "dblp", "openalex"], "max_results": 100},
                        now - timedelta(hours=3),
                        [("arxiv", "ok", 2, None), ("dblp", "ok", 0, "upstream_failure"),
                         ("openalex", "ok", 0, "answered_empty")],
                        ["cli-new-1", "cli-new-2"], ["cli-new-1", "cli-new-2"], routine_id=routine)
        sweep = run("deep_sweep", {"query": "protein folding", "keywords": ["protein folding"],
                                   "repositories": ["crossref", "arxiv"], "max_results": 100},
                    now - timedelta(hours=1),
                    [("crossref", "ok", 1, None), ("arxiv", "ok", 0, "answered_empty")],
                    ["cli-new-3"], ["cli-new-3"])
        conn.commit()
    finally:
        conn.close()
    return {"papers": ids, "routine": routine, "dive": dive, "watch_run": watch_run, "sweep": sweep}


@pytest.fixture(scope="module")
def service(tmp_path_factory):
    """The background service's entry point over a seeded corpus, its scheduler on."""
    state = tmp_path_factory.mktemp("cli-service")
    seeded = _seed(state / "resmon.db")
    backend = instance.start_backend(state, daemon=True, scheduler=True)
    try:
        assert (state / "daemon.lock").exists()
        yield backend, seeded
    finally:
        backend.stop()


@pytest.fixture(scope="module")
def app_engine(tmp_path_factory):
    """The engine the app starts for its window: no lock, a port file, no scheduler."""
    state = tmp_path_factory.mktemp("cli-app")
    seeded = _seed(state / "resmon.db")
    backend = instance.start_backend(state)
    try:
        assert not (state / "daemon.lock").exists()
        assert (state / "resmon.port").read_text().strip() == str(backend.port)
        yield backend, seeded
    finally:
        backend.stop()


# ---------------------------------------------------------------------------
# Finding resmon, without one running
# ---------------------------------------------------------------------------

@pytest.mark.parametrize("platform", ["darwin", "linux", "win32"])
@pytest.mark.parametrize("override", [None, "/elsewhere/state"])
def test_the_state_folder_is_the_daemon_s_on_every_platform(monkeypatch, tmp_path, platform, override):
    env = {"HOME": str(tmp_path), "XDG_STATE_HOME": str(tmp_path / "xdg"),
           "LOCALAPPDATA": str(tmp_path / "local")}
    if override:
        env["RESMON_STATE_DIR"] = override
    else:
        monkeypatch.delenv("RESMON_STATE_DIR", raising=False)
    for name, value in env.items():
        monkeypatch.setenv(name, value)
    monkeypatch.setattr(sys, "platform", platform)
    assert cli_engine.state_dir(env, platform=platform, home=tmp_path) == daemon.state_dir()


def test_nothing_running_is_said_plainly_and_nothing_is_written(tmp_path):
    state = tmp_path / "state"
    state.mkdir()
    status, out, err = cli(cli_env(state), "today")
    assert status == cli_engine.NOT_RUNNING
    assert out == ""
    assert "No resmon is running for the state folder" in err
    assert "daemon.lock (the background service): not there" in err
    assert "resmon.port (the app's own engine): not there" in err
    assert "This command does not start resmon itself." in err
    # The command looked and touched nothing: no database, no lock, no token.
    assert list(state.iterdir()) == []

    status, out, err = cli(cli_env(state), "service", "status", "--json")
    assert status == cli_engine.NOT_RUNNING
    body = json.loads(out)
    assert body["running"] is False
    assert [x["what"] for x in body["looked"]] == ["daemon.lock", "port file"]

    status, _, err = cli(cli_env(state), "runs", "--json")
    assert status == cli_engine.NOT_RUNNING
    assert json.loads(err)["error"] == "not_running"


def test_a_lock_whose_port_has_no_token_is_not_probed(tmp_path, service):
    """Something answers on that port, and it is not attached to without the token."""
    backend, _ = service
    state = tmp_path / "state"
    state.mkdir()
    (state / "daemon.lock").write_text(json.dumps({"pid": 1, "port": backend.port, "version": "x"}))
    status, _, err = cli(cli_env(state), "today")
    assert status == cli_engine.NOT_RUNNING
    assert f"names port {backend.port}, but the state folder holds no token for it" in err


def test_a_token_left_by_an_earlier_run_is_named_as_that(tmp_path, service):
    backend, _ = service
    state = tmp_path / "state"
    state.mkdir()
    (state / "daemon.lock").write_text(json.dumps({"pid": 1, "port": backend.port, "version": "x"}))
    (state / f"api-token-{backend.port}").write_text("A" * 43)
    status, _, err = cli(cli_env(state), "today")
    assert status == cli_engine.NOT_RUNNING
    assert "refused the token" in err and "an earlier run left behind" in err


def test_a_named_port_is_never_widened(service):
    """RESMON_PORT names a port with nothing on it; the live service in the same
    state folder is not tried instead."""
    backend, _ = service
    empty = instance.free_port()
    status, _, err = cli(cli_env(backend.state, RESMON_PORT=str(empty)), "today")
    assert status == cli_engine.NOT_RUNNING
    assert f"RESMON_PORT: names port {empty}, but the state folder holds no token for it" in err
    assert "RESMON_PORT names one port, so no other place was tried." in err

    # With a token on file for it, the named port is probed -- and still only it.
    token = backend.state / f"api-token-{empty}"
    token.write_text("B" * 43)
    try:
        status, _, err = cli(cli_env(backend.state, RESMON_PORT=str(empty)), "today")
    finally:
        token.unlink()
    assert status == cli_engine.NOT_RUNNING
    assert f"nothing answered on port {empty}" in err

    status, _, err = cli(cli_env(backend.state, RESMON_PORT="eighty"), "today")
    assert status == 2 and "not a port" in err


# ---------------------------------------------------------------------------
# The background service
# ---------------------------------------------------------------------------

def test_service_status_reaches_the_service_by_its_lock(service):
    backend, _ = service
    status, out, _ = cli(cli_env(backend.state), "service", "status", "--json")
    assert status == 0
    body = json.loads(out)
    reached = body["reached"]
    assert reached["how"] == "service" and reached["is_service"] is True
    assert reached["port"] == backend.port
    assert reached["pid"] == backend.proc.pid == reached["lock_pid"]
    assert body["scheduler"]["state"] == "fires_here"
    assert body["health"] == backend.get("/api/health") | {"embeddings": body["health"]["embeddings"]}

    status, out, _ = cli(cli_env(backend.state), "service", "status")
    assert status == 0
    assert "resmon is running: the background service." in out
    assert "This resmon runs the schedule." in out
    assert f"port {backend.port}" in out


def test_today_json_is_the_engine_s_own_answer(service):
    backend, _ = service
    status, out, _ = cli(cli_env(backend.state), "today", "--json")
    assert status == 0
    mine, engine = json.loads(out), backend.get("/api/today")
    # With no look recorded, ``since`` is seven days before the request's own
    # ``now``, so two requests a second apart differ in both. Compared apart.
    assert mine["window"] == engine["window"] == "first_look"
    for body in (mine, engine):
        now, since = (datetime.fromisoformat(body.pop(k).replace("Z", "+00:00")) for k in ("now", "since"))
        assert now - since == timedelta(days=7)
    assert mine == engine


def test_today_in_words(service):
    backend, seeded = service
    status, raw, _ = cli(cli_env(backend.state), "today")
    assert status == 0, raw
    out = flat(raw)
    assert "nothing has been marked read yet" in out
    assert "3 papers first collected since then." in out
    for title in ("Agents that read the literature", "A second paper on agents", "Protein folding at scale"):
        assert title in out
    assert "An older paper about agents" not in out  # collected before the window
    # Today's text under a paper is the abstract's opening, labeled as such,
    # and a paper with none says so rather than leaving a gap.
    assert "Abstract (its opening, as the source gave it): We study agents that read papers." in out
    assert "Abstract not recorded." in out
    assert "A One, B Two, C Three, and 2 others" in out
    assert "https://doi.org/10.5555/cli.1" in out
    # The watch, with the source that did not answer named on it.
    assert "daily_agents · 2 new" in out
    assert f"last run #{seeded['watch_run']}, completed" in out
    assert "2 of 3 sources answered" in out
    assert "DBLP: did not answer." in out
    assert "1 of them came from your own searches" in out
    assert "resmon today mark-read marks them all read." in out


def test_runs_say_what_each_found_and_who_answered(service):
    backend, seeded = service
    status, out, _ = cli(cli_env(backend.state), "runs")
    assert status == 0
    assert f'#{seeded["watch_run"]} · Watch "daily_agents" · completed' in out
    assert "2 results, 2 new · 2 of 3 selected sources answered; 1 could not answer: DBLP" in flat(out)
    assert "1 result, 1 new" in flat(out)
    assert f'#{seeded["dive"]} · Deep Dive "agents" on arXiv' in out
    assert f'#{seeded["sweep"]} · Deep Sweep "protein folding"' in out

    status, out, _ = cli(cli_env(backend.state), "runs", "--json")
    assert json.loads(out) == backend.get("/api/executions", params={"limit": 20})

    status, out, _ = cli(cli_env(backend.state), "runs", "--kind", "dive", "--json")
    assert [r["id"] for r in json.loads(out)] == [seeded["dive"]]


def test_one_run_s_whole_account(service):
    backend, seeded = service
    status, raw, _ = cli(cli_env(backend.state), "runs", str(seeded["watch_run"]))
    assert status == 0
    out = flat(raw)
    account = backend.get(f"/api/executions/{seeded['watch_run']}")["coverage"]
    assert f"Sources: {account['summary']}" in out
    assert "arXiv: answered · 2 records." in out
    # A non-answer's stored zero is not printed as a count of records.
    assert "DBLP: did not answer. " in out and "did not answer · 0" not in out
    assert "OpenAlex: answered, zero. " in out
    assert "About this account" in out
    assert '"agents" · up to 100 per source' in out

    status, _, err = cli(cli_env(backend.state), "runs", "999")
    assert status == 1 and "Execution not found" in err


def test_the_source_wall(service):
    backend, _ = service
    status, out, _ = cli(cli_env(backend.state), "wall")
    assert status == 0
    data = backend.get("/api/coverage/source-wall", params={"limit": 12})
    assert data["verdict"]["headline"].split(" ")[0] in out
    rows = {line.split()[0]: line for line in out.splitlines() if line[:1].isalpha()}
    assert "✕" in rows["DBLP"] and "1 failed" in rows["DBLP"]
    assert "○" in rows["OpenAlex"]
    # A run DBLP was not in reads as not asked, never as a failure.
    assert "2 not asked on this run" in rows["DBLP"]
    assert "● answered" in out and "– not asked on this run" in out
    assert "1 answered · 1 answered, zero" not in out  # arXiv's row: two answered, one zero
    assert "2 answered · 1 answered, zero" in rows["arXiv"]

    status, out, _ = cli(cli_env(backend.state), "wall", "--json")
    assert json.loads(out) == data


def test_search_as_the_explorer_does(service):
    backend, _ = service
    status, out, _ = cli(cli_env(backend.state), "search", "agents")
    assert status == 0
    assert "3 papers match." in out
    assert "Agents that read the literature" in out and "Protein folding" not in out

    status, out, _ = cli(cli_env(backend.state), "search", "--source", "CROSSREF", "--json")
    body = json.loads(out)
    assert [r["source_repository"] for r in body["results"]] == ["crossref"]
    assert body == backend.post("/api/explorer/search", {"sources": ["crossref"], "limit": 20,
                                                          "sort": "newest"})

    status, _, err = cli(cli_env(backend.state), "search", "--source", "nowhere")
    assert status == 2 and "No source called 'nowhere'" in err


def test_closest_without_an_embedding_model_says_so(service):
    backend, _ = service
    status, out, _ = cli(cli_env(backend.state), "search", "agents", "--sort", "closest")
    assert status == 0
    assert "No embedding model is configured" in out
    assert "Ranked by closeness" not in out


def test_export_a_run_to_a_file(service, tmp_path):
    backend, seeded = service
    target = tmp_path / "refs.bib"
    status, out, _ = cli(cli_env(backend.state), "export", "--run", str(seeded["watch_run"]), "-o", str(target))
    assert status == 0
    assert "Wrote 2 references (BibTeX)" in out
    assert target.read_text().count("@") == 2

    status, out, err = cli(cli_env(backend.state), "export", "--run", str(seeded["watch_run"]),
                           "--format", "csv")
    assert status == 0 and "Agents that read the literature" in out and "2 references (CSV)." in err


def test_export_today_as_a_json_envelope(service):
    backend, _ = service
    status, out, _ = cli(cli_env(backend.state), "export", "--today", "--format", "ris", "--json")
    assert status == 0
    body = json.loads(out)
    assert body["document_count"] == backend.get("/api/today")["total"] == 3
    assert body["content"].startswith("TY  -")


def test_export_refuses_a_filter_it_would_ignore(service):
    backend, seeded = service
    status, _, err = cli(cli_env(backend.state), "export", "--run", str(seeded["watch_run"]),
                         "--source", "arxiv")
    assert status == 2 and "go with --search" in err


def test_watch_add_is_scheduled_by_the_service(service):
    backend, _ = service
    before = len(backend.get("/api/routines"))
    status, out, _ = cli(cli_env(backend.state), "watch", "add", "cli watch",
                         "--keyword", "graph neural networks", "--source", "arxiv",
                         "--source", "DBLP", "--schedule", "0 3 1 1 *", "--json")
    assert status == 0, out
    body = json.loads(out)
    routine = body["routine"]
    assert routine["name"] == "cli watch" and routine["is_active"] is True
    params = json.loads(routine["parameters"])
    assert params["repositories"] == ["arxiv", "dblp"]
    assert params["keywords"] == ["graph neural networks"]
    # The window the app's editor offers first.
    assert params["date_window"] == {"since": "previous_run"}
    assert body["firing"] == {"id": routine["id"], "will_fire": True, "reason": "scheduled"}
    assert len(backend.get("/api/routines")) == before + 1

    status, out, _ = cli(cli_env(backend.state), "watch", "list")
    assert f"#{routine['id']} cli watch · active · will run: this resmon holds its schedule" in out
    assert "papers since the previous run" in out

    status, out, _ = cli(cli_env(backend.state), "watch", "add", "cli month", "--keyword", "graphs",
                         "--source", "arxiv", "--last-days", "30", "--inactive", "--json")
    assert status == 0, out
    assert json.loads(json.loads(out)["routine"]["parameters"])["date_window"] == {"last_days": 30}
    status, out, _ = cli(cli_env(backend.state), "watch", "add", "cli undated", "--keyword", "graphs",
                         "--source", "arxiv", "--no-date-limit", "--inactive", "--json")
    assert status == 0, out
    assert "date_window" not in json.loads(json.loads(out)["routine"]["parameters"])


def test_watch_add_refuses_before_it_saves(service):
    backend, _ = service
    before = len(backend.get("/api/routines"))
    status, _, err = cli(cli_env(backend.state), "watch", "add", "bad", "--keyword", "x",
                         "--source", "nowhere")
    assert status == 2 and "No source called 'nowhere'" in err
    status, _, err = cli(cli_env(backend.state), "watch", "add", "bad", "--keyword", "x",
                         "--source", "arxiv", "--schedule", "every morning")
    assert status == 2 and "five-field cron" in err
    assert len(backend.get("/api/routines")) == before


# ---------------------------------------------------------------------------
# The app's own engine
# ---------------------------------------------------------------------------

def test_the_app_s_engine_is_found_by_its_port_file(app_engine):
    backend, _ = app_engine
    status, out, _ = cli(cli_env(backend.state), "service", "status", "--json")
    assert status == 0
    reached = json.loads(out)["reached"]
    assert reached["how"] == "app" and reached["is_service"] is False
    assert reached["port"] == backend.port

    status, out, _ = cli(cli_env(backend.state), "service", "status")
    assert "resmon is running: the engine the resmon app started for its window." in out
    assert "This resmon does not run the schedule" in out
    # Which of the two "no scheduler" states depends on whether this machine
    # has a service unit installed, so the case asserts the verdict, not the state.
    assert "Nothing will run this watch." in out


def test_an_active_watch_nothing_runs_says_so(app_engine):
    backend, _ = app_engine
    status, out, _ = cli(cli_env(backend.state), "watch", "add", "unscheduled",
                         "--keyword", "agents", "--source", "arxiv")
    assert status == 0, out
    out = flat(out)
    assert 'Added watch #' in out and '"unscheduled", active.' in out
    assert "Nothing will run this watch." in out
    assert "will run" not in out.replace("Nothing will run", "")


def test_mark_read_starts_the_next_today_there(app_engine):
    backend, _ = app_engine
    status, out, _ = cli(cli_env(backend.state), "today", "mark-read", "--json")
    assert status == 0
    looked = json.loads(out)["looked_at"]
    status, out, _ = cli(cli_env(backend.state), "today", "--json")
    body = json.loads(out)
    assert body["window"] == "since_last_look" and body["since"] == looked
    assert body["total"] == 0 and body["papers"] == []
    status, out, _ = cli(cli_env(backend.state), "today")
    assert "Today: 0 papers first collected since you last marked all read" in out


def test_the_service_is_asked_before_the_app_s_engine(tmp_path, service, app_engine):
    """Both named in one state folder: the service, which owns the schedule, is
    the one asked. With its lock gone, the app's engine is."""
    svc, _ = service
    app, _ = app_engine
    state = tmp_path / "state"
    state.mkdir()
    shutil.copy(svc.state / "daemon.lock", state / "daemon.lock")
    for backend in (svc, app):
        shutil.copy(backend.state / f"api-token-{backend.port}", state)
    (state / "resmon.port").write_text(str(app.port))

    status, out, _ = cli(cli_env(state), "service", "status", "--json")
    assert status == 0
    assert json.loads(out)["reached"]["port"] == svc.port

    (state / "daemon.lock").unlink()
    status, out, _ = cli(cli_env(state), "service", "status", "--json")
    reached = json.loads(out)["reached"]
    assert (reached["how"], reached["port"]) == ("app", app.port)


# ---------------------------------------------------------------------------
# The package, as installed
# ---------------------------------------------------------------------------

def _subprocess_env(state: Path) -> dict:
    env = {k: v for k, v in os.environ.items() if not k.startswith("RESMON_")}
    env.update({"RESMON_STATE_DIR": str(state), "PYTHONPATH": str(CLI)})
    return env


def test_python_m_resmon_cli_runs_in_a_process_of_its_own(service):
    backend, _ = service
    run = subprocess.run([sys.executable, "-m", "resmon_cli", "today", "--json"], cwd=ROOT,
                         env=_subprocess_env(backend.state), capture_output=True, text=True, timeout=60)
    assert run.returncode == 0, run.stderr
    assert json.loads(run.stdout)["window"] == "first_look"
    version = subprocess.run([sys.executable, "-m", "resmon_cli", "--version"], cwd=ROOT,
                             env=_subprocess_env(backend.state), capture_output=True, text=True, timeout=60)
    assert version.stdout.strip() == f"resmon command line {__version__}"


def test_the_package_declares_the_resmon_command_and_no_dependencies():
    pyproject = (CLI / "pyproject.toml").read_text()
    assert re.search(r'^resmon = "resmon_cli\.main:run"$', pyproject, re.M)
    assert re.search(r"^dependencies = \[\]$", pyproject, re.M)
    assert 'requires-python = ">=3.10"' in pyproject
    assert callable(cli_main.run)


def test_the_command_line_never_opens_the_database_or_imports_the_engine():
    """It reaches resmon over HTTP only. A module that imported the engine or
    sqlite3 would be one step from answering without a running resmon -- from a
    database it picked itself."""
    for path in (CLI / "resmon_cli").glob("*.py"):
        source = path.read_text()
        for forbidden in ("sqlite3", "implementation_scripts", "import resmon\n", "from resmon import"):
            assert forbidden not in source, f"{path.name} mentions {forbidden!r}"


# ---------------------------------------------------------------------------
# Words
# ---------------------------------------------------------------------------

def test_a_time_without_a_zone_is_not_converted():
    assert cli_text.when("2026-10-28 06:05:00").endswith("(time zone not recorded)")
    assert "time zone" not in cli_text.when("2026-10-28 06:05:00", assume_utc=True)
    assert cli_text.when(None) == "not recorded"
    # Converted to this machine's clock, so the day depends on its zone.
    assert re.match(r"October 2[78], 2026, \d{1,2}:\d{2} [AP]M", cli_text.when("2026-10-28T06:05:00Z", long=True))


def test_publication_dates_keep_the_precision_the_source_gave():
    assert cli_text.publication_date("2026-10-05") == "October 5, 2026"
    assert cli_text.publication_date("2026-10") == "October 2026"
    assert cli_text.publication_date("2026") == "2026"
    assert cli_text.publication_date(None) == "not recorded"


def test_a_route_this_resmon_lacks_is_named_as_missing(monkeypatch):
    def fake_send(port, token, method, path, **kwargs):
        if path.startswith("/api/today"):
            return cli_engine.Reply(404, {}, b'{"detail": "Not Found"}')
        return cli_engine.Reply(404, {}, b'{"detail": "Execution not found"}')

    monkeypatch.setattr(cli_engine, "_send", fake_send)
    engine = cli_engine.Engine(port=1, token="t" * 43, how="service", state=Path("."),
                               health={"version": "2.2.0", "pid": 5}, lock_pid=6)
    with pytest.raises(cli_engine.CliError) as missing:
        engine.get("/api/today")
    assert missing.value.code == "missing_route"
    assert "This resmon (2.2.0) has no GET /api/today" in missing.value.message
    with pytest.raises(cli_engine.CliError) as absent:
        engine.get("/api/executions/9")
    assert absent.value.code == "not_found"
    # A lock whose pid is not the process answering is not called the service.
    assert engine.is_service is False and "is not the one the lock records" in engine.describe()
