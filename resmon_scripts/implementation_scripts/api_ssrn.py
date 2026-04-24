# resmon_scripts/implementation_scripts/api_ssrn.py
"""SSRN scraper client — heuristic HTML scraping with robots.txt compliance (Tier 3).

STATUS: EXCLUDED from the active resmon registry as of 2026-04-18.

SSRN's results.cfm search page is protected by Cloudflare and returns HTTP 403
bot-challenge responses to programmatic clients. SSRN does not publish an open
search API. This module is retained on disk for historical reference only; it
is not imported by ``api_registry.py`` and therefore cannot be invoked from the
application. See ``.ai/prep/repos.md`` → "Excluded Repositories" for the full
rationale.
"""

import logging
import time
from urllib.robotparser import RobotFileParser

from bs4 import BeautifulSoup

from .api_base import BaseAPIClient, NormalizedResult, RateLimiter, safe_request

logger = logging.getLogger(__name__)

_SSRN_SEARCH_URL = "https://papers.ssrn.com/sol3/results.cfm"
_SSRN_ROBOTS_URL = "https://papers.ssrn.com/robots.txt"

# Minimum 5-second delay for Tier 3 scraping
_RATE_LIMITER = RateLimiter(requests_per_second=0.2)

# User-Agent for robots.txt compliance
_USER_AGENT = "resmon-bot/0.1"


def _check_robots_txt(url: str) -> bool:
    """Check if the URL is allowed by robots.txt. Returns True if allowed or on error."""
    try:
        rp = RobotFileParser()
        rp.set_url(_SSRN_ROBOTS_URL)
        rp.read()
        return rp.can_fetch(_USER_AGENT, url)
    except Exception:
        logger.warning("Could not fetch SSRN robots.txt; assuming allowed")
        return True


class SsrnClient(BaseAPIClient):
    """SSRN scraper client (Tier 3)."""

    def get_name(self) -> str:
        return "SSRN"

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
            logger.exception("SSRN scraping failed; returning empty results")
            return []

    def _do_search(
        self,
        query: str,
        date_from: str | None,
        date_to: str | None,
        max_results: int,
    ) -> list[NormalizedResult]:
        target_url = f"{_SSRN_SEARCH_URL}?txtKey_Words={query}"
        if not _check_robots_txt(target_url):
            logger.warning("SSRN robots.txt disallows access to %s", target_url)
            return []

        params = {
            "txtKey_Words": query,
            "npage": 1,
        }

        try:
            response = safe_request(
                "GET", _SSRN_SEARCH_URL,
                params=params,
                rate_limiter=_RATE_LIMITER,
                headers={"User-Agent": _USER_AGENT},
            )
            if response.status_code != 200:
                if response.status_code == 403:
                    logger.warning(
                        "SSRN blocked the request with HTTP 403 (Cloudflare bot "
                        "challenge). SSRN cannot be reliably scraped without a "
                        "real browser; returning empty results."
                    )
                else:
                    logger.error("SSRN returned %d", response.status_code)
                return []
        except Exception:
            logger.exception("SSRN request failed")
            return []

        soup = BeautifulSoup(response.text, "lxml")
        results: list[NormalizedResult] = []

        # SSRN search results are in <div class="result-item"> or similar containers
        # The exact structure may change; use heuristic parsing
        for item in soup.select(".result-item, .paper-result, .searchResult"):
            if len(results) >= max_results:
                break

            title_el = item.select_one("a.title, h3 a, .paper-title a, a[href*='abstract']")
            if not title_el:
                continue

            title = title_el.get_text(strip=True)
            if not title:
                continue

            url = title_el.get("href", "")
            if url and not url.startswith("http"):
                url = f"https://papers.ssrn.com{url}"

            # Extract SSRN abstract ID from URL
            external_id = ""
            if "abstract=" in url:
                external_id = url.split("abstract=")[-1].split("&")[0]
            elif "abstract_id=" in url:
                external_id = url.split("abstract_id=")[-1].split("&")[0]

            # Authors
            author_el = item.select_one(".authors, .author-name")
            authors = []
            if author_el:
                authors = [a.strip() for a in author_el.get_text().split(",") if a.strip()]

            # Date
            date_el = item.select_one(".date, .posted-date")
            pub_date = None
            if date_el:
                pub_date = date_el.get_text(strip=True)[:10]

            results.append(NormalizedResult(
                source_repository="ssrn",
                external_id=external_id or title[:50],
                doi=None,
                title=title,
                authors=authors,
                abstract=None,  # Abstracts typically not on search result page
                publication_date=pub_date,
                url=url,
                categories=[],
            ))

        return results[:max_results]


# ---------------------------------------------------------------------------
# Registry auto-registration
# ---------------------------------------------------------------------------
def _register():
    from .api_registry import register_client
    register_client("ssrn", SsrnClient)

_register()
