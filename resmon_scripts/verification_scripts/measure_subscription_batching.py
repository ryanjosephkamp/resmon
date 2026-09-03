#!/usr/bin/env python3
"""Measure what batching the subscription lane actually buys, and what it costs.

**This is not a test.** It is opt-in, it drives the real installed CLIs, and it
spends the user's Claude Max or ChatGPT window. It is deliberately not
collected by pytest — the filename has no ``test_`` prefix and it takes minutes
rather than milliseconds.

Run it::

    .venv/bin/python resmon_scripts/verification_scripts/measure_subscription_batching.py \\
        --database ~/path/to/resmon.db --sizes 5 10 25 --provider claude_code

Why it exists. Phase 1.8.5 makes the subscription lane the primary AI route,
and the order inside the phase is a constraint: repair, batch, **measure**,
flip. Flipping first would ship the slow path as the default. So the flip is
gated on numbers this script produces, and it reports them whether or not they
pass:

* **Speed** — median wall-clock per paper, batched against per-document. The
  gate is ≤ ¼ of per-document at the chosen size.
* **Leakage** — the accuracy risk batching introduces, and the reason this
  script exists at all rather than a stopwatch. Ten abstracts in one context
  is ten opportunities to carry a fact from paper three into paper seven's
  summary. Each synthetic canary abstract carries a unique invented token; a
  token appearing in another document's summary is leakage. The gate is 0.
* **Band compliance** — summaries inside the configured word-count band, which
  is the cheapest available proxy for "the summary is still a summary". The
  gate is no worse than the per-document run.
* **Fallback rate** — batches that could not be answered as a batch. The gate
  is ≤ 10 %.

The canaries matter more than the real abstracts for leakage. Papers from one
sweep are on one topic by construction, so a phrase shared between two real
summaries is not evidence of anything. An invented token can only have come
from the document that carried it.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sqlite3
import statistics
import sys
import time
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parent.parent.parent
sys.path.insert(0, str(PROJECT_ROOT / "resmon_scripts"))

from implementation_scripts.ai_cli import (  # noqa: E402
    SUPPORTED_CLI_PROVIDERS,
    discover_cli,
)
from implementation_scripts.ai_errors import AIError  # noqa: E402
from implementation_scripts.llm_subscription import SubscriptionLLMClient  # noqa: E402
from implementation_scripts.prompt_templates import length_band  # noqa: E402


# ---------------------------------------------------------------------------
# The canaries
# ---------------------------------------------------------------------------
#
# Ten synthetic abstracts, each carrying one invented token that exists nowhere
# else. They are written to be plausible and *mutually irrelevant*: a model
# summarizing them together has no honest reason to mention one in another's
# summary, so a token crossing over is leakage rather than a shared topic.

_CANARY_TOKENS = [
    "ZORVEX-4417", "QUILNAB-8823", "FREMDIS-1902", "TARLOQ-6635",
    "VYNDROS-7741", "KELBRAX-3308", "MORVITE-9954", "SUNTHEL-2260",
    "GRAVOSK-5176", "PILNARE-8034",
]

_CANARY_TEMPLATES = [
    "Title: Thermal drift in {t} lattice sensors\n\nAbstract: We characterise "
    "the thermal drift of {t}, a layered sensing lattice, across 240 hours of "
    "continuous operation. Drift was 0.4 mK per hour under nominal load and "
    "rose to 1.9 mK per hour above 340 K. We attribute the change to grain "
    "boundary migration and propose a compensation schedule.",

    "Title: A retrieval benchmark for {t} corpora\n\nAbstract: {t} is a "
    "collection of 1.2 million annotated procedural documents. We report "
    "baseline retrieval scores for sparse and dense methods and find that "
    "sparse retrieval remains competitive on procedural queries, contrary to "
    "results on general-domain corpora.",

    "Title: Population dynamics of the {t} beetle\n\nAbstract: Field surveys "
    "across eleven sites record the seasonal abundance of {t}, a ground beetle "
    "of temperate grassland. Abundance peaked in late June and correlated with "
    "soil moisture rather than with temperature. We find no evidence of the "
    "two-generation cycle reported for congeners.",

    "Title: {t}: a compiler pass for loop fusion\n\nAbstract: We present {t}, a "
    "compiler pass that fuses adjacent loops under a dependence test weaker "
    "than the standard one. On a suite of nineteen numerical kernels it reduces "
    "memory traffic by 22 % with no change in emitted arithmetic.",

    "Title: Crystallisation kinetics of the {t} polymorph\n\nAbstract: The {t} "
    "polymorph nucleates below 12 °C and converts irreversibly above 40 °C. We "
    "measure conversion rates by powder diffraction and fit an Avrami exponent "
    "of 2.1, consistent with two-dimensional growth from pre-existing nuclei.",

    "Title: Survey instrument validation for the {t} scale\n\nAbstract: The {t} "
    "scale measures self-reported procedural confidence in eight items. Across "
    "three samples the scale showed a single factor and acceptable internal "
    "consistency. Test-retest reliability over six weeks was moderate.",

    "Title: Orbital debris tracking with the {t} array\n\nAbstract: {t} is a "
    "phased radar array operating at 1.3 GHz. Over six months it produced "
    "orbital elements for 4,100 objects below 900 km. Position residuals were "
    "under 90 m for objects larger than 20 cm and degraded sharply below that.",

    "Title: Enzymatic degradation of {t} in soil columns\n\nAbstract: {t}, a "
    "synthetic ester, degraded with a half-life of 31 days in loam and 88 days "
    "in sand. Degradation was suppressed under anaerobic conditions. No "
    "persistent transformation products were detected above the reporting "
    "limit.",

    "Title: A fault model for the {t} interconnect\n\nAbstract: We propose a "
    "fault model for {t}, a chiplet interconnect, covering transient link "
    "errors and permanent lane failures. Simulation over synthetic traffic "
    "shows that lane sparing recovers 94 % of the lost bandwidth at a 3 % area "
    "cost.",

    "Title: Lexical change in the {t} manuscripts\n\nAbstract: The {t} "
    "manuscripts span roughly two centuries. We track the replacement of four "
    "lexical items and find that the change proceeds faster in legal than in "
    "devotional texts. Dating of three manuscripts remains uncertain.",
]


def canary_documents() -> list[tuple[str, str]]:
    """Return ``(token, document)`` pairs."""
    return [
        (token, template.format(t=token))
        for token, template in zip(_CANARY_TOKENS, _CANARY_TEMPLATES)
    ]


# ---------------------------------------------------------------------------
# Real abstracts
# ---------------------------------------------------------------------------

def real_documents(database: str, limit: int) -> list[str]:
    """Title + abstract for up to *limit* documents, exactly as the sweep builds them."""
    conn = sqlite3.connect(database)
    conn.row_factory = sqlite3.Row
    try:
        rows = conn.execute(
            """
            SELECT title, abstract FROM documents
             WHERE abstract IS NOT NULL AND length(abstract) > 400
             ORDER BY id DESC LIMIT ?
            """,
            (limit,),
        ).fetchall()
    finally:
        conn.close()
    return [
        f"Title: {row['title']}\n\nAbstract: {row['abstract']}"
        for row in rows
    ]


# ---------------------------------------------------------------------------
# Scoring
# ---------------------------------------------------------------------------

_BAND_RE = re.compile(r"~?(\d+)[–-](\d+)")


def band_bounds(length: str = "standard") -> tuple[int, int]:
    match = _BAND_RE.search(length_band(length))
    return (int(match.group(1)), int(match.group(2))) if match else (0, 10 ** 6)


def in_band(summary: str, bounds: tuple[int, int]) -> bool:
    words = len(summary.split())
    low, high = bounds
    # A 20 % margin either side. The band is guidance in a prompt, not a
    # constraint the model is held to, so scoring it exactly would measure
    # prompt adherence rather than whether batching degraded it.
    return low * 0.8 <= words <= high * 1.2


def leaked(summaries: list[str | None], tokens: list[str]) -> list[tuple[int, str]]:
    """Return ``(position, token)`` for every token found in another document's summary."""
    findings = []
    for position, summary in enumerate(summaries):
        if not summary:
            continue
        for other, token in enumerate(tokens):
            if other != position and token in summary:
                findings.append((position, token))
    return findings


