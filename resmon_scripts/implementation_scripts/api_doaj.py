# resmon_scripts/implementation_scripts/api_doaj.py
"""DOAJ API client — JSON, Lucene query syntax, page-based pagination."""

import logging
from typing import Mapping
from urllib.parse import urlsplit

from .api_base import (Author, BaseAPIClient, NormalizedResult, RateLimiter,
                       bare_orcid, read_json_body, safe_request)
from .utils import month_from_name

logger = logging.getLogger(__name__)

_DOAJ_API_URL = "https://doaj.org/api/search/articles"

# Conservative: 5 req/s
_RATE_LIMITER = RateLimiter(requests_per_second=5.0)


def _month_number(month: object) -> str:
    """``bibjson.month`` as two digits, or ``01`` when it cannot be read.

    DOAJ gives the month as a number, a number in a string, or a name
    ("January", "Jul"). The name used to be zero-padded as it came, storing
    ``2025-January-01``: a date nothing else in resmon can read, so month
    buckets, the discovery-lag view's ``julianday`` and the explorer's date
    order all misread it. A month that is missing or unreadable falls back to
    the year alone, as a missing one always has; the catalog says DOAJ dates
    papers only to the year.
    """
    text = str(month).strip().lower().rstrip(".") if month is not None else ""
    if text.isdigit() and 1 <= int(text) <= 12:
        return f"{int(text):02d}"
    number = month_from_name(text)
    return f"{number:02d}" if number else "01"


def _describe_request(url: str, params: Mapping | None, body: Mapping | None) -> str | None:
    """A DOAJ search carries its query in the request path, not in a parameter."""
    if not url.startswith(_DOAJ_API_URL + "/"):
        return None
    return "path " + urlsplit(url).path


class DoajClient(BaseAPIClient):
    """DOAJ repository API client."""

    describe_request = staticmethod(_describe_request)

    def get_name(self) -> str:
        return "DOAJ"

    def search(
        self,
        query: str,
        date_from: str | None = None,
        date_to: str | None = None,
        max_results: int = 100,
        **kwargs,
    ) -> list[NormalizedResult]:
        # DOAJ uses Lucene query syntax
        search_query = query
        if date_from or date_to:
            d_from = date_from or "1900-01-01"
            d_to = date_to or "2099-12-31"
            # In parentheses, so the date clause applies to the whole query.
            # Appended bare, it changed what an explicit OR meant: on October
            # 30, 2026, `climate OR model AND bibjson.year:[2024 TO 2024]` matched
            # 206,374 where `(climate OR model) AND ...` matched 230,717.
            # DataCite, ERIC, Open Library and Zenodo already group theirs.
            # Plain words changed too: dated to 2024, `climate model` matched
            # 9,249 bare and 7,704 grouped.
            date_clause = f"bibjson.year:[{d_from[:4]} TO {d_to[:4]}]"
            search_query = (
                f"({search_query}) AND {date_clause}"
                if search_query.strip() else date_clause
            )

        results: list[NormalizedResult] = []
        page = 1
        page_size = min(max_results, 100)

        while len(results) < max_results:
            url = f"{_DOAJ_API_URL}/{search_query}"
            # A page number is an offset *over the page size*, so the size is
            # held for the whole search. Shrinking it on the last request
            # moves the window back over records already held and never asks
            # for the tail — the same hazard ``api_zenodo.py`` documents and
            # pins its size for. The overshoot is trimmed by the
            # ``results[:max_results]`` this loop already ends with.
            params = {
                "page": page,
                "pageSize": page_size,
            }

            try:
                response = safe_request(
                    "GET", url,
                    params=params,
                    rate_limiter=_RATE_LIMITER,
                )
                if response.status_code != 200:
                    logger.error("DOAJ API returned %d", response.status_code)
                    break
            except Exception:
                logger.exception("DOAJ API request failed")
                break

            data = read_json_body(response, "DOAJ")
            if data is None:
                break

            items = data.get("results", [])
            if not items:
                break

            for item in items:
                parsed = self._parse_article(item)
                if parsed is not None:
                    results.append(parsed)

            page += 1
            total = data.get("total", 0)
            if len(results) >= total or len(items) < params["pageSize"]:
                break

        return results[:max_results]

    @staticmethod
    def _parse_article(item: dict) -> NormalizedResult | None:
        bibjson = item.get("bibjson", {})
        title = bibjson.get("title")
        if not title:
            return None

        external_id = item.get("id", "")

        # DOI
        doi = None
        for identifier in bibjson.get("identifier", []):
            if identifier.get("type") == "doi":
                doi = identifier.get("id")
                break

        # Authors
        # 2.1 — DOAJ carries an affiliation on essentially every author (**72 of
        # 72** in the 2026-09-06 sample) and an ORCID on none of them, so only
        # the affiliation is read. `orcid_id` exists in the schema and was empty
        # throughout; a client that filled it from an empty field would be
        # claiming an identity DOAJ never sent.
        authors = []
        for author in bibjson.get("author", []):
            name = author.get("name", "").strip()
            if not name:
                continue
            affiliation = (author.get("affiliation") or "").strip()
            authors.append(Author(
                name=name,
                orcid=bare_orcid(author.get("orcid_id")),
                affiliations=(affiliation,) if affiliation else (),
            ))

        abstract = bibjson.get("abstract")

        # Date
        year = bibjson.get("year")
        if year:
            publication_date = f"{year}-{_month_number(bibjson.get('month'))}-01"
        else:
            publication_date = None

        # URL
        url = ""
        for link in bibjson.get("link", []):
            if link.get("type") == "fulltext":
                url = link.get("url", "")
                break
        if not url and doi:
            url = f"https://doi.org/{doi}"

        # Subject / keywords
        categories = []
        for subj in bibjson.get("subject", []):
            term = subj.get("term", "").strip()
            if term:
                categories.append(term)
        categories.extend(bibjson.get("keywords", []))

        return NormalizedResult(
            source_repository="doaj",
            external_id=external_id,
            doi=doi,
            title=title,
            authors=authors,
            abstract=abstract,
            publication_date=publication_date,
            url=url,
            categories=categories[:10],
        )


# ---------------------------------------------------------------------------
# Registry auto-registration
# ---------------------------------------------------------------------------
def _register():
    from .api_registry import register_client
    register_client("doaj", DoajClient)

_register()
