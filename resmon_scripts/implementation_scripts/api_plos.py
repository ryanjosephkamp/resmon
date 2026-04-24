# resmon_scripts/implementation_scripts/api_plos.py
"""PLOS (Public Library of Science) API client — Solr search API."""

import logging

from .api_base import BaseAPIClient, NormalizedResult, RateLimiter, safe_request

logger = logging.getLogger(__name__)

_PLOS_API_URL = "https://api.plos.org/search"

# PLOS rate limit: 10 req/s max for unauthenticated; use 5 req/s politely
_RATE_LIMITER = RateLimiter(requests_per_second=5.0)


class PlosClient(BaseAPIClient):
    """PLOS repository API client (Tier 2)."""

    def get_name(self) -> str:
        return "PLOS"

    def search(
        self,
        query: str,
        date_from: str | None = None,
        date_to: str | None = None,
        max_results: int = 100,
        **kwargs,
    ) -> list[NormalizedResult]:
        results: list[NormalizedResult] = []
        start = 0
        page_size = min(max_results, 100)

        while len(results) < max_results:
            # Build query with optional date filter
            q = query
            if date_from or date_to:
                d_from = date_from or "*"
                d_to = date_to or "*"
                q += f" AND publication_date:[{d_from}T00:00:00Z TO {d_to}T23:59:59Z]"

            params = {
                "q": q,
                "fl": "id,title,author,abstract,publication_date,journal",
                "rows": min(page_size, max_results - len(results)),
                "start": start,
                "sort": "publication_date desc",
                "wt": "json",
            }

            try:
                response = safe_request(
                    "GET", _PLOS_API_URL,
                    params=params,
                    rate_limiter=_RATE_LIMITER,
                )
                if response.status_code != 200:
                    logger.error("PLOS API returned %d", response.status_code)
                    break
            except Exception:
                logger.exception("PLOS API request failed")
                break

            data = response.json()
            docs = data.get("response", {}).get("docs", [])
            if not docs:
                break

            for doc in docs:
                title = doc.get("title")
                if not title:
                    continue

                doi = doc.get("id", "")
                authors = doc.get("author", [])
                if isinstance(authors, str):
                    authors = [authors]

                abstract_list = doc.get("abstract", [])
                if isinstance(abstract_list, list):
                    abstract = abstract_list[0] if abstract_list else None
                else:
                    abstract = abstract_list

                pub_date = doc.get("publication_date")
                if pub_date:
                    pub_date = str(pub_date)[:10]

                url = f"https://doi.org/{doi}" if doi else ""
                journal = doc.get("journal", "")
                categories = [journal] if journal else []

                results.append(NormalizedResult(
                    source_repository="plos",
                    external_id=doi,
                    doi=doi if doi else None,
                    title=title,
                    authors=authors,
                    abstract=abstract,
                    publication_date=pub_date,
                    url=url,
                    categories=categories,
                ))

            start += len(docs)
            if len(docs) < params["rows"]:
                break

        return results[:max_results]


# ---------------------------------------------------------------------------
# Registry auto-registration
# ---------------------------------------------------------------------------
def _register():
    from .api_registry import register_client
    register_client("plos", PlosClient)

_register()
