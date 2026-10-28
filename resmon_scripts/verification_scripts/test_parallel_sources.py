# resmon_scripts/verification_scripts/test_parallel_sources.py
"""A sweep asks its sources together, and says what it said asking one at a time.

Sources used to be asked one after another, so a ten-source sweep took the sum
of ten sources' times. ``SweepEngine._query_sources`` now asks up to
``_SOURCE_CONCURRENCY`` at once. The speed is the harness's to measure
(``perf/``, against recorded replies); what these cases hold is everything the
change must *not* move:

  * the bound: never more than ``_SOURCE_CONCURRENCY`` searches in flight, and
    fewer sources than that are all asked at once;
  * the claims: a run whose sources answer in a different order from the one
    they were selected in records the same per-source outcomes, zero reasons,
    errors, missing keys, task-log lines, stored papers and dedup figures as
    the same run asked one at a time -- only the order of the events differs;
  * cancellation: a source that had already answered is recorded as answered,
    each search still in flight as cancelled, and a source never started gets
    no row at all;
  * the heartbeat: a slow source still says so in the live log while others
    finish around it;
  * the rate limiters: every request to a source, from two sweeps running at
    once, waits on that source's one module-level ``RateLimiter``, and the
    limiter's spacing holds across both.

Where a sweep runs on the test's own thread, its database is a plain
``sqlite3.connect(":memory:")`` connection, which raises if it is touched from
any other thread. So those cases also hold the rule that only
``client.search`` leaves the sweep's thread: a row written from a search
thread fails them.

What this does not establish: anything about a real upstream. The clients in
the first four cases are stand-ins with scripted answers; the limiter case
drives three real clients over a transport that answers locally.
"""

from __future__ import annotations

import re
import sqlite3
import sys
import threading
import time
from pathlib import Path

import httpx
import pytest

PROJECT_ROOT = Path(__file__).resolve().parent.parent.parent
sys.path.insert(0, str(PROJECT_ROOT / "resmon_scripts"))

from implementation_scripts import (  # noqa: E402
    api_base,
    api_crossref,
    api_doaj,
    api_openalex,
    config,
    sweep_engine as se,
)
from implementation_scripts.api_base import NormalizedResult  # noqa: E402
from implementation_scripts.api_registry import RETIRED_REPOSITORIES  # noqa: E402
from implementation_scripts.database import (  # noqa: E402
    get_execution_by_id,
    get_execution_sources,
    init_db,
)
from implementation_scripts.progress import progress_store  # noqa: E402
from implementation_scripts.sweep_engine import SweepEngine  # noqa: E402

# The benchmark's ten keyless sources: real slugs, so the catalog, the
# credential gate and the display names behave as they do for a user.
TEN = ["arxiv", "crossref", "dblp", "doaj", "europepmc",
       "hal", "inspire_hep", "openalex", "pubmed", "zenodo"]


def _paper(slug: str, n: int, title: str | None = None) -> NormalizedResult:
    return NormalizedResult(
        source_repository=slug, external_id=f"{slug}-{n}", doi=None,
        title=title or f"A paper from {slug}, number {n}",
        authors=["Ada Lovelace"], abstract="An abstract.",
        publication_date="2025-03-01", url=f"https://example.org/{slug}/{n}",
    )


class _Stand:
    """A stand-in client whose search runs a script for its slug."""

    def __init__(self, slug: str, script):
        self.slug = slug
        self.script = script

    def search(self, query, date_from=None, date_to=None, max_results=100):
        return self.script(self.slug)


@pytest.fixture(autouse=True)
def reports_elsewhere(monkeypatch, tmp_path):
    """Each run's log and report go to this test's own folder, not the checkout."""
    monkeypatch.setattr(se, "REPORTS_DIR", tmp_path / "reports")


@pytest.fixture
def conn():
    connection = sqlite3.connect(":memory:")
    init_db(conn=connection)
    yield connection
    connection.close()


