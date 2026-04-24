# resmon_scripts/implementation_scripts/api_doaj.py
"""DOAJ API client — JSON, Lucene query syntax, page-based pagination."""

import logging

from .api_base import BaseAPIClient, NormalizedResult, RateLimiter, safe_request

logger = logging.getLogger(__name__)

_DOAJ_API_URL = "https://doaj.org/api/search/articles"

# Conservative: 5 req/s
_RATE_LIMITER = RateLimiter(requests_per_second=5.0)


class DoajClient(BaseAPIClient):
    """DOAJ repository API client."""

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
            search_query += f" AND bibjson.year:[{d_from[:4]} TO {d_to[:4]}]"

        results: list[NormalizedResult] = []
        page = 1
        page_size = min(max_results, 100)

        while len(results) < max_results:
            url = f"{_DOAJ_API_URL}/{search_query}"
            params = {
                "page": page,
                "pageSize": min(page_size, max_results - len(results)),
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

            data = response.json()
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
        authors = []
        for author in bibjson.get("author", []):
            name = author.get("name", "").strip()
            if name:
                authors.append(name)

        abstract = bibjson.get("abstract")

        # Date
        year = bibjson.get("year")
        month = bibjson.get("month", "01")
        if year:
            publication_date = f"{year}-{str(month).zfill(2)}-01"
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
