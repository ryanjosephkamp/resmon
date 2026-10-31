# resmon_scripts/implementation_scripts/api_arxiv.py
"""arXiv API client — Atom XML response parsing."""

import logging
import re
import time
import xml.etree.ElementTree as ET

import httpx

from .api_base import (
    BaseAPIClient,
    NormalizedResult,
    RateLimiter,
    ServerCooldownActive,
    note_parse_failure,
    note_retry_wait,
    retry_after_seconds,
    safe_request,
)

logger = logging.getLogger(__name__)

_ARXIV_API_URL = "https://export.arxiv.org/api/query"
_ATOM_NS = "{http://www.w3.org/2005/Atom}"
# arXiv's own field prefixes, from its API user manual's *Query Interface*
# table. A query opening with one of these already says which field it means,
# and prefixing `all:` in front of it makes a query arXiv rejects outright.
_FIELD_PREFIXED = re.compile(
    r"^\s*(?:ti|au|abs|co|jr|cat|rn|id|all)\s*:", re.IGNORECASE)

# arXiv's own query syntax anywhere in the string: a field prefix on any term,
# or one of its Boolean operators. The manual names AND, OR and ANDNOT; NOT
# is here too because arXiv parses it as ANDNOT (October 30, 2026:
# `all:graph NOT neural` and `all:graph ANDNOT all:neural` both returned
# 130,463). A query written in that syntax is sent as typed. The operators
# are arXiv's only in capitals; a lowercase "and" is a word.
_FIELD_ANYWHERE = re.compile(
    r"(?:^|[\s(])(?:ti|au|abs|co|jr|cat|rn|id|all)\s*:", re.IGNORECASE)
_OPERATOR = re.compile(r"(?<!\S)(?:AND|OR|ANDNOT|NOT)(?!\S)")

# A quoted phrase, or a run of characters with no space and no quote. A stray
# quote with no partner is dropped rather than sent: arXiv cannot parse one.
_TERM = re.compile(r'"[^"]*"|[^\s"]+')

# The English stop words of Lucene's default list, which arXiv's index leaves
# out. Requiring one empties the search: measured October 30, 2026 against
# `all:graph` (151,599 papers), `all:graph AND all:<word>` returned at most 359
# for 32 of these 33 words, and 0 for `all:theory AND all:of AND all:mind`
# where `all:theory AND all:mind` returned 2,013. The 33rd, `a`, is indexed in
# some records and requiring it cut the same search to 39,726, which is not
# what anybody typing "a" means either. They are left out of the words that
# must match; a quoted phrase keeps them, and arXiv matches it as written.
_STOP_WORDS = frozenset({
    "a", "an", "and", "are", "as", "at", "be", "but", "by", "for", "if", "in",
    "into", "is", "it", "no", "not", "of", "on", "or", "such", "that", "the",
    "their", "then", "there", "these", "they", "this", "to", "was", "will",
    "with",
})

_ARXIV_NS = "{http://arxiv.org/schemas/atom}"

# arXiv guideline: 1 request per 3 seconds
_RATE_LIMITER = RateLimiter(requests_per_second=0.33)

# What arXiv is given when it answers 429 or 503: time. Its API terms ask for
# no more than one request every three seconds, and a 429 means it wants far
# longer than that. ``safe_request``'s shared ladder waits 1, 2 and 4 seconds,
# which the limiter stretches to three each, so a nightly watch spent its four
# attempts inside about ten seconds and failed (October 27 and 29, 2026:
# `rate_limited`, HTTP 429, 4 attempts, an 11-second run). So those two
# statuses are left out of ``safe_request``'s own retries and waited out here:
# 5 seconds doubling, or longer when arXiv's Retry-After asks for longer, until
# one search has waited `_PATIENCE_SECONDS` in all. 5 + 10 + 20 + 40 + 80 is
# 155 seconds over six attempts; the next wait would pass three minutes, so
# the sixth answer stands and the run records it with the time waited. Every
# other status, a timeout and a dropped connection keep ``safe_request``'s
# ladder, and each attempt keeps its own request timeout.
_PATIENT_STATUSES = frozenset({429, 503})
# The rest of ``safe_request``'s transient set, which it still retries itself.
_QUICK_RETRY_STATUSES = frozenset({500, 502, 504})
_FIRST_WAIT_SECONDS = 5.0
_PATIENCE_SECONDS = 180.0


def _wait(seconds: float) -> None:
    """Sleep between attempts. A seam, so a test can wait without sleeping."""
    time.sleep(seconds)


class _Patience:
    """One search's waiting, shared by all of its pages."""

    def __init__(self) -> None:
        self.waited = 0.0
        self.next_wait = _FIRST_WAIT_SECONDS

    def allows(self, seconds: float) -> bool:
        return self.waited + seconds <= _PATIENCE_SECONDS

    def spend(self, seconds: float, why: str) -> None:
        logger.warning("arXiv %s; waiting %.0f s before asking again", why, seconds)
        _wait(seconds)
        self.waited += seconds
        note_retry_wait(seconds)


