"""The classification rule, enumerated — one row per input the renderer can be handed.

``zero_reason.answered`` is the rule that decides whether a source replied to
the query resmon sent it, and ``source_coverage.outcome`` is the categorizer
built on top of it. The renderer has to apply both itself in one place: the
live Monitor, where a ``repo_done`` event carries a reason slug and a rendered
sentence and no classification at all. ``frontend/src/api/zeroReason.ts`` does
that, and until this module it did it from a **hand transcription** whose own
docstring said so.

The vocabulary had already been pulled out of the renderer's hands --
``zeroReasonVocabulary.ts`` is generated from ``zero_reason.py`` and
byte-compared, so a new reason reddens the frontend suite. The *rule* was
still two files agreeing by hand, and a reviewer measured the gap exactly:
make ``answered`` return ``True`` for ``not_recorded`` and every renderer test
stays green. That is the same defect class, one level up, as the one that put
a green tick on the seven sources that have no author query.

**This module is the backend half of a two-sided guard, and it has to be two
sided.** A fixture that only the renderer reads goes stale the instant the
Python changes -- which is the generated-vocabulary blind spot moved up a
level rather than closed. So:

1. ``test_zero_reason_truth_table.py`` regenerates this table from the live
   ``zero_reason.answered`` and ``source_coverage.outcome`` and fails if the
   committed JSON differs. A backend change reddens the backend job.
2. ``frontend/src/__tests__/ZeroReasonTruthTable.test.ts`` fails if
   ``zeroReason.ts`` does not reproduce the committed JSON exactly. A renderer
   change reddens the frontend job.

Neither can go green alone, and neither file can be edited into agreement
without the other noticing.

**Nothing here is transcribed.** The reason axis is ``zero_reason.ZERO_REASONS``
itself, and the recorded-status axis is read out of ``source_coverage.outcome``'s
own abstract syntax tree rather than copied from it, because a copy of the
status set here would be the very defect this file exists to close. Both
derivations **raise by name** on anything they cannot read: the vocabulary
generator next door learned that the hard way, where a parser that silently
dropped an entry made the guard and the thing it guarded agree on the same
wrong answer.

Regenerate with::

    .venv/bin/python -m resmon_scripts.verification_scripts.zero_reason_truth_table --write

from the repository root.
"""

from __future__ import annotations

import ast
import json
import sys
from pathlib import Path

from implementation_scripts import source_coverage, zero_reason

#: The committed table. Read by the pytest guard and by the renderer suite.
FIXTURE_PATH = Path(__file__).resolve().parent / "fixtures" / "zero_reason_truth_table.json"

#: ``source_coverage``'s own file, which the status axis is read out of.
SOURCE_COVERAGE_PATH = Path(source_coverage.__file__).resolve()

# A status that is *not* one of the four the schema's CHECK constraint allows.
# ``executions.status`` holds this one, and reading an execution's status where
# a source row's status belongs is the realistic way an unrecognized value
# arrives -- more realistic than a nonsense string, and it is the input where
# falling through to "answered" would draw a tick resmon never observed.
UNRECOGNIZED_STATUS = "running"

# A reason slug this build has never heard of. Named like a plausible future
# addition on purpose: the question the row asks is what happens when the
# backend learns a reason before the renderer does, which is the ordinary
# order of events on a two-sided change.
UNRECOGNIZED_REASON = "quota_exhausted"

# Three counts: none, one, and a realistic page. The middle and the last are
# the same question to the rule and they are both here because a table whose
# only positive count is 1 reads like a unit test rather than like the data.
RESULT_COUNTS: tuple[int, ...] = (0, 1, 25)

#: The columns of every row, in order. The renderer reads this, not a copy.
COLUMNS: tuple[str, ...] = ("status", "result_count", "zero_reason", "answered", "category")


