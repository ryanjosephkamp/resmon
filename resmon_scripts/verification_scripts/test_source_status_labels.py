"""A source's recorded status is said in words, the same words wherever it is said.

``execution_sources.status`` holds an identifier (``skipped_missing_key``). A
line about the source on Today, the Source wall's legend, and the Search record
must not print it with its underscores taken out; each status has a written
label in ``zero_reason``, and the places that say it use that one. The same
holds for the reason a zero was recorded with (``window_unanswerable``): every
reason the engine can record has a written label, and a Source wall cell says
it in those words.
"""

from __future__ import annotations

import re
import sys
from pathlib import Path

import pytest

PROJECT_ROOT = Path(__file__).resolve().parent.parent.parent
sys.path.insert(0, str(PROJECT_ROOT / "resmon_scripts"))

from implementation_scripts import search_record, source_coverage, source_wall, zero_reason  # noqa: E402

DATABASE = PROJECT_ROOT / "resmon_scripts" / "implementation_scripts" / "database.py"


def _statuses() -> list[str]:
    """The statuses the engine records for a source, from the table's own CHECK."""
    source = DATABASE.read_text(encoding="utf-8")
    start = source.index("CREATE TABLE IF NOT EXISTS execution_sources (")
    check = re.search(r"CHECK \(status IN \(([^)]*)\)\)", source[start:])
    assert check, "execution_sources has no status CHECK this test can read"
    return [v.strip().strip("'") for v in check.group(1).split(",")]


def test_the_table_still_records_the_statuses_this_test_covers():
    assert set(_statuses()) == {"ok", "error", "skipped_missing_key", "cancelled"}


@pytest.mark.parametrize("status", _statuses())
def test_every_status_has_a_written_label(status):
    label = zero_reason.status_label(status)
    assert label and "_" not in label and label != status
    assert label == zero_reason._STATUS_LABELS[status]


def test_a_missing_key_is_said_as_the_zero_reason_says_it():
    assert zero_reason.status_label("skipped_missing_key") == zero_reason.label("missing_key") == "no API key configured"


@pytest.mark.parametrize("reason", zero_reason.ZERO_REASONS)
def test_every_recordable_reason_has_a_written_label(reason):
    label = zero_reason.label(reason)
    assert label and "_" not in label and label != reason
    assert label == zero_reason._LABELS[reason]


@pytest.mark.parametrize("status", ["ok", "error"])
@pytest.mark.parametrize("reason", zero_reason.ZERO_REASONS)
def test_a_source_wall_cell_says_its_recorded_reason_in_words(reason, status):
    # The cell's label is what the wall's reading shows for the reason; its
    # stored code is not shown beside it.
    row = {"source": "dblp", "status": status, "result_count": 0, "zero_reason": reason,
           "zero_detail": None, "error_message": "boom"}
    said = source_wall._cell(1, row, True)["label"]
    assert said and "_" not in said and said not in zero_reason.ZERO_REASONS


@pytest.mark.parametrize("status", [s for s in _statuses() if s != "ok"])
def test_today_the_search_record_and_the_wall_say_the_same_thing_for_a_status(status):
    row = {"source": "core", "status": status, "result_count": 0, "zero_reason": None,
           "zero_detail": None, "error_message": "boom"}
    said = source_coverage.outcome(row)
    assert said["label"] == zero_reason.status_label(status)
    assert search_record._outcome_label({**row}) == said["label"]
