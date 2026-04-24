# resmon_scripts/implementation_scripts/api_dblp.py
"""DBLP API client — JSON, f/h pagination."""

import logging

from .api_base import BaseAPIClient, NormalizedResult, RateLimiter, safe_request

logger = logging.getLogger(__name__)

_DBLP_API_URL = "https://dblp.org/search/publ/api"

# Conservative: 2 req/s
_RATE_LIMITER = RateLimiter(requests_per_second=2.0)


class DblpClient(BaseAPIClient):
    """DBLP repository API client."""

    def get_name(self) -> str:
        return "DBLP"

    def search(
        self,
        query: str,
        date_from: str | None = None,
        date_to: str | None = None,
        max_results: int = 100,
        **kwargs,
    ) -> list[NormalizedResult]:
        results: list[NormalizedResult] = []
        first = 0
        page_size = min(max_results, 1000)

        while len(results) < max_results:
            params = {
                "q": query,
                "format": "json",
                "f": first,
                "h": min(page_size, max_results - len(results)),
            }

            try:
                response = safe_request(
                    "GET", _DBLP_API_URL,
                    params=params,
                    rate_limiter=_RATE_LIMITER,
                )
                if response.status_code != 200:
                    logger.error("DBLP API returned %d", response.status_code)
                    break
            except Exception:
                logger.exception("DBLP API request failed")
                break

            data = response.json()
            result_obj = data.get("result", {})
            hits = result_obj.get("hits", {})
            hit_list = hits.get("hit", [])
            if not hit_list:
                break

            for hit in hit_list:
                info = hit.get("info", {})
                parsed = self._parse_info(info, date_from, date_to)
                if parsed is not None:
                    results.append(parsed)

            first += len(hit_list)
            total = int(hits.get("@total", 0))
            if first >= total or len(hit_list) < params["h"]:
                break

        return results[:max_results]

    @staticmethod
    def _parse_info(
        info: dict,
        date_from: str | None = None,
        date_to: str | None = None,
    ) -> NormalizedResult | None:
        title = info.get("title", "").rstrip(".")
        if not title:
            return None

        # Date filtering (DBLP API doesn't support date filters natively)
        year_str = info.get("year", "")
        if year_str:
            if date_from and year_str < date_from[:4]:
                return None
            if date_to and year_str > date_to[:4]:
                return None

        external_id = info.get("key", "")

        doi = info.get("doi")
        if doi and "/" in doi and not doi.startswith("10."):
            doi = None  # invalid DOI

        # Authors — can be a string or a list
        authors_raw = info.get("authors", {}).get("author", [])
        authors = []
        if isinstance(authors_raw, list):
            for a in authors_raw:
                if isinstance(a, dict):
                    name = a.get("text", "").strip()
                elif isinstance(a, str):
                    name = a.strip()
                else:
                    continue
                if name:
                    authors.append(name)
        elif isinstance(authors_raw, dict):
            name = authors_raw.get("text", "").strip()
            if name:
                authors.append(name)
        elif isinstance(authors_raw, str):
            authors.append(authors_raw.strip())

        publication_date = f"{year_str}-01-01" if year_str else None

        url = info.get("url", "")
        if url and not url.startswith("http"):
            url = f"https://dblp.org/rec/{url}"

        venue = info.get("venue", "")
        categories = [venue] if venue else []

        return NormalizedResult(
            source_repository="dblp",
            external_id=external_id,
            doi=doi,
            title=title,
            authors=authors,
            abstract=None,  # DBLP does not provide abstracts
            publication_date=publication_date,
            url=url,
            categories=categories,
        )


# ---------------------------------------------------------------------------
# Registry auto-registration
# ---------------------------------------------------------------------------
def _register():
    from .api_registry import register_client
    register_client("dblp", DblpClient)

_register()
