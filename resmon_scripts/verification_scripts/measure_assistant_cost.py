#!/usr/bin/env python3
"""What a turn of the assistant costs, measured against the real CLI.

**Not a test.** Opt-in, drives the installed ``claude``, and spends the user's
own subscription window. Deliberately not collected by pytest — no ``test_``
prefix, and it takes minutes.

    .venv/bin/python resmon_scripts/verification_scripts/measure_assistant_cost.py \\
        --out workspace/handbacks/2.0/evidence/assistant-cost.md

Why it exists. The MCP contract makes token efficiency a *contract term* rather
than an aspiration: "a harness asking what did my arXiv routine find this week
must not cost a five-hour usage window." Phase 2.0's decision 4c says the same
thing about the assistant and adds the only honest way to hold it — **measure,
then set the ceiling from the measurement**, which is the method 1.8.5's flip
gate used after its first version thresholded the wrong quantity.

So this script does not assert anything. It runs ten canonical requests against
a real backend seeded with a small corpus, reports tokens, cost and tool calls
per request, and prints the ceiling its own numbers justify.
``test_assistant_budget.py`` is where that ceiling becomes a guard.

**What the numbers are not.** One machine, one account, one model, one day, and
one run per request — no repetition, so the spread between the cheapest and the
dearest request is the only variance figure here. A ceiling set from this is a
regression guard, not a performance claim, and the file it writes says so.
"""

from __future__ import annotations

import argparse
import json
import os
import socket
import statistics
import subprocess
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

import httpx

PROJECT_ROOT = Path(__file__).resolve().parent.parent.parent
sys.path.insert(0, str(PROJECT_ROOT / "resmon_scripts"))

from implementation_scripts import ai_cli  # noqa: E402

# The ten. Chosen to span what a person actually opens the panel for rather than
# to be uniform: three reads that need one tool, three that need several, two
# that need a write (and are denied, so the measurement is of the *asking*), and
# two that resmon should refuse outright. The refusals are in the set on
# purpose — an assistant that spends a fortune saying "I can't do that here" is
# the expensive failure nobody thinks to measure.
REQUESTS: list[tuple[str, str]] = [
    ("health", "Is resmon running, and what version?"),
    ("routines", "What monitoring routines do I have?"),
    ("sources", "Which sources can resmon search, and which need a key I have not added?"),
    ("last-run", "What did my most recent run find?"),
    ("search", "Find papers in my corpus about graphene."),
    ("why-zero", "Did any source return nothing last run, and did it say why?"),
    ("export", "Export the references from my last run as BibTeX."),
    ("create-routine", "Set up a weekly arXiv routine on quantum error correction."),
    ("activate", "Turn on the routine you just created."),
    ("refused", "Delete every paper in my corpus."),
]


def _free_port() -> int:
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        return sock.getsockname()[1]


def _start_backend(state: Path, cli_path: str) -> tuple[subprocess.Popen, str]:
    port = _free_port()
    env = {
        **os.environ,
        "RESMON_DB_PATH": str(state / "resmon.db"),
        "RESMON_REPORTS_DIR": str(state / "reports"),
        "RESMON_PORT_FILE": str(state / "resmon.port"),
        "RESMON_DISABLE_SCHEDULER": "1",
        "RESMON_PORT": str(port),
        "PYTHONPATH": str(PROJECT_ROOT / "resmon_scripts"),
    }
    proc = subprocess.Popen(
        [sys.executable, str(PROJECT_ROOT / "resmon_scripts" / "resmon.py"), str(port)],
        env=env, stdout=subprocess.DEVNULL, stderr=subprocess.STDOUT,
        cwd=str(PROJECT_ROOT),
    )
    base = f"http://127.0.0.1:{port}"
    deadline = time.monotonic() + 60
    while time.monotonic() < deadline:
        try:
            if httpx.get(f"{base}/api/health", timeout=1.0).status_code == 200:
                break
        except httpx.HTTPError:
            time.sleep(0.3)
    else:
        raise SystemExit("the backend did not start")
    httpx.put(f"{base}/api/settings/ai",
              json={"settings": {"ai_cli_path": cli_path}}, timeout=20)
    return proc, base


def _seed(base: str) -> None:
    """A small real corpus, so the questions have something to answer about."""
    httpx.post(f"{base}/api/routines", json={
        "name": "Quantum error correction (weekly)",
        "schedule_cron": "0 9 * * 1",
        "parameters": {"query": "quantum error correction", "repositories": ["arxiv"]},
        "is_active": False,
    }, timeout=30)
    started = httpx.post(f"{base}/api/search/sweep", json={
        "repositories": ["arxiv"], "query": "graphene", "max_results": 5,
    }, timeout=60)
    if started.status_code != 200:
        print(f"  (could not seed a corpus: {started.status_code}); questions about "
              f"papers will be answered honestly as 'nothing there'")
        return
    exec_id = started.json()["execution_id"]
    deadline = time.monotonic() + 180
    while time.monotonic() < deadline:
        row = httpx.get(f"{base}/api/executions/{exec_id}", timeout=20).json()
        if row.get("status") in ("completed", "failed"):
            return
        time.sleep(1.0)


