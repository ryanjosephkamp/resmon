"""A large collection, measured where its size shows: counts, rankings, exports, and the long list.

``python -m perf scale`` builds (or reuses) a seeded collection of 100,000
papers with a 768-dimension vector each, and measures, against an isolated
engine over a copy of it:

- **Counting.** Each query of :data:`COUNT_QUERIES` as Search › Your collection
  asks it: the first page, which counts every match, and the second, which
  reuses that count; and the count alone, timed in this process on the same
  copy (``explorer.count_where`` under its budget). Every count must come back
  exact, or the run says which did not.
- **Ranking by meaning.** The first page of a ranking of every paper (embedding
  the phrase through the loopback fake, so resmon's side is timed) and a later
  page, which slices the first page's ranking.
- **Exporting.** Every paper as BibTeX, RIS, and CSV through
  ``POST /api/explorer/export``, read to the end and thrown away, while the
  engine's resident memory is sampled every 20 ms: the peak, the engine before
  the export, and the file's size and time. For comparison, the same file built
  whole in memory, as the export was before it streamed (every document read,
  then the text joined), in a child interpreter of its own, measured by its
  peak resident size against the same interpreter before it read anything.
- **The long list.** ``frontend/perf/scroll.perf.ts``, through Playwright: the
  app opened isolated over a copy, ``--rows`` rows read into Search › Your
  collection's list, then the list scrolled at a steady speed with each frame
  timed. Needs ``npm run build`` first.

Results go to ``--out`` as ``results.json`` and ``summary.md``. Numbers are
specific to the machine; the seeded text means nothing, so they are cost, not
findings.
"""

from __future__ import annotations

import json
import os
import shutil
import sqlite3
import statistics
import subprocess
import sys
import tempfile
import threading
import time
from pathlib import Path
from typing import Callable, Optional

from . import instance, seed, stats
from .embedder import FakeEmbedder

PAPERS = 100_000
DIMS = 768
FORMATS = ("bibtex", "ris", "csv")

COUNT_QUERIES = {
    # The whole collection, unfiltered: the first screen.
    "browse": {},
    # Words that nearly every paper holds: the largest walk a word search makes.
    "broad_words": {"query": "model"},
    # A phrase a few thousand papers hold.
    "phrase": {"query": "graph neural"},
    # A category, which reads the normalized table for every paper.
    "category": {"categories": ["cs.LG"]},
    # Two categories and a date floor.
    "categories_since": {"categories": ["cs.LG", "stat.ML"], "date_from": "2025-01-01"},
    # Words, two sources, and a date floor: a narrowed search.
    "narrowed": {"query": "protein folding", "sources": ["pubmed", "europepmc"], "date_from": "2025-06-01"},
    # One author.
    "author": {"authors": ["Ada Bauer"]},
}

Progress = Callable[[str], None]


def _median(values: list[float]) -> float:
    return statistics.median(values) if values else float("nan")


def _rss_mb(pid: int) -> Optional[float]:
    out = subprocess.run(["ps", "-o", "rss=", "-p", str(pid)], capture_output=True, text=True).stdout.strip()
    return int(out) / 1024 if out else None


class _Sampler:
    """The resident memory of one process, every *interval* seconds, until stopped."""

    def __init__(self, pid: int, interval: float = 0.02) -> None:
        self.pid, self.interval, self.samples = pid, interval, []
        self._stop = threading.Event()
        self._thread = threading.Thread(target=self._run, daemon=True)

    def _run(self) -> None:
        while not self._stop.is_set():
            value = _rss_mb(self.pid)
            if value is not None:
                self.samples.append(value)
            self._stop.wait(self.interval)

    def __enter__(self) -> "_Sampler":
        self._thread.start()
        return self

    def __exit__(self, *_exc) -> None:
        self._stop.set()
        self._thread.join()


