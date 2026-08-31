# resmon_scripts/implementation_scripts/api_osti.py
"""OSTI.GOV public research-record API client."""

import calendar
import html
import logging
import re
from urllib.parse import unquote, urlparse

from .api_base import BaseAPIClient, NormalizedResult, RateLimiter, safe_request

logger = logging.getLogger(__name__)

_OSTI_API_URL = "https://www.osti.gov/api/v1/records"

# OSTI publishes no numeric API limit and prohibits excessive automated
# requests. One request every two seconds is a conservative local ceiling.
_RATE_LIMITER = RateLimiter(requests_per_second=0.5)

_PARTIAL_DATE = re.compile(r"^\d{4}(?:-\d{2}(?:-\d{2})?)?$")
_NEXT_LINK = re.compile(r"rel=\"?next\"?")


def _date_interval(value: str | None) -> tuple[str, str] | None:
    """Expand a partial ISO date without inventing record precision."""
    if not value or not _PARTIAL_DATE.fullmatch(value):
        return None
    if len(value) == 4:
        return f"{value}-01-01", f"{value}-12-31"
    if len(value) == 7:
        try:
            year = int(value[:4])
            month = int(value[5:7])
            last_day = calendar.monthrange(year, month)[1]
        except (ValueError, IndexError):
            return None
        return f"{value}-01", f"{value}-{last_day:02d}"
    try:
        year = int(value[:4])
        month = int(value[5:7])
        day = int(value[8:10])
        last_day = calendar.monthrange(year, month)[1]
    except (ValueError, IndexError):
        return None
    if not 1 <= day <= last_day:
        return None
    return value, value


def _requested_bounds(
    date_from: str | None,
    date_to: str | None,
) -> tuple[str | None, str | None] | None:
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
    return lower, upper


def _osti_date(value: str) -> str:
    """Convert a validated ISO date to OSTI's MM/DD/YYYY parameter format."""
    return f"{value[5:7]}/{value[8:10]}/{value[:4]}"


def _publication_date(value: object) -> str | None:
    if not isinstance(value, str) or len(value) < 10:
        return None
    candidate = value[:10]
    interval = _date_interval(candidate)
    if interval is None or interval[0] != interval[1]:
        return None
    return candidate


def _inside_requested_window(
    value: str | None,
    date_from: str | None,
    date_to: str | None,
) -> bool:
    if value is None:
        return False
    if date_from and value < date_from:
        return False
    if date_to and value > date_to:
        return False
    return True


def _string_list(value: object) -> list[str]:
    if isinstance(value, str):
        values = [value]
    elif isinstance(value, list):
        values = value
    else:
        return []
    return [
        html.unescape(item).strip()
        for item in values
        if isinstance(item, str) and item.strip()
    ]


def _normalize_doi(value: object) -> str | None:
    if not isinstance(value, str) or not value.strip():
        return None
    candidate = value.strip()
    parsed = urlparse(candidate)
    if parsed.hostname in {"doi.org", "dx.doi.org"}:
        candidate = unquote(parsed.path).lstrip("/")
    elif candidate.lower().startswith("doi:"):
        candidate = candidate[4:]
    candidate = candidate.strip()
    return candidate or None


class OstiClient(BaseAPIClient):
    """Search public OSTI.GOV metadata without authentication."""

    def get_name(self) -> str:
        return "OSTI.GOV"

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

        bounds = _requested_bounds(date_from, date_to)
        if bounds is None:
            return []
        normalized_from, normalized_to = bounds

        results: list[NormalizedResult] = []
        page = 1
        # OSTI documents no maximum rows value; 100 is the documented example
        # size and keeps individual responses bounded.
        page_size = min(max_results, 100)
        # Do not let malformed or unexpectedly out-of-window records turn a
        # bounded result request into an open-ended crawl of the repository.
        page_limit = (max_results + page_size - 1) // page_size

        while len(results) < max_results and page <= page_limit:
            params: dict[str, object] = {
                "q": query.strip(),
                "page": page,
                "rows": page_size,
            }
            if normalized_from:
                params["publication_date_start"] = _osti_date(normalized_from)
            if normalized_to:
                params["publication_date_end"] = _osti_date(normalized_to)

            try:
                response = safe_request(
                    "GET",
                    _OSTI_API_URL,
                    params=params,
                    headers={"Accept": "application/json"},
                    rate_limiter=_RATE_LIMITER,
                )
                if response.status_code != 200:
                    logger.error("OSTI API returned %d", response.status_code)
                    break
                payload = response.json()
            except Exception:
                logger.exception("OSTI API request failed")
                break

            if not isinstance(payload, list):
                logger.error("OSTI API response was not a record list")
                break
            if not payload:
                break

            for record in payload:
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

            headers = getattr(response, "headers", {})
            link_header = headers.get("Link", "") if headers else ""
            if not _NEXT_LINK.search(link_header):
                break
            page += 1

        return results[:max_results]

    @staticmethod
    def _parse_record(record: object) -> NormalizedResult | None:
        if not isinstance(record, dict):
            logger.warning("OSTI record was not an object; skipping it")
            return None

        identifier = record.get("osti_id")
        external_id = str(identifier).strip() if identifier is not None else ""
        title_value = record.get("title")
        title = (
            html.unescape(title_value).strip()
            if isinstance(title_value, str) else ""
        )
        if not external_id or not title:
            logger.warning(
                "OSTI record %r has no stable id or title; skipping it",
                record.get("osti_id"),
            )
            return None

        citation_url = None
        links = record.get("links")
        if isinstance(links, list):
            for link in links:
                if not isinstance(link, dict) or link.get("rel") != "citation":
                    continue
                href = link.get("href")
                if isinstance(href, str) and href.strip():
                    citation_url = href.strip()
                    break

        descriptions = _string_list(record.get("description"))
        subjects = _string_list(record.get("subjects"))

        return NormalizedResult(
            source_repository="osti",
            external_id=external_id,
            doi=_normalize_doi(record.get("doi")),
            title=title,
            authors=_string_list(record.get("authors")),
            abstract=descriptions[0] if descriptions else None,
            publication_date=_publication_date(record.get("publication_date")),
            url=citation_url or f"https://www.osti.gov/biblio/{external_id}",
            categories=subjects[:10],
        )


def _register() -> None:
    from .api_registry import register_client
    register_client("osti", OstiClient)


_register()
