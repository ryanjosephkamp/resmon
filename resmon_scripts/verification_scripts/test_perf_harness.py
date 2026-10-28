"""The performance harness's own parts (``resmon_scripts/perf``).

The harness is how the rebuild's performance gate is decided, so the parts a
wrong number would come from are tested here: the replay transport (a request
with no recording must be refused, never answered from the network), the gate
arithmetic (a throughput that drops is worse, a duration that drops is
better), the soak's reading of a sawtooth (a leak is a rising floor, not a
high last peak), the seeded corpus (the same every time), and the isolation of
every process the harness starts.
"""

from __future__ import annotations

import json
import math
import sqlite3
import sys
from pathlib import Path

import httpx
import pytest

PROJECT_ROOT = Path(__file__).resolve().parent.parent.parent
sys.path.insert(0, str(PROJECT_ROOT / "resmon_scripts"))

from perf import instance, replay, seed, soak, stats  # noqa: E402


# ---------------------------------------------------------------------------
# Replay
# ---------------------------------------------------------------------------


def test_request_key_ignores_query_order_and_host_case_but_not_body():
    a = replay.request_key("get", "https://API.example.org/search?b=2&a=1")
    b = replay.request_key("GET", "https://api.example.org/search?a=1&b=2")
    assert a == b
    assert replay.request_key("POST", "https://x.org/q", b'{"a":1}') != replay.request_key(
        "POST", "https://x.org/q", b'{"a":2}')


@pytest.fixture
def restore_transports():
    sync, async_ = httpx.HTTPTransport.handle_request, httpx.AsyncHTTPTransport.handle_async_request
    yield
    httpx.HTTPTransport.handle_request = sync
    httpx.AsyncHTTPTransport.handle_async_request = async_


def _recorded(root: Path, url: str, replies: list[tuple[int, bytes]]) -> None:
    rec = replay.Recordings(root)
    key = replay.request_key("GET", url)
    for status, body in replies:
        rec.add(key, url, httpx.Response(status, headers={"content-type": "application/json"}),
                body, elapsed=0.0)


def test_replay_serves_recordings_in_order_then_repeats_the_last(tmp_path, restore_transports):
    url = "https://api.example.org/search?q=graphs"
    _recorded(tmp_path, url, [(503, b'{"busy":true}'), (200, b'{"ok":1}')])
    replay.install("replay", tmp_path)
    with httpx.Client() as client:
        statuses = [client.get(url).status_code for _ in range(3)]
        body = client.get(url).json()
    # The hermetic suite refuses any non-loopback socket, so these four
    # answers prove no request left the process.
    assert statuses == [503, 200, 200]
    assert body == {"ok": 1}


def test_replay_refuses_an_unrecorded_request_and_writes_it_down(tmp_path, restore_transports):
    _recorded(tmp_path, "https://api.example.org/a", [(200, b"{}")])
    replay.install("replay", tmp_path)
    with httpx.Client() as client, pytest.raises(httpx.ConnectError):
        client.get("https://api.example.org/b")
    misses = [json.loads(line) for line in (tmp_path / "misses.jsonl").read_text().splitlines()]
    assert [m["url"] for m in misses] == ["https://api.example.org/b"]


# ---------------------------------------------------------------------------
# The gate
# ---------------------------------------------------------------------------


def test_percentile_interpolates_between_ranks():
    assert stats.percentile([1, 2, 3, 4], 0.5) == 2.5
    assert stats.percentile([10.0], 0.95) == 10.0
    assert math.isclose(stats.percentile(list(range(1, 11)), 0.95), 9.55)


def _run(name: str, unit: str, better: str, samples: list[float]) -> dict:
    return {"metrics": [stats.metric(name, unit, samples, better=better)]}


@pytest.mark.parametrize("better,baseline,candidate,status", [
    ("lower", [100] * 5, [109] * 5, "pass"),        # 9% slower: inside 10%
    ("lower", [100] * 5, [111] * 5, "fail"),        # 11% slower
    ("lower", [100] * 5, [50] * 5, "pass"),         # faster is never a failure
    ("higher", [100] * 5, [91] * 5, "pass"),        # 9% less throughput
    ("higher", [100] * 5, [89] * 5, "fail"),        # 11% less throughput
    ("higher", [100] * 5, [300] * 5, "pass"),
])
def test_gate_follows_each_measurements_direction(better, baseline, candidate, status):
    [row] = stats.compare(_run("m", "x", better, baseline), _run("m", "x", better, candidate))
    assert row["status"] == status


