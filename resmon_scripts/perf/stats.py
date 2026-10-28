"""Summaries, the machine a run was taken on, and the gate.

The gate is the one the rebuild agreed to: no measurement more than 10% worse
than the baseline at the median, or 20% at the 95th percentile. "Worse" depends
on the measurement -- a longer launch is worse, a larger results-per-second is
better -- so every metric carries its direction.
"""

from __future__ import annotations

import math
import platform
import subprocess
from datetime import datetime, timezone
from pathlib import Path
from typing import Iterable, Optional

MEDIAN_TOLERANCE = 0.10
P95_TOLERANCE = 0.20


def percentile(values: list[float], q: float) -> float:
    """The ``q`` quantile by linear interpolation between closest ranks.

    With ten samples the 95th percentile sits between the ninth and tenth
    value; it is reported with the sample count so nobody reads it as a tail
    measured over thousands.
    """
    if not values:
        return math.nan
    ordered = sorted(values)
    if len(ordered) == 1:
        return ordered[0]
    position = (len(ordered) - 1) * q
    low = math.floor(position)
    high = math.ceil(position)
    if low == high:
        return ordered[low]
    return ordered[low] + (ordered[high] - ordered[low]) * (position - low)


def summarize(values: Iterable[float]) -> dict:
    samples = [float(v) for v in values]
    return {
        "n": len(samples),
        "median": percentile(samples, 0.5),
        "p95": percentile(samples, 0.95),
        "min": min(samples) if samples else math.nan,
        "max": max(samples) if samples else math.nan,
        "samples": samples,
    }


def metric(name: str, unit: str, samples: Iterable[float], *, better: str = "lower",
           note: Optional[str] = None) -> dict:
    """One measurement: its samples, summary, unit and which way is better."""
    if better not in ("lower", "higher"):
        raise ValueError(better)
    entry = {"name": name, "unit": unit, "better": better, **summarize(samples)}
    if note:
        entry["note"] = note
    return entry


def _run(args: list[str], cwd: Optional[Path] = None) -> str:
    try:
        return subprocess.run(args, capture_output=True, text=True, cwd=cwd,
                              timeout=20).stdout.strip()
    except (OSError, subprocess.TimeoutExpired):
        return ""


def environment(repo: Path) -> dict:
    """What a number is specific to: the machine, the OS, the commit, the day."""
    info = {
        "taken_at": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "commit": _run(["git", "rev-parse", "HEAD"], cwd=repo),
        "commit_subject": _run(["git", "log", "-1", "--format=%s"], cwd=repo),
        "dirty": bool(_run(["git", "status", "--porcelain", "--untracked-files=no"], cwd=repo)),
        "os": platform.platform(),
        "machine": platform.machine(),
        "python": platform.python_version(),
    }
    if platform.system() == "Darwin":
        info["model"] = _run(["sysctl", "-n", "hw.model"])
        info["cpu"] = _run(["sysctl", "-n", "machdep.cpu.brand_string"])
        info["cores"] = _run(["sysctl", "-n", "hw.ncpu"])
        info["memory_bytes"] = _run(["sysctl", "-n", "hw.memsize"])
        info["macos"] = _run(["sw_vers", "-productVersion"])
        info["power"] = _run(["pmset", "-g", "batt"]).splitlines()[0:1]
    return info


def compare(baseline: dict, candidate: dict) -> list[dict]:
    """Every metric in both runs, with its change and whether it passes the gate.

    A metric present in only one run is listed as not compared rather than
    dropped: a measurement the new build lost is a finding, not a pass.
    """
    base = {m["name"]: m for m in baseline.get("metrics", [])}
    cand = {m["name"]: m for m in candidate.get("metrics", [])}
    rows = []
    for name in sorted(set(base) | set(cand)):
        b, c = base.get(name), cand.get(name)
        if b is None or c is None:
            rows.append({"name": name, "status": "not compared",
                         "reason": "missing from the baseline" if b is None else "missing from the candidate"})
            continue
        row = {"name": name, "unit": b["unit"], "better": b["better"]}
        verdicts = []
        for stat, tolerance in (("median", MEDIAN_TOLERANCE), ("p95", P95_TOLERANCE)):
            old, new = b[stat], c[stat]
            if not old or math.isnan(old) or math.isnan(new):
                row[stat] = {"baseline": old, "candidate": new, "change": None}
                continue
            change = (new - old) / old
            worse = change if b["better"] == "lower" else -change
            row[stat] = {"baseline": old, "candidate": new, "change": change,
                         "passes": worse <= tolerance}
            verdicts.append(worse <= tolerance)
        row["status"] = "pass" if verdicts and all(verdicts) else ("fail" if verdicts else "not compared")
        rows.append(row)
    return rows
