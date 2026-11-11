# resmon_scripts/implementation_scripts/api_semantic_scholar.py
"""Semantic Scholar API client — JSON with explicit field selection."""

import logging

from .api_base import (Author, BaseAPIClient, LookupUnsupported, NormalizedResult, RateLimiter,
                       bare_orcid, either, note_not_found, path_after, read_json_body,
                       safe_request, sent_params)
from . import search_terms
from .credential_manager import get_credential_for

logger = logging.getLogger(__name__)

_S2_API_URL = "https://api.semanticscholar.org/graph/v1/paper/search"
_S2_MATCH_URL = "https://api.semanticscholar.org/graph/v1/paper/search/match"
_S2_PAPER_URL = "https://api.semanticscholar.org/graph/v1/paper"
#: How the paper endpoint names each kind of id (its "paper_id" forms).
_S2_ID_PREFIX = {"doi": "DOI", "arxiv": "ARXIV", "pmid": "PMID"}

# Unauthenticated: ~100 req / 5 min ≈ 0.33 req/s
_RATE_LIMITER = RateLimiter(requests_per_second=0.33)

_FIELDS = "paperId,externalIds,title,authors,abstract,publicationDate,url,fieldsOfStudy,openAccessPdf"


class SemanticScholarClient(BaseAPIClient):
    """Semantic Scholar repository API client."""

    describe_request = staticmethod(either(
        sent_params("query", "year", url=_S2_API_URL),
        sent_params("query", url=_S2_MATCH_URL),
        path_after(_S2_PAPER_URL)))

    def get_name(self) -> str:
        return "Semantic Scholar"

    def lookup(self, kind: str, value: str, max_results: int = 5) -> list[NormalizedResult]:
        """An id at ``/paper/{DOI:…|ARXIV:…|PMID:…}``; a title at ``/paper/search/match``.

        Both answer one paper, or 404 when Semantic Scholar holds none, which
        is its answer. The title match is Semantic Scholar's own closest title,
        which may not be the paper asked for; it is matched locally.
        """
        headers = {}
        api_key = get_credential_for(self._exec_id, "semantic_scholar_api_key")
        if api_key:
            headers["x-api-key"] = api_key
        if kind in _S2_ID_PREFIX:
            url, params = f"{_S2_PAPER_URL}/{_S2_ID_PREFIX[kind]}:{value.strip()}", {"fields": _FIELDS}
        elif kind == "title":
            url, params = _S2_MATCH_URL, {"query": value, "fields": _FIELDS}
        else:
            raise LookupUnsupported(f"Semantic Scholar cannot be asked for a paper by {kind}.")
        try:
            response = safe_request("GET", url, params=params, headers=headers or None,
                                    rate_limiter=_RATE_LIMITER)
        except Exception:
            logger.exception("Semantic Scholar lookup failed")
            return []
        if response.status_code == 404:
            note_not_found()
            return []
        if response.status_code != 200:
            return []
        data = read_json_body(response, "Semantic Scholar")
        if data is None:
            return []
        papers = data.get("data") if kind == "title" else [data]
        out = [p for p in (self._parse_paper(x) for x in (papers or []) if isinstance(x, dict)) if p]
        return out[:max_results]

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
        from .api_base import (  # noqa: PLC0415
            EntityUnsupported, _profile_query_name, note_author_query)

        name = _profile_query_name(profile)
        if not name:
            raise EntityUnsupported("That profile has no name to search with.")

        native = ""
        if isinstance(profile, dict):
            native = str(((profile.get("identifiers") or {})
                          .get("semantic_scholar") or {}).get("value") or "")

        author_id = native
        note_author_query("semantic_scholar" if native else "author", native or name)
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
        terms = kwargs.get("terms")
        text = search_terms.semantic_scholar(terms) if terms else query
        results: list[NormalizedResult] = []
        offset = 0
        page_size = min(max_results, 100)

        while len(results) < max_results:
            params: dict = {
                "query": text,
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

            data = read_json_body(response, "Semantic Scholar")
            if data is None:
                break

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

        locations, identifiers = _open_access(paper, ext_ids)
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
            open_access=locations,
            identifiers=identifiers,
        )


def _open_access(paper: dict, ext_ids: dict) -> tuple[list, list]:
    """``openAccessPdf`` and the arXiv, PubMed and PubMed Central ids in ``externalIds``.

    ``openAccessPdf`` is ``{url, status, license}``: Semantic Scholar's pointer
    to a PDF elsewhere, with the license it records for that copy (``CCBY``),
    or none. A pointer to arXiv is recorded as the arXiv id instead, so arXiv's
    copy is held once.
    """
    from . import open_access  # noqa: PLC0415

    locations = []
    identifiers: list[tuple[str, str]] = []
    pdf = paper.get("openAccessPdf")
    if isinstance(pdf, dict):
        found = open_access.location("semantic_scholar", pdf_url=pdf.get("url"),
                                     license=pdf.get("license"))
        if found is not None:
            arxiv_id = open_access.bare_arxiv_id(found.pdf_url or "")
            if arxiv_id and open_access.host_of(found.pdf_url) in ("arxiv.org", "export.arxiv.org"):
                identifiers.append(("arxiv", arxiv_id))
            else:
                locations.append(found)
    for key, scheme in (("ArXiv", "arxiv"), ("PubMed", "pmid"), ("PubMedCentral", "pmcid")):
        value = ext_ids.get(key)
        if isinstance(value, (str, int)) and str(value).strip():
            text = str(value).strip()
            if scheme == "pmcid" and not text.upper().startswith("PMC"):
                text = "PMC" + text
            identifiers.append((scheme, text))
    return locations, identifiers


# ---------------------------------------------------------------------------
# Registry auto-registration
# ---------------------------------------------------------------------------
def _register():
    from .api_registry import register_client
    register_client("semantic_scholar", SemanticScholarClient)

_register()
