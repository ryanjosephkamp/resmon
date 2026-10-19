#!/usr/bin/env python3
"""What a run did not select, said where the person reading a green run is.

``pytest -q`` deselects 110 ``live_network`` cases and reports it as the word
``deselected`` at the end of a line of counts. Nothing names them, nothing
groups them, and nothing appears in the GitHub run summary at all — so every
green merge in this project's history has been silent about roughly a thirtieth
of the suite. In one branch that silence was hiding real failures in three
separate modules at once: a hard-coded tool count four short of the real
surface, a settings module whose cases a narrowing had broken, and a third
picking keys by a sort order the same change had invalidated.

The asymmetry is the thing. ``.github/workflows/live-network.yml`` *does* report
what it could not run — every ``needs_agent_cli`` case named by node id — because
an earlier session worked out that a green tick must not imply a test nobody
ran. That reasoning was never applied one level up, to the gate that deselects
far more.

So this renders the same statement for the hermetic gate. Everything in it is
read off the items pytest actually deselected: the count, the modules, and the
markers that put them there. There is no list to keep up to date, and a new
live module appears here the day it is written.
"""

from __future__ import annotations

import configparser
import re
from collections import Counter
from pathlib import Path
from typing import Iterable, Optional, Sequence

# How many modules to name before summarising the rest. A ``-k`` run during
# development can deselect three thousand cases across every module in the
# suite, and a hundred-line block at the end of every local run is a block
# people learn to scroll past.
MODULE_LIMIT = 24

HEADING = "deselected — these cases did not run"


def project_marker_names(ini_path: Optional[Path]) -> set[str]:
    """The marker names ``pytest.ini`` itself declares.

    ``item.iter_markers()`` also yields pytest's own built-ins — ``parametrize``
    above all, which 42 of the 110 deselected cases carry. Reporting those would
    be worse than noise: the sentence this report ends on says a live case
    carrying a *second* marker runs on no runner, and a parametrized live case
    carries ``parametrize`` and runs weekly like the rest.

    ``config.getini("markers")`` is not the list to use, because pytest core
    registers its own built-ins into exactly that setting at configure time, so
    it comes back carrying ``parametrize`` as if the project had declared it.
    The file is the only place that says which markers are this project's.

    An unreadable or absent ini returns the empty set, and the caller then
    reports no markers at all rather than the wrong ones.
    """
    if ini_path is None:
        return set()
    parser = configparser.ConfigParser()
    try:
        parser.read(str(ini_path), encoding="utf-8")
        raw = parser.get("pytest", "markers", fallback="")
    except (configparser.Error, OSError):            # pragma: no cover - unreadable ini
        return set()
    names = set()
    for entry in raw.splitlines():
        match = re.match(r"^\s*([A-Za-z_]\w*)\s*(?:\(|:)", entry)
        if match:
            names.add(match.group(1))
    return names


def _module_of(nodeid: str) -> str:
    """``test_foo.py`` from ``resmon_scripts/.../test_foo.py::test_bar``."""
    path = nodeid.split("::", 1)[0]
    return path.rsplit("/", 1)[-1]


def selection_sentence(markexpr: Optional[str], keyword: Optional[str]) -> str:
    """How the run says it chose, in the words it was given on the command line."""
    parts = []
    if markexpr:
        parts.append(f'-m "{markexpr}"')
    if keyword:
        parts.append(f'-k "{keyword}"')
    if not parts:
        # Deselection with neither expression set: a plugin did it, or
        # ``--last-failed``. Saying "by something" beats implying a cause.
        return "by this run's selection"
    return "by " + " and ".join(parts)


def render(
    deselected: Sequence[tuple[str, Iterable[str]]],
    *,
    collected: int,
    markexpr: Optional[str] = None,
    keyword: Optional[str] = None,
    module_limit: int = MODULE_LIMIT,
) -> list[str]:
    """The report, as lines.

    *deselected* is ``(nodeid, marker names)`` for every case pytest took out of
    the run. Markers come from the items themselves rather than from a list
    here: a second local-resource marker added next month groups itself.
    """
    if not deselected:
        return []

    total = len(deselected)
    denominator = collected + total
    lines = [
        f"{total} of {denominator} collected cases were deselected "
        f"{selection_sentence(markexpr, keyword)} and did not run.",
        "A green result above is not a statement about any of them.",
        "",
    ]

    by_marker = Counter(
        ", ".join(sorted(markers)) or "(no declared marker — deselected by name)"
        for _, markers in deselected
    )
    lines.append("By marker:")
    for combination, count in sorted(by_marker.items(), key=lambda kv: (-kv[1], kv[0])):
        lines.append(f"  {count:>5}  {combination}")
    lines.append("")

    by_module = Counter(_module_of(nodeid) for nodeid, _ in deselected)
    shown = sorted(by_module.items(), key=lambda kv: (-kv[1], kv[0]))[:module_limit]
    lines.append(f"By module ({len(by_module)}):")
    for module, count in shown:
        lines.append(f"  {count:>5}  {module}")
    if len(by_module) > len(shown):
        omitted = len(by_module) - len(shown)
        hidden = total - sum(count for _, count in shown)
        lines.append(f"  {hidden:>5}  in {omitted} further module(s), not listed")
    if any("live_network" in markers for _, markers in deselected):
        lines.append("")
        lines.append(
            "The live_network cases carrying no further marker are run weekly by "
            ".github/workflows/live-network.yml, which names what it could not "
            "run. Any case above carrying a second marker runs on no runner at all."
        )
    return lines


def as_markdown(lines: Sequence[str]) -> str:
    """The same report for ``$GITHUB_STEP_SUMMARY``.

    A fenced block rather than a table: the content is already aligned, and a
    table would need the counts restructured to say exactly what the terminal
    says. The two have to agree, so they are generated from the same lines.
    """
    if not lines:
        return ""
    return "## " + HEADING.capitalize() + "\n\n```\n" + "\n".join(lines) + "\n```\n"
