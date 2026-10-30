"""``python -m perf`` from ``resmon_scripts/``.

    run      every measurement; writes results.json and summary.md to --out
    soak     the background service running routines for --hours
    host     the background service as the bare engine and as the app, alternated
    wording  a shared-wording scan, full and of new papers, timed with its peak memory
    record   record the benchmark sweep's replies from the live sources
    seed     build a seeded corpus (run builds the ones it needs itself)
    compare  a candidate's results.json against a baseline's, by the gate

``perf/README.md`` is the guide.
"""

from __future__ import annotations

import argparse
import json
import math
import os
import shutil
import subprocess
import sys
import tempfile
import time
from pathlib import Path

from . import engine, host, instance, seed, size, soak, stats, wording

SCRIPTS = Path(__file__).resolve().parent.parent
REPO = SCRIPTS.parent
FRONTEND = SCRIPTS / "frontend"
DEFAULT_CACHE = Path(tempfile.gettempdir()) / "resmon-perf-cache"

UI_CORPUS_PAPERS = 10_000
SEMANTIC_DIMS = 768


def _say(message: str) -> None:
    print(f"[perf {time.strftime('%H:%M:%S')}] {message}", flush=True)


def _ui(args: argparse.Namespace, corpus: Path, work: Path) -> tuple[list[dict], dict]:
    """Run the Playwright half and turn its samples into metrics."""
    out_file = work / "ui.json"
    env = {**os.environ,
           "RESMON_PERF_RUNS": str(args.ui_runs),
           "RESMON_PERF_CORPUS": str(corpus),
           "RESMON_PERF_OUT": str(out_file),
           "RESMON_PERF_WORK": str(work / "ui"),
           "RESMON_PERF_IDLE_SECONDS": str(args.idle_seconds)}
    if args.executable:
        env["RESMON_PERF_EXECUTABLE"] = str(args.executable)
        env.pop("RESMON_PYTHON", None)
    else:
        env["RESMON_PERF_FRONTEND"] = str(args.frontend)
        env["RESMON_PYTHON"] = sys.executable
    _say(f"interface: {args.ui_runs} launches of "
         f"{args.executable or args.frontend} over {UI_CORPUS_PAPERS:,} papers")
    subprocess.run(["npx", "playwright", "test", "--config", "perf/playwright.config.ts"],
                   cwd=FRONTEND, env=env, check=True)
    raw = json.loads(out_file.read_text())
    samples = raw["samples"]
    metrics = [
        stats.metric("launch.cold", "ms", [s["launchCold"] for s in samples],
                     note="Process start to the first screen settled, with a fresh profile and "
                          "a database this app had not opened. The OS file cache is warm."),
        stats.metric("launch.warm", "ms", [s["launchWarm"] for s in samples],
                     note="The same, relaunched over the same profile and database."),
        stats.metric("launch.first_window", "ms", [s["firstWindowCold"] for s in samples],
                     note="Process start to the first window existing (cold)."),
    ]
    for route in raw["routes"]:
        values = [s["navigation"][route["hash"]] for s in samples if route["hash"] in s["navigation"]]
        metrics.append(stats.metric(f"navigation.{route['hash']}", "ms", values,
                                    note=f"{route['name']}: hash change to settled."))
    roles = sorted({role for s in samples for role in s["memoryMb"]})
    for role in roles:
        metrics.append(stats.metric(f"memory.app.idle.{role}", "MB",
                                    [s["memoryMb"].get(role, 0.0) for s in samples]))
    for role in sorted({role for s in samples for role in s["idleCpuPercent"]}):
        metrics.append(stats.metric(f"cpu.app.idle.{role}", "% of one core",
                                    [s["idleCpuPercent"].get(role, 0.0) for s in samples]))
    return metrics, raw