def counts(backend: instance.Backend, db: Path, repeats: int, say: Progress) -> list[dict]:
    from implementation_scripts import explorer  # noqa: PLC0415 - perf imports resmon lazily

    rows = []
    conn = sqlite3.connect(f"file:{db}?mode=ro", uri=True)
    conn.row_factory = sqlite3.Row
    try:
        with backend.client() as client:
            for label, filters in COUNT_QUERIES.items():
                first_ms, next_ms, total, exact = [], [], None, None
                for _ in range(repeats):
                    started = time.perf_counter()
                    page = client.post("/api/explorer/search", json={**filters, "limit": 50})
                    page.raise_for_status()
                    first_ms.append((time.perf_counter() - started) * 1000)
                    body = page.json()
                    total, exact = body["total"], body["total_is_exact"]
                    if body.get("next_cursor"):
                        started = time.perf_counter()
                        client.post("/api/explorer/search", json={**filters, "limit": 50,
                                                                  "cursor": body["next_cursor"]}).raise_for_status()
                        next_ms.append((time.perf_counter() - started) * 1000)
                where, params, _ = explorer._build_where(
                    conn, query=filters.get("query"), sources=filters.get("sources"),
                    authors=filters.get("authors"), categories=filters.get("categories"),
                    date_from=filters.get("date_from"), date_to=filters.get("date_to"))
                count_ms = []
                for _ in range(repeats):
                    started = time.perf_counter()
                    counted = explorer.count_where(conn, where, params, budget_s=explorer.COUNT_BUDGET_S)
                    count_ms.append((time.perf_counter() - started) * 1000)
                rows.append({"query": label, "filters": filters, "total": total, "exact": exact,
                             "count_exact_in_process": counted.exact,
                             "count_ms": _median(count_ms), "count_ms_max": max(count_ms),
                             "first_page_ms": _median(first_ms), "first_page_ms_max": max(first_ms),
                             "next_page_ms": _median(next_ms) if next_ms else None})
                say(f"count {label}: {total:,} ({'exact' if exact else 'NOT exact'}), "
                    f"count {rows[-1]['count_ms']:.0f} ms, first page {rows[-1]['first_page_ms']:.0f} ms, "
                    f"next page {rows[-1]['next_page_ms'] or 0:.0f} ms")
    finally:
        conn.close()
    return rows


def ranking(backend: instance.Backend, repeats: int, say: Progress) -> dict:
    with FakeEmbedder(DIMS) as model:
        backend.put("/api/settings/embeddings", {"settings": {
            "embedding_enabled": "true", "embedding_provider": "local",
            "embedding_model": seed.EMBEDDING_MODEL, "embedding_endpoint": model.url,
        }})
        probe = backend.post("/api/embeddings/probe", {})
        if not probe.get("ok"):
            raise RuntimeError(f"the embedding probe failed: {probe}")
        first_ms, later_ms, body = [], [], {}
        with backend.client() as client:
            for n in range(repeats):
                phrase = f"graph neural networks on molecules {n}"  # a new phrase is a new ranking
                started = time.perf_counter()
                response = client.post("/api/explorer/search", json={"query": phrase, "sort": "similarity", "limit": 50})
                response.raise_for_status()
                first_ms.append((time.perf_counter() - started) * 1000)
                body = response.json()
                if body.get("similarity_unavailable"):
                    raise RuntimeError(body["similarity_unavailable"])
                started = time.perf_counter()
                client.post("/api/explorer/search", json={"query": phrase, "sort": "similarity", "limit": 50,
                                                          "cursor": "5000"}).raise_for_status()
                later_ms.append((time.perf_counter() - started) * 1000)
    out = {"total": body.get("total"), "ranked": body.get("ranked_count"), "unranked": body.get("unranked_count"),
           "first_page_ms": _median(first_ms), "first_page_ms_max": max(first_ms),
           "later_page_ms": _median(later_ms), "later_page_ms_max": max(later_ms)}
    say(f"ranking: {out['ranked']:,} ranked of {out['total']:,}; first page {out['first_page_ms']:.0f} ms, "
        f"page at row 5,000 {out['later_page_ms']:.0f} ms")
    return out


