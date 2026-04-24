# resmon_scripts/implementation_scripts/api_arxiv.py
"""arXiv API client — Atom XML response parsing."""

import logging
import xml.etree.ElementTree as ET

from .api_base import BaseAPIClient, NormalizedResult, RateLimiter, safe_request

logger = logging.getLogger(__name__)

_ARXIV_API_URL = "https://export.arxiv.org/api/query"
_ATOM_NS = "{http://www.w3.org/2005/Atom}"
_ARXIV_NS = "{http://arxiv.org/schemas/atom}"

# arXiv guideline: 1 request per 3 seconds
_RATE_LIMITER = RateLimiter(requests_per_second=0.33)


class ArxivClient(BaseAPIClient):
    """arXiv repository API client."""

    def get_name(self) -> str:
        return "arXiv"

    def search(
        self,
        query: str,
        date_from: str | None = None,
        date_to: str | None = None,
        max_results: int = 100,
        **kwargs,
    ) -> list[NormalizedResult]:
        search_query = f"all:{query}"

        # Date filtering via submittedDate field. arXiv expects the literal
        # format YYYYMMDDHHMM, where HHMM must be a valid clock time. Padding
        # the right-hand endpoint with "9999" produces 99 minutes, which arXiv
        # rejects as an internal error and returns a fake entry titled "Error"
        # with 0 real results. Pad with valid start/end-of-day times instead.
        if date_from or date_to:
            d_from_raw = (date_from or "1900-01-01").replace("-", "")
            d_to_raw = (date_to or "2099-12-31").replace("-", "")
            d_from = (d_from_raw + "0000")[:12]   # start of day
            d_to = (d_to_raw + "2359")[:12]       # end of day
            search_query += f" AND submittedDate:[{d_from} TO {d_to}]"

        results: list[NormalizedResult] = []
        start = 0
        page_size = min(max_results, 100)

        while len(results) < max_results:
            params = {
                "search_query": search_query,
                "start": start,
                "max_results": min(page_size, max_results - len(results)),
                "sortBy": "submittedDate",
                "sortOrder": "descending",
            }

            try:
                response = safe_request(
                    "GET", _ARXIV_API_URL,
                    params=params,
                    rate_limiter=_RATE_LIMITER,
                )
                if response.status_code != 200:
                    logger.error("arXiv API returned %d", response.status_code)
                    break
            except Exception:
                logger.exception("arXiv API request failed")
                break

            entries = self._parse_atom(response.text)
            if not entries:
                break

            results.extend(entries)
            start += len(entries)

            # arXiv returns fewer than requested when no more results
            if len(entries) < params["max_results"]:
                break

        return results[:max_results]

    # ------------------------------------------------------------------
    # Parsing
    # ------------------------------------------------------------------

    @staticmethod
    def _parse_atom(xml_text: str) -> list[NormalizedResult]:
        """Parse Atom XML feed into NormalizedResult list."""
        results: list[NormalizedResult] = []
        try:
            root = ET.fromstring(xml_text)
        except ET.ParseError:
            logger.error("Failed to parse arXiv Atom XML response")
            return results

        for entry in root.findall(f"{_ATOM_NS}entry"):
            # Skip opensearch total element or error entries
            title_el = entry.find(f"{_ATOM_NS}title")
            if title_el is None or title_el.text is None:
                continue

            # arXiv returns a synthetic "Error" entry whose <id> points at
            # https://arxiv.org/api/errors when the query itself is malformed.
            # Skip those so they don't pollute real results.
            id_el_check = entry.find(f"{_ATOM_NS}id")
            if id_el_check is not None and id_el_check.text and "/api/errors" in id_el_check.text:
                logger.warning("arXiv returned error entry: %s",
                               (entry.find(f"{_ATOM_NS}summary").text or "").strip()[:200]
                               if entry.find(f"{_ATOM_NS}summary") is not None else "")
                continue

            title = " ".join(title_el.text.split())

            # Extract arXiv ID from the <id> element (URL form)
            id_el = entry.find(f"{_ATOM_NS}id")
            raw_id = id_el.text.strip() if id_el is not None and id_el.text else ""
            # e.g. http://arxiv.org/abs/2604.12345v1 → 2604.12345v1
            external_id = raw_id.rsplit("/", 1)[-1] if "/" in raw_id else raw_id

            # DOI (optional, via arxiv namespace or link)
            doi_el = entry.find(f"{_ARXIV_NS}doi")
            doi = doi_el.text.strip() if doi_el is not None and doi_el.text else None

            # Authors
            authors = []
            for author_el in entry.findall(f"{_ATOM_NS}author"):
                name_el = author_el.find(f"{_ATOM_NS}name")
                if name_el is not None and name_el.text:
                    authors.append(name_el.text.strip())

            # Abstract
            summary_el = entry.find(f"{_ATOM_NS}summary")
            abstract = " ".join(summary_el.text.split()) if summary_el is not None and summary_el.text else None

            # Publication date
            published_el = entry.find(f"{_ATOM_NS}published")
            publication_date = None
            if published_el is not None and published_el.text:
                publication_date = published_el.text.strip()[:10]  # YYYY-MM-DD

            # URL — prefer the abstract page link
            url = raw_id

            # Categories
            categories = []
            for cat_el in entry.findall(f"{_ARXIV_NS}primary_category"):
                term = cat_el.get("term")
                if term:
                    categories.append(term)
            for cat_el in entry.findall(f"{_ATOM_NS}category"):
                term = cat_el.get("term")
                if term and term not in categories:
                    categories.append(term)

            results.append(NormalizedResult(
                source_repository="arxiv",
                external_id=external_id,
                doi=doi,
                title=title,
                authors=authors,
                abstract=abstract,
                publication_date=publication_date,
                url=url,
                categories=categories,
            ))

        return results


# ---------------------------------------------------------------------------
# Registry auto-registration
# ---------------------------------------------------------------------------
def _register():
    from .api_registry import register_client
    register_client("arxiv", ArxivClient)

_register()
