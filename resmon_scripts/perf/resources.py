"""Memory and CPU of a process tree, from ``ps``.

``ps`` rather than a library because the harness should add nothing to what
resmon installs, and because it reads the same numbers on macOS and Linux:
resident set size in kilobytes, and CPU time consumed. CPU at idle is CPU time
consumed over a window divided by the window, which is the honest form of
"percent at idle" -- an instantaneous ``%cpu`` is a decaying average.
"""

from __future__ import annotations

import re
import subprocess
import time
from typing import Optional

_FOOTPRINT = re.compile(r"Footprint:\s*([\d.]+)\s*(B|KB|MB|GB)\b")
_TO_MB = {"B": 1 / 1048576.0, "KB": 1 / 1024.0, "MB": 1.0, "GB": 1024.0}


def _ps() -> list[tuple[int, int, int, float, str]]:
    """``(pid, ppid, rss_kb, cpu_seconds, command)`` for every process."""
    out = subprocess.run(["ps", "-axo", "pid=,ppid=,rss=,time=,command="],
                         capture_output=True, text=True, check=True).stdout
    rows = []
    for line in out.splitlines():
        parts = line.split(None, 4)
        if len(parts) < 5:
            continue
        pid, ppid, rss, cputime, command = parts
        rows.append((int(pid), int(ppid), int(rss), _seconds(cputime), command))
    return rows


def _seconds(cputime: str) -> float:
    """``[[dd-]hh:]mm:ss.cc`` to seconds."""
    days = 0
    if "-" in cputime:
        d, cputime = cputime.split("-", 1)
        days = int(d)
    parts = [float(p) for p in cputime.split(":")]
    while len(parts) < 3:
        parts.insert(0, 0.0)
    h, m, s = parts
    return days * 86400 + h * 3600 + m * 60 + s


def tree(root: int) -> list[dict]:
    """``root`` and every descendant, each with its RSS and CPU time."""
    rows = _ps()
    children: dict[int, list[int]] = {}
    for pid, ppid, *_ in rows:
        children.setdefault(ppid, []).append(pid)
    wanted, stack = set(), [root]
    while stack:
        pid = stack.pop()
        if pid in wanted:
            continue
        wanted.add(pid)
        stack.extend(children.get(pid, []))
    return [
        {"pid": pid, "ppid": ppid, "rss_mb": rss / 1024.0, "cpu_s": cpu,
         "role": classify(command), "command": command[:160]}
        for pid, ppid, rss, cpu, command in rows if pid in wanted
    ]


def classify(command: str) -> str:
    """Which part of resmon a process is, by its command line."""
    lowered = command.lower()
    if "resmon.py" in lowered or "perf.backend" in lowered or "implementation_scripts.daemon" in lowered:
        return "backend"
    if "--type=renderer" in lowered:
        return "renderer"
    if "--type=gpu-process" in lowered:
        return "gpu"
    if "--type=utility" in lowered:
        return "utility"
    if "--type=" in lowered:
        return "helper"
    return "main"


def snapshot(root: int) -> dict:
    """Total and per-role resident memory of a tree, in megabytes."""
    procs = tree(root)
    by_role: dict[str, float] = {}
    for proc in procs:
        by_role[proc["role"]] = by_role.get(proc["role"], 0.0) + proc["rss_mb"]
    return {"total_mb": sum(p["rss_mb"] for p in procs), "by_role_mb": by_role,
            "processes": len(procs)}


def idle_cpu(root: int, seconds: float = 30.0) -> dict:
    """Percent of one core the tree used over ``seconds`` of idling."""
    before = {p["pid"]: p["cpu_s"] for p in tree(root)}
    time.sleep(seconds)
    after = tree(root)
    used = sum(p["cpu_s"] - before.get(p["pid"], 0.0) for p in after)
    by_role: dict[str, float] = {}
    for p in after:
        by_role[p["role"]] = by_role.get(p["role"], 0.0) + (p["cpu_s"] - before.get(p["pid"], 0.0))
    return {"percent_of_one_core": 100.0 * used / seconds,
            "by_role_percent": {k: 100.0 * v / seconds for k, v in by_role.items()},
            "window_s": seconds}


def open_files(pid: int) -> Optional[int]:
    """How many descriptors ``pid`` holds, from ``lsof``; ``None`` if unreadable."""
    try:
        out = subprocess.run(["lsof", "-n", "-P", "-p", str(pid)],
                             capture_output=True, text=True, timeout=30).stdout
    except (OSError, subprocess.TimeoutExpired):
        return None
    lines = out.splitlines()
    return max(0, len(lines) - 1) if lines else None


def footprint_mb(root: int) -> Optional[float]:
    """The tree's physical footprint in megabytes, from macOS's ``footprint``.

    Resident size cannot see a leak on a Mac that is compressing memory: the
    compressor takes the pages nothing touches, which are a leak's pages, and
    they leave RSS. The first by-runs soak read the service at 40 MB, below
    what it starts at, while this Mac held 23 GB compressed. The footprint is
    what Activity Monitor calls Memory and counts compressed pages, so it is
    the number a leak cannot hide from. ``None`` where the tool is absent
    (Linux) or a process cannot be read.
    """
    total = 0.0
    for proc in tree(root):
        one = footprint_of(proc["pid"])
        if one is not None:
            total += one
        elif proc["pid"] == root:
            return None
        # A child that exited between ``ps`` and ``footprint`` (``ps`` itself,
        # when the root is this process) holds nothing now and is left out.
    return total


def footprint_of(pid: int) -> Optional[float]:
    """One process's physical footprint in megabytes; ``None`` if it cannot be read."""
    try:
        out = subprocess.run(["footprint", "-p", str(pid)],
                             capture_output=True, text=True, timeout=30).stdout
    except (OSError, subprocess.TimeoutExpired):
        return None
    match = _FOOTPRINT.search(out)
    return float(match.group(1)) * _TO_MB[match.group(2)] if match else None