def cmd_run(args: argparse.Namespace) -> int:
    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    work = Path(tempfile.mkdtemp(prefix="resmon-perf-"))
    cache = Path(args.cache)
    only = set(args.only.split(",")) if args.only else {"engine", "ui", "size", "service"}
    env = stats.environment(REPO)
    _say(f"commit {env['commit'][:10]} on {env.get('model', env['machine'])}; work in {work}")
    metrics: list[dict] = []
    extra: dict = {"environment": env, "problems": [], "inputs": {}}
    try:
        corpus_10k = seed.cached(cache, papers=UI_CORPUS_PAPERS, embed_dims=SEMANTIC_DIMS)
        extra["inputs"]["corpus_10k"] = json.loads(corpus_10k.with_suffix(".manifest.json").read_text())
        if "engine" in only:
            replies = Path(args.replies)
            index = json.loads((replies / "index.json").read_text())
            extra["inputs"]["replies"] = {
                "dir": str(replies), "requests": sum(len(v) for v in index.values()),
                "recorded_latency_s": round(sum(e["elapsed_ms"] for v in index.values() for e in v) / 1000, 2),
            }
            metrics += engine.backend_start(work, corpus_10k, args.runs, _say)
            metrics += engine.sweep(work, corpus_10k, replies, args.runs, _say)
            metrics += engine.explorer(work, corpus_10k, "10k", args.repeats, _say)
            corpus_100k = seed.cached(cache, papers=100_000)
            extra["inputs"]["corpus_100k"] = json.loads(corpus_100k.with_suffix(".manifest.json").read_text())
            metrics += engine.explorer(work, corpus_100k, "100k", args.repeats, _say)
            metrics += engine.semantic(work, corpus_10k, SEMANTIC_DIMS, args.repeats, _say)
        if "service" in only:
            metrics += engine.service(work, corpus_10k, _say)
        if "ui" in only:
            ui_metrics, raw = _ui(args, corpus_10k, work)
            metrics += ui_metrics
            extra["problems"] += raw.get("problems", [])
        if "size" in only:
            installers = [Path(p) for p in (args.installer or [])]
            metrics += size.measure(Path(args.frontend), Path(args.app_bundle) if args.app_bundle else None,
                                    installers)
    finally:
        if not args.keep_work:
            shutil.rmtree(work, ignore_errors=True)
    results = {**extra, "metrics": metrics}
    instance.write_json(out / "results.json", results)
    (out / "summary.md").write_text(render_summary(results), encoding="utf-8")
    _say(f"wrote {out / 'results.json'} and {out / 'summary.md'}")
    if extra["problems"]:
        _say("problems: " + "; ".join(extra["problems"]))
        return 1
    return 0


def _fmt(value: float, unit: str) -> str:
    if value is None or (isinstance(value, float) and math.isnan(value)):
        return "–"
    if unit == "ms":
        return f"{value:,.0f}"
    if unit in ("MB", "results/s"):
        return f"{value:,.1f}"
    return f"{value:,.2f}"


def render_summary(results: dict) -> str:
    env = results["environment"]
    lines = [
        "# resmon performance run",
        "",
        f"- **Commit:** `{env.get('commit', '')[:10]}` {env.get('commit_subject', '')}"
        + (" (working tree had changes)" if env.get("dirty") else ""),
        f"- **Machine:** {env.get('model', '')} · {env.get('cpu', env.get('machine', ''))} · "
        f"{int(env.get('memory_bytes') or 0) // 2**30} GB · macOS {env.get('macos', '')}",
        f"- **Taken:** {env.get('taken_at', '')}",
        "",
        "Median and 95th percentile of *n* samples. With ten samples or fewer the 95th "
        "percentile is close to the largest one.",
        "",
        "| Measurement | Median | p95 | n | Unit |",
        "|---|---:|---:|---:|---|",
    ]
    for m in results["metrics"]:
        lines.append(f"| `{m['name']}` | {_fmt(m['median'], m['unit'])} | "
                     f"{_fmt(m['p95'], m['unit'])} | {m['n']} | {m['unit']} |")
    notes = [(m["name"], m["note"]) for m in results["metrics"] if m.get("note")]
    if notes:
        lines += ["", "## What each measures", ""]
        lines += [f"- `{name}`: {note}" for name, note in notes]
    if results.get("problems"):
        lines += ["", "## Problems", ""] + [f"- {p}" for p in results["problems"]]
    return "\n".join(lines) + "\n"


