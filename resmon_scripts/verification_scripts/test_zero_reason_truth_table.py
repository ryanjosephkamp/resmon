"""The backend half of the two-sided guard on the zero-reason rule.

``zero_reason.answered`` and ``source_coverage.outcome`` are the rule. The
renderer applies the same rule itself on the live Monitor, where there is no
served classification to read, and it did that from a hand transcription. The
vocabulary had already been taken out of the renderer's hands; the rule had
not, and the measurement of the gap was exact: make ``answered`` return
``True`` for ``not_recorded`` and every renderer test stayed green.

A committed fixture closes that only if **both** sides are held to it. A
fixture that only the renderer reads goes stale the moment the Python changes,
which moves the generated-vocabulary blind spot up a level instead of closing
it. So this file is the backend half: it regenerates the table from the live
functions and fails when the committed file differs. The renderer half is
``frontend/atlas/src/screens/runs/__tests__/zeroReasonTruthTable.test.ts``. A backend change
reddens the backend job, a renderer change reddens the frontend job, and
neither can go green alone.

What this file does **not** do is assert the verdicts themselves. Writing
"``ok`` / 0 / ``upstream_failure`` is a non-answer" here would put a third
copy of the rule in the repository, which is the defect, not the fix. The
committed table is the artifact; these tests say it is the live rule's own
output and that the generator cannot quietly produce a smaller one.
"""

from __future__ import annotations

import json
import textwrap

import pytest

from implementation_scripts import zero_reason
from resmon_scripts.verification_scripts import zero_reason_truth_table as table


def test_the_committed_truth_table_is_what_the_live_rule_produces():
    """Byte-compare, in the shape the vocabulary guard next door settled on.

    The failure message names the first differing row rather than printing a
    221-row diff, because the useful question when this reddens is *which
    input changed meaning*, and a wall of JSON does not answer it.
    """
    committed = table.FIXTURE_PATH.read_text(encoding="utf-8")
    regenerated = table.render()
    if committed == regenerated:
        return

    old, new = json.loads(committed), json.loads(regenerated)
    changed = [
        f"  {json.dumps(a)}  ->  {json.dumps(b)}"
        for key in ("rows", "invalid_input_rows")
        for a, b in zip(old.get(key, []), new.get(key, []))
        if a != b
    ]
    counts = (
        f"{len(old.get('rows', []))}+{len(old.get('invalid_input_rows', []))} committed, "
        f"{len(new.get('rows', []))}+{len(new.get('invalid_input_rows', []))} regenerated"
    )
    pytest.fail(textwrap.dedent(f"""
        The committed zero-reason truth table is not what the live rule
        produces ({counts} rows).

        If the rule changed on purpose, regenerate it and say in the PR which
        inputs changed meaning:

            python -m resmon_scripts.verification_scripts.zero_reason_truth_table --write

        The frontend suite will then redden too, until Atlas's `outcomeOf`
        reproduces the new table. That is the point: neither side goes green
        on its own.

        Rows whose verdict changed (first 20 of {len(changed)}):
        """) + "\n".join(changed[:20] or ["  (none -- the axes or the header changed)"]))


def test_every_reason_in_the_taxonomy_is_a_row():
    """A reason added to ``ZERO_REASONS`` must change the table, not slip past it.

    This is the property that makes the byte-compare above worth anything. If
    the reason axis were a list written here, a new backend reason would leave
    the table byte-identical and both guards would stay green while the
    renderer had never been shown the new slug.
    """
    committed = json.loads(table.FIXTURE_PATH.read_text(encoding="utf-8"))
    assert committed["axes"]["zero_reasons"] == list(zero_reason.ZERO_REASONS)

    reasons_in_rows = {row[2] for row in committed["rows"]}
    missing = [r for r in zero_reason.ZERO_REASONS if r not in reasons_in_rows]
    assert missing == [], f"reasons with no row in the table: {missing}"

    # The two deliberate non-members of the taxonomy: no reason recorded at
    # all, and a slug this build has never heard of. The second is the one
    # that matters -- `answered` reads an unknown slug as *answered*, and only
    # the categorizer's validity gate stops that reaching a user as a tick.
    assert None in reasons_in_rows
    assert table.UNRECOGNIZED_REASON in reasons_in_rows
    assert table.UNRECOGNIZED_REASON not in zero_reason.ZERO_REASONS


