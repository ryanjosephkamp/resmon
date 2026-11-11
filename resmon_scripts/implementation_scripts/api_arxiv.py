# resmon_scripts/implementation_scripts/api_arxiv.py
"""arXiv API client — Atom XML response parsing."""

import logging
import os
import re
import time
import xml.etree.ElementTree as ET

import httpx

from .api_base import (
    BaseAPIClient,
    NormalizedResult,
    RateLimiter,
    ServerCooldownActive,
    SourceRefused,
    SourceStoppedEarly,
    note_parse_failure,
    note_read,
    note_retry,
    note_retry_wait,
    waiting,
    retry_after_seconds,
    safe_request,
    search_outcome,
    sent_params,
)
from . import search_terms

logger = logging.getLogger(__name__)

_ARXIV_API_URL = "https://export.arxiv.org/api/query"
_ATOM_NS = "{http://www.w3.org/2005/Atom}"
_OPENSEARCH_NS = "{http://a9.com/-/spec/opensearch/1.1/}"
# arXiv's own field prefixes, from its API user manual's *Query Interface*
# table. A query opening with one of these already says which field it means,
# and prefixing `all:` in front of it makes a query arXiv rejects outright.
_FIELD_PREFIXED = re.compile(
    r"^\s*(?:ti|au|abs|co|jr|cat|rn|id|all)\s*:", re.IGNORECASE)

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
# one search has waited its budget in all. Every other status, a timeout and a
# dropped connection keep ``safe_request``'s ladder, and each attempt keeps its
# own request timeout.
#
# The budget depends on who is waiting for the search. A search a person
# started (a Deep Dive, a Deep Sweep, a watch's Run now) waits three minutes:
# 5 + 10 + 20 + 40 + 80 is 155 seconds over six attempts; the next wait would
# pass three minutes, so the sixth answer stands and the run records it with
# the time waited. A watch's scheduled run, which nobody is waiting on, waits
# fifteen minutes, and no single wait is longer than five: 5 + 10 + 20 + 40 +
# 80 + 160 + 300 is 615 seconds over eight attempts, and the next 300 would
# pass fifteen minutes. Three minutes was not enough at midnight: on November
# 4, 2026 a watch's run got 429 after 6 attempts and 155 seconds of waiting,
# the third midnight 429 known after October 27 and 29, while a single request
# at 8:55 PM that evening was answered in 0.15 seconds. The engine says
# which kind of run a search belongs to on its outcome channel
# (``SearchOutcome.unattended``), read when the search starts.
_PATIENT_STATUSES = frozenset({429, 503})
# The rest of ``safe_request``'s transient set, which it still retries itself.
_QUICK_RETRY_STATUSES = frozenset({500, 502, 504})
_FIRST_WAIT_SECONDS = 5.0
_PATIENCE_SECONDS = 180.0
_UNATTENDED_PATIENCE_SECONDS = 900.0
_UNATTENDED_LONGEST_WAIT_SECONDS = 300.0


def _budget(variable: str, ceiling: float) -> float:
    raw = os.environ.get(variable, "").strip()
    try:
        return min(ceiling, max(0.0, float(raw))) if raw else ceiling
    except ValueError:
        return ceiling


def _patience_seconds(unattended: bool = False) -> float:
    """The budget: three minutes, or fifteen for a watch's scheduled run.

    ``RESMON_ARXIV_PATIENCE_SECONDS`` and
    ``RESMON_ARXIV_UNATTENDED_PATIENCE_SECONDS`` can make each shorter, never
    longer: a test that stands in for arXiv and answers 503 every time sets
    them short, so a run that would wait minutes for a real arXiv ends in
    seconds.
    """
    if unattended:
        return _budget("RESMON_ARXIV_UNATTENDED_PATIENCE_SECONDS", _UNATTENDED_PATIENCE_SECONDS)
    return _budget("RESMON_ARXIV_PATIENCE_SECONDS", _PATIENCE_SECONDS)


# How often a wait looks for a canceled run: the longest a cancel waits for it.
_WAIT_SLICE_SECONDS = 0.5


