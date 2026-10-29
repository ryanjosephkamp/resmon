"""A DOAJ record's publication date is an ISO date, whatever form the month came in.

DOAJ gives ``bibjson.month`` as a number, a number in a string, or a name, and
the client used to zero-pad whatever came, storing ``2025-January-01``. resmon
reads dates as ISO everywhere else: ``analytics.publication_volume`` buckets by
the first seven characters, so that paper landed in a month called ``2025-Ja``,
and ``analytics.discovery_lag``'s ``julianday`` returned NULL for it, so it was
skipped. Found on a demo corpus while building the Atlas Analytics view.

This covers new records only. Rows already stored with a month's name are left
as they are.
"""

from __future__ import annotations

import re
import sqlite3
import sys
from pathlib import Path

import pytest

PROJECT_ROOT = Path(__file__).resolve().parent.parent.parent
sys.path.insert(0, str(PROJECT_ROOT / "resmon_scripts"))

from implementation_scripts.api_doaj import DoajClient  # noqa: E402


def _date(month: object, year: object = 2025) -> str | None:
    bibjson: dict = {"title": "A paper", "year": year}
    if month is not ...:
        bibjson["month"] = month
    result = DoajClient._parse_article({"id": "doaj-1", "bibjson": bibjson})
    assert result is not None
    return result.publication_date


@pytest.mark.parametrize("month, expected", [
    (7, "2025-07-01"), ("7", "2025-07-01"), ("07", "2025-07-01"), (" 12 ", "2025-12-01"),
    ("January", "2025-01-01"), ("july", "2025-07-01"), ("Jul", "2025-07-01"), ("Sept.", "2025-09-01"),
    ("SEPTEMBER", "2025-09-01"), ("May", "2025-05-01"),
])
def test_a_month_in_any_of_doajs_forms_is_stored_as_two_digits(month: object, expected: str):
    assert _date(month) == expected


@pytest.mark.parametrize("month", [..., None, "", "13", "0", "Spring", "2025-07", "Julyish"])
def test_a_month_that_cannot_be_read_falls_back_to_the_year_alone(month: object):
    assert _date(month) == "2025-01-01"


def test_no_year_is_no_date():
    assert _date("July", year=None) is None


@pytest.mark.parametrize("month", ["January", "Jul", "11", 3, "Spring"])
def test_every_date_stored_is_one_sqlite_can_read(month: object):
    stored = _date(month)
    assert stored and re.fullmatch(r"\d{4}-\d{2}-\d{2}", stored)
    conn = sqlite3.connect(":memory:")
    try:
        assert conn.execute("SELECT julianday(?)", (stored,)).fetchone()[0] is not None
    finally:
        conn.close()
