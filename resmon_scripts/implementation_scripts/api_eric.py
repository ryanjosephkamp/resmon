# resmon_scripts/implementation_scripts/api_eric.py
"""ERIC public education-research API client."""

import calendar
import html
import logging
import re
from urllib.parse import quote, unquote, urlparse

from .api_base import (
    BaseAPIClient,
    NormalizedResult,
    RateLimiter,
    note_parse_failure_unless_transport,
    note_unanswerable,
    safe_request,
)

logger = logging.getLogger(__name__)

_ERIC_API_URL = "https://api.ies.ed.gov/eric/"
_ERIC_FIELDS = (
    "id,title,author,description,publicationdateyear,subject,"
    "url"
)

# ERIC publishes no numeric API limit. One request every two seconds is a
# conservative local ceiling for this anonymous public service.
_RATE_LIMITER = RateLimiter(requests_per_second=0.5)

_PARTIAL_DATE = re.compile(r"^\d{4}(?:-\d{2}(?:-\d{2})?)?$")


def _publication_year_clause(
    year_from: int | None,
    year_to: int | None,
) -> str | None:
    """Build a query over ERIC's year-only publication date field."""
    if year_from is not None and year_to is not None:
        if year_from == year_to:
            return f"publicationdateyear:{year_from}"
        years = " OR ".join(
            f"publicationdateyear:{year}" for year in range(year_from, year_to + 1)
        )
        return f"({years})"
    if year_from is not None:
        return f"publicationdateyear:[{year_from} TO *]"
    if year_to is not None:
        return f"publicationdateyear:[* TO {year_to}]"
    return None


def _date_interval(value: str | None) -> tuple[str, str] | None:
    """Expand a partial ISO date while retaining its actual precision."""
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


def _search_year_bounds(
    date_from: str | None,
    date_to: str | None,
) -> tuple[int | None, int | None, str | None, str | None] | None:
    """Return only publication years provably contained by the window."""
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


def _doi_from_url(value: object) -> str | None:
    if not isinstance(value, str) or not value.strip():
        return None
    parsed = urlparse(value.strip())
    if parsed.hostname not in {"doi.org", "dx.doi.org"}:
        return None
    doi = unquote(parsed.path).lstrip("/").strip()
    return doi or None


class EricClient(BaseAPIClient):
    """Search public ERIC metadata without authentication."""

    def get_name(self) -> str:
        return "ERIC"

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
            # ERIC exposes only a publication year. If no whole calendar year
            # fits, any returned record would have unknowable in-window status.
            #
            # No HTTP call is made, so ``safe_request`` records nothing and the
            # engine would otherwise have to report this zero as "not
            # recorded". The refusal is a fact resmon knows, and it is the
            # answer the user is actually looking for.
            note_unanswerable("year_granularity")
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
        start = 0
        page_size = min(max_results, 2000)

        while len(results) < max_results:
            params: dict[str, object] = {
                "search": search_query,
                "format": "json",
                "start": start,
                "rows": page_size,
                "fields": _ERIC_FIELDS,
            }
            try:
                response = safe_request(
                    "GET",
                    _ERIC_API_URL,
                    params=params,
                    rate_limiter=_RATE_LIMITER,
                )
                if response.status_code != 200:
                    logger.error("ERIC API returned %d", response.status_code)
                    break
                payload = response.json()
            except Exception as exc:
                logger.exception("ERIC API request failed")
                # A reply that arrived and would not parse is a
                # different fact from a source that never answered;
                # safe_request has already recorded the second kind.
                note_parse_failure_unless_transport(exc)
                break

            if not isinstance(payload, dict):
                logger.error("ERIC API response was not an object")
                break
            response_data = payload.get("response")
            if not isinstance(response_data, dict):
                logger.error("ERIC API response has no response object")
                break
            records = response_data.get("docs")
            if not isinstance(records, list):
                logger.error("ERIC API response has no response.docs list")
                break
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

            start += len(records)
            try:
                total = int(response_data.get("numFound"))
            except (TypeError, ValueError):
                total = None
            if total is not None and start >= total:
                break
            if len(records) < page_size:
                break

        return results[:max_results]

    @staticmethod
    def _parse_record(record: object) -> NormalizedResult | None:
        if not isinstance(record, dict):
            logger.warning("ERIC record was not an object; skipping it")
            return None

        external_id_value = record.get("id")
        title_value = record.get("title")
        external_id = (
            external_id_value.strip()
            if isinstance(external_id_value, str) else ""
        )
        title = (
            html.unescape(title_value).strip()
            if isinstance(title_value, str) else ""
        )
        if not external_id or not title:
            logger.warning(
                "ERIC record %r has no stable id or title; skipping it",
                record.get("id"),
            )
            return None

        publication_year = record.get("publicationdateyear")
        publication_date = None
        if publication_year is not None:
            candidate = str(publication_year).strip()
            if _PARTIAL_DATE.fullmatch(candidate):
                publication_date = candidate

        descriptions = _string_list(record.get("description"))
        subjects = _string_list(record.get("subject"))

        return NormalizedResult(
            source_repository="eric",
            external_id=external_id,
            doi=_doi_from_url(record.get("url")),
            title=title,
            authors=_string_list(record.get("author")),
            abstract=descriptions[0] if descriptions else None,
            publication_date=publication_date,
            url=f"https://eric.ed.gov/?id={quote(external_id, safe='')}",
            categories=subjects[:10],
        )


def _register() -> None:
    from .api_registry import register_client
    register_client("eric", EricClient)


_register()
