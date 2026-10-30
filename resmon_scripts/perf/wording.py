"""Shared wording: a full scan and a new-papers scan, timed, with their peak memory.

Each measurement runs in a child interpreter of its own, so its peak resident
size is the scan's and not the harness's: the child reports the high-water
mark it reached before the scan (the interpreter, NumPy, the engine's modules)
and after it. The corpus is the seeded one (``seed.py``), copied into the work
directory first, because the new-papers pass adds papers and the cached corpus
is shared with every other measurement.

The seeded text is drawn from a small vocabulary and means nothing, so these
numbers are about cost, not about what the method finds; one paper in thirty is
the same paper from a second source, which gives the set-aside path real work.
``shared_wording``'s docstring has what the method finds on real abstracts.
"""

from __future__ import annotations

import dataclasses
import json
import random
import resource
import sqlite3
import subprocess
import sys
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Callable

from . import instance, seed

#: Papers a run brings, for the new-papers pass.
NEW_PAPERS = 200


def _child(corpus: Path, kind: str) -> dict:
    """Run one scan in a fresh interpreter and read what it reports."""
    out = subprocess.run(
        [sys.executable, "-m", "perf.wording", "child", str(corpus), kind],
        cwd=instance.SCRIPTS, capture_output=True, text=True, check=True,
    ).stdout
    return json.loads(out.strip().splitlines()[-1])


def _rss_mb() -> float:
    peak = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss
    # Bytes on macOS, kilobytes on Linux.
    return peak / (1024 * 1024) if sys.platform == "darwin" else peak / 1024


def child(corpus: str, kind: str) -> None:
    from implementation_scripts import shared_wording as sw

    conn = sqlite3.connect(corpus)
    conn.row_factory = sqlite3.Row
    before = _rss_mb()
    started = time.perf_counter()
    if kind == "full":
        result = sw.find_pairs(conn)
        stored = sw._new_state(result, kind="full", started_at=sw._now(),
                               seconds=time.perf_counter() - started, previous=None)
        Path(corpus + ".state.json").write_text(json.dumps(stored))
    else:
        stored = json.loads(Path(corpus + ".state.json").read_text())
        new_ids = sw._changed_since(conn, stored)
        result = sw.find_pairs(conn, new_ids=new_ids)
    seconds = time.perf_counter() - started
    print(json.dumps({
        "kind": kind, "seconds": round(seconds, 2), "rss_before_mb": round(before, 1),
        "rss_peak_mb": round(_rss_mb(), 1), "compared": result["compared"],
        "pairs": len(result["pairs"]), "candidates": result["candidates"],
    }))


def _add_new_papers(path: Path, count: int) -> None:
    """Papers a run would bring: new records from the seed's generator, and a
    few that copy a passage of a paper already held, so the pass has pairs to make."""
    from implementation_scripts import normalizer

    conn = sqlite3.connect(path)
    conn.row_factory = sqlite3.Row
    rng = random.Random(seed.SEED + 1)
    today = datetime.now(timezone.utc)
    held = [r["abstract"] for r in conn.execute(
        "SELECT abstract FROM documents WHERE abstract IS NOT NULL ORDER BY id LIMIT 20")]
    batch = []
    for i in range(count):
        paper = seed._paper(rng, 10_000_000 + i, today)
        if i < len(held):
            copied = held[i].split()[10:70]
            paper = dataclasses.replace(paper, abstract=" ".join(copied) + " " + paper.abstract)
        batch.append(paper)
    normalizer.deduplicate_batch(conn, batch)
    conn.commit()
    conn.close()


def measure(work: Path, cache: Path, sizes: list[int], say: Callable[[str], None]) -> list[dict]:
    metrics: list[dict] = []
    for papers in sizes:
        source = seed.cached(cache, papers=papers)
        corpus = work / f"wording-{papers}.db"
        with sqlite3.connect(source) as src, sqlite3.connect(corpus) as dst:
            src.backup(dst)
        label = f"{papers // 1000}k"
        full = _child(corpus, "full")
        say(f"shared wording, full scan of {papers:,} papers: {full['seconds']} s, "
            f"peak {full['rss_peak_mb']} MB (interpreter and modules {full['rss_before_mb']} MB); "
            f"{full['compared']:,} compared, {full['pairs']:,} pairs")
        _add_new_papers(corpus, NEW_PAPERS)
        new = _child(corpus, "new")
        say(f"shared wording, {NEW_PAPERS} new papers against {papers:,}: {new['seconds']} s, "
            f"peak {new['rss_peak_mb']} MB; {new['pairs']:,} pairs")
        for kind, sample in (("full", full), ("new", new)):
            metrics.append({"name": f"wording.{kind}@{label}", "unit": "s", "direction": "lower",
                            "samples": [sample["seconds"]], "detail": sample})
            metrics.append({"name": f"wording.{kind}.peak_rss@{label}", "unit": "MB", "direction": "lower",
                            "samples": [sample["rss_peak_mb"]], "detail": sample})
    return metrics


if __name__ == "__main__" and len(sys.argv) == 4 and sys.argv[1] == "child":
    child(sys.argv[2], sys.argv[3])