def _patient_request(params: dict, patience: _Patience) -> httpx.Response:
    """One page, asked again after a 429 or a 503 until the patience runs out.

    The response that ends the ladder is returned as it is, so a page that is
    still 429 after the last wait reaches the caller, and the run, as the
    failure it is. ``safe_request`` has already recorded each attempt.
    """
    while True:
        try:
            response = safe_request(
                "GET", _ARXIV_API_URL,
                params=params,
                rate_limiter=_RATE_LIMITER,
                retry_statuses=_QUICK_RETRY_STATUSES,
            )
        except ServerCooldownActive as exc:
            # Another arXiv search was told to wait, and the shared limiter
            # holds that cooldown for every search. Wait it out here too,
            # rather than giving up while the time is inside the budget.
            if not patience.allows(exc.seconds):
                raise
            patience.spend(exc.seconds, "is cooling down after an earlier 429")
            continue
        if response.status_code not in _PATIENT_STATUSES:
            return response
        # Retry-After is the earliest arXiv will take another request, so it
        # is honored as a floor under the doubling wait rather than in place
        # of it: a header saying 0 or 1 would otherwise turn three minutes
        # into sixty requests three seconds apart.
        retry_after = retry_after_seconds(response)
        seconds = max(retry_after or 0.0, patience.next_wait)
        if not patience.allows(seconds):
            return response
        patience.spend(seconds, f"answered {response.status_code}")
        patience.next_wait *= 2


def _search_query(
    query: str, date_from: str | None = None, date_to: str | None = None,
) -> str:
    """The `search_query` arXiv is sent: every plain word must match.

    **arXiv reads several bare words as any one of them.** Measured October 30,
    2026: `all:graph` matched 151,599 papers, `all:neural` 200,959, and
    `all:graph neural` 331,422, the same total as `all:graph OR all:neural`;
    `all:graph AND all:neural` matched 21,136. This client sent `all:{query}`,
    so every multi-word search and watch over arXiv found papers containing
    any one of its words while the catalog said all of them.

    It was worse with a date window. `all:graph neural AND submittedDate:[...]`
    parses as `all:graph OR (neural AND submittedDate:[...])`: for January 2024
    it matched 152,934 papers where the window held 222 with both words, so
    the window bound only the last word and a dated search came back with
    papers from any year.

    So a plain query becomes one `all:` term per word, joined with AND, and a
    quoted phrase stays one exact phrase. Stop words are left out of the AND
    (see ``_STOP_WORDS``) unless the query has nothing else. A query written in
    arXiv's own syntax -- a field prefix or a Boolean operator anywhere -- is
    sent as typed, because whoever wrote it chose arXiv's meaning: one opening
    with a field is passed through whole, as the entity search needs (see the
    comment in ``search``), and any other gets `all:` in front, as before. The
    date clause is appended last, and a query sent as typed is put in
    parentheses first so the window binds all of it rather than its last term.
    """
    if _FIELD_PREFIXED.match(query):
        search_query = query
        typed = True
    elif _FIELD_ANYWHERE.search(query) or _OPERATOR.search(query):
        search_query = f"all:{query}"
        typed = True
    else:
        terms = [term for term in _TERM.findall(query) if term != '""']
        words = [
            term for term in terms
            if term.startswith('"') or term.lower() not in _STOP_WORDS
        ]
        terms = words or terms
        search_query = " AND ".join(f"all:{term}" for term in terms) or f"all:{query}"
        typed = False

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
        if typed and len(search_query.split()) > 1:
            search_query = f"({search_query})"
        search_query += f" AND submittedDate:[{d_from} TO {d_to}]"
    return search_query


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
        # `all:` is the default field, and it is wrong for a query that already
        # names one.
        #
        # **This was a real defect, found by the first live case that drove
        # `search_entity` against arXiv.** The generic `search_entity` in
        # `api_base` asks a source by putting the catalog's own syntax into the
        # query string — `au:"Yoshua Bengio"` for arXiv — on the reasonable
        # assumption that `search()` sends the string it is given. This client
        # did not: it wrapped it into `all:au:"Yoshua Bengio"`, which arXiv
        # answers **HTTP 400**. The client logs the status and returns `[]`, so
        # every watch routine over arXiv reported that the person had published
        # nothing. Silent, plausible and wrong — the failure shape this app
        # exists to refuse.
        #
        # A query that already opens with one of arXiv's own field prefixes is
        # passed through unwrapped. This also fixes the same query typed into a
        # Deep Dive box, which produced the same 400 for the same reason.
        #
        # Every other query is built by ``_search_query``, which is where a
        # watch's keyword list arrives too: every writer of a watch or a
        # search (both renderers, the MCP server and the command line) joins
        # the keywords with spaces into ``query``, and the sweep engine hands
        # that string to ``search()`` unchanged.
        search_query = _search_query(query, date_from, date_to)

        results: list[NormalizedResult] = []
        start = 0
        page_size = min(max_results, 100)
        patience = _Patience()

        while len(results) < max_results:
            params = {
                "search_query": search_query,
                "start": start,
                "max_results": min(page_size, max_results - len(results)),
                "sortBy": "submittedDate",
                "sortOrder": "descending",
            }

            try:
                response = _patient_request(params, patience)
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
            # A 200 whose body will not parse ends the paging loop and the
            # search returns []. Without this the record would read "arXiv
            # answered and had nothing", which is a different claim.
            note_parse_failure()
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
