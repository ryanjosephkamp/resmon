"""The engine's measurements, taken over HTTP against an isolated backend.

Everything here goes through the same routes the interface calls, so a number
is what a window waiting on that route would wait. Nothing is called in
process: the backend runs as its own process, exactly as Electron or launchd
starts it.
"""

from __future__ import annotations

import time
from pathlib import Path
from typing import Callable, Optional

from . import instance, resources, seed
from .embedder import FakeEmbedder
from .stats import metric

# The benchmark sweep. A year-long window because DBLP refuses anything
# shorter, and a year of "graph neural networks" fills every source's cap.
SWEEP_SOURCES = list(seed.SOURCES)
SWEEP_BODY = {
    "repositories": SWEEP_SOURCES,
    "query": "graph neural networks",
    "date_from": "2025-01-01",
    "date_to": "2025-12-31",
    "max_results": 100,
}

EXPLORER_QUERIES = {
    # Free text through the FTS index, the commonest search.
    "keyword": {"query": "graph neural", "limit": 50},
    # No text: the newest page of the whole corpus, which is the Explorer's first screen.
    "browse": {"limit": 50},
    # Text plus a source filter and a date floor, the shape a narrowed search takes.
    "filtered": {"query": "protein folding", "limit": 50,
                 "sources": ["pubmed", "europepmc"], "date_from": "2025-06-01"},
}

Progress = Callable[[str], None]


def _say(progress: Optional[Progress], message: str) -> None:
    if progress:
        progress(message)


def backend_start(work: Path, corpus: Path, runs: int, progress: Optional[Progress] = None) -> list[dict]:
    """Spawn to ``/api/health`` answering, over the 10,000-paper corpus."""
    samples = []
    for i in range(runs):
        state = instance.fresh_state(work, f"start-{i}", seed_db=corpus)
        backend = instance.start_backend(state)
        samples.append(backend.healthy_at - backend.started_at)
        backend.stop()
        _say(progress, f"backend start {i + 1}/{runs}: {samples[-1]:.2f} s")
    return [metric("backend.start_to_health", "s", samples,
                   note="Process spawn until /api/health answers, over the 10,000-paper corpus.")]


def _stage_durations(events: list[tuple[float, dict]], posted: float, ended: float) -> dict:
    """Seconds spent in each stage, from when the harness first saw each stage event."""
    marks = [(t, e.get("stage")) for t, e in events if e.get("type") == "stage" and e.get("stage")]
    durations: dict[str, float] = {}
    for (t, stage), nxt in zip(marks, marks[1:] + [(ended, None)]):
        durations[stage] = durations.get(stage, 0.0) + max(0.0, nxt[0] - t)
    if marks:
        durations["before_querying"] = max(0.0, marks[0][0] - posted)
    return durations


def sweep(work: Path, corpus: Path, replies: Path, runs: int,
          progress: Optional[Progress] = None) -> list[dict]:
    """The ten-source sweep, answered from recordings at their recorded latency."""
    walls, stores, reports, queries, rates, rss_after = [], [], [], [], [], []
    misses = replies / "misses.jsonl"
    if misses.exists():
        misses.unlink()
    for i in range(runs):
        state = instance.fresh_state(work, f"sweep-{i}", seed_db=corpus)
        backend = instance.start_backend(state, replay={"mode": "replay", "dir": replies})
        try:
            posted = time.perf_counter()
            exec_id = backend.post("/api/search/sweep", SWEEP_BODY)["execution_id"]
            row, events = instance.wait_for_execution(backend, exec_id)
            ended = time.perf_counter()
            if row.get("status") != "completed":
                raise RuntimeError(f"the benchmark sweep ended {row.get('status')}: {row}")
            if misses.exists():
                raise RuntimeError(
                    f"the sweep asked for something with no recording; see {misses}. "
                    "Re-record (perf/README.md) rather than report a faster run that skipped work.")
            stages = _stage_durations(events, posted, ended)
            walls.append(ended - posted)
            queries.append(stages.get("querying", 0.0))
            stores.append(stages.get("dedup", 0.0))
            reports.append(stages.get("reporting", 0.0))
            stored = int(row.get("result_count") or 0)
            if stages.get("dedup"):
                rates.append(stored / stages["dedup"])
            rss_after.append(resources.snapshot(backend.proc.pid)["total_mb"])
            _say(progress, f"sweep {i + 1}/{runs}: {walls[-1]:.1f} s, {stored} results, "
                           f"stages {', '.join(f'{k} {v:.2f}' for k, v in stages.items())}")
        finally:
            backend.stop()
    note = (f"{len(SWEEP_SOURCES)} sources, recorded replies served after their recorded "
            "latency, through the real clients, safe_request and rate limiters. "
            "Stage times are from the run's own stage events, seen by polling every 50 ms.")
    return [
        metric("sweep.10_sources.wall", "s", walls, note=note),
        metric("sweep.10_sources.querying", "s", queries),
        metric("sweep.10_sources.storing", "s", stores,
               note="The dedup stage: normalizing, checking and writing every result."),
        metric("sweep.10_sources.results_per_second", "results/s", rates, better="higher",
               note="Results stored divided by the dedup stage's time."),
        metric("sweep.10_sources.report_writing", "s", reports,
               note="The reporting stage: the run's Markdown report and log."),
        metric("memory.backend.after_sweep", "MB", rss_after),
    ]


