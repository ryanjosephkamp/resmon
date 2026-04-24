# resmon_scripts/implementation_scripts/api_crossref.py
"""CrossRef API client — JSON response, polite pool with mailto."""

import logging

from .api_base import BaseAPIClient, NormalizedResult, RateLimiter, safe_request

logger = logging.getLogger(__name__)

_CROSSREF_API_URL = "https://api.crossref.org/works"

# Polite pool: 10 req/s with mailto header
_RATE_LIMITER = RateLimiter(requests_per_second=10.0)

# mailto address for polite pool access
_MAILTO = "resmon@example.com"


class CrossrefClient(BaseAPIClient):
    """CrossRef repository API client."""

    def __init__(self, mailto: str | None = None):
        self._mailto = mailto or _MAILTO

    def get_name(self) -> str:
        return "CrossRef"

    def search(
        self,
        query: str,
        date_from: str | None = None,
        date_to: str | None = None,
        max_results: int = 100,
        **kwargs,
    ) -> list[NormalizedResult]:
        results: list[NormalizedResult] = []
        offset = 0
        page_size = min(max_results, 100)

        while len(results) < max_results:
            params: dict = {
                "query": query,
                "offset": offset,
                "rows": min(page_size, max_results - len(results)),
                "mailto": self._mailto,
            }

            # Date filtering
            filters = []
            if date_from:
                filters.append(f"from-pub-date:{date_from}")
            if date_to:
                filters.append(f"until-pub-date:{date_to}")
            if filters:
                params["filter"] = ",".join(filters)

            try:
                response = safe_request(
                    "GET", _CROSSREF_API_URL,
                    params=params,
                    rate_limiter=_RATE_LIMITER,
                )
                if response.status_code != 200:
                    logger.error("CrossRef API returned %d", response.status_code)
                    break
            except Exception:
                logger.exception("CrossRef API request failed")
                break

            data = response.json()
            items = data.get("message", {}).get("items", [])
            if not items:
                break

            for item in items:
                results.append(self._parse_item(item))

            offset += len(items)
            if len(items) < params["rows"]:
                break

        return results[:max_results]

    # ------------------------------------------------------------------
    # Parsing
    # ------------------------------------------------------------------

    @staticmethod
    def _parse_item(item: dict) -> NormalizedResult:
        """Map a CrossRef work item to NormalizedResult."""
        # Title
        title_list = item.get("title", [])
        title = title_list[0] if title_list else "Untitled"

        # DOI
        doi = item.get("DOI")

        # External ID — use DOI as canonical identifier
        external_id = doi or ""

        # Authors
        authors = []
        for author in item.get("author", []):
            given = author.get("given", "")
            family = author.get("family", "")
            name = f"{given} {family}".strip()
            if name:
                authors.append(name)

        # Abstract
        abstract = item.get("abstract")
        if abstract:
            # CrossRef abstracts sometimes contain JATS XML tags
            import re
            abstract = re.sub(r"<[^>]+>", "", abstract).strip()

        # Publication date — prefer published-print, then published-online, then created
        publication_date = None
        for date_key in ("published-print", "published-online", "created"):
            date_obj = item.get(date_key)
            if date_obj and "date-parts" in date_obj:
                parts = date_obj["date-parts"][0]
                if parts:
                    year = str(parts[0])
                    month = str(parts[1]).zfill(2) if len(parts) > 1 else "01"
                    day = str(parts[2]).zfill(2) if len(parts) > 2 else "01"
                    publication_date = f"{year}-{month}-{day}"
                    break

        # URL
        url = item.get("URL", f"https://doi.org/{doi}" if doi else "")

        # Categories / subjects
        categories = item.get("subject", [])

        return NormalizedResult(
            source_repository="crossref",
            external_id=external_id,
            doi=doi,
            title=title,
            authors=authors,
            abstract=abstract,
            publication_date=publication_date,
            url=url,
            categories=categories,
        )


# ---------------------------------------------------------------------------
# Registry auto-registration
# ---------------------------------------------------------------------------
def _register():
    from .api_registry import register_client
    register_client("crossref", CrossrefClient)

_register()