def _stand_ins(monkeypatch, script):
    """Route every source to a stand-in, except a retired one, as the registry does."""
    real = se.get_client

    def get_client(name: str, **kwargs):
        if name in RETIRED_REPOSITORIES:
            return real(name, **kwargs)
        return _Stand(name, script)

    monkeypatch.setattr(se, "get_client", get_client)


def _start(conn, sources, **params):
    """Prepare a sweep here and return it with a thread that will run it."""
    engine = SweepEngine(db_conn=conn, config={})
    out: dict = {"exec_id": engine.prepare_execution(
        "deep_sweep", list(sources), {"query": "graphs", "max_results": 10, **params})}
    progress_store.register(out["exec_id"])

    def run() -> None:
        try:
            out["result"] = engine.run_prepared(out["exec_id"])
        except BaseException as exc:  # surfaced by the test
            out["error"] = exc

    return out, threading.Thread(target=run)


def _run(conn, sources, **params) -> dict:
    """A whole sweep on this thread, as ``execute_sweep`` runs one."""
    engine = SweepEngine(db_conn=conn, config={})
    exec_id = engine.prepare_execution(
        "deep_sweep", list(sources), {"query": "graphs", "max_results": 10, **params})
    progress_store.register(exec_id)
    result = engine.run_prepared(exec_id)
    return {"exec_id": exec_id, "result": result,
            "events": progress_store.get_events(exec_id)}


# ---------------------------------------------------------------------------
# The bound
# ---------------------------------------------------------------------------


class _Gate:
    """Holds every search until released, and counts how many are in at once."""

    def __init__(self):
        self.lock = threading.Lock()
        self.inside = 0
        self.most = 0
        self.entered: list[str] = []
        self.release = threading.Event()

    def __call__(self, slug: str) -> list:
        with self.lock:
            self.inside += 1
            self.most = max(self.most, self.inside)
            self.entered.append(slug)
        try:
            assert self.release.wait(10), "the test never released the gate"
            return [_paper(slug, 1)]
        finally:
            with self.lock:
                self.inside -= 1

    def wait_for(self, count: int, timeout: float = 5.0) -> None:
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            with self.lock:
                if len(self.entered) >= count:
                    return
            time.sleep(0.01)
        raise AssertionError(f"only {len(self.entered)} searches started, expected {count}")


def test_ten_sources_are_asked_eight_at_a_time(monkeypatch):
    assert se._SOURCE_CONCURRENCY == 8
    gate = _Gate()
    _stand_ins(monkeypatch, gate)
    connection = sqlite3.connect(":memory:", check_same_thread=False)
    init_db(conn=connection)
    out, thread = _start(connection, TEN)
    thread.start()
    try:
        gate.wait_for(8)
        time.sleep(0.3)          # room for a ninth, if the bound did not hold
        assert gate.entered == TEN[:8], "the first eight selected start first"
        assert gate.most == 8
    finally:
        gate.release.set()
        thread.join(15)
    assert "error" not in out, out.get("error")
    assert sorted(gate.entered) == sorted(TEN) and gate.most == 8
    rows = get_execution_sources(connection, out["exec_id"])
    assert sorted((r["source"], r["status"], r["result_count"]) for r in rows) == [
        (slug, "ok", 1) for slug in sorted(TEN)]
    connection.close()


def test_fewer_sources_than_the_bound_are_all_asked_at_once(monkeypatch):
    gate = _Gate()
    _stand_ins(monkeypatch, gate)
    connection = sqlite3.connect(":memory:", check_same_thread=False)
    init_db(conn=connection)
    out, thread = _start(connection, TEN[:3])
    thread.start()
    try:
        gate.wait_for(3)
        assert gate.most == 3
    finally:
        gate.release.set()
        thread.join(15)
    assert "error" not in out, out.get("error")
    connection.close()


# ---------------------------------------------------------------------------
# The claims
# ---------------------------------------------------------------------------

# Slowest first, so the order they answer in is the reverse of the order they
# were selected in. ``doaj`` returns arXiv's first paper under its own id: the
# cross-source duplicate whose "which copy was first" depends on order.
_DELAYS = {"arxiv": 0.40, "crossref": 0.32, "dblp": 0.24, "doaj": 0.16,
           "europepmc": 0.08, "core": 0.04}
