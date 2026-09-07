# resmon_scripts/implementation_scripts/api_semantic_scholar.py
"""Semantic Scholar API client — JSON with explicit field selection."""

import logging

from .api_base import Author, BaseAPIClient, NormalizedResult, RateLimiter, bare_orcid, safe_request
from .credential_manager import get_credential_for

logger = logging.getLogger(__name__)

_S2_API_URL = "https://api.semanticscholar.org/graph/v1/paper/search"

# Unauthenticated: ~100 req / 5 min ≈ 0.33 req/s
_RATE_LIMITER = RateLimiter(requests_per_second=0.33)

_FIELDS = "paperId,externalIds,title,authors,abstract,publicationDate,url,fieldsOfStudy"


class SemanticScholarClient(BaseAPIClient):
    """Semantic Scholar repository API client."""

    def get_name(self) -> str:
        return "Semantic Scholar"

    def search_entity(
        self,
        profile,
        date_from: str | None = None,
        date_to: str | None = None,
        max_results: int = 100,
        **kwargs,
    ) -> list[NormalizedResult]:
        """Semantic Scholar's author endpoint, which is a different URL.

        The paper search has **no author field** — established 2026-09-06 — so
        this is a two-step: resolve the name to an author id, then read that
        author's papers. It is the only source in the catalog whose entity query
        is an endpoint rather than a field or a parameter, and it is the reason
        ``entity_search.author_query`` has an ``endpoint`` value at all.

        **The first match is taken, and that is a real limitation.** A search for
        a common name returns several author records and resmon does not know
        which is meant; local verification then re-checks every paper against the
        profile, so a wrong pick produces *no* matches rather than wrong ones —
        the failure is silence, not a false claim. A profile with a Semantic
        Scholar id in its identifiers would skip this step, which is why the
        field is in the model.
        """
        from .api_base import EntityUnsupported, _profile_query_name  # noqa: PLC0415

        name = _profile_query_name(profile)
        if not name:
            raise EntityUnsupported("That profile has no name to search with.")

        native = ""
        if isinstance(profile, dict):
            native = str(((profile.get("identifiers") or {})
                          .get("semantic_scholar") or {}).get("value") or "")

        author_id = native
        if not author_id:
            response = safe_request(
                "GET", "https://api.semanticscholar.org/graph/v1/author/search",
                params={"query": name, "limit": 1, "fields": "name"},
                rate_limiter=_RATE_LIMITER,
            )
            if response is None or response.status_code != 200:
                return []
            data = (response.json() or {}).get("data") or []
            if not data:
                return []
            author_id = str(data[0].get("authorId") or "")
        if not author_id:
            return []

        response = safe_request(
            "GET",
            f"https://api.semanticscholar.org/graph/v1/author/{author_id}/papers",
            params={"limit": min(max_results, 100), "fields": _FIELDS},
            rate_limiter=_RATE_LIMITER,
        )
        if response is None or response.status_code != 200:
            return []
        papers = (response.json() or {}).get("data") or []
        out: list[NormalizedResult] = []
        for paper in papers:
            parsed = self._parse_paper(paper)
            if parsed is not None:
                out.append(parsed)
        return out[:max_results]

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
                "limit": min(page_size, max_results - len(results)),
                "fields": _FIELDS,
            }

            # Year filtering (Semantic Scholar uses year or year range)
            if date_from or date_to:
                year_from = date_from[:4] if date_from else ""
                year_to = date_to[:4] if date_to else ""
                if year_from and year_to:
                    params["year"] = f"{year_from}-{year_to}"
                elif year_from:
                    params["year"] = f"{year_from}-"
                elif year_to:
                    params["year"] = f"-{year_to}"

            headers = {}
            api_key = get_credential_for(self._exec_id, "semantic_scholar_api_key")
            if api_key:
                headers["x-api-key"] = api_key

            try:
                response = safe_request(
                    "GET", _S2_API_URL,
                    params=params,
                    headers=headers if headers else None,
                    rate_limiter=_RATE_LIMITER,
                )
                if response.status_code != 200:
                    logger.error("Semantic Scholar API returned %d: %s",
                                 response.status_code, response.text[:200])
                    break
            except Exception:
                logger.exception("Semantic Scholar API request failed")
                break

            data = response.json()
            papers = data.get("data", [])
            if not papers:
                break

            for paper in papers:
                parsed = self._parse_paper(paper)
                if parsed is not None:
                    results.append(parsed)

            offset += len(papers)

            # Check if more pages exist
            total = data.get("total", 0)
            if offset >= total or len(papers) < params["limit"]:
                break

        return results[:max_results]

    # ------------------------------------------------------------------
    # Parsing
    # ------------------------------------------------------------------

    @staticmethod
    def _parse_paper(paper: dict) -> NormalizedResult | None:
        """Map a Semantic Scholar paper object to NormalizedResult."""
        title = paper.get("title")
        if not title:
            return None

        paper_id = paper.get("paperId", "")

        # External IDs — try DOI first
        ext_ids = paper.get("externalIds") or {}
        doi = ext_ids.get("DOI")

        # Authors
        # 2.1 — Semantic Scholar returns its **own** author id and nothing else.
        # `authors.externalIds` and `authors.affiliations` are rejected outright
        # as unsupported fields (2026-09-06), so there is no ORCID to be had on
        # this path and none is claimed. The id is namespaced by the source slug
        # so it can never be compared against another source's.
        authors = []
        for author in paper.get("authors", []):
            name = (author.get("name") or "").strip()
            if not name:
                continue
            author_id = str(author.get("authorId") or "").strip()
            authors.append(Author(
                name=name,
                source_ids=(("semantic_scholar", author_id),) if author_id else (),
            ))

        abstract = paper.get("abstract")
        publication_date = paper.get("publicationDate")  # already YYYY-MM-DD

        url = paper.get("url", f"https://www.semanticscholar.org/paper/{paper_id}")

        categories = paper.get("fieldsOfStudy") or []

        return NormalizedResult(
            source_repository="semantic_scholar",
            external_id=paper_id,
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
    register_client("semantic_scholar", SemanticScholarClient)

_register()