def _wait(seconds: float) -> None:
    """Wait between attempts, ending early if the run is canceled.

    Slept with ``time.sleep`` a slice at a time, so a test that stubs
    ``time.sleep`` waits for nothing, and a seam besides, so a test can record
    the waits instead.
    """
    stop = search_outcome().stop
    left = max(0.0, float(seconds))
    while left > 0 and not stop.is_set():
        step = min(_WAIT_SLICE_SECONDS, left)
        time.sleep(step)
        left -= step


def _stopped() -> bool:
    """Whether the run this search belongs to was canceled (``SearchOutcome.stop``)."""
    return search_outcome().stop.is_set()


class _Patience:
    """One search's waiting, shared by all of its pages.

    Whether nobody is waiting on the search is read from its outcome channel
    when it starts, unless ``unattended`` says.
    """

    def __init__(self, unattended: bool | None = None) -> None:
        self.unattended = search_outcome().unattended if unattended is None else bool(unattended)
        self.budget = _patience_seconds(self.unattended)
        self.longest = _UNATTENDED_LONGEST_WAIT_SECONDS if self.unattended else None
        self.waited = 0.0
        self.next_wait = _FIRST_WAIT_SECONDS

    def allows(self, seconds: float) -> bool:
        if self.longest is not None and seconds > self.longest:
            return False
        return self.waited + seconds <= self.budget

    def lengthen(self) -> None:
        """The next wait of the ladder: twice this one, and no longer than the longest wait."""
        self.next_wait *= 2
        if self.longest is not None:
            self.next_wait = min(self.next_wait, self.longest)

    def spend(self, seconds: float, why: str, kind: str = "retry") -> None:
        logger.warning("arXiv %s; waiting %.0f s before asking again", why, seconds)
        # ``kind`` is what the run's heartbeat says this wait is for.
        note_retry()
        with waiting(kind, seconds):
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
            patience.spend(exc.seconds, "is cooling down after an earlier 429", "cooldown")
            if _stopped():
                raise
            continue
        if response.status_code not in _PATIENT_STATUSES:
            return response
        # Retry-After is the earliest arXiv will take another request, so it
        # is honored as a floor under the doubling wait rather than in place
        # of it: a header saying 0 or 1 would otherwise turn three minutes
        # into sixty requests three seconds apart. A Retry-After longer than
        # the longest wait a watch's scheduled run takes is not waited for.
        retry_after = retry_after_seconds(response)
        seconds = max(retry_after or 0.0, patience.next_wait)
        if not patience.allows(seconds):
            return response
        patience.spend(seconds, f"answered {response.status_code}")
        if _stopped():
            # The run was canceled during the wait: nothing reads this search
            # any more, so arXiv is not asked again for it.
            return response
        patience.lengthen()


def _date_clause(date_from: str | None, date_to: str | None) -> str | None:
    """arXiv's submission-date window, or ``None`` for a search with no dates.

    arXiv expects the literal format YYYYMMDDHHMM, where HHMM must be a valid
    clock time. Padding the right-hand endpoint with "9999" produces 99
    minutes, which arXiv rejects as an internal error and returns a fake entry
    titled "Error" with 0 real results. Pad with valid start/end-of-day times
    instead.
    """
    if not (date_from or date_to):
        return None
    d_from_raw = (date_from or "1900-01-01").replace("-", "")
    d_to_raw = (date_to or "2099-12-31").replace("-", "")
    d_from = (d_from_raw + "0000")[:12]   # start of day
    d_to = (d_to_raw + "2359")[:12]       # end of day
    return f"submittedDate:[{d_from} TO {d_to}]"