def exports(backend: instance.Backend, say: Progress) -> list[dict]:
    rows = []
    pid = backend.proc.pid
    with backend.client(timeout=600.0) as client:
        # Once, unmeasured, so the engine's first export does not carry its imports.
        client.post("/api/explorer/export", json={"format": "csv", "sources": ["arxiv"], "date_from": "2026-01-01"}).read()
        for fmt in FORMATS:
            time.sleep(1.0)
            before = _rss_mb(pid) or 0.0
            size = 0
            started = time.perf_counter()
            with _Sampler(pid) as sampler:
                with client.stream("POST", "/api/explorer/export", json={"format": fmt}) as response:
                    response.raise_for_status()
                    said = int(response.headers["X-Resmon-Document-Count"])
                    for piece in response.iter_bytes():
                        size += len(piece)
            seconds = time.perf_counter() - started
            peak = max(sampler.samples or [before])
            rows.append({"format": fmt, "papers": said, "bytes": size, "seconds": seconds,
                         "engine_before_mb": before, "engine_peak_mb": peak, "rise_mb": peak - before,
                         "samples": len(sampler.samples)})
            say(f"export {fmt}: {said:,} papers, {size / 2**20:.0f} MB in {seconds:.1f} s; "
                f"engine {before:.0f} MB before, peak {peak:.0f} MB (+{peak - before:.0f})")
    return rows


_IN_MEMORY = r"""
import json, resource, sqlite3, sys
sys.path.insert(0, sys.argv[1])
from implementation_scripts import reference_export
from implementation_scripts.database import get_documents_by_ids
def rss():
    return resource.getrusage(resource.RUSAGE_SELF).ru_maxrss / (2**20 if sys.platform == "darwin" else 2**10)
conn = sqlite3.connect(sys.argv[2]); conn.row_factory = sqlite3.Row
before = rss()
ids = [r[0] for r in conn.execute("SELECT id FROM documents ORDER BY pub_sort DESC, id DESC")]
documents = get_documents_by_ids(conn, ids)
text, _media, _ext = reference_export.render(documents, sys.argv[3])
print(json.dumps({"papers": len(documents), "bytes": len(text.encode("utf-8")), "before_mb": before, "peak_mb": rss()}))
"""


def in_memory(db: Path, say: Progress) -> list[dict]:
    """Each file built whole, as the export was built before it streamed, in a child of its own."""
    rows = []
    scripts = Path(__file__).resolve().parent.parent
    for fmt in FORMATS:
        out = subprocess.run([sys.executable, "-c", _IN_MEMORY, str(scripts), str(db), fmt],
                             capture_output=True, text=True, check=True).stdout
        row = {"format": fmt, **json.loads(out)}
        row["rise_mb"] = row["peak_mb"] - row["before_mb"]
        rows.append(row)
        say(f"built whole in memory, {fmt}: peak {row['peak_mb']:.0f} MB (+{row['rise_mb']:.0f} over the interpreter)")
    return rows


def scroll(corpus: Path, rows: int, runs: int, work: Path, frontend: Path, say: Progress) -> dict:
    out_file = work / "scroll.json"
    env = {**os.environ, "RESMON_PERF_SCROLL_CORPUS": str(corpus), "RESMON_PERF_SCROLL_OUT": str(out_file),
           "RESMON_PERF_SCROLL_ROWS": str(rows), "RESMON_PERF_RUNS": str(runs),
           "RESMON_PERF_WORK": str(work / "ui"), "RESMON_PYTHON": sys.executable}
    say(f"the long list: {runs} launches, {rows:,} rows read, then scrolled")
    subprocess.run(["npx", "playwright", "test", "--config", "perf/playwright.config.ts", "perf/scroll.perf.ts"],
                   cwd=frontend, env=env, check=True)
    result = json.loads(out_file.read_text())
    for sample in result["samples"]:
        say(f"  {sample['rowsRead']:,} rows read in {sample['readMs'] / 1000:.1f} s; {sample['frames']} frames, "
            f"p50 {sample['frameP50']:.1f} ms, p95 {sample['frameP95']:.1f} ms, max {sample['frameMax']:.0f} ms, "
            f"{sample['framesOver16_7']:.1%} over 17.7 ms, {sample['framesLate']:.1%} late; "
            f"{sample['domRowsAfter']} rows in the page; {sample['readLongTasks']} long tasks reading "
            f"(longest {sample['readLongestTaskMs']:.0f} ms), {sample['scrollLongTasks']} scrolling")
    return result


