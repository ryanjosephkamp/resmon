"""The soak: the background service running routines for hours.

A leak shows as a line that keeps climbing, so the soak samples the service's
open files and memory on a fixed interval while a routine fires every few
minutes, and reports the slope of each after a warm-up. The service is the
one copy of resmon that runs for weeks, and the copy that once ran out of
file descriptors (``daemon._raise_open_file_limit`` tells that story), so it is
the one soaked: started as launchd starts it, with its scheduler on, over the
seeded corpus, its sources answered from the recordings.

``python -m perf soak --hours 4`` runs it; nothing else should run alongside
it, though it measures flatness rather than speed, so a quiet machine matters
less here than in ``run``.
"""

from __future__ import annotations

import time
from pathlib import Path
from typing import Optional

from . import engine, instance, resources

ROUTINE_CRON = "*/3 * * * *"


def _slope_per_hour(points: list[tuple[float, float]]) -> float:
    """Least-squares slope of ``(seconds, value)`` points, per hour."""
    n = len(points)
    if n < 2:
        return 0.0
    mean_t = sum(t for t, _ in points) / n
    mean_v = sum(v for _, v in points) / n
    num = sum((t - mean_t) * (v - mean_v) for t, v in points)
    den = sum((t - mean_t) ** 2 for t, _ in points)
    return 0.0 if den == 0 else num / den * 3600.0


def run(work: Path, corpus: Path, replies: Path, *, hours: float, interval: float = 30.0,
        warmup_minutes: float = 60.0, out: Optional[Path] = None,
        progress=None) -> dict:
    state = instance.fresh_state(work, "soak", seed_db=corpus)
    backend = instance.start_backend(state, daemon=True, scheduler=True,
                                     replay={"mode": "replay", "dir": replies})
    samples: list[dict] = []
    started = time.monotonic()
    try:
        routine = backend.post("/api/routines", {
            "name": "soak", "schedule_cron": ROUTINE_CRON,
            "parameters": {k: v for k, v in engine.SWEEP_BODY.items()},
            "is_active": True, "notify_on_complete": False,
        })
        deadline = started + hours * 3600.0
        while time.monotonic() < deadline:
            if backend.proc.poll() is not None:
                raise RuntimeError(f"the service exited with {backend.proc.returncode}")
            snap = resources.snapshot(backend.proc.pid)
            # Only the soak routine's own runs: the seeded corpus already
            # holds 150 runs, and the first soak counted them as its own,
            # reporting 209 runs and six failures for a soak whose 59 runs
            # all completed.
            runs = [r for r in backend.get("/api/executions", params={"limit": 500})
                    if r.get("routine_id") == routine.get("id")]
            sample = {
                "t": round(time.monotonic() - started, 1),
                "rss_mb": round(snap["total_mb"], 1),
                "open_files": resources.open_files(backend.proc.pid),
                "runs": len(runs),
                "completed": sum(1 for r in runs if r.get("status") == "completed"),
                "not_completed": sum(1 for r in runs if r.get("status") not in ("completed", "running")),
            }
            samples.append(sample)
            if out:
                instance.write_json(out, {"samples": samples, "routine": routine})
            if progress and len(samples) % 20 == 1:
                progress(f"soak {sample['t'] / 60:.0f} min: {sample['rss_mb']} MB, "
                         f"{sample['open_files']} files, {sample['runs']} runs")
            time.sleep(interval)
    finally:
        backend.stop()

    steady = [s for s in samples if s["t"] >= warmup_minutes * 60.0] or samples
    result = {
        "hours": hours, "interval_s": interval, "warmup_minutes": warmup_minutes,
        "routine_cron": ROUTINE_CRON, "samples": samples,
        "runs": samples[-1]["runs"] if samples else 0,
        "not_completed": samples[-1]["not_completed"] if samples else 0,
        "rss_mb_per_hour": _slope_per_hour([(s["t"], s["rss_mb"]) for s in steady]),
        "open_files_per_hour": _slope_per_hour(
            [(s["t"], float(s["open_files"])) for s in steady if s["open_files"] is not None]),
        "rss_mb_first": steady[0]["rss_mb"] if steady else None,
        "rss_mb_last": steady[-1]["rss_mb"] if steady else None,
        "rss_mb_min": min(s["rss_mb"] for s in steady) if steady else None,
        "rss_mb_max": max(s["rss_mb"] for s in steady) if steady else None,
        "open_files_first": steady[0]["open_files"] if steady else None,
        "open_files_last": steady[-1]["open_files"] if steady else None,
    }
    if out:
        instance.write_json(out, result)
    return result


def describe(result: dict) -> str:
    return (
        f"{result['hours']} h, a routine every 3 minutes ({result['runs']} runs, "
        f"{result['not_completed']} not completed). After a {result['warmup_minutes']:.0f}-minute "
        f"warm-up: memory {result['rss_mb_first']} → {result['rss_mb_last']} MB, ranging "
        f"{result['rss_mb_min']}–{result['rss_mb_max']} MB ({result['rss_mb_per_hour']:+.1f} MB/h "
        f"by least squares); open files {result['open_files_first']} → "
        f"{result['open_files_last']} ({result['open_files_per_hour']:+.1f}/h)."
    )

