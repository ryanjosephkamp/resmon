"""The route total is derived in one place, and nothing else types it.

Four counters in this tree held the number of HTTP routes by hand. Only one was
the API-contract guard everybody knows about; the other three were discovered
one at a time, by three different people, each as a red that looked like a real
regression and each time turning out to be a counter nobody had been told to
move. The number itself was never wrong — the fourth copy of it was.

``route_census.py`` derives it three independent ways. This module requires the
three to agree, requires the derivation to be able to notice a missing route,
and then sweeps the suite for anything still typing the number instead of
asking for it.
"""

from __future__ import annotations

import re
from pathlib import Path

import pytest

import route_census

PROJECT_ROOT = Path(__file__).resolve().parent.parent.parent
VERIFICATION = PROJECT_ROOT / "resmon_scripts" / "verification_scripts"

# Files allowed to still hold the total as a literal, each with the reason.
# This is an upper bound, not a requirement: folding one in and leaving its
# name here keeps the sweep green, so a branch that removes a counter never
# has to come back and edit this list to land.
KNOWN_HAND_HELD = {
    "test_response_models.py": (
        "being edited on another branch together with the generated contract; "
        "folding it from here would have been a merge conflict rather than a fix"
    ),
}


def test_the_three_derivations_agree():
    """Source, committed contract, running app.

    Each disagreement means something different, so the message names which
    pair came apart and which keys differ rather than printing two integers.
    """
    declared = set(route_census.declared_routes())
    contract = set(route_census.contract_routes())
    app = set(route_census.app_routes())

    assert declared == contract, (
        "resmon.py's decorators and docs/api-contract/openapi.json disagree. "
        "Usually the committed contract is stale — regenerate it. "
        f"Only in the source: {sorted(declared - contract)}. "
        f"Only in the contract: {sorted(contract - declared)}."
    )
    assert app == contract, (
        "the running app and the committed contract disagree; the contract is "
        "generated from the app, so this is a stale document. "
        f"Only on the app: {sorted(app - contract)}. "
        f"Only in the contract: {sorted(contract - app)}."
    )
    assert route_census.declared_total() == route_census.app_total()


def test_a_route_removed_from_the_source_is_noticed():
    """The derivation can go red, driven over the real file minus one route.

    Not a constructed fixture: the point of a census is that it tracks the real
    source, and a parser that only ever sees a two-line sample proves nothing
    about a 185-route module.
    """
    source = route_census.RESMON_SOURCE.read_text(encoding="utf-8")
    full = route_census.declared_in(source)
    assert full, "the census found no routes at all in resmon.py"

    method, path = full[0]
    pattern = re.compile(
        r'^@app\.' + method.lower() + r'\(\s*["\']' + re.escape(path) + r'["\']',
        re.MULTILINE,
    )
    assert pattern.search(source), f"could not find the decorator for {method} {path}"
    trimmed = route_census.declared_in(pattern.sub("@app.get('/__removed__'", source, count=1))
    assert (method, path) not in trimmed, "removing a decorator did not change the census"
    assert len(trimmed) == len(full), "the replacement should keep the count, not the key"


def test_a_decorator_the_parser_cannot_read_lowers_the_count():
    source = route_census.RESMON_SOURCE.read_text(encoding="utf-8")
    full = route_census.declared_in(source)
    without = route_census.declared_in(
        re.sub(r"^@app\.(get|post|put|patch|delete)\(", "@app.unknown_verb(",
               source, count=1, flags=re.MULTILINE))
    assert len(without) == len(full) - 1


def test_nothing_in_the_suite_still_types_the_route_total():
    """The sweep. One derived denominator means one place holds the number.

    Matches a line carrying the current total as a standalone integer *and* the
    word "route", which is what distinguishes a counter from a byte offset or a
    colour channel that happens to be the same number.
    """
    total = route_census.contract_total()
    pattern = re.compile(rf"\b{total}\b")
    offenders: dict[str, list[str]] = {}
    for path in sorted(VERIFICATION.glob("*.py")):
        if path.name in {"route_census.py", Path(__file__).name}:
            continue
        for number, line in enumerate(path.read_text(encoding="utf-8").splitlines(), 1):
            if pattern.search(line) and "route" in line.lower():
                offenders.setdefault(path.name, []).append(f"{number}: {line.strip()}")

    unexpected = {name: hits for name, hits in offenders.items() if name not in KNOWN_HAND_HELD}
    assert not unexpected, (
        f"these files hold the route total ({total}) by hand instead of asking "
        "route_census.py for it:\n"
        + "\n".join(f"  {name}\n    " + "\n    ".join(hits) for name, hits in unexpected.items())
    )


@pytest.mark.parametrize("name,reason", sorted(KNOWN_HAND_HELD.items()))
def test_each_remaining_hand_held_counter_is_still_there_and_still_explained(name, reason):
    """An exemption for a file that no longer needs one is a stale exemption.

    This does not fail when the counter is folded in — the sweep above accepts
    that — it fails when the *file* goes away, which is the case where the
    reason has certainly stopped being true.
    """
    assert reason.strip(), f"{name} is exempt with no reason given"
    assert (VERIFICATION / name).exists(), (
        f"{name} is listed as holding the route total by hand and no longer exists; "
        "remove it from KNOWN_HAND_HELD"
    )