def run(args, say: Progress) -> int:
    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    work = Path(tempfile.mkdtemp(prefix="resmon-perf-scale-"))
    corpus = seed.cached(Path(args.cache), papers=args.papers, embed_dims=DIMS)
    only = set(args.only.split(",")) if args.only else {"engine", "ui"}
    results: dict = {"environment": stats.environment(seed_root()), "corpus": json.loads(
        corpus.with_suffix(".manifest.json").read_text())}
    try:
        if "engine" in only:
            state = instance.fresh_state(work, "scale", seed_db=corpus)
            backend = instance.start_backend(state)
            try:
                results["counts"] = counts(backend, state / "resmon.db", args.repeats, say)
                results["ranking"] = ranking(backend, args.repeats, say)
                results["exports"] = exports(backend, say)
            finally:
                backend.stop()
            results["exports_built_in_memory"] = in_memory(state / "resmon.db", say)
        if "ui" in only:
            results["scroll"] = scroll(corpus, args.rows, args.ui_runs, work, Path(args.frontend), say)
    finally:
        if not args.keep_work:
            shutil.rmtree(work, ignore_errors=True)
    instance.write_json(out / "results.json", results)
    (out / "summary.md").write_text(summary(results), encoding="utf-8")
    say(f"wrote {out / 'results.json'} and {out / 'summary.md'}")
    return 0


def seed_root() -> Path:
    return Path(__file__).resolve().parent.parent.parent


def summary(results: dict) -> str:
    lines = ["# resmon at scale", ""]
    corpus = results.get("corpus", {})
    lines.append(f"{corpus.get('counts', {}).get('documents', 0):,} papers, "
                 f"{corpus.get('counts', {}).get('document_embeddings', 0):,} with a {corpus.get('embed_dims')}-dimension vector.")
    if results.get("counts"):
        lines += ["", "## Counting", "", "| Query | Matches | Exact | Count | First page | Next page |",
                  "|---|---:|---|---:|---:|---:|"]
        for r in results["counts"]:
            lines.append(f"| {r['query']} | {r['total']:,} | {'yes' if r['exact'] else 'no'} | {r['count_ms']:.0f} ms | "
                         f"{r['first_page_ms']:.0f} ms | {(r['next_page_ms'] or 0):.0f} ms |")
    if results.get("ranking"):
        r = results["ranking"]
        lines += ["", "## Ranking by meaning", "",
                  f"{r['ranked']:,} of {r['total']:,} ranked. First page {r['first_page_ms']:.0f} ms "
                  f"(max {r['first_page_ms_max']:.0f}); the page at row 5,000 {r['later_page_ms']:.0f} ms."]
    if results.get("exports"):
        lines += ["", "## Exporting every paper", "",
                  "| Format | Papers | File | Time | Engine before | Engine peak | Built whole in memory, peak rise |",
                  "|---|---:|---:|---:|---:|---:|---:|"]
        whole = {r["format"]: r for r in results.get("exports_built_in_memory", [])}
        for r in results["exports"]:
            w = whole.get(r["format"], {})
            lines.append(f"| {r['format']} | {r['papers']:,} | {r['bytes'] / 2**20:.0f} MB | {r['seconds']:.1f} s | "
                         f"{r['engine_before_mb']:.0f} MB | {r['engine_peak_mb']:.0f} MB (+{r['rise_mb']:.0f}) | "
                         f"+{w.get('rise_mb', float('nan')):.0f} MB |")
    if results.get("scroll"):
        lines += ["", "## The long list", "",
                  "| Rows read | Read in | Long tasks reading (longest) | Frames | p50 | p95 | p99 | Max | Late | "
                  "Over 17.7 ms | Long tasks scrolling | Rows in the page |",
                  "|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|"]
        for s in results["scroll"]["samples"]:
            lines.append(f"| {s['rowsRead']:,} | {s['readMs'] / 1000:.1f} s | {s['readLongTasks']} "
                         f"({s['readLongestTaskMs']:.0f} ms) | {s['frames']} | {s['frameP50']:.1f} ms | "
                         f"{s['frameP95']:.1f} ms | {s['frameP99']:.1f} ms | {s['frameMax']:.0f} ms | "
                         f"{s['framesLate']:.1%} | {s['framesOver16_7']:.1%} | {s['scrollLongTasks']} | "
                         f"{s['domRowsAfter']} |")
    return "\n".join(lines) + "\n"