def test_gate_tolerates_a_wider_tail_than_median():
    # Median unchanged and the slowest of ten samples 35% slower, which the
    # interpolated p95 reads as 19%: inside the 20% allowed for the tail.
    base = [100.0] * 9 + [100.0]
    cand = [100.0] * 9 + [135.0]
    [row] = stats.compare(_run("m", "ms", "lower", base), _run("m", "ms", "lower", cand))
    assert row["median"]["passes"] and row["p95"]["passes"]
    cand = [100.0] * 8 + [200.0, 200.0]
    [row] = stats.compare(_run("m", "ms", "lower", base), _run("m", "ms", "lower", cand))
    assert row["status"] == "fail"


def test_a_measurement_the_candidate_lost_is_not_a_pass():
    base = {"metrics": [stats.metric("a", "ms", [1.0]), stats.metric("b", "ms", [1.0])]}
    cand = {"metrics": [stats.metric("a", "ms", [1.0])]}
    rows = {r["name"]: r for r in stats.compare(base, cand)}
    assert rows["b"]["status"] == "not compared"
    assert rows["b"]["reason"] == "missing from the candidate"


# ---------------------------------------------------------------------------
# The soak by runs
# ---------------------------------------------------------------------------


def _sawtooth(runs: int, leak_mb_per_run: float) -> tuple[list[dict], list[dict]]:
    """Three samples a run: the floor, partway up, and a peak that wanders.

    The last block's peak is the highest of all, as the first soak's was, so a
    reading that judged by the last peak would call both of these leaks.
    """
    samples, finished = [], []
    for run in range(1, runs + 1):
        floor = 120.0 + leak_mb_per_run * run
        peak = floor + 100.0 + 50.0 * ((run * 37) % 7) / 6.0 + (60.0 if run > runs - 20 else 0.0)
        for rss in (floor, floor + 40.0, peak):
            samples.append({"run": run, "rss_mb": rss, "footprint_mb": rss + 30.0, "open_files": 85})
        finished.append({"run": run, "status": "completed"})
    return samples, finished


def test_a_soak_with_a_flat_floor_and_a_high_last_peak_reads_as_no_leak():
    shape = soak.by_blocks(*_sawtooth(100, 0.0), warmup_runs=20)
    assert [b["runs"] for b in shape["blocks"]] == [[1, 20], [21, 40], [41, 60], [61, 80], [81, 100]]
    assert abs(shape["floor_mb_per_100_runs"]) < 1e-9
    assert abs(shape["footprint_floor_mb_per_100_runs"]) < 1e-9
    assert shape["peak_mb_per_100_runs"] > 0
    assert shape["open_files_per_100_runs"] == 0


def test_a_soak_whose_floor_rises_reads_as_the_rate_it_rises_at():
    shape = soak.by_blocks(*_sawtooth(100, 0.5), warmup_runs=20)
    assert math.isclose(shape["floor_mb_per_100_runs"], 50.0)
    assert math.isclose(shape["footprint_floor_mb_per_100_runs"], 50.0)


# ---------------------------------------------------------------------------
# The seeded corpus and isolation
# ---------------------------------------------------------------------------


def _titles(path: Path) -> list[str]:
    with sqlite3.connect(path) as conn:
        return [r[0] for r in conn.execute("SELECT title FROM documents ORDER BY id")]


def test_seeded_corpus_is_the_same_every_time(tmp_path):
    a = seed.build(tmp_path / "a.db", papers=300, runs=6, embed_dims=8)
    b = seed.build(tmp_path / "b.db", papers=300, runs=6, embed_dims=8)
    assert a["counts"] == b["counts"]
    assert a["counts"]["documents"] == 300
    assert a["counts"]["executions"] == 6
    assert a["counts"]["document_embeddings"] == 300
    assert _titles(tmp_path / "a.db") == _titles(tmp_path / "b.db")
    with sqlite3.connect(tmp_path / "a.db") as conn:
        # Stored through the sweep's own path, so free-text search finds them.
        hits = conn.execute(
            "SELECT COUNT(*) FROM documents_fts WHERE documents_fts MATCH 'graph'").fetchone()[0]
        reasons = {r[0] for r in conn.execute("SELECT DISTINCT zero_reason FROM execution_sources")}
    assert hits > 0
    assert None in reasons and len(reasons) > 1, "the history has answers and non-answers"


def test_every_harness_process_is_isolated(tmp_path, monkeypatch):
    monkeypatch.setenv("RESMON_DB_PATH", "/somewhere/real/resmon.db")
    env = instance.isolated_env(tmp_path)
    assert env["RESMON_DB_PATH"] == str(tmp_path / "resmon.db")
    assert env["RESMON_REPORTS_DIR"] == str(tmp_path / "reports")
    assert env["RESMON_PORT_FILE"] == str(tmp_path / "resmon.port")
    assert env["RESMON_STATE_DIR"] == str(tmp_path)
    assert env["PYTHON_KEYRING_BACKEND"] == "keyring.backends.null.Keyring"
    assert all(instance.free_port() != instance.SERVICE_PORT for _ in range(50))