def cmd_soak(args: argparse.Namespace) -> int:
    work = Path(tempfile.mkdtemp(prefix="resmon-soak-"))
    corpus = seed.cached(Path(args.cache), papers=UI_CORPUS_PAPERS, embed_dims=SEMANTIC_DIMS)
    try:
        if args.runs:
            result = soak.run_back_to_back(work, corpus, Path(args.replies), runs=args.runs,
                                           latency=args.latency, out=Path(args.out),
                                           progress=_say)
        else:
            result = soak.run(work, corpus, Path(args.replies), hours=args.hours,
                              out=Path(args.out), progress=_say)
    finally:
        shutil.rmtree(work, ignore_errors=True)
    _say(soak.describe(result))
    return 0


def cmd_host(args: argparse.Namespace) -> int:
    work = Path(tempfile.mkdtemp(prefix="resmon-host-"))
    corpus = seed.cached(Path(args.cache), papers=UI_CORPUS_PAPERS, embed_dims=SEMANTIC_DIMS)
    executable = [args.executable] if args.executable else None
    rounds = []
    try:
        # Alternated, so a drift in the machine's state over the sitting lands
        # on both forms rather than on whichever ran second.
        for number in range(args.rounds):
            for form in ("engine", "app"):
                result = host.measure(work, corpus, Path(args.replies), form=form,
                                      executable=executable, python=args.python, progress=_say)
                rounds.append({"round": number + 1, **result})
                instance.write_json(Path(args.out), {"rounds": rounds})
    finally:
        shutil.rmtree(work, ignore_errors=True)
    instance.write_json(Path(args.out), {"rounds": rounds, "summary": host.summarize(rounds)})
    _say(host.describe(host.summarize(rounds)))
    return 0


def cmd_wording(args: argparse.Namespace) -> int:
    work = Path(tempfile.mkdtemp(prefix="resmon-wording-"))
    try:
        metrics = wording.measure(work, Path(args.cache), [int(p) for p in args.papers.split(",")], _say)
    finally:
        shutil.rmtree(work, ignore_errors=True)
    instance.write_json(Path(args.out), {"environment": stats.environment(REPO), "metrics": metrics})
    _say(f"wrote {args.out}")
    return 0


def cmd_record(args: argparse.Namespace) -> int:
    replies = Path(args.replies)
    if (replies / "index.json").exists() and not args.force:
        _say(f"{replies} already holds recordings; pass --force to replace them")
        return 1
    shutil.rmtree(replies, ignore_errors=True)
    work = Path(tempfile.mkdtemp(prefix="resmon-record-"))
    try:
        state = instance.fresh_state(work, "record")
        backend = instance.start_backend(state, replay={"mode": "record", "dir": replies})
        try:
            exec_id = backend.post("/api/search/sweep", engine.SWEEP_BODY)["execution_id"]
            row, _events = instance.wait_for_execution(backend, exec_id)
        finally:
            backend.stop()
    finally:
        shutil.rmtree(work, ignore_errors=True)
    for source in row.get("coverage", {}).get("sources", []):
        _say(f"{source['source']}: {source['label']}, {source['result_count']}")
    _say(f"recorded into {replies}: {row.get('status')}, {row.get('result_count')} results")
    return 0


def cmd_seed(args: argparse.Namespace) -> int:
    path = seed.cached(Path(args.cache), papers=args.papers,
                       embed_dims=args.embed_dims or None)
    _say(f"{path}: " + path.with_suffix(".manifest.json").read_text())
    return 0


