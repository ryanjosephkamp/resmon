#!/usr/bin/env python3
"""Which live tests a machine with nothing but a network connection can run.

`live_network` has meant two different things since it was invented, and the
difference only mattered once something went unheard. Most of those tests need
**the internet and nothing else**: a scholarly API, a loopback backend, a socket.
A minority need **something that belongs to the person running them** — an agent
CLI they installed and signed into, a provider key in their keyring, a model
serving on their own machine. No CI runner has any of those, and no runner can be
given them.

Nothing ran either group on a schedule, and in 1.9 a live test that contradicted
the shipped MCP contract sat red on ``main`` for two releases with nobody
hearing about it (2.0a *Decided* 8). The fix is not "run the live suite in CI" —
half of it cannot run there. It is to say, in code, which half can, and to run
that half every week.

**The split is a marker, not a list of files.** A live test that needs a local
resource carries the marker naming it; everything else is scheduled. A new live
test with neither is a gap, and ``test_live_suite.py`` fails on it by
construction: it collects the whole ``live_network`` set and asserts that the
scheduled selection and the marked selection partition it exactly.

Run as a script by ``.github/workflows/live-network.yml``, which asks this file
for its own selection rather than repeating it — a workflow holding its own copy
of the expression is a copy that drifts.
"""

from __future__ import annotations

import json
import os
import re
import subprocess
import sys
from pathlib import Path

from live_evidence import (
    asserted_line,
    disposition_sentence,
    load_quarantine,
    quarantine_line,
    quarantine_path,
    record_label,
    reduce_evidence,
    utc_today,
    validate_evidence,
)

PROJECT_ROOT = Path(__file__).resolve().parent.parent.parent

# Marker -> what the machine must have, in the words the run summary uses.
#
# Each entry is a promise that no GitHub runner can keep. Adding one means
# saying which resource, in a sentence a person reading a run summary can act
# on; it is not a place for "flaky".
LOCAL_RESOURCE_MARKERS: dict[str, str] = {
    "needs_agent_cli": (
        "an agent CLI installed on the machine and signed in to the user's own "
        "subscription (`claude`, `codex`)"
    ),
}

_MARKED = " or ".join(sorted(LOCAL_RESOURCE_MARKERS))

# What the weekly job runs: everything live that needs only a network.
SCHEDULED_SELECTION = f"live_network and not ({_MARKED})"

# Its complement, which the run summary names as *not run*.
LOCAL_ONLY_SELECTION = f"live_network and ({_MARKED})"


def collect(selection: str) -> list[str]:
    """Node ids pytest selects for *selection*, from a real collection.

    A subprocess rather than an in-process ``pytest.main``: this is called from
    inside a pytest run and a nested one would inherit the outer run's plugins,
    its ``addopts`` and its already-imported modules.
    """
    result = subprocess.run(
        [sys.executable, "-m", "pytest", "--collect-only", "-q", "-p", "no:cacheprovider",
         "-p", "timeout", "-m", selection],
        cwd=str(PROJECT_ROOT), capture_output=True, text=True, timeout=300,
    )
    if result.returncode not in (0, 5):               # 5 = nothing collected
        raise RuntimeError(
            f"collection failed for {selection!r}:\n{result.stdout[-4000:]}"
            f"\n{result.stderr[-2000:]}"
        )
    return sorted(
        line.strip() for line in result.stdout.splitlines()
        if "::" in line and not line.startswith(("ERROR", "FAILED"))
    )


def summary() -> str:
    """The Markdown the weekly job appends to its run summary.

    It names what the run did **not** cover, from a collection rather than from
    prose, because a summary that says "all live tests pass" while a third of
    them never ran is the sentence this whole exercise exists to prevent. Same
    rule as the UI-smoke jobs, which each print their own NOT VERIFIED lines.
    """
    scheduled = collect(SCHEDULED_SELECTION)
    skipped = collect(LOCAL_ONLY_SELECTION)
    lines = [
        "## What this run covered",
        "",
        f"**{len(scheduled)} of {len(scheduled) + len(skipped)} `live_network` tests.** "
        "Selection: `" + SCHEDULED_SELECTION + "`",
        "",
        *quarantine_summary(scheduled),
        "## What it did not run, and why",
        "",
    ]
    for marker, need in sorted(LOCAL_RESOURCE_MARKERS.items()):
        marked = collect(f"live_network and {marker}")
        lines.append(f"### `{marker}` — {len(marked)} test(s)")
        lines.append("")
        lines.append(f"Needs {need}. No GitHub runner has one, and none can be given one.")
        lines.append("")
        for node in marked:
            lines.append(f"- `{node}`")
        lines.append("")
    lines += [
        "These run on a developer's own machine and are reported in the phase "
        "handback that touches them. **A green tick here is not a statement "
        "about them.**",
        "",
    ]
    return "\n".join(lines)