def recorded_statuses(path: Path = SOURCE_COVERAGE_PATH) -> tuple[str, ...]:
    """The statuses ``source_coverage.outcome`` recognizes, read from its own AST.

    ``outcome`` holds the set inline, in the expression that decides whether a
    recorded row is one resmon understands at all::

        valid = (valid_count and status in {"ok", "error", "skipped_missing_key", "cancelled"}
                 and ...)

    There is no module-level constant to import, and writing the four strings
    out here would put a third copy of them in the repository -- next to the
    renderer's ``RECORDED_STATUSES``, which is the copy this whole exercise
    exists to tie down. So the function is parsed instead.

    Strict on purpose, in the shape ``scripts/generate-zero-reason.js`` settled
    on after review: exactly one ``status in {...}`` comparison against a set
    of plain string literals, or this raises and names what it found. A guard
    that shrugs at a shape it does not recognize is a guard that agrees with
    whatever is there.
    """
    tree = ast.parse(path.read_text(encoding="utf-8"), filename=str(path))

    function = next(
        (node for node in tree.body
         if isinstance(node, ast.FunctionDef) and node.name == "outcome"),
        None,
    )
    if function is None:
        raise ValueError(f"no top-level `outcome` function in {path}")

    found: list[tuple[str, ...]] = []
    for node in ast.walk(function):
        if not isinstance(node, ast.Compare):
            continue
        if not (isinstance(node.left, ast.Name) and node.left.id == "status"):
            continue
        if len(node.ops) != 1 or not isinstance(node.ops[0], ast.In):
            continue
        comparator = node.comparators[0]
        if not isinstance(comparator, ast.Set):
            raise ValueError(
                f"`status in ...` in {path.name} compares against "
                f"{type(comparator).__name__}, which this reader does not "
                "understand. Teach it the new shape rather than letting the "
                "status axis silently shrink."
            )
        values = []
        for element in comparator.elts:
            if not (isinstance(element, ast.Constant) and isinstance(element.value, str)):
                raise ValueError(
                    f"the recorded-status set in {path.name} holds an entry "
                    f"this reader does not understand: {ast.dump(element)}."
                )
            values.append(element.value)
        found.append(tuple(values))

    if len(found) != 1:
        raise ValueError(
            f"expected exactly one `status in {{...}}` comparison in "
            f"{path.name}:outcome, found {len(found)}. The validity gate has "
            "moved or been duplicated; this reader has to be taught where it "
            "went before the table can be trusted."
        )
    return found[0]


def reason_axis() -> tuple[object, ...]:
    """Every reason the table walks: the taxonomy, no reason at all, and a stranger.

    Taken from ``zero_reason.ZERO_REASONS`` rather than listed, so a reason
    added to the backend lands here on the next run and changes the committed
    bytes, which is what reddens the backend job.
    """
    return (*zero_reason.ZERO_REASONS, None, UNRECOGNIZED_REASON)


def status_axis() -> tuple[str, ...]:
    """The four recorded statuses plus one the categorizer must refuse."""
    return (*recorded_statuses(), UNRECOGNIZED_STATUS)


# The inputs that are not of the right *kind* at all. A table of valid rows
# walks straight past these, and the validity gate is precisely what this
# classification was missing: without it an unrecognized slug falls through to
# *answered* and draws a tick, the one verdict resmon must never reach by
# accident. They are enumerated as their own block rather than folded into the
# grid so that the grid stays legible and so this list reads as the question it
# is asking.
INVALID_COUNTS: tuple[object, ...] = (-1, 2.5, None, True, "3")
INVALID_STATUSES: tuple[object, ...] = (None, True, "", 3)
INVALID_REASONS: tuple[object, ...] = ("", True, 3, "UPSTREAM_FAILURE", "upstream-failure")


def _answered(status: object, count: object, reason: object) -> bool:
    """``zero_reason.answered``, called -- never re-implemented, never swallowed.

    Raises by name if the rule cannot answer for an input the table offers it.
    Recording "this one errored" as a value would let the renderer agree with
    an error, and recording nothing would quietly drop the row.
    """
    try:
        return zero_reason.answered(status, count, reason)  # type: ignore[arg-type]
    except Exception as exc:  # noqa: BLE001 - the message is the point
        raise ValueError(
            f"zero_reason.answered({status!r}, {count!r}, {reason!r}) raised "
            f"{type(exc).__name__}: {exc}. The table cannot record a verdict "
            "for this input. Either the input does not belong in the table or "
            "the rule has to say what it means."
        ) from exc


def _category(status: object, count: object, reason: object) -> str:
    """``source_coverage.outcome``'s category for one recorded row.

    ``zero_detail`` is left empty throughout. The table's subject is the
    classification of ``status`` / ``result_count`` / ``zero_reason``; the
    detail dictionary feeds the *sentences* and the partial-answer flag, which
    are served to the renderer rather than computed by it.
    """
    row = {
        "source": "demo",
        "status": status,
        "result_count": count,
        "zero_reason": reason,
        "zero_detail": None,
        "error_message": None,
        "recorded_at": None,
    }
    return source_coverage.outcome(row)["category"]


