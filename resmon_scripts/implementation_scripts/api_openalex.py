# resmon_scripts/implementation_scripts/api_openalex.py
"""OpenAlex API client — JSON, polite pool with mailto."""

import logging

from .api_base import (Author, BaseAPIClient, NormalizedResult, RateLimiter,
                       bare_orcid, read_json_body, safe_request, sent_params)

logger = logging.getLogger(__name__)

_OPENALEX_API_URL = "https://api.openalex.org/works"

# Polite pool: 10 req/s with mailto
_RATE_LIMITER = RateLimiter(requests_per_second=10.0)


class OpenAlexClient(BaseAPIClient):
    """OpenAlex repository API client."""

    describe_request = staticmethod(sent_params("search", "filter"))

    def __init__(self, mailto: str | None = None):
        # The address set in Settings › Sources, or None, when nothing is sent (``source_contact``).
        self._mailto = mailto

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
        from .api_base import (  # noqa: PLC0415
            EntityUnsupported, _profile_query_name, note_author_query)

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
            note_author_query("orcid", orcid)
            return self.search("", date_from, date_to, max_results,
                               author_orcid=orcid, **kwargs)
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
        page = 1
        per_page = min(max_results, 200)

        while len(results) < max_results:
            # A page number is an offset *over the page size*, so the size is
            # held for the whole search. Shrinking it on the last request
            # moves the window: asking for 250 would fetch page 1 at 200 per
            # page and then page 2 at 50, which is records 51-100 a second
            # time, while 201-250 were never requested at all. Dedup collapsed
            # the duplicates, so the shortfall would be invisible. ``api_zenodo.py``
            # carries the same note; the overshoot is trimmed by the
            # ``results[:max_results]`` this loop already ends with.
            params: dict = {
                "search": query,
                "page": page,
                "per-page": per_page,
                **({"mailto": self._mailto} if self._mailto else {}),
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

            data = read_json_body(response, "OpenAlex")
            if data is None:
                break

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

        locations, identifiers = _open_access(work)
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
            open_access=locations,
            identifiers=identifiers,
        )


def _open_access(work: dict) -> tuple[list, list]:
    """The open copies OpenAlex lists for a work, and its PMID, PMCID and arXiv id.

    OpenAlex's ``locations`` are Unpaywall's: every place the work is hosted,
    each with ``is_oa``, a ``pdf_url`` and a ``landing_page_url``, the
    ``license`` OpenAlex records for that copy (``cc-by``, ``publisher-specific-oa``,
    or none) and its ``version``. Only the ones marked open are kept;
    ``best_oa_location`` is one of them and adds nothing. An arXiv copy names
    its id in its address, and ``ids`` carries the PMID and PMCID as URLs.
    """
    from . import open_access  # noqa: PLC0415 - a cycle through api_base otherwise

    locations = []
    seen: set[str] = set()
    identifiers: list[tuple[str, str]] = []
    nodes = list(work.get("locations") or [])
    best = work.get("best_oa_location")
    if isinstance(best, dict):
        nodes.append(best)
    for node in nodes:
        if not isinstance(node, dict) or node.get("is_oa") is not True:
            continue
        found = open_access.location(
            "openalex", pdf_url=node.get("pdf_url"), landing_url=node.get("landing_page_url"),
            license=node.get("license"), version=node.get("version"))
        if found is None or found.location in seen:
            continue
        seen.add(found.location)
        arxiv_id = open_access.bare_arxiv_id(found.landing_url or found.pdf_url or "")
        if arxiv_id and open_access.host_of(found.location) in ("arxiv.org", "www.arxiv.org"):
            # arXiv's own copy is recorded once, from the id, with its license
            # read from arXiv; OpenAlex's record of it adds its license when
            # OpenAlex states one.
            identifiers.append(("arxiv", arxiv_id))
            if found.license is None:
                continue
        locations.append(found)
    ids = work.get("ids") if isinstance(work.get("ids"), dict) else {}
    pmid = str(ids.get("pmid") or "").rstrip("/").rsplit("/", 1)[-1]
    if pmid.isdigit():
        identifiers.append(("pmid", pmid))
    pmcid = str(ids.get("pmcid") or "").rstrip("/").rsplit("/", 1)[-1]
    if pmcid.upper().startswith("PMC"):
        identifiers.append(("pmcid", pmcid.upper()))
    return locations, identifiers


# ---------------------------------------------------------------------------
# Registry auto-registration
# ---------------------------------------------------------------------------
def _register():
    from .api_registry import register_client
    register_client("openalex", OpenAlexClient)

_register()