def quarantine_summary(scheduled: list[str], today=None) -> list[str]:
    """The quarantine paragraph: its denominator, and every entry that has expired.

    The count comes from the scheduled collection it is handed. It is never
    typed, so a case added to or removed from the suite moves it.
    """
    today = today or utc_today()
    try:
        entries = load_quarantine()
    except Exception as exc:
        return [
            f"**Quarantine unreadable ({type(exc).__name__}); nothing is excused.** "
            f"{asserted_line(len(scheduled), [])}.",
            "",
        ]
    lines = [
        f"**{quarantine_line(scheduled, entries, today)}.** A quarantined case "
        "still runs and still asserts. Only a failure whose recorded failure "
        "history carries the named signature is excused, and a pass is reported "
        f"as a recovery. Policy: `{quarantine_path().name}`.",
        "",
    ]
    selected = set(scheduled)
    for entry in entries:
        if entry.nodeid in selected and not entry.active(today):
            lines.append(
                f"- Quarantine expired and ignored: `{entry.nodeid}` "
                f"({entry.label()}). Its case fails as normal; lift or renew the entry.")
    if lines[-1] != "":
        lines.append("")
    return lines


def validate_workflow_evidence(root: Path) -> dict:
    """Fail closed on missing, stale, wrong-selection, or incomplete evidence."""
    reduction = validate_evidence(root)
    selection = json.loads((root / "SELECTION.json").read_text())
    run = json.loads((root / "RUN.json").read_text())
    if selection["selection"] != SCHEDULED_SELECTION:
        raise AssertionError("evidence used a different live selection")
    collected = collect(SCHEDULED_SELECTION)
    if selection["nodeids"] != collected:
        raise AssertionError("evidence selection does not match fresh collection")
    identity = run["identity"]
    if identity.get("candidate_sha") in {None, "", "unknown"}:
        raise AssertionError("candidate head identity is missing")
    if identity.get("checkout_sha") in {None, "", "unknown"}:
        raise AssertionError("checkout head identity is missing")
    expected_identity = {
        "candidate_sha": os.environ.get("RESMON_LIVE_CANDIDATE_SHA"),
        "checkout_sha": os.environ.get("RESMON_LIVE_CHECKOUT_SHA"),
        "selection": os.environ.get("RESMON_LIVE_SELECTION"),
    }
    for key, expected in expected_identity.items():
        if expected and identity.get(key) != expected:
            raise AssertionError(f"evidence {key} does not match workflow context")
    return reduction