_MIXED = ["arxiv", "crossref", "dblp", "doaj", "europepmc", "core", "ieee"]


def _mixed_script(slug: str) -> list:
    time.sleep(_DELAYS.get(slug, 0.0))
    if slug == "arxiv":
        return [_paper("arxiv", 1, "Shared title"), _paper("arxiv", 2)]
    if slug == "crossref":
        return []                       # an empty answer resmon cannot explain
    if slug == "dblp":
        raise RuntimeError("the upstream closed the connection")
    if slug == "doaj":
        return [_paper("doaj", 9, "Shared title")]
    if slug == "europepmc":
        return [_paper("europepmc", n) for n in range(3)]
    return []                           # core: no key on this machine


_VOLATILE = ("timestamp", "elapsed", "execution_id")


def _claims(events: list[dict]) -> list:
    """Each per-source event with the fields that vary between any two runs removed."""
    kept = []
    for event in events:
        if event.get("type") in ("repo_start", "repo_done", "repo_error",
                                  "repo_skipped_missing_key", "dedup_stats") or (
                event.get("type") == "query_progress"
                and event.get("phase") in ("search_start", "search_done")):
            kept.append(repr(sorted((k, v) for k, v in event.items() if k not in _VOLATILE)))
    return sorted(kept)


def _log_lines(path: str) -> list[str]:
    text = Path(path).read_text(encoding="utf-8")
    # A file name carries the second the run started in.
    return sorted(re.sub(r"\d{8}T\d{6}", "<start>",
                         re.sub(r"^\[\d\d:\d\d:\d\d\] ", "", line))
                  for line in text.splitlines()
                  if re.match(r"^\[\d\d:\d\d:\d\d\] ", line)
                  and "Execution ID" not in line and "Elapsed" not in line)


def _record(conn, exec_id: int) -> dict:
    row = dict(get_execution_by_id(conn, exec_id))
    sources = sorted(
        (r["source"], r["status"], r["result_count"], r["error_message"],
         r["zero_reason"], r["zero_detail"], r["credential_name"])
        for r in get_execution_sources(conn, exec_id))
    documents = [tuple(r) for r in conn.execute(
        "SELECT source_repository, external_id, title FROM documents ORDER BY id")]
    linked = [tuple(r) for r in conn.execute(
        "SELECT d.source_repository, d.external_id, ed.is_new FROM execution_documents ed "
        "JOIN documents d ON d.id = ed.document_id WHERE ed.execution_id = ? ORDER BY ed.rowid",
        (exec_id,))]
    return {
        "status": row["status"], "result_count": row["result_count"],
        "new_result_count": row["new_result_count"], "error_message": row["error_message"],
        "dedup": [row[k] for k in ("dedup_total", "dedup_new", "dedup_duplicates",
                                   "dedup_invalid", "dedup_cross_source")],
        "sources": sources, "documents": documents, "linked": linked,
    }


