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

``python -m perf soak --runs 240`` is the same soak by work rather than by
the clock: the routine is run again the moment its last run finishes, with the
recordings answered at once. The first soak (3 hours, 59 runs) ended on its
highest memory peak, which three hours could not tell from a slow leak, and the
twelve hours owed to settle it are 240 runs at the 3-minute cadence. What
resmon holds onto grows with what it does (runs, requests, stored results,
descriptors), so 240 runs back to back ask the same question in about an hour.
It does not ask about anything that would grow with time alone; the hours mode
still does, and the first soak's three hours are its answer so far.

A sawtooth's peaks say when the allocator last let go, not whether anything is
kept, so the by-runs mode judges by blocks of runs: the lowest and highest
memory in each block, and the slope of each across the blocks after warm-up.
A leak raises the floor; a noisy allocator moves only the peaks. On macOS the
memory judged is the physical footprint, which counts compressed pages;
resident size is kept beside it and is not evidence on a Mac that compresses
(``resources.footprint_mb`` says why).
"""

from __future__ import annotations

import time
from pathlib import Path
from typing import Optional

from . import engine, instance, resources

ROUTINE_CRON = "*/3 * * * *"
# How many runs one block of the by-runs soak holds: enough that each block
# spans several of the sawtooth's drops, so its lowest point is a real floor.
BLOCK_RUNS = 20


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


def _sample(backend, **extra) -> dict:
    snap = resources.snapshot(backend.proc.pid)
    footprint = resources.footprint_mb(backend.proc.pid)
    return {"rss_mb": round(snap["total_mb"], 1),
            "footprint_mb": None if footprint is None else round(footprint, 1),
            "open_files": resources.open_files(backend.proc.pid), **extra}


def by_blocks(samples: list[dict], finished: list[dict], warmup_runs: int) -> dict:
    """Each block of runs' lowest and highest memory, and the slope of each.

    Slopes are per 100 runs across the blocks after warm-up, each block placed
    at its middle run: the floor is the leak's line, the peak the allocator's.
    """
    blocks = []
    for first in range(1, len(finished) + 1, BLOCK_RUNS):
        last = min(first + BLOCK_RUNS - 1, len(finished))
        inside = [s for s in samples if first <= s["run"] <= last]
        files = [s["open_files"] for s in inside if s["open_files"] is not None]
        prints = [s["footprint_mb"] for s in inside if s.get("footprint_mb") is not None]
        blocks.append({
            "runs": [first, last],
            "footprint_mb_min": min(prints) if prints else None,
            "footprint_mb_max": max(prints) if prints else None,
            "rss_mb_min": min(s["rss_mb"] for s in inside),
            "rss_mb_max": max(s["rss_mb"] for s in inside),
            "open_files_min": min(files) if files else None,
            "open_files_max": max(files) if files else None,
        })
    steady = [b for b in blocks if b["runs"][0] > warmup_runs] or blocks
    middle = [(b["runs"][0] + b["runs"][1]) / 2.0 for b in steady]

    def per_100(key: str) -> Optional[float]:
        points = [(m, float(b[key])) for m, b in zip(middle, steady) if b[key] is not None]
        return _slope_per_hour(points) / 3600.0 * 100.0 if len(points) >= 2 else None

    return {
        "footprint_floor_mb_per_100_runs": per_100("footprint_mb_min"),
        "footprint_peak_mb_per_100_runs": per_100("footprint_mb_max"),
        "floor_mb_per_100_runs": per_100("rss_mb_min"),
        "peak_mb_per_100_runs": per_100("rss_mb_max"),
        "open_files_per_100_runs": per_100("open_files_max"),
        "blocks": blocks,
    }


def run_back_to_back(work: Path, corpus: Path, replies: Path, *, runs: int,
                     latency: str = "zero", interval: float = 2.0,
                     warmup_runs: int = BLOCK_RUNS, run_timeout: float = 600.0,
                     out: Optional[Path] = None, progress=None) -> dict:
    """The soak by work: ``runs`` runs of one routine, each started as the last ends."""
    state = instance.fresh_state(work, "soak", seed_db=corpus)
    backend = instance.start_backend(state, daemon=True, scheduler=True,
                                     replay={"mode": "replay", "dir": replies, "latency": latency})
    samples: list[dict] = []
    finished: list[dict] = []
    started = time.monotonic()

    def stamp() -> float:
        return round(time.monotonic() - started, 1)

    def save(extra: Optional[dict] = None) -> None:
        if out:
            instance.write_json(out, {"samples": samples, "run_log": finished, **(extra or {})})

    try:
        # Inactive, so the scheduler never fires it on its own and a fire can
        # never collide with the run the soak is waiting on. "Run now" is
        # ``_dispatch_routine_fire``, the function the scheduler calls, so each
        # run takes the scheduled path; the scheduler itself stays on, as the
        # service runs it.
        routine = backend.post("/api/routines", {
            "name": "soak", "schedule_cron": ROUTINE_CRON,
            "parameters": {k: v for k, v in engine.SWEEP_BODY.items()},
            "is_active": False, "notify_on_complete": False,
        })
        samples.append(_sample(backend, t=stamp(), run=0))
        for number in range(1, runs + 1):
            if backend.proc.poll() is not None:
                raise RuntimeError(f"the service exited with {backend.proc.returncode}")
            began = time.monotonic()
            exec_id = backend.post(f"/api/routines/{routine['id']}/run")["execution_id"]
            while True:
                time.sleep(interval)
                samples.append(_sample(backend, t=stamp(), run=number))
                status = backend.get(f"/api/executions/{exec_id}").get("status")
                if status != "running":
                    break
                if time.monotonic() - began > run_timeout:
                    raise RuntimeError(f"run {number} (execution {exec_id}) was still "
                                       f"running after {run_timeout:.0f} s")
            finished.append({"run": number, "execution_id": exec_id, "status": status,
                             "seconds": round(time.monotonic() - began, 1)})
            save({"routine": routine})
            if progress and (number == 1 or number % BLOCK_RUNS == 0):
                last = samples[-1]
                progress(f"soak run {number}/{runs} at {last['t'] / 60:.0f} min: "
                         f"{last['rss_mb']} MB, {last['open_files']} files")
    finally:
        backend.stop()

    shape = by_blocks(samples, finished, warmup_runs)
    seconds = [r["seconds"] for r in finished]
    result = {
        "mode": "runs", "runs_asked": runs, "latency": latency, "interval_s": interval,
        "warmup_runs": warmup_runs, "block_runs": BLOCK_RUNS,
        "runs": len(finished),
        "not_completed": sum(1 for r in finished if r["status"] != "completed"),
        "wall_minutes": round(samples[-1]["t"] / 60.0, 1) if samples else 0.0,
        "run_seconds_median": sorted(seconds)[len(seconds) // 2] if seconds else None,
        "rss_mb_start": samples[0]["rss_mb"] if samples else None,
        "rss_mb_end": samples[-1]["rss_mb"] if samples else None,
        **shape, "samples": samples, "run_log": finished, "routine": routine,
    }
    if out:
        instance.write_json(out, result)
    return result


def describe(result: dict) -> str:
    if result.get("mode") == "runs":
        steady = [b for b in result["blocks"] if b["runs"][0] > result["warmup_runs"]] \
            or result["blocks"]
        first, last = (steady[0], steady[-1]) if steady else ({}, {})
        return (
            f"{result['runs']} runs back to back in {result['wall_minutes']} min "
            f"({result['not_completed']} not completed; a run took {result['run_seconds_median']} s "
            f"at the median, latency {result['latency']}). After {result['warmup_runs']} runs of "
            f"warm-up, in blocks of {result['block_runs']}: footprint floor "
            f"{first.get('footprint_mb_min')} → {last.get('footprint_mb_min')} MB "
            f"({_signed(result.get('footprint_floor_mb_per_100_runs'))} MB per 100 runs), peak "
            f"{first.get('footprint_mb_max')} → {last.get('footprint_mb_max')} MB "
            f"({_signed(result.get('footprint_peak_mb_per_100_runs'))}); resident floor "
            f"{first.get('rss_mb_min')} → {last.get('rss_mb_min')} MB "
            f"({_signed(result['floor_mb_per_100_runs'])} MB per 100 runs), peak "
            f"{first.get('rss_mb_max')} → {last.get('rss_mb_max')} MB "
            f"({_signed(result['peak_mb_per_100_runs'])}); open files at most "
            f"{first.get('open_files_max')} → {last.get('open_files_max')} "
            f"({_signed(result['open_files_per_100_runs'])} per 100 runs)."
        )
    return (
        f"{result['hours']} h, a routine every 3 minutes ({result['runs']} runs, "
        f"{result['not_completed']} not completed). After a {result['warmup_minutes']:.0f}-minute "
        f"warm-up: memory {result['rss_mb_first']} → {result['rss_mb_last']} MB, ranging "
        f"{result['rss_mb_min']}–{result['rss_mb_max']} MB ({result['rss_mb_per_hour']:+.1f} MB/h "
        f"by least squares); open files {result['open_files_first']} → "
        f"{result['open_files_last']} ({result['open_files_per_hour']:+.1f}/h)."
    )


def _signed(value: Optional[float]) -> str:
    return "n/a" if value is None else f"{value:+.1f}"