def evidence_summary(root: Path) -> str:
    """Render partial evidence without treating it as acceptance."""
    try:
        reduction = reduce_evidence(root, require_finish=False)
    except Exception as exc:
        return "## Durable live evidence\n\nUnavailable or invalid: " + type(exc).__name__ + "\n"
    quarantine = reduction["quarantine"]
    excused = {
        nodeid for nodeid, value in quarantine["dispositions"].items()
        if value["disposition"] == "excused"
    }
    counts = {"passed": 0, "failed": 0, "skipped": 0}
    for nodeid, outcome in reduction["outcomes"].items():
        if nodeid not in excused:
            counts[outcome] += 1

    def literal(value: object, limit: int = 128) -> str:
        text = str(value).replace("\r", " ").replace("\n", " ")[:limit]
        runs = [len(match.group(0)) for match in re.finditer(r"`+", text)]
        fence = "`" * (max(runs, default=0) + 1)
        padding = " " if text.startswith("`") or text.endswith("`") else ""
        return f"{fence}{padding}{text}{padding}{fence}"

    def names(values: list[str]) -> str:
        shown = values[:32]
        suffix = f" (+{len(values) - len(shown)} more)" if len(values) > len(shown) else ""
        return (", ".join(literal(value) for value in shown) or "none") + suffix

    lines = [
        "## Durable live evidence",
        "",
        f"Run `{reduction['run_id']}` selected {reduction['selected']} tests.",
        f"**{asserted_line(reduction['selected'], quarantine['entries'])}.**",
        f"Completed outcomes: {counts['passed']} passed, {counts['failed']} failed, "
        f"{counts['skipped']} skipped, {len(excused)} quarantined; "
        f"{len(reduction['unfinished'])} unfinished.",
        "",
    ]
    if quarantine["entries"]:
        lines.extend(["### Quarantine", ""])
        for record in quarantine["entries"][:8]:
            nodeid = record["nodeid"]
            value = quarantine["dispositions"].get(nodeid)
            if value is not None:
                lines.append("- " + disposition_sentence(
                    literal(nodeid, 4096), value["disposition"], record, value["history"]))
            elif not record["active"]:
                lines.append(
                    f"- EXPIRED {literal(nodeid, 4096)}: the quarantine "
                    f"({record_label(record)}) has expired and was ignored.")
            else:
                lines.append(
                    f"- {literal(nodeid, 4096)}: quarantined ({record_label(record)}); "
                    "no call result was recorded.")
        lines.append("")
    histories = [
        (nodeid, value) for nodeid, value in sorted(quarantine["source_outcomes"].items())
        if value["failure_history"]
    ]
    if histories:
        lines.extend(["### Recorded source failure history", ""])
        for nodeid, value in histories[:32]:
            omitted = value["failure_history_omitted"]
            lines.append(
                f"- {literal(nodeid, 4096)} ({literal(value['source'], 64)}): "
                + " -> ".join(value["failure_history"])
                + (f" (+{omitted} earlier)" if omitted else "")
                + f"; last call failed: {'yes' if value['last_call_failed'] else 'no'}."
            )
        lines.append("")
    ledger = reduction.get("source_ledger")
    if ledger is None:
        return "\n".join(lines)

    if ledger["complete"]:
        threshold = "passed" if ledger["threshold_pass"] else "failed"
        lines.extend([
            "### Source-response ledger",
            "",
            f"Complete denominator: {len(ledger['expected'])} keyless sources; "
            f"minimum {ledger['minimum']}; threshold **{threshold}**; "
            f"aggregate case **{ledger['aggregate_case_outcome']}**.",
            f"Answered: {names(ledger['answered'])}.",
            f"Partial within answered: {names(ledger['partial'])}.",
            f"Excluded credential-gated: {names(ledger['excluded_keyed'])}.",
            "",
        ])
    else:
        lines.extend([
            "### Source-response ledger — incomplete",
            "",
            "No aggregate acceptance is available for this interrupted run.",
            f"Observed: {names(ledger['observed'])}; missing: {names(ledger['missing'])}; "
            f"aggregate present: {'yes' if ledger['aggregate_present'] else 'no'}.",
            f"Incomplete pytest lifecycles: {names(ledger['incomplete_lifecycle'])}.",
            f"Expected denominator: {len(ledger['expected'])}; minimum would be "
            f"{ledger['minimum']} after complete evidence.",
            "",
        ])
    for row in ledger["sources"][:32]:
        returned = "n/a" if row["returned_count"] is None else str(row["returned_count"])
        lines.append(
            f"- {literal(row['slug'])}: result {literal(row['result'], 32)}; "
            f"returned {returned}; "
            f"partial {'yes' if row['partial'] else 'no'}; "
            f"source case {literal(row['source_case_outcome'] or 'unavailable', 32)}."
        )
    if len(ledger["sources"]) > 32:
        lines.append(f"- {len(ledger['sources']) - 32} additional source rows omitted.")
    lines.append("")
    return "\n".join(lines)


def main() -> int:                                   # pragma: no cover - entrypoint
    what = sys.argv[1] if len(sys.argv) > 1 else "--selection"
    if what == "--selection":
        print(SCHEDULED_SELECTION)
    elif what == "--summary":
        print(summary())
    elif what == "--validate-evidence" and len(sys.argv) == 3:
        result = validate_workflow_evidence(Path(sys.argv[2]))
        print(json.dumps(result, sort_keys=True))
    elif what == "--evidence-summary" and len(sys.argv) == 3:
        print(evidence_summary(Path(sys.argv[2])))
    else:
        print(
            f"usage: {Path(__file__).name} "
            "[--selection|--summary|--validate-evidence DIR|--evidence-summary DIR]",
            file=sys.stderr,
        )
        return 2
    return 0


if __name__ == "__main__":                           # pragma: no cover
    sys.exit(main())