def test_a_run_answered_out_of_order_claims_what_a_one_at_a_time_run_claims(monkeypatch):
    _stand_ins(monkeypatch, _mixed_script)

    monkeypatch.setattr(se, "_SOURCE_CONCURRENCY", 1)
    serial_db = sqlite3.connect(":memory:")
    init_db(conn=serial_db)
    serial = _run(serial_db, _MIXED)

    monkeypatch.setattr(se, "_SOURCE_CONCURRENCY", 8)
    parallel_db = sqlite3.connect(":memory:")
    init_db(conn=parallel_db)
    parallel = _run(parallel_db, _MIXED)

    def finished_order(events):
        return [e["repository"] for e in events if e.get("type") in ("repo_done", "repo_error")]

    # The case is only worth something if the two runs really differ in order.
    # At a bound of one, each source starts only after the last one's
    # ``repo_done`` or ``repo_error``: the one-after-another sequence.
    assert finished_order(serial["events"]) == [s for s in _MIXED]
    starts_and_ends = [(e["type"], e["repository"]) for e in serial["events"]
                       if e.get("type") in ("repo_start", "repo_done", "repo_error")]
    assert starts_and_ends == [pair for slug in _MIXED for pair in (
        ("repo_start", slug), ("repo_error" if slug in ("dblp", "ieee") else "repo_done", slug))]
    assert finished_order(parallel["events"]) != finished_order(serial["events"])
    assert finished_order(parallel["events"])[:3] == ["ieee", "core", "europepmc"]

    assert _claims(parallel["events"]) == _claims(serial["events"])
    assert _record(parallel_db, parallel["exec_id"]) == _record(serial_db, serial["exec_id"])
    assert (_log_lines(parallel["result"]["log_path"])
            == _log_lines(serial["result"]["log_path"]))
    # The report's footer lists the zero notes in the order sources were
    # selected, so the two reports agree line for line apart from the run's
    # own id and times.
    def report(result):
        text = Path(result["result"]["report_path"]).read_text(encoding="utf-8")
        text = text.replace(str(result["exec_id"]), "<id>")
        return [line for line in text.splitlines() if not re.search(r"\d\d:\d\d", line)]
    assert report(parallel) == report(serial)

    record = _record(parallel_db, parallel["exec_id"])
    # Stored in the order the sources were selected, not the order they
    # answered in: arXiv's copy of the shared paper is the one kept as new.
    assert [d[:2] for d in record["documents"]] == [
        ("arxiv", "arxiv-1"), ("arxiv", "arxiv-2"), ("doaj", "doaj-9"),
        ("europepmc", "europepmc-0"), ("europepmc", "europepmc-1"),
        ("europepmc", "europepmc-2")]
    assert ("dblp", "error", 0, "the upstream closed the connection", None, None, None) \
        in record["sources"]
    assert ("crossref", "ok", 0, None, "not_recorded", None, None) in record["sources"]
    assert ("core", "skipped_missing_key", 0, None, "missing_key",
            '{"credential_name": "core_api_key"}', "core_api_key") in record["sources"]
    assert any(s[0] == "ieee" and s[1] == "error" and s[4] == "retired"
               for s in record["sources"])
    assert record["dedup"][4] == 1, "doaj's copy of arXiv's paper is the cross-source one"
    serial_db.close()
    parallel_db.close()


# ---------------------------------------------------------------------------
# Cancellation
# ---------------------------------------------------------------------------


def test_cancel_records_answered_sources_as_answered_and_in_flight_ones_as_cancelled(
        monkeypatch):
    monkeypatch.setattr(se, "_SOURCE_CONCURRENCY", 2)
    monkeypatch.setattr(se, "_HEARTBEAT_SECONDS", 0.05)
    hold = threading.Event()
    asked: list[str] = []

    def script(slug: str) -> list:
        asked.append(slug)
        if slug == "arxiv":
            return [_paper("arxiv", 1)]
        hold.wait(10)
        return [_paper(slug, 1)]

    _stand_ins(monkeypatch, script)
    connection = sqlite3.connect(":memory:", check_same_thread=False)
    init_db(conn=connection)
    out, thread = _start(connection, ["arxiv", "crossref", "dblp", "doaj"])
    thread.start()
    try:
        deadline = time.monotonic() + 5
        while sorted(asked) != ["arxiv", "crossref", "dblp"] and time.monotonic() < deadline:
            time.sleep(0.01)
        assert sorted(asked) == ["arxiv", "crossref", "dblp"]
        progress_store.request_cancel(out["exec_id"])
        thread.join(5)
        assert not thread.is_alive(), "cancellation waited on a search in flight"
    finally:
        hold.set()
        thread.join(5)

    assert "error" not in out, out.get("error")
    assert out["result"]["status"] == "cancelled"
    assert get_execution_by_id(connection, out["exec_id"])["status"] == "cancelled"
    rows = {r["source"]: r for r in get_execution_sources(connection, out["exec_id"])}
    assert set(rows) == {"arxiv", "crossref", "dblp"}, "doaj was never asked and has no row"
    assert (rows["arxiv"]["status"], rows["arxiv"]["result_count"]) == ("ok", 1)
    for slug in ("crossref", "dblp"):
        assert rows[slug]["status"] == "cancelled"
        assert rows[slug]["error_message"] == "cancelled by user"
    events = progress_store.get_events(out["exec_id"])
    cancelled = sorted(e["repository"] for e in events
                       if e.get("type") == "repo_error" and e.get("error") == "cancelled by user")
    assert cancelled == ["crossref", "dblp"]
    assert not any(e.get("repository") == "doaj" for e in events)
    connection.close()


