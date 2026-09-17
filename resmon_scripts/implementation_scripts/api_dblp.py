# resmon_scripts/implementation_scripts/api_dblp.py
"""DBLP API client — REST keyword search and SPARQL author search."""

import email.utils
import logging
import re
import time
from datetime import date, datetime, timezone

from .api_base import (
    Author,
    BaseAPIClient,
    EntityUnsupported,
    NormalizedResult,
    RateLimiter,
    _profile_query_name,
    note_parse_failure,
    note_parse_failure_unless_transport,
    note_unanswerable,
    safe_request,
)

logger = logging.getLogger(__name__)

_DBLP_API_URL = "https://dblp.org/search/publ/api"
_DBLP_SPARQL_URL = "https://sparql.dblp.org/sparql"
_DBLP_USER_AGENT = "resmon-scholar-monitor (+https://github.com/ryanjosephkamp/resmon)"
_SEARCH_BUDGET_SECONDS = 45.0
_REQUEST_TIMEOUT_SECONDS = 10.0
_MAX_RESPONSE_ATTEMPTS = 2
_SPARQL_PAGE_SIZE = 100
_TRANSIENT_CODES = {429, 500, 502, 503, 504}

# DBLP asks automated clients to leave one or two seconds between requests.
# Use the slower documented boundary, shared by REST and SPARQL calls.
_RATE_LIMITER = RateLimiter(requests_per_second=0.5)
_DBLP_HEADERS = {"User-Agent": _DBLP_USER_AGENT}
_RECORD_IRI_PREFIX = "https://dblp.org/rec/"
_PERSON_IRI_PREFIX = "https://dblp.org/pid/"
_DOI_IRI_PREFIX = "https://doi.org/"
_XSD_GYEAR = "http://www.w3.org/2001/XMLSchema#gYear"
_YEAR_RE = re.compile(r"^\d{4}$")


def _looks_like_access_challenge(response) -> bool:
    """Recognize the observed DBLP HTML challenge without trying to bypass it."""
    headers = getattr(response, "headers", {}) or {}
    content_type = str(headers.get("content-type", "")).lower()
    body = str(getattr(response, "text", ""))[:4096].lower()
    return "text/html" in content_type and (
        "making sure you are not a bot" in body or "anubis" in body
    )


def _header(response, name: str) -> str | None:
    headers = getattr(response, "headers", {}) or {}
    for key, value in headers.items():
        if str(key).lower() == name.lower():
            return str(value)
    return None


def _retry_after_seconds(response) -> float | None:
    """Return a valid Retry-After delay, without inventing invalid values."""
    value = _header(response, "retry-after")
    if not value:
        return None
    try:
        return max(0.0, float(value.strip()))
    except ValueError:
        try:
            when = email.utils.parsedate_to_datetime(value)
            if when.tzinfo is None:
                when = when.replace(tzinfo=timezone.utc)
            return max(0.0, (when - datetime.now(timezone.utc)).total_seconds())
        except (TypeError, ValueError, OverflowError):
            logger.warning("DBLP returned an invalid Retry-After value")
            return None


def _wait_for_retry(response, deadline: float) -> bool:
    """Honor Retry-After only when it fits inside the shared search budget."""
    wait = _retry_after_seconds(response)
    if wait is None:
        return True
    remaining = deadline - time.monotonic()
    if wait >= remaining:
        logger.error(
            "DBLP Retry-After %.1fs exceeds the remaining %.1fs search budget; "
            "the request stays failed",
            wait,
            max(0.0, remaining),
        )
        return False
    time.sleep(wait)
    return True


