# resmon_scripts/implementation_scripts/api_datacite.py
"""DataCite public DOI metadata API client."""

import calendar
import logging
import re

from .api_base import BaseAPIClient, NormalizedResult, RateLimiter, safe_request

logger = logging.getLogger(__name__)

_DATACITE_API_URL = "https://api.datacite.org/dois"

# Unidentified public requests are limited to 500 per five minutes per IP.
# Leave ten percent headroom below that published ceiling.
_RATE_LIMITER = RateLimiter(requests_per_second=1.5)

_PARTIAL_DATE = re.compile(r"^\d{4}(?:-\d{2}(?:-\d{2})?)?$")


def _year(value: str | None) -> int | None:
    if not value or len(value) < 4 or not value[:4].isdigit():
        return None
    return int(value[:4])


def _publication_year_filter(
    date_from: str | None,
    date_to: str | None,
) -> str | None:
    """Return DataCite's documented comma-separated publication years."""
    year_from = _year(date_from)
    year_to = _year(date_to)
    if year_from is None or year_to is None or year_from > year_to:
        return None
    # The published filter accepts at most ten comma-separated years.
    if year_to - year_from >= 10:
        return None
    return ",".join(str(year) for year in range(year_from, year_to + 1))


def _date_interval(value: str | None) -> tuple[str, str] | None:
    """Expand a precise or partial ISO date without inventing precision."""
    if not value or not _PARTIAL_DATE.fullmatch(value):
        return None
    if len(value) == 4:
        return f"{value}-01-01", f"{value}-12-31"
    if len(value) == 7:
        year = int(value[:4])
        month = int(value[5:7])
        if not 1 <= month <= 12:
            return None
        last_day = calendar.monthrange(year, month)[1]
        return f"{value}-01", f"{value}-{last_day:02d}"
    try:
        year = int(value[:4])
        month = int(value[5:7])
        day = int(value[8:10])
        calendar.monthrange(year, month)
        if not 1 <= day <= calendar.monthrange(year, month)[1]:
            return None
    except (ValueError, IndexError):
        return None
    return value, value


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


class DataCiteClient(BaseAPIClient):
    """Search Findable DataCite DOI metadata without authentication."""

    def get_name(self) -> str:
        return "DataCite"

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

        search_query = query.strip()
        published_years = _publication_year_filter(date_from, date_to)
        if (date_from or date_to) and published_years is None:
            # DataCite's dedicated published filter is year-only and accepts at
            # most ten years. OpenSearch ranges cover one-sided or wider bounds.
            lower = str(_year(date_from)) if _year(date_from) is not None else "*"
            upper = str(_year(date_to)) if _year(date_to) is not None else "*"
            date_clause = f"publicationYear:[{lower} TO {upper}]"
            search_query = (
                f"({search_query}) AND {date_clause}"
                if search_query else date_clause
            )

        results: list[NormalizedResult] = []
        page = 1
        page_size = min(max_results, 1000)

        while len(results) < max_results:
            params: dict[str, object] = {
                "query": search_query,
                "page[size]": page_size,
                "page[number]": page,
                "sort": "relevance",
            }
            if published_years is not None:
                params["published"] = published_years

            try:
                response = safe_request(
                    "GET",
                    _DATACITE_API_URL,
                    params=params,
                    rate_limiter=_RATE_LIMITER,
                )
                if response.status_code != 200:
                    logger.error("DataCite API returned %d", response.status_code)
                    break
                payload = response.json()
            except Exception:
                logger.exception("DataCite API request failed")
                break

            if not isinstance(payload, dict):
                logger.error("DataCite API returned a non-object response")
                break
            records = payload.get("data")
            if not isinstance(records, list):
                logger.error("DataCite API response has no data list")
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
                        parsed.publication_date, date_from, date_to,
                    )
                ):
                    continue
                results.append(parsed)
                if len(results) >= max_results:
                    break

            total_pages = None
            meta = payload.get("meta")
            if isinstance(meta, dict):
                try:
                    total_pages = int(meta.get("totalPages"))
                except (TypeError, ValueError):
                    total_pages = None
            if total_pages is not None and page >= total_pages:
                break
            if len(records) < page_size:
                break
            page += 1

        return results[:max_results]

    @staticmethod
    def _parse_record(record: object) -> NormalizedResult | None:
        if not isinstance(record, dict):
            logger.warning("DataCite record was not an object; skipping it")
            return None
        attributes = record.get("attributes")
        if not isinstance(attributes, dict):
            logger.warning("DataCite record has no attributes object; skipping it")
            return None

        doi_value = attributes.get("doi") or record.get("id")
        doi = doi_value.strip() if isinstance(doi_value, str) else ""

        title = None
        fallback_title = None
        titles = attributes.get("titles")
        if isinstance(titles, list):
            for title_node in titles:
                if not isinstance(title_node, dict):
                    continue
                value = title_node.get("title")
                if not isinstance(value, str) or not value.strip():
                    continue
                if fallback_title is None:
                    fallback_title = value.strip()
                if not title_node.get("titleType"):
                    title = value.strip()
                    break
        title = title or fallback_title
        if not doi or not title:
            logger.warning(
                "DataCite record %r has no stable DOI or title; skipping it",
                record.get("id"),
            )
            return None

        authors: list[str] = []
        creators = attributes.get("creators")
        if isinstance(creators, list):
            for creator in creators:
                if not isinstance(creator, dict):
                    continue
                name = creator.get("name")
                if isinstance(name, str) and name.strip():
                    authors.append(name.strip())

        abstract = None
        descriptions = attributes.get("descriptions")
        if isinstance(descriptions, list):
            for description in descriptions:
                if (
                    not isinstance(description, dict)
                    or description.get("descriptionType") != "Abstract"
                ):
                    continue
                value = description.get("description")
                if isinstance(value, str) and value.strip():
                    abstract = value.strip()
                    break

        publication_date = None
        dates = attributes.get("dates")
        if isinstance(dates, list):
            for date_node in dates:
                if (
                    not isinstance(date_node, dict)
                    or date_node.get("dateType") != "Issued"
                ):
                    continue
                value = date_node.get("date")
                if isinstance(value, str) and _PARTIAL_DATE.fullmatch(value.strip()):
                    publication_date = value.strip()
                    break
        if publication_date is None:
            year_value = attributes.get("publicationYear")
            if year_value is not None and str(year_value).isdigit():
                publication_date = str(year_value)

        categories: list[str] = []
        subjects = attributes.get("subjects")
        if isinstance(subjects, list):
            for subject_node in subjects:
                if not isinstance(subject_node, dict):
                    continue
                subject = subject_node.get("subject")
                if isinstance(subject, str) and subject.strip():
                    categories.append(subject.strip())
                    if len(categories) >= 10:
                        break

        return NormalizedResult(
            source_repository="datacite",
            external_id=doi,
            doi=doi,
            title=title,
            authors=authors,
            abstract=abstract,
            publication_date=publication_date,
            url=f"https://doi.org/{doi}",
            categories=categories,
        )


def _register() -> None:
    from .api_registry import register_client
    register_client("datacite", DataCiteClient)


_register()