def test_the_table_carries_the_verdict_an_unknown_slug_gets():
    """Name the row that is the whole argument for the validity gate.

    ``answered`` says *yes* for a reason it has never heard of, because the
    rule asks only whether the slug is in ``DID_NOT_ANSWER``. The categorizer
    refuses the row first. Those two facts sitting on one line is why the
    table carries both columns instead of only the category.
    """
    committed = json.loads(table.FIXTURE_PATH.read_text(encoding="utf-8"))
    row = next(r for r in committed["rows"]
               if r[:3] == ["ok", 0, table.UNRECOGNIZED_REASON])
    assert row[3] is True, "the rule reads an unrecognized slug as answered"
    assert row[4] == "unknown", "the validity gate must refuse it anyway"


def test_the_status_axis_is_read_from_the_categorizer_not_copied():
    """``recorded_statuses`` parses ``source_coverage.outcome``; prove it parses.

    Two things are asserted and the second is the one that keeps the first
    honest: the reader finds the four statuses, **and** it raises by name
    rather than returning a shorter tuple when the gate it reads is not the
    shape it knows. A reader that shrugs at an unfamiliar shape is a reader
    that agrees with whatever is there -- the lesson written at length in
    ``scripts/generate-zero-reason.js``, which had exactly that bug.
    """
    assert table.recorded_statuses() == ("ok", "error", "skipped_missing_key", "cancelled")


@pytest.mark.parametrize("body, expected", [
    # The gate moved out of `outcome` entirely.
    ("""
     def outcome(row):
         return {"category": "unknown"}
     """, "assignment to `valid`"),
    # Someone replaced the inline set with a module constant. That is a fine
    # refactor and this reader cannot follow it, so it must say so rather than
    # quietly producing an empty axis.
    ("""
     RECORDED = {"ok"}
     def outcome(row):
         valid = status in RECORDED
         return {"category": "unknown"}
     """, "does not understand"),
    # A non-literal crept into the set.
    ("""
     def outcome(row):
         valid = status in {"ok", EXTRA}
         return {"category": "unknown"}
     """, "does not understand"),
    # The gate was lifted into its own name, so the `valid` expression no
    # longer mentions `status` at all and the axis this reader could report
    # would not be the gate.
    ("""
     def outcome(row):
         gate = status in {"ok"}
         valid = valid_count and gate
         return {"category": "unknown"}
     """, "mentions `status`"),
    # **The reviewer's break, and the reason this function was rewritten.** A
    # fifth status added with an `or` arm instead of an entry in the set. The
    # first reader filtered on `ast.In`, so this arm was skipped rather than
    # counted, the "exactly one" check never fired, and both guards stayed
    # green while `outcome` genuinely reclassified an `interrupted` row.
    ("""
     def outcome(row):
         valid = (valid_count
                  and (status in {"ok", "error", "skipped_missing_key", "cancelled"}
                       or status == "interrupted")
                  and not malformed)
         return {"category": "unknown"}
     """, "mentions `status`"),
    # The same family, one mention each, so the comparison shape is what has
    # to refuse them: `==`, `!=` and `not in` are all readable Python and none
    # of them is the gate this reader knows how to report.
    ("""
     def outcome(row):
         valid = status == "ok"
         return {"category": "unknown"}
     """, "does not understand"),
    ("""
     def outcome(row):
         valid = valid_count and status != "running"
         return {"category": "unknown"}
     """, "does not understand"),
    ("""
     def outcome(row):
         valid = status not in {"running", "interrupted"}
         return {"category": "unknown"}
     """, "does not understand"),
    # The name is there once, but inside a call rather than as the left of the
    # comparison. A scan keyed on `left` skips it; this one must not.
    ("""
     def outcome(row):
         valid = status.lower() in {"ok"}
         return {"category": "unknown"}
     """, "does not understand"),
    # Two gates in one expression: which set is the axis is not decidable.
    ("""
     def outcome(row):
         valid = status in {"ok"} and status in {"error"}
         return {"category": "unknown"}
     """, "mentions `status`"),
])
def test_an_unreadable_validity_gate_stops_the_run(tmp_path, body, expected):
    path = tmp_path / "source_coverage.py"
    path.write_text(textwrap.dedent(body), encoding="utf-8")
    with pytest.raises(ValueError, match=expected):
        table.recorded_statuses(path)


def test_the_generator_refuses_to_record_a_verdict_it_could_not_compute():
    """An input the rule cannot answer for names itself instead of becoming a row.

    ``zero_reason.answered`` coerces its count with ``int()``, so a count it
    cannot read raises. Recording that as ``false`` would hand the renderer a
    verdict the backend never reached, and recording nothing would drop the
    row out of both sides at once -- the silent-skip failure that made the
    first vocabulary parser agree with its own mistake.
    """
    with pytest.raises(ValueError, match="raised ValueError"):
        table._answered("ok", "not a number", None)
