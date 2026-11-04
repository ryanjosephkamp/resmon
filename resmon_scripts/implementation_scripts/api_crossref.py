# resmon_scripts/implementation_scripts/api_crossref.py
"""Crossref API client — JSON response, polite pool with a contact address."""

import logging

from .api_base import (Author, BaseAPIClient, NormalizedResult, RateLimiter,
                       bare_orcid, read_json_body, safe_request, sent_params)

logger = logging.getLogger(__name__)

_CROSSREF_API_URL = "https://api.crossref.org/works"

# Since July 21, 2026, Crossref answers requests for lists of records (a query
# or a filter, which is every request resmon makes, the lifecycle check's DOI
# batches included) at 1 a second from its public pool and 3 a second from its
# polite pool, the one a contact address reaches; single records stay at 5 and
# 10 (https://community.crossref.org/t/16137). 1 a second keeps within the
# public pool whether or not an address is set.
_RATE_LIMITER = RateLimiter(requests_per_second=1.0)


class CrossrefClient(BaseAPIClient):
    """Crossref repository API client."""

    describe_request = staticmethod(sent_params("query", "query.author", "filter"))

    def __init__(self, mailto: str | None = None):
        # The address set in Settings › Sources, or None, when nothing is sent (``source_contact``).
        self._mailto = mailto

    def get_name(self) -> str:
        return "Crossref"

    def search_entity(
        self,
        profile,
        date_from: str | None = None,
        date_to: str | None = None,
        max_results: int = 100,
        **kwargs,
    ) -> list[NormalizedResult]:
        """Ask this source about a person through its own **parameter**.

        Not the generic implementation in ``BaseAPIClient``, which formats a
        field into the query string: this source takes a separate parameter, and
        ``search()`` is where the parameter is built.
        """
        from .api_base import (  # noqa: PLC0415
            EntityUnsupported, _profile_query_name, note_author_query)

        name = _profile_query_name(profile)
        if not name:
            raise EntityUnsupported("That profile has no name to search with.")
        note_author_query("author", name)
        return self.search("", date_from, date_to, max_results, author=name, **kwargs)

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
                "rows": min(page_size, max_results - len(results)),
                **({"mailto": self._mailto} if self._mailto else {}),
            }

            # 2.1 — an author query goes in `query.author`, not `query`.
            # Crossref's own parameter, established 2026-09-06: it returned five
            # works naming the author and none for an author who does not exist.
            author = kwargs.get("author")
            if author:
                params.pop("query", None)
                params["query.author"] = author

            # Date filtering
            filters = []
            if date_from:
                filters.append(f"from-pub-date:{date_from}")
            if date_to:
                filters.append(f"until-pub-date:{date_to}")
            if filters:
                params["filter"] = ",".join(filters)

            try:
                response = safe_request(
                    "GET", _CROSSREF_API_URL,
                    params=params,
                    rate_limiter=_RATE_LIMITER,
                )
                if response.status_code != 200:
                    logger.error("Crossref API returned %d", response.status_code)
                    break
            except Exception:
                logger.exception("Crossref API request failed")
                break

            data = read_json_body(response, "Crossref")
            if data is None:
                break

            items = data.get("message", {}).get("items", [])
            if not items:
                break

            for item in items:
                results.append(self._parse_item(item))

            offset += len(items)
            if len(items) < params["rows"]:
                break

        return results[:max_results]

    # ------------------------------------------------------------------
    # Parsing
    # ------------------------------------------------------------------

    @staticmethod
    def _parse_item(item: dict) -> NormalizedResult:
        """Map a Crossref work item to NormalizedResult."""
        # Title
        title_list = item.get("title", [])
        title = title_list[0] if title_list else "Untitled"

        # DOI
        doi = item.get("DOI")

        # External ID — use DOI as canonical identifier
        external_id = doi or ""

        # Authors
        # 2.1 — Crossref carries both fields and populates them rarely.
        # Measured 2026-09-06 over 50 works: **2 of 84 authors had an `ORCID`
        # and 26 of 84 a non-empty `affiliation`**. The `affiliation` key is on
        # every author object and is an empty list on most, which is why the
        # catalog capability was counted rather than read off the key names.
        authors = []
        for author in item.get("author", []):
            given = author.get("given", "")
            family = author.get("family", "")
            name = f"{given} {family}".strip()
            if not name:
                continue
            affiliations = tuple(
                str(a.get("name")).strip() for a in (author.get("affiliation") or [])
                if isinstance(a, dict) and a.get("name")
            )
            authors.append(Author(
                name=name,
                orcid=bare_orcid(author.get("ORCID")),
                affiliations=affiliations,
            ))

        # Abstract
        abstract = item.get("abstract")
        if abstract:
            # Crossref abstracts sometimes contain JATS XML tags
            import re
            abstract = re.sub(r"<[^>]+>", "", abstract).strip()

        # Publication date — prefer published-print, then published-online, then created
        publication_date = None
        for date_key in ("published-print", "published-online", "created"):
            date_obj = item.get(date_key)
            if date_obj and "date-parts" in date_obj:
                parts = date_obj["date-parts"][0]
                if parts:
                    year = str(parts[0])
                    month = str(parts[1]).zfill(2) if len(parts) > 1 else "01"
                    day = str(parts[2]).zfill(2) if len(parts) > 2 else "01"
                    publication_date = f"{year}-{month}-{day}"
                    break

        # URL
        url = item.get("URL", f"https://doi.org/{doi}" if doi else "")

        # Categories / subjects
        categories = item.get("subject", [])

        return NormalizedResult(
            source_repository="crossref",
            external_id=external_id,
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
    register_client("crossref", CrossrefClient)

_register()