def _request_payload(
    method: str,
    url: str,
    deadline: float,
    **request_kwargs,
) -> dict | None:
    """Read one DBLP response with shared pacing and truthful failures."""
    extra_headers = request_kwargs.pop("headers", {})
    for attempt in range(_MAX_RESPONSE_ATTEMPTS):
        try:
            response = safe_request(
                method,
                url,
                rate_limiter=_RATE_LIMITER,
                timeout=_REQUEST_TIMEOUT_SECONDS,
                max_retries=0,
                deadline=deadline,
                headers={**_DBLP_HEADERS, **extra_headers},
                **request_kwargs,
            )
        except Exception as exc:
            if attempt + 1 < _MAX_RESPONSE_ATTEMPTS:
                logger.warning("DBLP API request failed; retrying once: %s", exc)
                continue
            logger.exception("DBLP API request failed")
            return None

        if _looks_like_access_challenge(response):
            note_parse_failure("access_challenge")
            logger.error("DBLP returned an access-challenge page")
            return None

        if not 200 <= response.status_code < 300:
            if (
                response.status_code in _TRANSIENT_CODES
                and attempt + 1 < _MAX_RESPONSE_ATTEMPTS
            ):
                if not _wait_for_retry(response, deadline):
                    return None
                logger.warning(
                    "DBLP API returned %d; retrying once",
                    response.status_code,
                )
                continue
            logger.error("DBLP API returned %d", response.status_code)
            return None

        try:
            payload = response.json()
        except Exception as exc:
            if attempt + 1 < _MAX_RESPONSE_ATTEMPTS:
                logger.warning("DBLP API returned unreadable JSON; retrying once")
                continue
            note_parse_failure_unless_transport(exc, "empty_or_invalid_json")
            logger.error("DBLP API returned unreadable JSON: %s", exc)
            return None

        if isinstance(payload, dict):
            return payload
        if attempt + 1 < _MAX_RESPONSE_ATTEMPTS:
            logger.warning("DBLP API returned a malformed shape; retrying once")
            continue
        note_parse_failure("malformed_json_shape")
        logger.error("DBLP API response was not an object")
        return None
    return None


def _request_json(params: dict[str, object], deadline: float) -> dict | None:
    """Read one documented REST publication-search page."""
    return _request_payload("GET", _DBLP_API_URL, deadline, params=params)


def _request_sparql(query: str, deadline: float) -> dict | None:
    """Read one documented SPARQL result page."""
    return _request_payload(
        "POST",
        _DBLP_SPARQL_URL,
        deadline,
        content=query.encode("utf-8"),
        headers={
            "Accept": "application/sparql-results+json",
            "Content-Type": "application/sparql-query",
        },
    )


def _whole_year_bounds(
    date_from: str | None,
    date_to: str | None,
) -> tuple[int | None, int | None] | None:
    """Return complete calendar years contained by a requested date window."""
    try:
        start = date.fromisoformat(date_from) if date_from else None
        end = date.fromisoformat(date_to) if date_to else None
    except ValueError:
        return None
    lower = None if start is None else start.year + ((start.month, start.day) != (1, 1))
    upper = None if end is None else end.year - ((end.month, end.day) != (12, 31))
    if lower is not None and upper is not None and lower > upper:
        return None
    return lower, upper


def _year_is_in_bounds(
    year: str,
    bounds: tuple[int | None, int | None],
) -> bool:
    if not _YEAR_RE.fullmatch(year):
        return False
    value = int(year)
    lower, upper = bounds
    return (lower is None or value >= lower) and (upper is None or value <= upper)


def _sparql_literal(value: str) -> str:
    """Escape caller text as one SPARQL string literal, never syntax."""
    escaped = []
    for character in value:
        if character == "\\":
            escaped.append("\\\\")
        elif character == '"':
            escaped.append('\\"')
        elif character == "\n":
            escaped.append("\\n")
        elif character == "\r":
            escaped.append("\\r")
        elif character == "\t":
            escaped.append("\\t")
        elif ord(character) < 0x20:
            escaped.append(f"\\u{ord(character):04x}")
        else:
            escaped.append(character)
    return '"' + "".join(escaped) + '"'


def _sparql_author_query(
    name: str,
    bounds: tuple[int | None, int | None],
    limit: int,
    offset: int,
) -> str:
    lower, upper = bounds
    filters = []
    if lower is not None:
        filters.append(f"?year >= \"{lower}\"^^xsd:gYear")
    if upper is not None:
        filters.append(f"?year <= \"{upper}\"^^xsd:gYear")
    filter_line = f"FILTER ({' && '.join(filters)})" if filters else ""
    return f"""PREFIX dblp: <https://dblp.org/rdf/schema#>
PREFIX rdfs: <http://www.w3.org/2000/01/rdf-schema#>
PREFIX xsd: <http://www.w3.org/2001/XMLSchema#>
SELECT ?publication ?title ?year ?author ?authorName ?venue ?doi WHERE {{
  {{
    SELECT DISTINCT ?publication ?title ?year WHERE {{
      ?person a dblp:Person ; rdfs:label {_sparql_literal(name)} .
      ?publication dblp:authoredBy ?person ;
                   dblp:title ?title ;
                   dblp:yearOfPublication ?year .
      {filter_line}
    }}
    ORDER BY DESC(?year) ?publication
    LIMIT {limit}
    OFFSET {offset}
  }}
  ?publication dblp:authoredBy ?author .
  ?author rdfs:label ?authorName .
  OPTIONAL {{ ?publication dblp:publishedIn ?venue }}
  OPTIONAL {{ ?publication dblp:doi ?doi }}
}}
ORDER BY DESC(?year) ?publication ?authorName"""


