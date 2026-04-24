# resmon_scripts/implementation_scripts/api_europepmc.py
"""EuropePMC API client — JSON, Lucene query syntax, cursor-based pagination."""

import logging

from .api_base import BaseAPIClient, NormalizedResult, RateLimiter, safe_request

logger = logging.getLogger(__name__)

_EUROPEPMC_API_URL = "https://www.ebi.ac.uk/europepmc/webservices/rest/search"

# Conservative: 5 req/s
_RATE_LIMITER = RateLimiter(requests_per_second=5.0)


class EuropepmcClient(BaseAPIClient):
    """EuropePMC repository API client."""

    def get_name(self) -> str:
        return "EuropePMC"

    def search(
        self,
        query: str,
        date_from: str | None = None,
        date_to: str | None = None,
        max_results: int = 100,
        **kwargs,
    ) -> list[NormalizedResult]:
        # Build Lucene query with optional date filtering
        search_query = query
        if date_from or date_to:
            d_from = date_from or "1900-01-01"
            d_to = date_to or "2099-12-31"
            search_query += f" AND FIRST_PDATE:[{d_from} TO {d_to}]"

        results: list[NormalizedResult] = []
        cursor_mark = "*"
        page_size = min(max_results, 1000)

        while len(results) < max_results:
            params = {
                "query": search_query,
                "format": "json",
                "pageSize": min(page_size, max_results - len(results)),
                "cursorMark": cursor_mark,
                "resultType": "core",
            }

            try:
                response = safe_request(
                    "GET", _EUROPEPMC_API_URL,
                    params=params,
                    rate_limiter=_RATE_LIMITER,
                )
                if response.status_code != 200:
                    logger.error("EuropePMC API returned %d", response.status_code)
                    break
            except Exception:
                logger.exception("EuropePMC API request failed")
                break

            data = response.json()
            result_list = data.get("resultList", {}).get("result", [])
            if not result_list:
                break

            for item in result_list:
                parsed = self._parse_result(item)
                if parsed is not None:
                    results.append(parsed)

            next_cursor = data.get("nextCursorMark")
            if not next_cursor or next_cursor == cursor_mark:
                break
            cursor_mark = next_cursor

        return results[:max_results]

    @staticmethod
    def _parse_result(item: dict) -> NormalizedResult | None:
        title = item.get("title")
        if not title:
            return None

        external_id = item.get("id", "")
        source = item.get("source", "")
        # Compose a unique ID from source + id
        if source:
            external_id = f"{source}:{external_id}"

        doi = item.get("doi")

        authors = []
        author_str = item.get("authorString", "")
        if author_str:
            # EuropePMC returns "Author A, Author B, Author C."
            for name in author_str.rstrip(".").split(", "):
                name = name.strip()
                if name:
                    authors.append(name)

        abstract = item.get("abstractText")

        # Date
        pub_date_str = item.get("firstPublicationDate")  # YYYY-MM-DD
        publication_date = pub_date_str if pub_date_str else None

        # URL
        pmid = item.get("pmid")
        if pmid:
            url = f"https://europepmc.org/article/MED/{pmid}"
        elif doi:
            url = f"https://doi.org/{doi}"
        else:
            url = f"https://europepmc.org/search?query={external_id}"

        categories = []
        mesh_terms = item.get("meshHeadingList", {}).get("meshHeading", [])
        for mesh in mesh_terms:
            name = mesh.get("descriptorName")
            if name:
                categories.append(name)

        return NormalizedResult(
            source_repository="europepmc",
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
    register_client("europepmc", EuropepmcClient)

_register()
