# resmon_scripts/implementation_scripts/api_core.py
"""CORE API v3 client — JSON, requires API key, graceful missing-key handling."""

import logging

from .api_base import BaseAPIClient, NormalizedResult, RateLimiter, safe_request
from .credential_manager import get_credential_for

logger = logging.getLogger(__name__)

_CORE_API_URL = "https://api.core.ac.uk/v3/search/works"

# 5 req/s default
_RATE_LIMITER = RateLimiter(requests_per_second=5.0)


class CoreClient(BaseAPIClient):
    """CORE repository API client (v3)."""

    def get_name(self) -> str:
        return "CORE"

    def search(
        self,
        query: str,
        date_from: str | None = None,
        date_to: str | None = None,
        max_results: int = 100,
        **kwargs,
    ) -> list[NormalizedResult]:
        api_key = get_credential_for(self._exec_id, "core_api_key")
        if not api_key:
            logger.warning("CORE API key not configured — returning empty results")
            return []

        results: list[NormalizedResult] = []
        offset = 0
        page_size = min(max_results, 100)

        while len(results) < max_results:
            params: dict = {
                "q": query,
                "offset": offset,
                "limit": min(page_size, max_results - len(results)),
            }

            # Date filtering via query
            if date_from or date_to:
                d_from = date_from or "1900-01-01"
                d_to = date_to or "2099-12-31"
                params["q"] = f"{query} AND createdDate>={d_from} AND createdDate<={d_to}"

            headers = {"Authorization": f"Bearer {api_key}"}

            try:
                response = safe_request(
                    "GET", _CORE_API_URL,
                    params=params,
                    headers=headers,
                    rate_limiter=_RATE_LIMITER,
                )
                if response.status_code == 401:
                    logger.error("CORE API key is invalid (401)")
                    break
                if response.status_code != 200:
                    logger.error("CORE API returned %d", response.status_code)
                    break
            except Exception:
                logger.exception("CORE API request failed")
                break

            data = response.json()
            items = data.get("results", [])
            if not items:
                break

            for item in items:
                parsed = self._parse_work(item)
                if parsed is not None:
                    results.append(parsed)

            offset += len(items)
            total = data.get("totalHits", 0)
            if offset >= total or len(items) < params["limit"]:
                break

        return results[:max_results]

    @staticmethod
    def _parse_work(work: dict) -> NormalizedResult | None:
        title = work.get("title")
        if not title:
            return None

        external_id = str(work.get("id", ""))

        doi = None
        for identifier in work.get("identifiers", []):
            if isinstance(identifier, str) and identifier.startswith("10."):
                doi = identifier
                break

        authors = []
        for author in work.get("authors", []):
            if isinstance(author, dict):
                name = author.get("name", "").strip()
            elif isinstance(author, str):
                name = author.strip()
            else:
                continue
            if name:
                authors.append(name)

        abstract = work.get("abstract")
        publication_date = work.get("publishedDate") or work.get("createdDate")
        if publication_date and len(publication_date) >= 10:
            publication_date = publication_date[:10]

        url = work.get("downloadUrl") or work.get("sourceFulltextUrls", [""])[0] if work.get("sourceFulltextUrls") else ""
        if not url:
            url = f"https://core.ac.uk/works/{external_id}"

        categories = work.get("fieldOfStudy") or []
        if isinstance(categories, str):
            categories = [categories]

        return NormalizedResult(
            source_repository="core",
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
    register_client("core", CoreClient)

_register()
