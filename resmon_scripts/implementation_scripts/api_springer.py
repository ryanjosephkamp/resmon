# resmon_scripts/implementation_scripts/api_springer.py
"""Springer Nature API client — REST JSON API (requires API key)."""

import logging

from .api_base import BaseAPIClient, NormalizedResult, RateLimiter, safe_request
from .credential_manager import get_credential_for

logger = logging.getLogger(__name__)

_SPRINGER_API_URL = "https://api.springernature.com/meta/v2/json"

# Springer Nature: 5 req/s for authenticated users
_RATE_LIMITER = RateLimiter(requests_per_second=5.0)


class SpringerClient(BaseAPIClient):
    """Springer Nature repository API client (Tier 2, requires API key)."""

    def get_name(self) -> str:
        return "Springer Nature"

    def search(
        self,
        query: str,
        date_from: str | None = None,
        date_to: str | None = None,
        max_results: int = 100,
        **kwargs,
    ) -> list[NormalizedResult]:
        api_key = get_credential_for(self._exec_id, "springer_api_key")
        if not api_key:
            logger.warning("Springer Nature API key not configured; returning empty results")
            return []

        results: list[NormalizedResult] = []
        start = 1  # Springer uses 1-based paging
        page_size = min(max_results, 50)  # Springer max page size is 50

        while len(results) < max_results:
            q = query
            if date_from or date_to:
                if date_from:
                    q += f" onlinedatefrom:{date_from}"
                if date_to:
                    q += f" onlinedateto:{date_to}"

            params = {
                "q": q,
                "api_key": api_key,
                "s": start,
                "p": min(page_size, max_results - len(results)),
            }

            try:
                response = safe_request(
                    "GET", _SPRINGER_API_URL,
                    params=params,
                    rate_limiter=_RATE_LIMITER,
                )
                if response.status_code == 403:
                    logger.warning("Springer Nature API key invalid or quota exceeded")
                    break
                if response.status_code != 200:
                    logger.error("Springer Nature API returned %d", response.status_code)
                    break
            except Exception:
                logger.exception("Springer Nature API request failed")
                break

            data = response.json()
            records = data.get("records", [])
            if not records:
                break

            for rec in records:
                title = rec.get("title", "")
                if not title:
                    continue

                # Authors
                creators = rec.get("creators", [])
                authors = [c.get("creator", "") for c in creators if c.get("creator")]

                abstract = rec.get("abstract")
                doi = rec.get("doi", "")
                pub_date = rec.get("onlineDate") or rec.get("publicationDate")
                if pub_date:
                    pub_date = str(pub_date)[:10]

                url = rec.get("url", [{}])
                if isinstance(url, list):
                    url = url[0].get("value", "") if url else ""

                if not url and doi:
                    url = f"https://doi.org/{doi}"

                subjects = rec.get("subjects", [])
                if isinstance(subjects, list):
                    categories = [s.get("term", s) if isinstance(s, dict) else str(s) for s in subjects]
                else:
                    categories = []

                results.append(NormalizedResult(
                    source_repository="springer",
                    external_id=doi or rec.get("identifier", ""),
                    doi=doi if doi else None,
                    title=title,
                    authors=authors,
                    abstract=abstract,
                    publication_date=pub_date,
                    url=url,
                    categories=categories,
                ))

            start += len(records)
            total = int(data.get("result", [{}])[0].get("total", 0)) if data.get("result") else 0
            if start > total or len(records) < params["p"]:
                break

        return results[:max_results]


# ---------------------------------------------------------------------------
# Registry auto-registration
# ---------------------------------------------------------------------------
def _register():
    from .api_registry import register_client
    register_client("springer", SpringerClient)

_register()
