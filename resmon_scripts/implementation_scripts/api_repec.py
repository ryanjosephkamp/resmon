# resmon_scripts/implementation_scripts/api_repec.py
"""RePEc / IDEAS scraper client — heuristic HTML scraping with robots.txt compliance (Tier 3).

STATUS: EXCLUDED from the active resmon registry as of 2026-04-18.

The RePEc/IDEAS htsearch CGI endpoint that this client targets is no longer
publicly reachable, and RePEc does not publish an open search API. This module
is retained on disk for historical reference only; it is not imported by
``api_registry.py`` and therefore cannot be invoked from the application. See
``.ai/prep/repos.md`` → "Excluded Repositories" for the full rationale.
"""

import logging
from urllib.robotparser import RobotFileParser

from bs4 import BeautifulSoup

from .api_base import BaseAPIClient, NormalizedResult, RateLimiter, safe_request

logger = logging.getLogger(__name__)

_IDEAS_SEARCH_URL = "https://ideas.repec.org/cgi-bin/htsearch2"
_IDEAS_ROBOTS_URL = "https://ideas.repec.org/robots.txt"

# Minimum 5-second delay for Tier 3 scraping
_RATE_LIMITER = RateLimiter(requests_per_second=0.2)

_USER_AGENT = "resmon-bot/0.1"


def _check_robots_txt(url: str) -> bool:
    """Check if the URL is allowed by robots.txt. Returns True if allowed or on error."""
    try:
        rp = RobotFileParser()
        rp.set_url(_IDEAS_ROBOTS_URL)
        rp.read()
        return rp.can_fetch(_USER_AGENT, url)
    except Exception:
        logger.warning("Could not fetch IDEAS robots.txt; assuming allowed")
        return True


class RepecClient(BaseAPIClient):
    """RePEc / IDEAS scraper client (Tier 3)."""

    def get_name(self) -> str:
        return "RePEc / IDEAS"

    def search(
        self,
        query: str,
        date_from: str | None = None,
        date_to: str | None = None,
        max_results: int = 100,
        **kwargs,
    ) -> list[NormalizedResult]:
        try:
            return self._do_search(query, max_results)
        except Exception:
            logger.exception("RePEc/IDEAS scraping failed; returning empty results")
            return []

    def _do_search(self, query: str, max_results: int) -> list[NormalizedResult]:
        target_url = f"{_IDEAS_SEARCH_URL}?q={query}"
        if not _check_robots_txt(target_url):
            logger.warning("IDEAS robots.txt disallows access to %s", target_url)
            return []

        params = {
            "q": query,
            "cmd": "Search!",
            "form": "extended",
            "wm": "wrd",
            "dt": "any",
            "ul": "",
            "s": "R",
            "db": "",
            "de": "",
        }

        try:
            # IDEAS' htsearch2 form uses POST; GET returns the homepage and
            # produces zero scrapable results.
            response = safe_request(
                "POST", _IDEAS_SEARCH_URL,
                data=params,
                rate_limiter=_RATE_LIMITER,
                headers={"User-Agent": _USER_AGENT},
            )
            if response.status_code != 200:
                logger.error("IDEAS returned %d", response.status_code)
                return []
        except Exception:
            logger.exception("IDEAS request failed")
            return []

        soup = BeautifulSoup(response.text, "lxml")
        results: list[NormalizedResult] = []

        # IDEAS/htsearch2 results render as <li class="list-group-item
        # downfree"> (or without the ``downfree`` modifier). Each item
        # contains an anchor to the paper/article page at /p/... or /a/...
        # plus author/date text. Fall back to a broader selector if the
        # primary one matches nothing.
        items = soup.select("li.list-group-item.downfree, li.list-group-item")
        for item in items:
            if len(results) >= max_results:
                break

            # Find the paper link (ideas.repec.org/p/... or /a/...)
            link_el = None
            for a in item.select("a[href]"):
                href = a.get("href", "")
                if "/p/" in href or "/a/" in href:
                    link_el = a
                    break
            if not link_el:
                continue

            title = link_el.get_text(strip=True)
            if not title or len(title) < 5:
                continue

            url = link_el.get("href", "")
            if url and not url.startswith("http"):
                url = f"https://ideas.repec.org{url}"

            # Extract text after the link for authors/date
            full_text = item.get_text(separator=" ", strip=True)
            authors: list[str] = []
            # Try to extract author info from the remaining text
            remaining = full_text.replace(title, "").strip()
            if remaining:
                # Heuristic: first part before date-like text is authors
                parts = remaining.split(",")
                for part in parts[:3]:
                    part = part.strip().strip(".")
                    if part and not part.isdigit() and len(part) > 2:
                        authors.append(part)

            results.append(NormalizedResult(
                source_repository="repec",
                external_id=url.split("/")[-1] if url else title[:50],
                doi=None,
                title=title,
                authors=authors,
                abstract=None,
                publication_date=None,
                url=url,
                categories=[],
            ))

        return results[:max_results]


# ---------------------------------------------------------------------------
# Registry auto-registration
# ---------------------------------------------------------------------------
def _register():
    from .api_registry import register_client
    register_client("repec", RepecClient)

_register()
