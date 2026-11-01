# resmon_scripts/implementation_scripts/api_biorxiv.py
"""bioRxiv / medRxiv API client — JSON, date-range endpoints, both servers."""

import logging
import re
import time
from datetime import date, timedelta
from typing import Iterator, Mapping

from .api_base import (
    BaseAPIClient,
    NormalizedResult,
    RateLimiter,
    note_default_start,
    note_parse_failure_unless_transport,
    note_read,
    safe_request,
    search_outcome,
)
from .repo_catalog import constraints_for

logger = logging.getLogger(__name__)

_BIORXIV_API_BASE = "https://api.biorxiv.org/details"
_SEARCH_BUDGET_SECONDS = 45.0
_REQUEST_TIMEOUT_SECONDS = 10.0
_MAX_RESPONSE_ATTEMPTS = 2
_PAGE_SIZE = 30
_TRANSIENT_CODES = {429, 500, 502, 503, 504}
# What /details answers for a range with no records (measured November 1,
# 2026: `{"messages":[{"status":"no posts found"}], "collection":[]}`). It was
# recorded as a failure, so an empty window read as a source that did not answer.
_NO_POSTS = "no posts found"

# Conservative: 2 req/s
_RATE_LIMITER = RateLimiter(requests_per_second=2.0)


def _request_json(url: str, deadline: float) -> dict | None:
    """Read one JSON page, retrying one unusable or transient response.

    The provider has been observed returning HTTP 200 with an empty body. That
    is not an empty search result: retry it once inside the search budget, then
    record that the reply could not be parsed. A later successful attempt stays
    successful because the parse failure is recorded only after exhaustion.
    """
    last_parse_error: Exception | None = None
    for attempt in range(_MAX_RESPONSE_ATTEMPTS):
        try:
            response = safe_request(
                "GET",
                url,
                rate_limiter=_RATE_LIMITER,
                timeout=_REQUEST_TIMEOUT_SECONDS,
                max_retries=0,
                deadline=deadline,
            )
        except Exception as exc:
            if attempt + 1 < _MAX_RESPONSE_ATTEMPTS:
                logger.warning("bioRxiv request failed; retrying once: %s", exc)
                continue
            logger.exception("bioRxiv API request failed")
            return None

        if response.status_code != 200:
            if (
                response.status_code in _TRANSIENT_CODES
                and attempt + 1 < _MAX_RESPONSE_ATTEMPTS
            ):
                logger.warning(
                    "bioRxiv API returned %d; retrying once",
                    response.status_code,
                )
                continue
            logger.error("bioRxiv API returned %d", response.status_code)
            return None

        try:
            payload = response.json()
        except Exception as exc:
            last_parse_error = exc
            if attempt + 1 < _MAX_RESPONSE_ATTEMPTS:
                logger.warning("bioRxiv API returned unreadable JSON; retrying once")
                continue
            note_parse_failure_unless_transport(exc, "empty_or_invalid_json")
            logger.error("bioRxiv API returned unreadable JSON: %s", exc)
            return None

        if isinstance(payload, dict):
            return payload
        last_parse_error = TypeError("bioRxiv API response was not an object")
        if attempt + 1 < _MAX_RESPONSE_ATTEMPTS:
            logger.warning("bioRxiv API returned a malformed shape; retrying once")
            continue

    if last_parse_error is not None:
        note_parse_failure_unless_transport(last_parse_error, "malformed_json_shape")
        logger.error("bioRxiv API returned a malformed response shape")
    return None


def _describe_request(url: str, params: Mapping | None, body: Mapping | None) -> str | None:
    """A /details request: a server and a date range, with no terms in it.

    The cursor at the end of the path is paging, and is left out. The terms
    are not sent at all: resmon matches them in each record it reads.
    """
    if not url.startswith(_BIORXIV_API_BASE + "/"):
        return None
    server, *dates = url[len(_BIORXIV_API_BASE) + 1:].split("/")[:3]
    if len(dates) != 2:
        return None
    return (f"path /details/{server}/{dates[0]}/{dates[1]} (no terms: resmon "
            "matches them in each record it reads)")


def _local_today() -> date:
    """This computer's calendar day, which a run's own dates are counted in."""
    return date.today()


def _iso_day(text: object) -> date | None:
    try:
        return date.fromisoformat(str(text or "")[:10])
    except ValueError:
        return None


def _default_start(server: str, date_to: str | None) -> dict:
    """Where a search with no start date begins, and from what.

    The /details endpoint needs both ends of a range, and the terms are
    matched in each record read, so a search reads its range for at most
    ``_SEARCH_BUDGET_SECONDS``. Asked from the first month of each archive
    (2013 for bioRxiv), a search with no start stopped at its cap or its
    budget years before recent preprints, and before that it began at
    2020-01-01. The start is the catalog's ``default_start_days`` before the
    run, or before ``date_to`` when that is earlier, so an end date in the
    past still has a range to read.
    """
    days = constraints_for(server).default_start_days
    if not days:
        raise ValueError(f"the catalog gives {server} no default_start_days")
    today = _local_today()
    end = _iso_day(date_to)
    if end is not None and end < today:
        anchor, before = end, "end_date"
    else:
        anchor, before = today, "run"
    return {"date_from": (anchor - timedelta(days=days)).isoformat(),
            "days": days, "before": before}