class DblpClient(BaseAPIClient):
    """DBLP repository API client."""

    def get_name(self) -> str:
        return "DBLP"

    def search(
        self,
        query: str,
        date_from: str | None = None,
        date_to: str | None = None,
        max_results: int = 100,
        **kwargs,
    ) -> list[NormalizedResult]:
        if max_results <= 0:
            return []

        year_bounds = _whole_year_bounds(date_from, date_to)
        if year_bounds is None:
            note_unanswerable("no_complete_calendar_year")
            return []

        deadline = time.monotonic() + _SEARCH_BUDGET_SECONDS
        results: list[NormalizedResult] = []
        first = 0
        page_size = min(max_results, 1000)

        while len(results) < max_results:
            params = {
                "q": query,
                "format": "json",
                "f": first,
                "h": min(page_size, max_results - len(results)),
            }

            data = _request_json(params, deadline)
            if data is None:
                break

            result_obj = data.get("result")
            hits = result_obj.get("hits") if isinstance(result_obj, dict) else None
            if not isinstance(hits, dict):
                note_parse_failure("malformed_json_shape")
                logger.error("DBLP API response has no result.hits object")
                break
            total_value = hits.get("@total")
            if total_value is None:
                note_parse_failure("malformed_json_shape")
                logger.error("DBLP API response has no result.hits total")
                break
            try:
                total = int(total_value)
            except (TypeError, ValueError):
                note_parse_failure("malformed_json_shape")
                logger.error("DBLP API response has an invalid total")
                break
            if total < 0:
                note_parse_failure("malformed_json_shape")
                logger.error("DBLP API response has a negative total")
                break
            hit_list = hits.get("hit") if isinstance(hits, dict) else None
            if hit_list is None and total == 0:
                break
            if isinstance(hit_list, dict):
                hit_list = [hit_list]
            if not isinstance(hit_list, list):
                note_parse_failure("malformed_json_shape")
                logger.error("DBLP API response has no result.hits.hit list")
                break
            if not hit_list:
                break

            for hit in hit_list:
                if not isinstance(hit, dict):
                    note_parse_failure("malformed_json_shape")
                    continue
                info = hit.get("info", {})
                parsed = self._parse_info(
                    info, date_from, date_to, year_bounds=year_bounds,
                )
                if parsed is not None:
                    results.append(parsed)

            first += len(hit_list)
            if first >= total or len(hit_list) < params["h"]:
                break

        return results[:max_results]

    def search_entity(
        self,
        profile,
        date_from: str | None = None,
        date_to: str | None = None,
        max_results: int = 100,
        **kwargs,
    ) -> list[NormalizedResult]:
        """Search DBLP's official KG for works authored by an exact name.

        This is a deliberate author route, not a fallback from the challenged
        REST endpoint. Exact labels may map to several DBLP people; stable
        person ids are retained on authors so that ambiguity is not hidden.
        """
        if max_results <= 0:
            return []
        name = _profile_query_name(profile)
        if not name:
            raise EntityUnsupported("That profile has no name to search with.")
        year_bounds = _whole_year_bounds(date_from, date_to)
        if year_bounds is None:
            note_unanswerable("no_complete_calendar_year")
            return []

        deadline = time.monotonic() + _SEARCH_BUDGET_SECONDS
        results: list[NormalizedResult] = []
        seen: set[str] = set()
        offset = 0
        while len(results) < max_results:
            page_size = min(_SPARQL_PAGE_SIZE, max_results - len(results))
            payload = _request_sparql(
                _sparql_author_query(name, year_bounds, page_size, offset),
                deadline,
            )
            if payload is None:
                break
            parsed_page = self._parse_sparql_page(payload, year_bounds)
            if parsed_page is None:
                break
            page, selected_count = parsed_page
            for record in page:
                if record.external_id in seen:
                    continue
                seen.add(record.external_id)
                results.append(record)
                if len(results) >= max_results:
                    break
            # The outer author join produces several binding rows for one
            # publication, while malformed publications may normalize to no
            # result. Continue from the number of distinct publications the
            # provider selected, never from normalized survivors or author
            # row count.
            if selected_count < page_size:
                break
            offset += page_size

        return results[:max_results]

    @staticmethod
    def _parse_sparql_page(
        payload: object,
        year_bounds: tuple[int | None, int | None],
    ) -> tuple[list[NormalizedResult], int] | None:
        if not isinstance(payload, dict):
            note_parse_failure("malformed_sparql_shape")
            return None
        results_obj = payload.get("results")
        bindings = results_obj.get("bindings") if isinstance(results_obj, dict) else None
        if not isinstance(bindings, list):
            note_parse_failure("malformed_sparql_shape")
            logger.error("DBLP SPARQL response has no results.bindings list")
            return None

        selected_publications: set[str] = set()
        publications: dict[str, dict[str, object]] = {}
        malformed = False
        for binding in bindings:
            if not isinstance(binding, dict):
                malformed = True
                continue

            def binding_value(
                name: str,
                expected_type: str,
                *,
                datatype: str | None = None,
            ) -> str | None:
                item = binding.get(name)
                if not isinstance(item, dict) or item.get("type") != expected_type:
                    return None
                if datatype is not None and item.get("datatype") != datatype:
                    return None
                raw = item.get("value")
                return raw if isinstance(raw, str) and raw else None

            publication = binding_value("publication", "uri")
            if publication is not None:
                # This is the page denominator even when another required
                # field in the same selected publication is malformed.
                selected_publications.add(publication)
            title = binding_value("title", "literal")
            year = binding_value(
                "year",
                "literal",
                datatype=_XSD_GYEAR,
            )
            author_name = binding_value("authorName", "literal")
            author_iri = binding_value("author", "uri")
            if (
                publication is None or not publication.startswith(_RECORD_IRI_PREFIX)
                or title is None or year is None or author_name is None
                or author_iri is None
            ):
                malformed = True
                continue
            external_id = publication[len(_RECORD_IRI_PREFIX):]
            if not external_id or not _year_is_in_bounds(year, year_bounds):
                malformed = True
                continue

            doi_value = binding_value("doi", "uri") if "doi" in binding else None
            doi = None
            if doi_value is not None:
                if doi_value.startswith(_DOI_IRI_PREFIX):
                    doi = doi_value[len(_DOI_IRI_PREFIX):]
                else:
                    malformed = True
            elif "doi" in binding:
                malformed = True

            venue = binding_value("venue", "literal") if "venue" in binding else None
            if venue is None and "venue" in binding:
                malformed = True

            if not author_iri.startswith(_PERSON_IRI_PREFIX):
                malformed = True
                continue
            author_source_id = author_iri[len(_PERSON_IRI_PREFIX):]
            if not author_source_id:
                malformed = True
                continue

            entry = publications.setdefault(external_id, {
                "title": title.rstrip("."),
                "year": year,
                "url": publication,
                "doi": doi,
                "authors": {},
                "venues": set(),
            })
            if entry["title"] != title.rstrip(".") or entry["year"] != year:
                malformed = True
                continue
            if entry["doi"] is None and doi is not None:
                entry["doi"] = doi
            venues = entry["venues"]
            assert isinstance(venues, set)
            if venue is not None:
                venues.add(venue)
            authors = entry["authors"]
            assert isinstance(authors, dict)
            authors[author_source_id] = Author(
                name=author_name,
                source_ids=(("dblp", author_source_id),),
            )

        if malformed:
            note_parse_failure("malformed_sparql_binding")

        normalized = []
        for external_id, entry in publications.items():
            authors = entry["authors"]
            assert isinstance(authors, dict)
            title = entry["title"]
            year = entry["year"]
            url = entry["url"]
            doi = entry["doi"]
            venues = entry["venues"]
            if not isinstance(title, str) or not title or not isinstance(year, str):
                continue
            assert isinstance(venues, set)
            normalized.append(NormalizedResult(
                source_repository="dblp",
                external_id=external_id,
                doi=doi if isinstance(doi, str) else None,
                title=title,
                authors=list(authors.values()),
                abstract=None,
                publication_date=f"{year}-01-01",
                url=url if isinstance(url, str) else "",
                categories=sorted(venues),
            ))
        return normalized, len(selected_publications)

    @staticmethod
    def _parse_info(
        info: object,
        date_from: str | None = None,
        date_to: str | None = None,
        *,
        year_bounds: tuple[int | None, int | None] | None = None,
    ) -> NormalizedResult | None:
        if not isinstance(info, dict):
            note_parse_failure("malformed_json_shape")
            logger.warning("DBLP hit info was not an object; skipping it")
            return None
        title_value = info.get("title", "")
        if title_value is None:
            title_value = ""
        if not isinstance(title_value, str):
            note_parse_failure("malformed_json_shape")
            logger.warning("DBLP hit title was not a string; skipping it")
            return None
        title = title_value.rstrip(".")
        if not title:
            return None

        # Date filtering (DBLP API doesn't support date filters natively)
        year_value = info.get("year", "")
        if year_value is None:
            year_str = ""
        elif isinstance(year_value, (str, int)) and not isinstance(year_value, bool):
            year_str = str(year_value)
        else:
            note_parse_failure("malformed_json_shape")
            logger.warning("DBLP hit year had an invalid type; skipping it")
            return None
        if year_str:
            bounds = year_bounds or _whole_year_bounds(date_from, date_to)
            if bounds is None or not _year_is_in_bounds(year_str, bounds):
                return None
        elif date_from or date_to:
            return None

        external_id = info.get("key", "")
        if external_id is None:
            external_id = ""
        if not isinstance(external_id, str):
            note_parse_failure("malformed_json_shape")
            logger.warning("DBLP hit key had an invalid type; skipping it")
            return None
        if not external_id:
            return None

        doi = info.get("doi")
        if doi is not None and not isinstance(doi, str):
            note_parse_failure("malformed_json_shape")
            logger.warning("DBLP hit DOI had an invalid type; skipping it")
            return None
        if doi and "/" in doi and not doi.startswith("10."):
            doi = None  # invalid DOI

        # Authors — can be a string or a list
        authors_value = info.get("authors", {})
        if authors_value is None:
            authors_value = {}
        if not isinstance(authors_value, dict):
            note_parse_failure("malformed_json_shape")
            logger.warning("DBLP hit authors was not an object; skipping it")
            return None
        authors_raw = authors_value.get("author", [])
        authors = []
        if isinstance(authors_raw, list):
            for a in authors_raw:
                if isinstance(a, dict):
                    name_value = a.get("text", "")
                    name = name_value.strip() if isinstance(name_value, str) else ""
                elif isinstance(a, str):
                    name = a.strip()
                else:
                    continue
                if name:
                    authors.append(name)
        elif isinstance(authors_raw, dict):
            name_value = authors_raw.get("text", "")
            name = name_value.strip() if isinstance(name_value, str) else ""
            if name:
                authors.append(name)
        elif isinstance(authors_raw, str):
            authors.append(authors_raw.strip())

        publication_date = f"{year_str}-01-01" if year_str else None

        url = info.get("url", "")
        venue = info.get("venue", "")
        if url is None:
            url = ""
        if venue is None:
            venue = ""
        if not isinstance(url, str) or not isinstance(venue, str):
            note_parse_failure("malformed_json_shape")
            logger.warning("DBLP hit URL or venue had an invalid type; skipping it")
            return None
        if url and not url.startswith("http"):
            url = f"https://dblp.org/rec/{url}"

        categories = [venue] if venue else []

        return NormalizedResult(
            source_repository="dblp",
            external_id=external_id,
            doi=doi,
            title=title,
            authors=authors,
            abstract=None,  # DBLP does not provide abstracts
            publication_date=publication_date,
            url=url,
            categories=categories,
        )


# ---------------------------------------------------------------------------
# Registry auto-registration
# ---------------------------------------------------------------------------
def _register():
    from .api_registry import register_client
    register_client("dblp", DblpClient)

_register()