def _terms_query(terms: search_terms.Terms, date_from: str | None = None,
                 date_to: str | None = None) -> str:
    """The `search_query` for a search's terms: ``all:`` words and phrases, OR or AND.

    **arXiv reads several bare words as any one of them, and a date clause
    appended bare binds only the last one.** Measured October 30, 2026:
    `all:graph neural` matched 331,422 papers, the same total as
    `all:graph OR all:neural`, and `all:graph neural AND submittedDate:[...]`
    for January 2024 matched 152,934 papers where the window held 222 with
    both words. So every term is its own `all:` clause, joined with OR or AND
    (``search_terms.arxiv``), and several clauses are put in parentheses
    before the date window, so the window binds all of them.
    """
    clauses = search_terms.arxiv(terms)
    clause = _date_clause(date_from, date_to)
    if not clause:
        return clauses
    several = len(terms.terms) > 1 and (" OR " in clauses or " AND " in clauses)
    return f"({clauses}) AND {clause}" if several else f"{clauses} AND {clause}"


def _search_query(
    query: str, date_from: str | None = None, date_to: str | None = None,
) -> str:
    """The `search_query` for a string handed to ``search()`` with no terms.

    Only resmon itself does that. The person search in ``api_base`` puts the
    catalog's syntax into the string (`au:"Yoshua Bengio"`), and a string that
    opens with one of arXiv's field prefixes is sent as it is, in parentheses
    before a date window: wrapped into `all:au:"..."` it is answered with HTTP
    400, which read as a person who had published nothing. Any other string
    is read as a typed query (``search_terms.split_query``), every word and
    quoted phrase in it required.
    """
    clause = _date_clause(date_from, date_to)
    if _FIELD_PREFIXED.match(query):
        if not clause:
            return query
        grouped = f"({query})" if len(query.split()) > 1 else query
        return f"{grouped} AND {clause}"
    terms = search_terms.make(search_terms.split_query(query), search_terms.MATCH_ALL)
    if not terms:
        return f"all:{query}" + (f" AND {clause}" if clause else "")
    return _terms_query(terms, date_from, date_to)


def _feed(xml_text: str) -> ET.Element | None:
    try:
        return ET.fromstring(xml_text)
    except ET.ParseError:
        return None


def _refused(xml_text: str) -> bool:
    """Record arXiv's error entry as a refused request, and say whether there was one.

    arXiv answers a request it cannot run (a query it cannot parse, a page
    past what it serves) with HTTP 200 and a feed holding one entry whose id
    is under `https://arxiv.org/api/errors`, its summary saying what was
    wrong. Skipped, the search read as arXiv answering with no papers, which
    is a claim about the papers rather than about the request. It is recorded
    as a refused request, as HAL's error object is (``api_base.SourceRefused``),
    and arXiv's own words go to the log: the outcome keeps resmon's category,
    never the source's text.
    """
    root = _feed(xml_text)
    if root is None:
        return False
    for entry in root.findall(f"{_ATOM_NS}entry"):
        id_el = entry.find(f"{_ATOM_NS}id")
        if id_el is not None and id_el.text and "/api/errors" in id_el.text:
            summary = entry.find(f"{_ATOM_NS}summary")
            message = " ".join((summary.text or "").split())[:300] if summary is not None else ""
            search_outcome().note_failure(SourceRefused("arXiv"), _ARXIV_API_URL)
            logger.error("arXiv refused the request: %s", message or "(no message)")
            return True
    return False


def _page_count(xml_text: str) -> tuple[int | None, int]:
    """The papers arXiv counts for the search (`opensearch:totalResults`, or ``None``),
    and the entries on this page, every one, read or not.

    Paging and the check for an early end count the page's entries rather
    than the papers parsed from it, so an entry resmon skips (one with no
    title) does not read as arXiv sending fewer than it did.
    """
    root = _feed(xml_text)
    if root is None:
        return None, 0
    node = root.find(f"{_OPENSEARCH_NS}totalResults")
    try:
        total = int((node.text or "").strip()) if node is not None else None
    except ValueError:
        total = None
    return total, len(root.findall(f"{_ATOM_NS}entry"))