def _padded_day(value: str | None) -> str | None:
    """A record's date as ``YYYY-MM-DD``.

    Some records carry their month and day unpadded: on October 31, 2026, the
    first three bioRxiv listed from October 30 on were dated "2026-8-17" and
    "2026-8-19". Compared as text, "2026-8-19" is later than "2026-10-30", so
    a run that stopped part-way said it had read preprints posted "between
    October 30, 2026 and August 19, 2026", and the paper was stored under a
    date written as nothing else in resmon writes one.
    """
    match = re.fullmatch(r"(\d{4})-(\d{1,2})-(\d{1,2})", value or "")
    if not match:
        return value
    year, month, day = match.groups()
    return f"{year}-{int(month):02d}-{int(day):02d}"


class BiorxivClient(BaseAPIClient):
    """bioRxiv / medRxiv repository API client."""

    describe_request = staticmethod(_describe_request)

    def __init__(self, server: str = "biorxiv"):
        """Initialize with server name: 'biorxiv' or 'medrxiv'."""
        self._server = server if server in ("biorxiv", "medrxiv") else "biorxiv"

    def get_name(self) -> str:
        return "bioRxiv" if self._server == "biorxiv" else "medRxiv"

    def search(
        self,
        query: str,
        date_from: str | None = None,
        date_to: str | None = None,
        max_results: int = 100,
        **kwargs,
    ) -> list[NormalizedResult]:
        if max_results <= 0:
            return []

        # The /details endpoint requires both ends of a range. An open start
        # is `_default_start`, noted so the run says where it began and why
        # (`note_default_start`), and an open end a date past anything posted.
        if date_from:
            d_from = date_from
        else:
            start = _default_start(self._server, date_to)
            d_from = start["date_from"]
            note_default_start(**start)
        d_to = date_to or "2099-12-31"
        deadline = time.monotonic() + _SEARCH_BUDGET_SECONDS

        # The endpoint lists a range oldest first, 30 records a page, and says
        # how many records the range holds. Read from the first page forward,
        # a search that stopped at its cap or its budget had read the oldest
        # part of the window, and a watch re-read the same oldest records on
        # every run and never reached the newest. The first page is now read
        # for the total, and the range is read from its end back
        # (`_newest_first`), newest first within each page, so a search cut
        # short has read the newest part, and `note_read` says how much of it
        # and which dates. Measured November 1, 2026: a cursor of the total
        # less 30 is answered with the range's last 30 records, a cursor off
        # the 30-record grid with the records from there to the end, and the
        # same page asked twice with the same records.
        first = self._page(0, d_from, d_to, deadline)
        if first is None:
            return []
        oldest, total = first

        query_lower = query.lower()
        results: list[NormalizedResult] = []
        # Each record once, should the list move under the read; a preprint's
        # versions are distinct records.
        seen: set[tuple[str, str]] = set()
        # How far the reading got: the records read, and the earliest and
        # latest dates among them.
        read = 0
        earliest: str | None = None
        latest: str | None = None

        for chunk in self._newest_first(oldest, total, d_from, d_to, deadline):
            for item in reversed(chunk):
                if isinstance(item, dict):
                    key = (str(item.get("doi")), str(item.get("version")))
                    if key in seen:
                        continue
                    seen.add(key)
                read += 1
                parsed = self._parse_item(item)
                if parsed is None:
                    continue
                posted = parsed.publication_date
                if posted:
                    earliest = posted if earliest is None else min(earliest, posted)
                    latest = posted if latest is None else max(latest, posted)
                # Client-side keyword filtering (bioRxiv API doesn't support keyword search)
                if self._matches_query(parsed, query_lower):
                    results.append(parsed)
                    if len(results) >= max_results:
                        break
            note_read(records=read, total=total or None,
                      first_date=earliest, last_date=latest, newest_first=True)
            if len(results) >= max_results:
                break

        return results[:max_results]

    def _newest_first(
        self, oldest: list, total: int, d_from: str, d_to: str, deadline: float,
    ) -> Iterator[list]:
        """The range's records in pages from its end back, the first page last.

        ``oldest`` is the first page, already read for the range's total.
        Each page asked for ends where the one before it began, and the last
        one asked for starts where ``oldest`` ends, so no record is asked for
        twice. A page that cannot be read ends the reading where it is, and
        ``oldest`` is then not reached: what was read is the newest part of
        the range, unbroken.
        """
        end = total
        held = len(oldest)
        while end > held:
            cursor = max(held, end - _PAGE_SIZE)
            page = self._page(cursor, d_from, d_to, deadline)
            if page is None or not page[0]:
                return
            yield page[0][: end - cursor]
            end = cursor
        yield oldest

    def _page(
        self, cursor: int, d_from: str, d_to: str, deadline: float,
    ) -> tuple[list, int] | None:
        """One page of the range and the range's total, or None where the reading stops.

        A range with no records is answered "no posts found", which is an
        empty answer and not a failure. An empty page with any other status
        ("Not available at this time" during upstream outages) is recorded as
        a failure, so the run says the source did not answer rather than
        reporting a quiet zero.
        """
        url = f"{_BIORXIV_API_BASE}/{self._server}/{d_from}/{d_to}/{cursor}"
        data = _request_json(url, deadline)
        if data is None:
            return None

        messages = data.get("messages")
        collection = data.get("collection")
        if (
            not isinstance(messages, list)
            or not all(isinstance(message, dict) for message in messages)
            or not isinstance(collection, list)
        ):
            note_parse_failure_unless_transport(
                TypeError("bioRxiv API response has invalid messages/collection"),
                "malformed_json_shape",
            )
            logger.error("bioRxiv API response has invalid messages/collection")
            return None
        status_value = messages[0].get("status") if messages else ""
        if status_value is None:
            status_msg = ""
        elif isinstance(status_value, str):
            status_msg = status_value
        else:
            note_parse_failure_unless_transport(
                TypeError("bioRxiv API status was not a string"),
                "malformed_json_shape",
            )
            logger.error("bioRxiv API response has an invalid status")
            return None

        if not collection:
            if status_msg and status_msg.lower() not in ("ok", _NO_POSTS):
                search_outcome().note_failure(
                    RuntimeError(
                        f"bioRxiv /details/{self._server} returned "
                        f"status={status_msg!r}"
                    ),
                    url,
                )
                logger.error(
                    "bioRxiv /details/%s reported unavailable: %s",
                    self._server,
                    status_msg,
                )
                return None
            return [], 0

        try:
            total = int(messages[0].get("total", 0)) if messages else 0
        except (TypeError, ValueError):
            note_parse_failure_unless_transport(
                TypeError("bioRxiv API total was not an integer"),
                "malformed_json_shape",
            )
            logger.error("bioRxiv API response has an invalid total")
            return None
        return collection, max(total, len(collection))

    @staticmethod
    def _matches_query(result: NormalizedResult, query_lower: str) -> bool:
        """Client-side keyword matching with OR semantics.

        A paper matches if any of the whitespace-separated query terms appears
        in its title or abstract. This mirrors the behavior users expect from
        multi-keyword search boxes (match any keyword, not all).
        """
        terms = [t for t in query_lower.split() if t]
        if not terms:
            return True
        text = f"{result.title} {result.abstract or ''}".lower()
        return any(term in text for term in terms)

    def _parse_item(self, item: object) -> NormalizedResult | None:
        if not isinstance(item, dict):
            note_parse_failure_unless_transport(
                TypeError("bioRxiv collection item was not an object"),
                "malformed_json_shape",
            )
            logger.warning("bioRxiv collection item was not an object; skipping it")
            return None
        title = item.get("title")
        if title is None or title == "":
            return None
        if not isinstance(title, str):
            note_parse_failure_unless_transport(
                TypeError("bioRxiv title was not a string"),
                "malformed_json_shape",
            )
            logger.warning("bioRxiv collection item has an invalid title; skipping it")
            return None

        doi = item.get("doi", "")
        if doi is None:
            doi = ""
        if not isinstance(doi, str):
            note_parse_failure_unless_transport(
                TypeError("bioRxiv DOI was not a string"),
                "malformed_json_shape",
            )
            logger.warning("bioRxiv collection item has an invalid DOI; skipping it")
            return None
        external_id = doi

        authors = []
        author_str = item.get("authors", "")
        if author_str and not isinstance(author_str, str):
            note_parse_failure_unless_transport(
                TypeError("bioRxiv authors was not a string"),
                "malformed_json_shape",
            )
            logger.warning("bioRxiv collection item has invalid authors; skipping it")
            return None
        if author_str:
            for name in author_str.split("; "):
                name = name.strip()
                if name:
                    authors.append(name)

        abstract = item.get("abstract")
        publication_date = item.get("date")  # YYYY-MM-DD, or unpadded
        category = item.get("category", "")
        if any(
            value is not None and not isinstance(value, str)
            for value in (abstract, publication_date, category)
        ):
            note_parse_failure_unless_transport(
                TypeError("bioRxiv text metadata had a non-string value"),
                "malformed_json_shape",
            )
            logger.warning("bioRxiv collection item has invalid text metadata; skipping it")
            return None

        url = f"https://doi.org/{doi}" if doi else ""
        publication_date = _padded_day(publication_date)

        categories = [category] if category else []

        return NormalizedResult(
            source_repository=self._server,
            external_id=external_id,
            doi=doi if doi else None,
            title=title,
            authors=authors,
            abstract=abstract,
            publication_date=publication_date,
            url=url,
            categories=categories,
        )


class MedrxivClient(BiorxivClient):
    """medRxiv client using the shared bioRxiv /details implementation."""

    def __init__(self) -> None:
        super().__init__(server="medrxiv")


# ---------------------------------------------------------------------------
# Registry auto-registration — each selectable source maps to a class.
# ---------------------------------------------------------------------------
def _register():
    from .api_registry import register_client
    register_client("biorxiv", BiorxivClient)
    register_client("medrxiv", MedrxivClient)

_register()
