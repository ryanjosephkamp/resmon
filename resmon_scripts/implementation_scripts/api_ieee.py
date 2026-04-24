# resmon_scripts/implementation_scripts/api_ieee.py
"""IEEE Xplore API client — REST API with optional API key (Tier 3)."""

import logging
from urllib.robotparser import RobotFileParser

from .api_base import BaseAPIClient, NormalizedResult, RateLimiter, safe_request
from .credential_manager import get_credential_for

logger = logging.getLogger(__name__)

_IEEE_API_URL = "https://ieeexploreapi.ieee.org/api/v1/search/articles"
_IEEE_ROBOTS_URL = "https://ieeexplore.ieee.org/robots.txt"

# Minimum 5-second delay for Tier 3
_RATE_LIMITER = RateLimiter(requests_per_second=0.2)

_USER_AGENT = "resmon-bot/0.1"


def _check_robots_txt() -> bool:
    """Check if IEEE Xplore robots.txt allows API access."""
    try:
        rp = RobotFileParser()
        rp.set_url(_IEEE_ROBOTS_URL)
        rp.read()
        return rp.can_fetch(_USER_AGENT, _IEEE_API_URL)
    except Exception:
        logger.warning("Could not fetch IEEE robots.txt; assuming allowed")
        return True


class IeeeClient(BaseAPIClient):
    """IEEE Xplore API client (Tier 3, may require institutional access)."""

    def get_name(self) -> str:
        return "IEEE Xplore"

    def search(
        self,
        query: str,
        date_from: str | None = None,
        date_to: str | None = None,
        max_results: int = 100,
        **kwargs,
    ) -> list[NormalizedResult]:
        try:
            return self._do_search(query, date_from, date_to, max_results)
        except Exception:
            logger.exception("IEEE Xplore search failed; returning empty results")
            return []

    def _do_search(
        self,
        query: str,
        date_from: str | None,
        date_to: str | None,
        max_results: int,
    ) -> list[NormalizedResult]:
        api_key = get_credential_for(self._exec_id, "ieee_api_key")
        if not api_key:
            logger.warning("IEEE Xplore API key not configured; returning empty results")
            return []

        if not _check_robots_txt():
            logger.warning("IEEE robots.txt disallows API access")
            return []

        results: list[NormalizedResult] = []
        start = 1  # IEEE uses 1-based record indexing
        page_size = min(max_results, 25)  # IEEE max per request is 200, but use 25

        while len(results) < max_results:
            params = {
                "querytext": query,
                "apikey": api_key,
                "start_record": start,
                "max_records": min(page_size, max_results - len(results)),
                "sort_field": "publication_date",
                "sort_order": "desc",
            }

            if date_from:
                # IEEE uses start_year / end_year
                params["start_year"] = date_from[:4]
            if date_to:
                params["end_year"] = date_to[:4]

            try:
                response = safe_request(
                    "GET", _IEEE_API_URL,
                    params=params,
                    rate_limiter=_RATE_LIMITER,
                    headers={"User-Agent": _USER_AGENT},
                )
                if response.status_code == 403:
                    logger.warning("IEEE Xplore API key invalid or access denied")
                    break
                if response.status_code != 200:
                    logger.error("IEEE Xplore API returned %d", response.status_code)
                    break
            except Exception:
                logger.exception("IEEE Xplore API request failed")
                break

            data = response.json()
            articles = data.get("articles", [])
            if not articles:
                break

            for article in articles:
                title = article.get("title", "")
                if not title:
                    continue

                # Authors
                author_data = article.get("authors", {}).get("authors", [])
                authors = [a.get("full_name", "") for a in author_data if a.get("full_name")]

                abstract = article.get("abstract")
                doi = article.get("doi", "")
                pub_date = article.get("publication_date")
                if pub_date:
                    pub_date = str(pub_date)[:10]
                elif article.get("publication_year"):
                    pub_date = f"{article['publication_year']}-01-01"

                article_number = article.get("article_number", "")
                url = article.get("html_url") or article.get("pdf_url", "")
                if not url and article_number:
                    url = f"https://ieeexplore.ieee.org/document/{article_number}"

                index_terms = article.get("index_terms", {})
                categories: list[str] = []
                for term_group in index_terms.values():
                    if isinstance(term_group, dict):
                        categories.extend(term_group.get("terms", []))
                    elif isinstance(term_group, list):
                        categories.extend(term_group)

                results.append(NormalizedResult(
                    source_repository="ieee",
                    external_id=article_number or doi or title[:50],
                    doi=doi if doi else None,
                    title=title,
                    authors=authors,
                    abstract=abstract,
                    publication_date=pub_date,
                    url=url,
                    categories=categories[:10],  # Limit categories
                ))

            start += len(articles)
            total = data.get("total_records", 0)
            if start > total or len(articles) < params["max_records"]:
                break

        return results[:max_results]


# ---------------------------------------------------------------------------
# Registry auto-registration
# ---------------------------------------------------------------------------
def _register():
    from .api_registry import register_client
    register_client("ieee", IeeeClient)

_register()