def _timed(call: Callable[[], object], repeats: int, warmup: int = 2) -> list[float]:
    for _ in range(warmup):
        call()
    samples = []
    for _ in range(repeats):
        started = time.perf_counter()
        call()
        samples.append((time.perf_counter() - started) * 1000.0)
    return samples


def explorer(work: Path, corpus: Path, size_label: str, repeats: int,
             progress: Optional[Progress] = None) -> list[dict]:
    """Explorer search and facets over one corpus size, as the page calls them."""
    state = instance.fresh_state(work, f"explorer-{size_label}", seed_db=corpus)
    backend = instance.start_backend(state)
    out = []
    try:
        with backend.client() as client:
            for label, body in EXPLORER_QUERIES.items():
                def call(body=body) -> None:
                    response = client.post("/api/explorer/search", json=body)
                    response.raise_for_status()
                samples = _timed(call, repeats)
                out.append(metric(f"explorer.search.{label}@{size_label}", "ms", samples))
                _say(progress, f"explorer {label}@{size_label}: median {sorted(samples)[len(samples) // 2]:.0f} ms")

            def facets() -> None:
                response = client.post("/api/explorer/facets", json={"query": "graph neural"})
                response.raise_for_status()
            samples = _timed(facets, repeats)
            out.append(metric(f"explorer.facets@{size_label}", "ms", samples))
        out.append(metric(f"memory.backend.idle@{size_label}", "MB",
                          [resources.snapshot(backend.proc.pid)["total_mb"]]))
    finally:
        backend.stop()
    return out


def semantic(work: Path, corpus: Path, dims: int, repeats: int,
             progress: Optional[Progress] = None) -> list[dict]:
    """The Explorer ranked by meaning: embed the phrase, then nearest neighbours."""
    state = instance.fresh_state(work, "semantic", seed_db=corpus)
    backend = instance.start_backend(state)
    try:
        with FakeEmbedder(dims) as model:
            backend.put("/api/settings/embeddings", {"settings": {
                "embedding_enabled": "true", "embedding_provider": "local",
                "embedding_model": seed.EMBEDDING_MODEL, "embedding_endpoint": model.url,
            }})
            probe = backend.post("/api/embeddings/probe", {})
            if not probe.get("ok"):
                raise RuntimeError(f"the embedding probe failed: {probe}")
            with backend.client() as client:
                def call() -> None:
                    response = client.post("/api/explorer/search", json={
                        "query": "graph neural networks on molecules", "sort": "similarity", "limit": 50})
                    response.raise_for_status()
                    payload = response.json()
                    if payload.get("similarity_unavailable"):
                        raise RuntimeError(payload["similarity_unavailable"])
                samples = _timed(call, repeats)
        _say(progress, f"semantic: median {sorted(samples)[len(samples) // 2]:.0f} ms")
    finally:
        backend.stop()
    return [metric("semantic.search@10k", "ms", samples,
                   note=f"{dims}-dimension vectors for 10,000 papers; the model is a loopback "
                        "fake answering from a hash, so this is resmon's side only.")]


def service(work: Path, corpus: Path, progress: Optional[Progress] = None,
            idle_seconds: float = 30.0) -> list[dict]:
    """The background service alone: its memory and CPU while nothing happens."""
    state = instance.fresh_state(work, "service", seed_db=corpus)
    backend = instance.start_backend(state, daemon=True, scheduler=True)
    try:
        time.sleep(5.0)
        rss = resources.snapshot(backend.proc.pid)["total_mb"]
        cpu = resources.idle_cpu(backend.proc.pid, idle_seconds)
        _say(progress, f"service idle: {rss:.0f} MB, {cpu['percent_of_one_core']:.2f}% of a core")
    finally:
        backend.stop()
    return [
        metric("memory.service.idle", "MB", [rss], note="The background service with its scheduler, 5 s after start."),
        metric("cpu.service.idle", "% of one core", [cpu["percent_of_one_core"]],
               note=f"CPU time over {idle_seconds:.0f} s of idling."),
    ]