def cmd_compare(args: argparse.Namespace) -> int:
    baseline = json.loads(Path(args.baseline).read_text())
    candidate = json.loads(Path(args.candidate).read_text())
    rows = stats.compare(baseline, candidate)
    failing = 0
    for row in rows:
        if row["status"] == "not compared":
            print(f"NOT COMPARED  {row['name']}: {row.get('reason', 'no baseline value')}")
            continue
        parts = []
        for stat in ("median", "p95"):
            s = row.get(stat) or {}
            if s.get("change") is not None:
                parts.append(f"{stat} {_fmt(s['baseline'], row['unit'])} → "
                             f"{_fmt(s['candidate'], row['unit'])} ({s['change']:+.1%})")
        print(f"{row['status'].upper():<13} {row['name']}: {'; '.join(parts)}")
        failing += row["status"] == "fail"
    print(f"\n{failing} of {len(rows)} measurements fail the gate "
          f"(median worse by more than {stats.MEDIAN_TOLERANCE:.0%}, p95 by more than {stats.P95_TOLERANCE:.0%}).")
    return 1 if failing else 0


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="python -m perf")
    sub = parser.add_subparsers(dest="command", required=True)
    replies_default = os.environ.get("RESMON_PERF_REPLIES_DIR")

    run = sub.add_parser("run")
    run.add_argument("--out", required=True)
    run.add_argument("--replies", default=replies_default)
    run.add_argument("--cache", default=str(DEFAULT_CACHE))
    run.add_argument("--runs", type=int, default=7, help="backend starts and sweeps")
    run.add_argument("--repeats", type=int, default=20, help="samples per search")
    run.add_argument("--ui-runs", type=int, default=7)
    run.add_argument("--idle-seconds", type=int, default=20)
    run.add_argument("--executable", help="a packaged app's binary; default: the checkout's build")
    run.add_argument("--frontend", default=str(FRONTEND))
    run.add_argument("--app-bundle", help="the packaged .app, for size")
    run.add_argument("--installer", action="append", help="an installer file, for size")
    run.add_argument("--only", help="comma-separated: engine,service,ui,size")
    run.add_argument("--keep-work", action="store_true")
    run.set_defaults(func=cmd_run)

    sk = sub.add_parser("soak")
    by = sk.add_mutually_exclusive_group(required=True)
    by.add_argument("--hours", type=float, help="a routine every 3 minutes for this long")
    by.add_argument("--runs", type=int, help="this many runs, each started as the last ends")
    sk.add_argument("--latency", default="zero",
                    help="--runs only: recorded, zero, or a scale factor for the recordings' latency")
    sk.add_argument("--out", required=True)
    sk.add_argument("--replies", default=replies_default)
    sk.add_argument("--cache", default=str(DEFAULT_CACHE))
    sk.set_defaults(func=cmd_soak)

    hs = sub.add_parser("host")
    hs.add_argument("--rounds", type=int, default=5)
    hs.add_argument("--out", required=True)
    hs.add_argument("--replies", default=replies_default)
    hs.add_argument("--cache", default=str(DEFAULT_CACHE))
    hs.add_argument("--executable", help="a packaged app's binary; default: the checkout's Electron")
    hs.add_argument("--python", help="the bare engine's interpreter; give a packaged app's own runtime")
    hs.set_defaults(func=cmd_host)

    wd = sub.add_parser("wording")
    wd.add_argument("--papers", default="16061,100000", help="comma-separated corpus sizes")
    wd.add_argument("--out", required=True)
    wd.add_argument("--cache", default=str(DEFAULT_CACHE))
    wd.set_defaults(func=cmd_wording)

    rec = sub.add_parser("record")
    rec.add_argument("--replies", default=replies_default, required=replies_default is None)
    rec.add_argument("--force", action="store_true")
    rec.set_defaults(func=cmd_record)

    sd = sub.add_parser("seed")
    sd.add_argument("--papers", type=int, default=UI_CORPUS_PAPERS)
    sd.add_argument("--embed-dims", type=int, default=0)
    sd.add_argument("--cache", default=str(DEFAULT_CACHE))
    sd.set_defaults(func=cmd_seed)

    cmp_ = sub.add_parser("compare")
    cmp_.add_argument("baseline")
    cmp_.add_argument("candidate")
    cmp_.set_defaults(func=cmd_compare)

    args = parser.parse_args(argv)
    if getattr(args, "command", "") in ("run", "soak") and args.replies is None and (
            args.command == "soak" or "engine" in (args.only or "engine")):
        parser.error("--replies (or RESMON_PERF_REPLIES_DIR) is needed: see perf/README.md")
    return args.func(args)


if __name__ == "__main__":
    raise SystemExit(main())