# ---------------------------------------------------------------------------
# The runs
# ---------------------------------------------------------------------------

def run_per_document(client, documents, params) -> dict:
    started = time.monotonic()
    summaries: list[str | None] = []
    failures = 0
    per_paper = []
    for document in documents:
        one = time.monotonic()
        try:
            summaries.append(client.summarize(document, params))
        except AIError as exc:
            print(f"    ! {exc.kind.value}: {exc.message}", file=sys.stderr)
            summaries.append(None)
            failures += 1
        per_paper.append(time.monotonic() - one)
    return {
        "mode": "per-document",
        "size": 1,
        "wall": time.monotonic() - started,
        "per_paper": per_paper,
        "summaries": summaries,
        "failures": failures,
        "calls": len(documents),
        "fallbacks": 0,
    }


def run_batched(client, documents, params, size) -> dict:
    started = time.monotonic()
    summaries: list[str | None] = []
    per_paper = []
    client.batch_fallbacks = 0
    client.batch_calls = 0
    for start in range(0, len(documents), size):
        slice_docs = documents[start:start + size]
        one = time.monotonic()
        try:
            answered = client.summarize_many(slice_docs, params)
        except AIError as exc:
            print(f"    ! {exc.kind.value}: {exc.message}", file=sys.stderr)
            answered = [None] * len(slice_docs)
        elapsed = time.monotonic() - one
        summaries.extend(answered)
        per_paper.extend([elapsed / max(1, len(slice_docs))] * len(slice_docs))
    return {
        "mode": f"batch-{size}",
        "size": size,
        "wall": time.monotonic() - started,
        "per_paper": per_paper,
        "summaries": summaries,
        "failures": sum(1 for s in summaries if not s),
        "calls": client.batch_calls,
        "fallbacks": client.batch_fallbacks,
    }