def _row(status: object, count: object, reason: object) -> list[object]:
    return [status, count, reason,
            _answered(status, count, reason), _category(status, count, reason)]


def grid_rows() -> list[list[object]]:
    """Every combination of a recognized-shape input: status x count x reason."""
    return [
        _row(status, count, reason)
        for status in status_axis()
        for count in RESULT_COUNTS
        for reason in reason_axis()
    ]


def invalid_rows() -> list[list[object]]:
    """Inputs that are the wrong kind, one axis at a time.

    Each block varies one axis away from a shape the categorizer recognizes and
    holds the other two at values that would otherwise classify cleanly, so the
    row isolates the gate it is asking about. A count of 2 with a known reason
    is the dangerous pair: it is the input that reaches *answered*, and it is
    where a missing gate shows up as a tick rather than as a blank.
    """
    rows: list[list[object]] = []
    for count in INVALID_COUNTS:
        for reason in (None, "answered_empty", "upstream_failure"):
            rows.append(_row("ok", count, reason))
    for status in INVALID_STATUSES:
        for count in (0, 2):
            for reason in (None, "answered_empty"):
                rows.append(_row(status, count, reason))
    for reason in INVALID_REASONS:
        for count in (0, 2):
            rows.append(_row("ok", count, reason))
    return rows


def _cell(value: object) -> str:
    """One JSON scalar. ``json.dumps`` for every type, so nothing is hand-spelled."""
    return json.dumps(value)


def _render_rows(rows: list[list[object]], indent: str) -> str:
    """Rows one per line, columns aligned, so the table can actually be read.

    A fixture nobody can read is a guard in name only -- the reviewer's words,
    and the reason this pads rather than handing the whole structure to
    ``json.dumps``. The output is still ordinary JSON; only the whitespace is
    chosen.
    """
    cells = [[_cell(value) for value in row] for row in rows]
    widths = [max(len(row[i]) for row in cells) for i in range(len(COLUMNS))]
    lines = []
    for index, row in enumerate(cells):
        padded = [cell.ljust(widths[i]) if i != 1 else cell.rjust(widths[i])
                  for i, cell in enumerate(row)]
        comma = "," if index < len(cells) - 1 else ""
        lines.append(f"{indent}[{', '.join(padded).rstrip()}]{comma}")
    return "\n".join(lines)


def render() -> str:
    """The exact text of the committed fixture."""
    grid = grid_rows()
    invalid = invalid_rows()
    header = {
        "generated_by": "verification_scripts/zero_reason_truth_table.py",
        "regenerate_with": (
            "python -m resmon_scripts.verification_scripts.zero_reason_truth_table --write"
        ),
        "source_of_truth": [
            "implementation_scripts/zero_reason.py :: answered",
            "implementation_scripts/source_coverage.py :: outcome",
        ],
        "guarded_by": [
            "verification_scripts/test_zero_reason_truth_table.py",
            "frontend/src/__tests__/ZeroReasonTruthTable.test.ts",
        ],
        "columns": list(COLUMNS),
        "axes": {
            "recorded_statuses": list(recorded_statuses()),
            "statuses": list(status_axis()),
            "result_counts": list(RESULT_COUNTS),
            "zero_reasons": list(zero_reason.ZERO_REASONS),
            "reasons": list(reason_axis()),
        },
        "counts": {"grid_rows": len(grid), "invalid_input_rows": len(invalid)},
    }
    lines = ["{"]
    for key, value in header.items():
        lines.append(f"  {json.dumps(key)}: {json.dumps(value, indent=None)},")
    lines.append('  "rows": [')
    lines.append(_render_rows(grid, "    "))
    lines.append("  ],")
    lines.append('  "invalid_input_rows": [')
    lines.append(_render_rows(invalid, "    "))
    lines.append("  ]")
    lines.append("}")
    return "\n".join(lines) + "\n"


def main(argv: list[str] | None = None) -> int:    # pragma: no cover - entrypoint
    argv = list(sys.argv[1:] if argv is None else argv)
    text = render()
    if argv == ["--write"]:
        FIXTURE_PATH.write_text(text, encoding="utf-8")
        print(f"Wrote {FIXTURE_PATH.name}.")
        return 0
    if argv in ([], ["--print"]):
        sys.stdout.write(text)
        return 0
    print(f"usage: {Path(__file__).name} [--write|--print]", file=sys.stderr)
    return 2


if __name__ == "__main__":                          # pragma: no cover
    sys.exit(main())
