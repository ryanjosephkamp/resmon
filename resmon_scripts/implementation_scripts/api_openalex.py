# resmon_scripts/implementation_scripts/api_openalex.py
"""OpenAlex API client — JSON, polite pool with mailto."""

import logging

from .api_base import BaseAPIClient, NormalizedResult, RateLimiter, safe_request

logger = logging.getLogger(__name__)

_OPENALEX_API_URL = "https://api.openalex.org/works"

# Polite pool: 10 req/s with mailto
_RATE_LIMITER = RateLimiter(requests_per_second=10.0)
_MAILTO = "resmon@example.com"


class OpenAlexClient(BaseAPIClient):
    """OpenAlex repository API client."""

    def __init__(self, mailto: str | None = None):
        self._mailto = mailto or _MAILTO

    def get_name(self) -> str:
        return "OpenAlex"

    def search(
        self,
        query: str,
        date_from: str | None = None,
        date_to: str | None = None,
        max_results: int = 100,
        **kwargs,
    ) -> list[NormalizedResult]:
        results: list[NormalizedResult] = []
        page = 1
        per_page = min(max_results, 200)

        while len(results) < max_results:
            params: dict = {
                "search": query,
                "page": page,
                "per-page": min(per_page, max_results - len(results)),
                "mailto": self._mailto,
            }

            # Date filtering
            filters = []
            if date_from:
                filters.append(f"from_publication_date:{date_from}")
            if date_to:
                filters.append(f"to_publication_date:{date_to}")
            if filters:
                params["filter"] = ",".join(filters)

            try:
                response = safe_request(
                    "GET", _OPENALEX_API_URL,
                    params=params,
                    rate_limiter=_RATE_LIMITER,
                )
                if response.status_code != 200:
                    logger.error("OpenAlex API returned %d", response.status_code)
                    break
            except Exception:
                logger.exception("OpenAlex API request failed")
                break

            data = response.json()
            items = data.get("results", [])
            if not items:
                break

            for item in items:
                parsed = self._parse_work(item)
                if parsed is not None:
                    results.append(parsed)

            page += 1
            if len(items) < params["per-page"]:
                break

        return results[:max_results]

    @staticmethod
    def _parse_work(work: dict) -> NormalizedResult | None:
        title = work.get("display_name") or work.get("title")
        if not title:
            return None

        # OpenAlex ID — e.g. "https://openalex.org/W1234567890" → "W1234567890"
        openalex_id = work.get("id", "")
        external_id = openalex_id.rsplit("/", 1)[-1] if "/" in openalex_id else openalex_id

        doi = work.get("doi")
        if doi and doi.startswith("https://doi.org/"):
            doi = doi[len("https://doi.org/"):]

        authors = []
        for authorship in work.get("authorships", []):
            author_obj = authorship.get("author", {})
            name = author_obj.get("display_name", "").strip()
            if name:
                authors.append(name)

        # Abstract — OpenAlex provides an inverted index; reconstruct if present
        abstract = None
        abstract_inv = work.get("abstract_inverted_index")
        if abstract_inv:
            # Reconstruct from inverted index: {word: [positions]}
            word_positions: list[tuple[int, str]] = []
            for word, positions in abstract_inv.items():
                for pos in positions:
                    word_positions.append((pos, word))
            word_positions.sort()
            abstract = " ".join(w for _, w in word_positions)

        publication_date = work.get("publication_date")  # YYYY-MM-DD

        url = work.get("primary_location", {}).get("landing_page_url") if work.get("primary_location") else None
        if not url:
            url = openalex_id

        categories = []
        for concept in work.get("concepts", []):
            name = concept.get("display_name")
            if name:
                categories.append(name)

        return NormalizedResult(
            source_repository="openalex",
            external_id=external_id,
            doi=doi,
            title=title,
            authors=authors,
            abstract=abstract,
            publication_date=publication_date,
            url=url,
            categories=categories[:10],  # Limit to top 10
        )


# ---------------------------------------------------------------------------
# Registry auto-registration
# ---------------------------------------------------------------------------
def _register():
    from .api_registry import register_client
    register_client("openalex", OpenAlexClient)

_register()