def score(result: dict, tokens: list[str] | None, bounds) -> dict:
    summaries = result["summaries"]
    produced = [s for s in summaries if s]
    return {
        "mode": result["mode"],
        "size": result["size"],
        "papers": len(summaries),
        "calls": result["calls"],
        "wall_s": round(result["wall"], 1),
        "median_s_per_paper": round(statistics.median(result["per_paper"]), 1)
        if result["per_paper"] else None,
        "produced": len(produced),
        "in_band": sum(1 for s in produced if in_band(s, bounds)),
        "leaks": len(leaked(summaries, tokens)) if tokens else None,
        "fallback_batches": result["fallbacks"],
    }


# ---------------------------------------------------------------------------
# The flip gate
# ---------------------------------------------------------------------------
#
# Evaluated here rather than by hand afterwards, so re-running this script
# reproduces the verdict as well as the numbers. The thresholds are the ones
# phase 1.8.5's brief adopted:
#
#   speed      median wall-clock per paper <= 1/4 of the per-document run
#   leakage    0 canary tokens in another document's summary
#   band       band compliance no worse than the per-document run
#   fallback   <= 10 % of batches fell back to per-document calls

SPEED_RATIO_GATE = 0.25
FALLBACK_RATE_GATE = 0.10


def _print_gate(rows: list[dict]) -> None:
    groups: dict = {}
    for row in rows:
        groups.setdefault((row["provider"], row["corpus"]), []).append(row)

    print("\n## Flip gate\n")
    print("| provider | corpus | mode | s/paper | ratio | speed | leakage | band | fallback | verdict |")
    print("|---|---|---|---|---|---|---|---|---|---|")
    for (provider, corpus), group in groups.items():
        baseline = next(
            (r for r in group if r["mode"] == "per-document"), None,
        )
        if baseline is None or not baseline["median_s_per_paper"]:
            print(f"| {provider} | {corpus} | — | — | — | — | — | — | — | "
                  f"no per-document baseline in this run |")
            continue
        base = baseline["median_s_per_paper"]
        for row in group:
            if row["mode"] == "per-document":
                continue
            ratio = row["median_s_per_paper"] / base
            speed_ok = ratio <= SPEED_RATIO_GATE
            leak_ok = row["leaks"] == 0 if row["leaks"] is not None else None
            band_ok = row["in_band"] >= baseline["in_band"]
            calls = row["calls"] or 1
            fallback_rate = row["fallback_batches"] / calls
            fallback_ok = fallback_rate <= FALLBACK_RATE_GATE
            checks = [speed_ok, band_ok, fallback_ok]
            if leak_ok is not None:
                checks.append(leak_ok)
            verdict = "PASS" if all(checks) else "FAIL"
            print(
                f"| {provider} | {corpus} | {row['mode']} | "
                f"{row['median_s_per_paper']} | {ratio:.3f} | "
                f"{'pass' if speed_ok else 'FAIL'} | "
                f"{'—' if leak_ok is None else ('pass' if leak_ok else 'FAIL')} | "
                f"{'pass' if band_ok else 'FAIL'} | "
                f"{'pass' if fallback_ok else 'FAIL'} ({fallback_rate:.0%}) | "
                f"**{verdict}** |"
            )

        _print_cost_model(provider, corpus, base, group)