def _note_stopped_early(results: list[NormalizedResult], total: int) -> None:
    """Record a search arXiv ended short of the papers it counted for it.

    How far it got is recorded the way a source read in order records it
    (``note_read``): newest first, because the search asks for the newest
    submissions first, with the dates of the papers it held.
    """
    dates = [r.publication_date for r in results if r.publication_date]
    note_read(records=len(results), total=total,
              first_date=min(dates) if dates else None,
              last_date=max(dates) if dates else None, newest_first=True)
    search_outcome().note_failure(SourceStoppedEarly("arXiv"), _ARXIV_API_URL)
    logger.warning("arXiv sent %d of the %d papers it counted, then an empty or short page",
                   len(results), total)


class ArxivClient(BaseAPIClient):
    """arXiv repository API client."""

    describe_request = staticmethod(sent_params("search_query", "sortBy", "sortOrder", "id_list"))

    def get_name(self) -> str:
        return "arXiv"

    def lookup(self, kind: str, value: str, max_results: int = 5) -> list[NormalizedResult]:
        """An arXiv id through ``id_list``, the API's own way of asking for named papers;
        a title as ``ti:"..."`` in relevance order.

        Relevance, not the newest first that ``search()`` asks for: a title
        many later papers echo ("... is all you need") would otherwise leave
        the paper itself past the first few records.
        """
        from .api_base import LookupUnsupported, lookup_value  # noqa: PLC0415

        if kind == "arxiv":
            params = {"id_list": value.strip(), "max_results": max_results}
        elif kind == "title":
            params = {"search_query": f'ti:"{lookup_value(value)}"', "max_results": max_results,
                      "sortBy": "relevance", "sortOrder": "descending"}
        else:
            raise LookupUnsupported(f"arXiv cannot be asked for a paper by {kind}.")
        try:
            response = _patient_request(params, _Patience())
        except Exception:
            logger.exception("arXiv lookup failed")
            return []
        if response.status_code != 200:
            logger.error("arXiv API returned %d", response.status_code)
            return []
        if _refused(response.text):
            return []
        return self._parse_atom(response.text)

    def search(
        self,
        query: str,
        date_from: str | None = None,
        date_to: str | None = None,
        max_results: int = 100,
        **kwargs,
    ) -> list[NormalizedResult]:
        # A search's terms arrive as ``terms`` (``search_terms``), and each is
        # its own `all:` clause. A string with no terms is resmon's own: the
        # person search puts `au:"Yoshua Bengio"` into it, which ``_search_query``
        # sends as it is (see there).
        terms = kwargs.get("terms")
        search_query = (_terms_query(terms, date_from, date_to) if terms
                        else _search_query(query, date_from, date_to))

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

            if _refused(response.text):
                break
            entries = self._parse_atom(response.text)
            total, sent = _page_count(response.text)

            results.extend(entries)
            start += sent

            # A page shorter than the one asked for is the last one, and the
            # count arXiv gives for the search says whether it really was.
            # arXiv can send an empty or short page while it still counts
            # more papers for the search; ending there silently would record
            # a search that answered in full.
            if sent < params["max_results"]:
                if total is not None and start < min(total, max_results):
                    _note_stopped_early(results, total)
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

            # arXiv's answer to a request it cannot run is an entry whose
            # <id> is under https://arxiv.org/api/errors; it is not a paper.
            # ``_refused`` records it before a search reads the page.
            id_el_check = entry.find(f"{_ATOM_NS}id")
            if id_el_check is not None and id_el_check.text and "/api/errors" in id_el_check.text:
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
            url = re.sub(r"^http://(?=arxiv\.org/)", "https://", raw_id, flags=re.I)

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

            # The paper's arXiv id, from which its own PDF address is built
            # (``open_access.arxiv_location``); its license is read from arXiv
            # when the PDF is asked for, because the Atom feed does not say.
            from . import open_access  # noqa: PLC0415

            arxiv_id = open_access.bare_arxiv_id(raw_id)
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
                identifiers=[("arxiv", arxiv_id)] if arxiv_id else [],
            ))

        return results


# ---------------------------------------------------------------------------
# Registry auto-registration
# ---------------------------------------------------------------------------
def _register():
    from .api_registry import register_client
    register_client("arxiv", ArxivClient)

_register()
