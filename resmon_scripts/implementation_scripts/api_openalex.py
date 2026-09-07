# resmon_scripts/implementation_scripts/api_openalex.py
"""OpenAlex API client — JSON, polite pool with mailto."""

import logging

from .api_base import Author, BaseAPIClient, NormalizedResult, RateLimiter, bare_orcid, safe_request

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
        from .api_base import EntityUnsupported, _profile_query_name  # noqa: PLC0415

        name = _profile_query_name(profile)
        if not name:
            raise EntityUnsupported("That profile has no name to search with.")

        # The identifier query, where there is one. An ORCID search is a search
        # for a *person*; a name search is a search for a string, and OpenAlex is
        # the only source in the catalog that offers the first.
        orcid = ""
        if isinstance(profile, dict):
            orcid = str(((profile.get("identifiers") or {})
                         .get("orcid") or {}).get("value") or "")
        if orcid:
            return self.search("", date_from, date_to, max_results,
                               author_orcid=orcid, **kwargs)
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
        page = 1
        per_page = min(max_results, 200)

        while len(results) < max_results:
            params: dict = {
                "search": query,
                "page": page,
                "per-page": min(per_page, max_results - len(results)),
                "mailto": self._mailto,
            }

            # 2.1 — OpenAlex is the only source with a real **identifier**
            # query. `author.orcid:` returned 1,294 works for one ORCID on
            # 2026-09-06 and OpenAlex echoed back the parsed filter, so this is
            # an identity search and not a name search that happens to work.
            #
            # `raw_author_name.search:` is the name query, used when the profile
            # has no ORCID. Both are *filters*, so the free-text `search` is
            # dropped: leaving it in would AND a keyword query onto a person
            # query and quietly hide most of their papers.
            filters = []
            author_orcid = kwargs.get("author_orcid")
            author_name = kwargs.get("author")
            if author_orcid or author_name:
                params.pop("search", None)
                if author_orcid:
                    filters.append(f"author.orcid:https://orcid.org/{author_orcid}")
                else:
                    filters.append(f"raw_author_name.search:{author_name}")

            # Date filtering
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

        # 2.1 — the identity OpenAlex actually returns. Measured 2026-09-06 over
        # one author query: **9 of 17 authorships carried an ORCID and 14 of 17 a
        # raw affiliation string**, so both are common here and neither is
        # reliable. An author with no ORCID is the ordinary case and is stored
        # with `orcid=None`, which downstream reads as "OpenAlex did not say".
        authors = []
        for authorship in work.get("authorships", []):
            author_obj = authorship.get("author", {}) or {}
            name = (author_obj.get("display_name") or "").strip()
            if not name:
                continue
            orcid = bare_orcid(author_obj.get("orcid"))
            affiliations = tuple(
                s.strip() for s in (authorship.get("raw_affiliation_strings") or [])
                if isinstance(s, str) and s.strip()
            )
            openalex_id = (author_obj.get("id") or "").rsplit("/", 1)[-1]
            authors.append(Author(
                name=name,
                orcid=orcid,
                affiliations=affiliations,
                source_ids=(("openalex", openalex_id),) if openalex_id else (),
            ))

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