def _print_cost_model(provider: str, corpus: str, base: float, group: list[dict]) -> None:
    """Split per-paper cost into fixed per-call overhead and per-paper work.

    Two batched points determine both, because batch-N per-paper is
    ``F / N + G``. This is the number that says whether a failing speed gate
    means "batch harder" or "this threshold cannot be met at any batch size" —
    batching amortises ``F`` and cannot touch ``G``. Reported because a ratio
    on its own does not distinguish those two, and they call for opposite
    decisions.
    """
    batched = sorted(
        (r for r in group if r["mode"].startswith("batch-") and r["median_s_per_paper"]),
        key=lambda r: r["size"],
    )
    if len(batched) < 2:
        return
    small, large = batched[0], batched[-1]
    n1, n2 = small["size"], large["size"]
    t1, t2 = small["median_s_per_paper"], large["median_s_per_paper"]
    if n1 == n2 or (1 / n1 - 1 / n2) == 0:
        return
    fixed = (t1 - t2) / (1 / n1 - 1 / n2)
    per_paper = t2 - fixed / n2

    # A negative fixed cost means the larger batch was *slower* per paper, so
    # "fixed overhead plus per-paper work" does not describe this CLI at these
    # sizes. Say that rather than printing a fitted number that reads as an
    # explanation. Observed for real: codex at the reasoning effort inherited
    # from the user's config is slower per paper at 10 than at 5.
    if fixed < 0 or per_paper < 0:
        print(
            f"|   ↳ {provider} / {corpus} cost model | | "
            f"**not monotonic** — {n2} papers per call is slower per paper "
            f"than {n1} ({t2}s vs {t1}s), so batching further makes it worse, "
            f"not better | | | | | | | |"
        )
        return

    print(
        f"|   ↳ {provider} / {corpus} cost model | | "
        f"fixed {fixed:.1f}s per call + {per_paper:.1f}s per paper | | "
        f"floor ratio {per_paper / base:.3f} at infinite batch size | | | | | |"
    )


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--database", help="a resmon.db to draw real abstracts from")
    parser.add_argument("--papers", type=int, default=25)
    parser.add_argument("--sizes", type=int, nargs="+", default=[5, 10, 25])
    parser.add_argument(
        "--provider", nargs="+", default=list(SUPPORTED_CLI_PROVIDERS),
        choices=list(SUPPORTED_CLI_PROVIDERS),
    )
    parser.add_argument("--model", default=None)
    parser.add_argument("--effort", default=None)
    parser.add_argument("--skip-per-document", action="store_true",
                        help="reuse a previous baseline instead of re-spending it")
    parser.add_argument("--json-out", default=None)
    args = parser.parse_args()

    params = {"tone": "technical", "length": "standard",
              "extraction_goals": "key findings, methodology, contributions"}
    bounds = band_bounds("standard")

    canaries = canary_documents()
    canary_tokens = [token for token, _ in canaries]
    canary_docs = [document for _, document in canaries]

    real = real_documents(args.database, args.papers) if args.database else []
    if args.database and len(real) < args.papers:
        print(
            f"note: asked for {args.papers} real abstracts, found {len(real)}",
            file=sys.stderr,
        )

    rows = []
    for provider in args.provider:
        found = discover_cli(provider)
        if not found.found:
            print(f"skipping {provider}: {found.describe()}", file=sys.stderr)
            continue
        print(f"\n=== {provider} @ {found.path} ===", file=sys.stderr)

        def _client():
            return SubscriptionLLMClient(
                provider=provider, binary_path=found.path,
                model=args.model, effort=args.effort,
            )

        corpora = [("canary", canary_docs, canary_tokens)]
        if real:
            corpora.append(("real", real, None))

        for name, documents, tokens in corpora:
            if not args.skip_per_document:
                print(f"  {name}: per-document ×{len(documents)}", file=sys.stderr)
                result = run_per_document(_client(), documents, params)
                row = score(result, tokens, bounds)
                row.update({"provider": provider, "corpus": name})
                rows.append(row)
                print(f"    {json.dumps(row)}", file=sys.stderr)

            for size in args.sizes:
                if size > len(documents):
                    continue
                print(f"  {name}: batch {size} ×{len(documents)}", file=sys.stderr)
                result = run_batched(_client(), documents, params, size)
                row = score(result, tokens, bounds)
                row.update({"provider": provider, "corpus": name})
                rows.append(row)
                print(f"    {json.dumps(row)}", file=sys.stderr)

    if not rows:
        print("nothing measured — no CLI was usable", file=sys.stderr)
        return 1

    _print_gate(rows)

    headers = ["provider", "corpus", "mode", "papers", "calls", "wall_s",
               "median_s_per_paper", "produced", "in_band", "leaks",
               "fallback_batches"]
    print("\n| " + " | ".join(headers) + " |")
    print("|" + "|".join("---" for _ in headers) + "|")
    for row in rows:
        print("| " + " | ".join(
            "—" if row.get(h) is None else str(row.get(h)) for h in headers
        ) + " |")

    print(
        "\nCommand: "
        + " ".join([os.path.relpath(sys.executable, PROJECT_ROOT.parent),
                    os.path.relpath(__file__, PROJECT_ROOT.parent)] + sys.argv[1:])
    )
    if args.json_out:
        Path(args.json_out).write_text(json.dumps(rows, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
