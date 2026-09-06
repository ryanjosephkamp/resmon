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

import subprocess
import sys
from pathlib import Path

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
         "-m", selection],
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


def main() -> int:                                   # pragma: no cover - entrypoint
    what = sys.argv[1] if len(sys.argv) > 1 else "--selection"
    if what == "--selection":
        print(SCHEDULED_SELECTION)
    elif what == "--summary":
        print(summary())
    else:
        print(f"usage: {Path(__file__).name} [--selection|--summary]", file=sys.stderr)
        return 2
    return 0


if __name__ == "__main__":                           # pragma: no cover
    sys.exit(main())