# ---------------------------------------------------------------------------
# The heartbeat
# ---------------------------------------------------------------------------


def test_a_slow_source_still_says_so_while_others_finish(monkeypatch, conn):
    monkeypatch.setattr(se, "_HEARTBEAT_SECONDS", 0.1)

    def script(slug: str) -> list:
        time.sleep(0.55 if slug == "zenodo" else 0.02)
        return [_paper(slug, 1)]

    _stand_ins(monkeypatch, script)
    run = _run(conn, ["arxiv", "zenodo", "hal"])
    beats = [e for e in run["events"]
             if e.get("type") == "query_progress" and e.get("phase") == "searching"]
    assert {e["repository"] for e in beats} == {"zenodo"}
    assert len(beats) >= 3
    elapsed = [e["elapsed"] for e in beats]
    assert elapsed == sorted(elapsed) and elapsed[-1] < 0.6
    assert all(e["message"] == f"still querying zenodo ({e['elapsed']:.0f}s elapsed)"
               or e["message"].startswith("still querying zenodo (") for e in beats)


# ---------------------------------------------------------------------------
# The rate limiters
# ---------------------------------------------------------------------------


def test_two_sweeps_at_once_contend_on_each_sources_one_module_level_limiter(monkeypatch):
    """Real clients, real ``safe_request``; only the transport answers locally.

    Each module's limiter is replaced by a slow one so its spacing is
    measurable, and every admission is recorded with the limiter it went
    through and the source whose search thread asked. Two sweeps over the
    same three sources run at once, each asking its three sources together.
    """
    modules = {"crossref": api_crossref, "doaj": api_doaj, "openalex": api_openalex}
    interval = 0.25
    limiters = {slug: api_base.RateLimiter(1 / interval) for slug in modules}
    for slug, module in modules.items():
        monkeypatch.setattr(module, "_RATE_LIMITER", limiters[slug])
    monkeypatch.setattr(config, "DEFAULT_MAX_RETRIES", 0)

    def request(_self, method, url, **kwargs):
        return httpx.Response(200, json={}, request=httpx.Request(method, url))

    monkeypatch.setattr(httpx.Client, "request", request)

    admissions: list[tuple[str, int, float]] = []
    lock = threading.Lock()
    acquire = api_base.RateLimiter.acquire

    def recording_acquire(self, *, deadline=None):
        acquire(self, deadline=deadline)
        name = threading.current_thread().name          # search-<slug>-<exec id>
        with lock:
            admissions.append((name.split("-")[1], id(self), time.monotonic()))

    monkeypatch.setattr(api_base.RateLimiter, "acquire", recording_acquire)

    results: list = []

    def sweep() -> None:
        connection = sqlite3.connect(":memory:")
        init_db(conn=connection)
        try:
            results.append(_run(connection, list(modules))["result"])
        finally:
            connection.close()

    threads = [threading.Thread(target=sweep) for _ in range(2)]
    for t in threads:
        t.start()
    for t in threads:
        t.join(30)
    assert len(results) == 2

    for slug in modules:
        mine = sorted((at, ident) for s, ident, at in admissions if s == slug)
        assert len(mine) >= 2, f"{slug}: both sweeps should have asked it"
        assert {ident for _at, ident in mine} == {id(limiters[slug])}, (
            f"{slug}: a request went through a limiter other than the module's")
        gaps = [b[0] - a[0] for a, b in zip(mine, mine[1:])]
        assert min(gaps) >= interval * 0.9, f"{slug}: admissions {gaps} s apart"
