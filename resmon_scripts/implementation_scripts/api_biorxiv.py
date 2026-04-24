# resmon_scripts/implementation_scripts/api_biorxiv.py
"""bioRxiv / medRxiv API client — JSON, date-range endpoints, both servers."""

import logging

from .api_base import BaseAPIClient, NormalizedResult, RateLimiter, safe_request

logger = logging.getLogger(__name__)

_BIORXIV_API_BASE = "https://api.biorxiv.org/details"

# Conservative: 2 req/s
_RATE_LIMITER = RateLimiter(requests_per_second=2.0)


class BiorxivClient(BaseAPIClient):
    """bioRxiv / medRxiv repository API client."""

    def __init__(self, server: str = "biorxiv"):
        """Initialize with server name: 'biorxiv' or 'medrxiv'."""
        self._server = server if server in ("biorxiv", "medrxiv") else "biorxiv"

    def get_name(self) -> str:
        return "bioRxiv" if self._server == "biorxiv" else "medRxiv"

    def search(
        self,
        query: str,
        date_from: str | None = None,
        date_to: str | None = None,
        max_results: int = 100,
        **kwargs,
    ) -> list[NormalizedResult]:
        # bioRxiv API requires date range; default to last 30 days
        d_from = date_from or "2020-01-01"
        d_to = date_to or "2099-12-31"

        results: list[NormalizedResult] = []
        cursor = 0

        while len(results) < max_results:
            url = f"{_BIORXIV_API_BASE}/{self._server}/{d_from}/{d_to}/{cursor}"

            try:
                response = safe_request(
                    "GET", url,
                    rate_limiter=_RATE_LIMITER,
                )
                if response.status_code != 200:
                    logger.error("bioRxiv API returned %d", response.status_code)
                    break
            except Exception:
                logger.exception("bioRxiv API request failed")
                break

            data = response.json()
            messages = data.get("messages") or []
            status_msg = (messages[0].get("status") if messages else "") or ""
            collection = data.get("collection", [])

            # The bioRxiv /details endpoint sometimes returns an empty
            # collection together with a non-"ok" status message (e.g.
            # "Not available at this time" during upstream outages). When
            # that happens on the *first* page, distinguish it from a
            # legitimate empty result set so the sweep engine surfaces a
            # repo_error instead of silently reporting zero results.
            if not collection:
                if cursor == 0 and status_msg and status_msg.lower() != "ok":
                    raise RuntimeError(
                        f"bioRxiv /details/{self._server} returned "
                        f"status={status_msg!r} (upstream API unavailable)"
                    )
                break

            query_lower = query.lower()
            for item in collection:
                parsed = self._parse_item(item)
                if parsed is None:
                    continue
                # Client-side keyword filtering (bioRxiv API doesn't support keyword search)
                if self._matches_query(parsed, query_lower):
                    results.append(parsed)
                    if len(results) >= max_results:
                        break

            # bioRxiv returns up to 100 per page
            messages = data.get("messages", [{}])
            total = int(messages[0].get("total", 0)) if messages else 0
            cursor += len(collection)
            if len(collection) < 100 or cursor >= total:
                break

        return results[:max_results]

    @staticmethod
    def _matches_query(result: NormalizedResult, query_lower: str) -> bool:
        """Client-side keyword matching with OR semantics.

        A paper matches if any of the whitespace-separated query terms appears
        in its title or abstract. This mirrors the behavior users expect from
        multi-keyword search boxes (match any keyword, not all).
        """
        terms = [t for t in query_lower.split() if t]
        if not terms:
            return True
        text = f"{result.title} {result.abstract or ''}".lower()
        return any(term in text for term in terms)

    def _parse_item(self, item: dict) -> NormalizedResult | None:
        title = item.get("title")
        if not title:
            return None

        doi = item.get("doi", "")
        external_id = doi

        authors = []
        author_str = item.get("authors", "")
        if author_str:
            for name in author_str.split("; "):
                name = name.strip()
                if name:
                    authors.append(name)

        abstract = item.get("abstract")
        publication_date = item.get("date")  # YYYY-MM-DD

        url = f"https://doi.org/{doi}" if doi else ""

        category = item.get("category", "")
        categories = [category] if category else []

        return NormalizedResult(
            source_repository=self._server,
            external_id=external_id,
            doi=doi if doi else None,
            title=title,
            authors=authors,
            abstract=abstract,
            publication_date=publication_date,
            url=url,
            categories=categories,
        )


# ---------------------------------------------------------------------------
# Registry auto-registration — register as "biorxiv" (default server)
# ---------------------------------------------------------------------------
def _register():
    from .api_registry import register_client
    register_client("biorxiv", BiorxivClient)

_register()
