"""Open Library public work-metadata search client."""

import calendar
import html
import logging
import re

from .api_base import BaseAPIClient, NormalizedResult, RateLimiter, safe_request

logger = logging.getLogger(__name__)

_OPENLIBRARY_API_URL = "https://openlibrary.org/search.json"
_OPENLIBRARY_FIELDS = "key,title,author_name,first_publish_year,subject"
_USER_AGENT = "resmon (+https://github.com/ryanjosephkamp/resmon/issues)"

# Open Library allows one request per second for unidentified clients. The
# project issue URL identifies the application without sending a maintainer's
# personal contact address, so resmon keeps the unidentified-client ceiling.
_RATE_LIMITER = RateLimiter(requests_per_second=1.0)

_PARTIAL_DATE = re.compile(r"^\d{4}(?:-\d{2}(?:-\d{2})?)?$")
_WORK_KEY = re.compile(r"^/works/[A-Za-z0-9][A-Za-z0-9._~-]*$")


def _date_interval(value: str | None) -> tuple[str, str] | None:
    """Expand a partial ISO date while retaining its actual precision."""
    if not value or not _PARTIAL_DATE.fullmatch(value):
        return None
    year_string = _normalized_publication_year(value[:4])
    if year_string is None:
        return None
    year = int(year_string)
    if len(value) == 4:
        return f"{year_string}-01-01", f"{year_string}-12-31"
    if len(value) == 7:
        try:
            month = int(value[5:7])
            last_day = calendar.monthrange(year, month)[1]
        except (ValueError, IndexError):
            return None
        return (
            f"{year_string}-{value[5:7]}-01",
            f"{year_string}-{value[5:7]}-{last_day:02d}",
        )
    try:
        month = int(value[5:7])
        day = int(value[8:10])
        last_day = calendar.monthrange(year, month)[1]
    except (ValueError, IndexError):
        return None
    if not 1 <= day <= last_day:
        return None
    return value, value


def _search_year_bounds(
    date_from: str | None,
    date_to: str | None,
) -> tuple[int | None, int | None, str | None, str | None] | None:
    """Return only publication years wholly contained by the request window."""
    lower = None
    if date_from:
        interval = _date_interval(date_from)
        if interval is None:
            return None
        lower = interval[0]

    upper = None
    if date_to:
        interval = _date_interval(date_to)
        if interval is None:
            return None
        upper = interval[1]

    if lower and upper and lower > upper:
        return None

    year_from = None
    if lower:
        year_from = int(lower[:4])
        if lower[5:] != "01-01":
            year_from += 1

    year_to = None
    if upper:
        year_to = int(upper[:4])
        if upper[5:] != "12-31":
            year_to -= 1

    if year_from is not None and year_to is not None and year_from > year_to:
        return None
    return year_from, year_to, lower, upper


def _publication_year_clause(year_from: int | None, year_to: int | None) -> str | None:
    """Build Open Library's fielded query for its year-only work field."""
    if year_from is not None and year_to is not None:
        if year_from == year_to:
            return f"first_publish_year:{year_from}"
        return f"first_publish_year:[{year_from} TO {year_to}]"
    if year_from is not None:
        return f"first_publish_year:[{year_from} TO *]"
    if year_to is not None:
        return f"first_publish_year:[* TO {year_to}]"
    return None


def _inside_requested_window(
    value: str | None,
    date_from: str | None,
    date_to: str | None,
) -> bool:
    interval = _date_interval(value)
    if interval is None:
        return False
    lower, upper = interval
    if date_from and lower < date_from:
        return False
    if date_to and upper > date_to:
        return False
    return True


def _string_list(value: object) -> list[str]:
    if not isinstance(value, list):
        return []
    return [
        html.unescape(item).strip()
        for item in value
        if isinstance(item, str) and item.strip()
    ]


def _normalized_publication_year(value: object) -> str | None:
    """Return a source year only when its range and precision are valid."""
    if isinstance(value, int):
        year = value
    elif isinstance(value, str) and re.fullmatch(r"\d{4}", value.strip()):
        year = int(value.strip())
    else:
        return None
    return str(year) if 1000 <= year <= 9999 else None


class OpenLibraryClient(BaseAPIClient):
    """Search Open Library work metadata without authentication."""

    def get_name(self) -> str:
        return "Open Library"

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

        bounds = _search_year_bounds(date_from, date_to)
        if bounds is None:
            # The source exposes only a publication year. Returning a work for
            # a window that does not contain a whole year would overstate what
            # resmon knows about its publication date.
            return []
        year_from, year_to, normalized_from, normalized_to = bounds

        search_query = query.strip()
        year_clause = _publication_year_clause(year_from, year_to)
        if year_clause:
            search_query = (
                f"({search_query}) AND {year_clause}"
                if search_query else year_clause
            )

        results: list[NormalizedResult] = []
        page = 1
        page_size = min(max_results, 100)
        seen_records = 0

        while len(results) < max_results:
            params = {
                "q": search_query,
                "page": page,
                "limit": page_size,
                "fields": _OPENLIBRARY_FIELDS,
            }
            try:
                response = safe_request(
                    "GET",
                    _OPENLIBRARY_API_URL,
                    params=params,
                    headers={"User-Agent": _USER_AGENT},
                    rate_limiter=_RATE_LIMITER,
                )
                if response.status_code != 200:
                    logger.error("Open Library API returned %d", response.status_code)
                    return []
                payload = response.json()
            except Exception:
                logger.exception("Open Library API request failed")
                return []

            if not isinstance(payload, dict):
                logger.error("Open Library API returned a non-object response")
                return []
            records = payload.get("docs")
            if not isinstance(records, list):
                logger.error("Open Library API response has no docs list")
                return []
            if not records:
                break

            for record in records:
                parsed = self._parse_record(record)
                if parsed is None:
                    continue
                if (
                    (date_from or date_to)
                    and not _inside_requested_window(
                        parsed.publication_date, normalized_from, normalized_to,
                    )
                ):
                    continue
                results.append(parsed)
                if len(results) >= max_results:
                    break

            seen_records += len(records)
            total = payload.get("numFound")
            if isinstance(total, int) and seen_records >= total:
                break
            if len(records) < page_size:
                break
            page += 1

        return results[:max_results]

    @staticmethod
    def _parse_record(record: object) -> NormalizedResult | None:
        if not isinstance(record, dict):
            logger.warning("Open Library record was not an object; skipping it")
            return None

        key_value = record.get("key")
        title_value = record.get("title")
        key = key_value.strip() if isinstance(key_value, str) else ""
        title = html.unescape(title_value).strip() if isinstance(title_value, str) else ""
        if not _WORK_KEY.fullmatch(key) or not title:
            logger.warning("Open Library record has no stable key or title; skipping it")
            return None

        publication_date = _normalized_publication_year(
            record.get("first_publish_year"),
        )

        return NormalizedResult(
            source_repository="openlibrary",
            external_id=key,
            doi=None,
            title=title,
            authors=_string_list(record.get("author_name")),
            abstract=None,
            publication_date=publication_date,
            url=f"https://openlibrary.org{key}",
            categories=_string_list(record.get("subject"))[:10],
        )


def _register() -> None:
    from .api_registry import register_client
    register_client("openlibrary", OpenLibraryClient)


_register()