def _run(base: str, label: str, prompt: str) -> dict:
    """One turn, denying every permission card, and what it cost."""
    session = httpx.post(f"{base}/api/assistant/sessions", json={}, timeout=30).json()
    events: list[dict] = []
    started = time.monotonic()
    with httpx.stream("POST",
                      f"{base}/api/assistant/sessions/{session['id']}/messages",
                      json={"text": prompt}, timeout=600) as response:
        for line in response.iter_lines():
            if not line.startswith("data: "):
                continue
            event = json.loads(line[6:])
            events.append(event)
            if event.get("type") == "permission_request":
                # Denied, always. What is being measured is the cost of the
                # assistant working out what to propose, which is the part that
                # happens whichever way the person answers.
                httpx.post(
                    f"{base}/api/assistant/permissions/{event['request_id']}",
                    json={"allow": False, "reason": "measurement run"}, timeout=30)
            if event.get("type") == "closed":
                break
    elapsed = time.monotonic() - started

    done = next((e for e in events if e["type"] == "done"), {})
    errors = [e for e in events if e["type"] == "error"]
    return {
        "label": label,
        "prompt": prompt,
        "seconds": round(elapsed, 1),
        "tool_calls": len([e for e in events if e["type"] == "tool_call"]),
        "cards": len([e for e in events if e["type"] == "permission_request"]),
        "input_tokens": done.get("input_tokens"),
        "output_tokens": done.get("output_tokens"),
        "cache_read_tokens": done.get("cache_read_tokens"),
        "cost_usd": done.get("cost_usd"),
        "error": errors[0]["message"] if errors else None,
        "reply_chars": len("".join(e["text"] for e in events if e["type"] == "text_delta")),
    }


def _table(rows: list[dict]) -> str:
    costs = [r["cost_usd"] for r in rows if r["cost_usd"] is not None]
    out = [
        "# What a turn of the resmon assistant costs",
        "",
        f"Measured {datetime.now(timezone.utc).strftime('%Y-%m-%d')} against the "
        "installed `claude` CLI, one run per request, on one machine and one "
        "account. **A ceiling set from this is a regression guard, not a "
        "performance claim.**",
        "",
        "Every permission card was denied, so what is measured is the cost of "
        "the assistant working out what to propose — the part that happens "
        "whichever way the person answers.",
        "",
        "| Request | Tools | Cards | In | Out | Cache read | Cost | Seconds |",
        "|---|---|---|---|---|---|---|---|",
    ]
    for row in rows:
        cost = f"${row['cost_usd']:.4f}" if row["cost_usd"] is not None else "not reported"
        out.append(
            f"| {row['label']} | {row['tool_calls']} | {row['cards']} | "
            f"{row['input_tokens'] if row['input_tokens'] is not None else '—'} | "
            f"{row['output_tokens'] if row['output_tokens'] is not None else '—'} | "
            f"{row['cache_read_tokens'] if row['cache_read_tokens'] is not None else '—'} | "
            f"{cost} | {row['seconds']} |")

    out += ["", "## What the numbers say", ""]
    if costs:
        out += [
            f"- **{len(costs)} of {len(rows)}** requests reported a cost. The rest are "
            "recorded as *not reported*, not as zero.",
            f"- Median **${statistics.median(costs):.4f}**, dearest "
            f"**${max(costs):.4f}** ({max(rows, key=lambda r: r['cost_usd'] or 0)['label']}), "
            f"cheapest **${min(costs):.4f}**.",
            f"- Ten turns in one sitting: **${sum(costs):.4f}**.",
            "",
            "## The ceiling this sets",
            "",
            f"**${max(costs) * 2:.4f} per turn** — twice the dearest request measured. "
            "Twice rather than the measured maximum, because one run per request "
            "gives no variance figure and a guard that fires on ordinary "
            "variation is a guard that gets deleted. It is a regression detector: "
            "a change that doubles what the dearest question costs fails it, and "
            "`test_assistant_budget.py` is where it is asserted.",
        ]
    else:
        out += ["- **No request reported a cost.** The ceiling cannot be set from this "
                "run, and `test_assistant_budget.py` says so rather than guessing one."]

    failed = [r for r in rows if r["error"]]
    if failed:
        out += ["", "## Requests that failed", ""]
        out += [f"- **{r['label']}** — {r['error']}" for r in failed]
    return "\n".join(out) + "\n"


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--out", type=Path, help="write the Markdown table here")
    parser.add_argument("--json", type=Path, help="write the raw rows here")
    parser.add_argument("--only", nargs="*", help="run only these labels")
    args = parser.parse_args()

    found = ai_cli.discover_cli("claude_code")
    if not found.found:
        raise SystemExit("no claude CLI found; nothing to measure")
    print(f"claude: {found.path}")

    import tempfile  # noqa: PLC0415

    with tempfile.TemporaryDirectory(prefix="resmon-cost-") as state:
        proc, base = _start_backend(Path(state), found.path)
        try:
            print("seeding a small corpus…")
            _seed(base)
            rows = []
            wanted = [r for r in REQUESTS if not args.only or r[0] in args.only]
            for index, (label, prompt) in enumerate(wanted, start=1):
                print(f"[{index}/{len(wanted)}] {label}: {prompt}")
                row = _run(base, label, prompt)
                cost = ("not reported" if row["cost_usd"] is None
                        else f"${row['cost_usd']:.4f}")
                print(f"    {row['tool_calls']} tool call(s), {cost}, "
                      f"{row['seconds']}s"
                      + (f" — ERROR: {row['error']}" if row["error"] else ""))
                rows.append(row)
        finally:
            proc.terminate()
            try:
                proc.wait(timeout=20)
            except subprocess.TimeoutExpired:
                proc.kill()

    table = _table(rows)
    print("\n" + table)
    if args.out:
        args.out.parent.mkdir(parents=True, exist_ok=True)
        args.out.write_text(table, encoding="utf-8")
        print(f"wrote {args.out}")
    if args.json:
        args.json.parent.mkdir(parents=True, exist_ok=True)
        args.json.write_text(json.dumps(rows, indent=2), encoding="utf-8")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
