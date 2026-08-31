"""NIST Resource Metadata Management paper-search client."""

import datetime as dt
import json
import logging
import re

from .api_base import BaseAPIClient, NormalizedResult, RateLimiter, safe_request

logger = logging.getLogger(__name__)

_NIST_RMM_API_URL = "https://data.nist.gov/rmm/papers"
_PAGE_SIZE = 50

# NIST's RMM OpenAPI publishes no numeric limit. Two seconds between requests
# is a conservative shared ceiling for the unauthenticated public endpoint.
_RATE_LIMITER = RateLimiter(requests_per_second=0.5)

_DOI = re.compile(r"^10\.\d{4,9}/[-._;()/:a-z0-9]+$", re.IGNORECASE)
_REQUEST_DATE = re.compile(r"^\d{4}-\d{2}-\d{2}$")

# The official RMM OpenAPI defines the ResultData envelope but leaves each
# item's shape unspecified. These aliases are cautious fixture-only parsing
# candidates, not live-observed fields or OpenAPI schema guarantees.


def _date_value(value: object) -> str | None:
    """Return a day-granular date only when a fixture alias contains one."""
    if not isinstance(value, str):
        return None
    candidate = value.strip()[:10]
    try:
        dt.date.fromisoformat(candidate)
    except ValueError:
        return None
    return candidate


def _request_date(value: object) -> str | None:
    """Validate a caller's day-granular bound without normalizing its text."""
    if not isinstance(value, str) or not _REQUEST_DATE.fullmatch(value):
        return None
    try:
        dt.date.fromisoformat(value)
    except ValueError:
        return None
    return value


def _raw_page_signature(records: list[object]) -> str:
    """Return a stable signature for an API page before record normalization."""
    # Response JSON consists of JSON values, so a canonical JSON encoding detects
    # repeated pages even when every record is malformed or already deduplicated.
    return json.dumps(records, ensure_ascii=False, separators=(",", ":"), sort_keys=True)


def _doi(value: object) -> str | None:
    """Normalize a DOI supplied as an identifier, not an arbitrary URL."""
    if not isinstance(value, str):
        return None
    candidate = value.strip()
    for prefix in ("https://doi.org/", "http://doi.org/", "doi:"):
        if candidate.lower().startswith(prefix):
            candidate = candidate[len(prefix):]
            break
    return candidate if _DOI.fullmatch(candidate) else None


def _stable_identifier(record: dict[str, object]) -> tuple[str, str | None] | None:
    """Prefer a canonical DOI, then nonblank provisional fixture aliases."""
    doi = _doi(record.get("doi"))
    if doi:
        return doi, doi

    ediid = record.get("ediid")
    if isinstance(ediid, str) and ediid.strip():
        return ediid, None

    ark = record.get("ark")
    if isinstance(ark, str) and ark.strip():
        return ark.strip(), None
    return None


def _authors(value: object) -> list[str]:
    """Keep string names only when the provisional fixture alias supplies them."""
    if not isinstance(value, list):
        return []
    return [author.strip() for author in value if isinstance(author, str) and author.strip()]


class NistRmmClient(BaseAPIClient):
    """Client for the documented RMM envelope and cautious fixture aliases."""

    def get_name(self) -> str:
        return "NIST Resource Metadata Management"

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

        lower_bound = _request_date(date_from) if date_from is not None else None
        upper_bound = _request_date(date_to) if date_to is not None else None
        if (date_from is not None and lower_bound is None) or (
            date_to is not None and upper_bound is None
        ):
            logger.error("NIST RMM requires day-granular ISO date constraints")
            return []
        if lower_bound and upper_bound and lower_bound > upper_bound:
            return []

        results: list[NormalizedResult] = []
        seen_identifiers: set[str] = set()
        seen_page_signatures: set[str] = set()
        skip = 0

        while len(results) < max_results:
            params: dict[str, str | int] = {
                "searchphrase": query.strip(),
                "skip": skip,
                "limit": _PAGE_SIZE,
            }
            # The documented RMM API has only from_date. date_to is applied
            # below after parsing each record, never presented as upstream work.
            if lower_bound:
                params["from_date"] = lower_bound

            try:
                response = safe_request(
                    "GET",
                    _NIST_RMM_API_URL,
                    params=params,
                    rate_limiter=_RATE_LIMITER,
                )
            except Exception:
                logger.exception("NIST RMM API request failed")
                return []

            if response.status_code != 200:
                logger.error("NIST RMM API returned %d", response.status_code)
                return []
            try:
                payload = response.json()
            except Exception:
                logger.exception("NIST RMM API returned invalid JSON")
                return []
            if not isinstance(payload, dict):
                logger.error("NIST RMM API returned a non-object response")
                return []
            records = payload.get("ResultData")
            if not isinstance(records, list):
                logger.error("NIST RMM API response has no ResultData list")
                return []
            result_count = payload.get("ResultCount")
            if not records:
                if isinstance(result_count, int) and skip < result_count:
                    logger.error("NIST RMM API ended before its ResultCount")
                    return []
                break

            page_signature = _raw_page_signature(records)
            if page_signature in seen_page_signatures:
                logger.warning("NIST RMM repeated a raw page; discarding partial results")
                return []
            seen_page_signatures.add(page_signature)

            for record in records:
                parsed = self._parse_record(record)
                if parsed is None:
                    continue
                if parsed.external_id in seen_identifiers:
                    continue
                seen_identifiers.add(parsed.external_id)

                if (lower_bound or upper_bound) and not self._inside_window(
                    parsed.publication_date, lower_bound, upper_bound,
                ):
                    continue
                results.append(parsed)
                if len(results) >= max_results:
                    break

            skip += len(records)
            if isinstance(result_count, int):
                if result_count < skip:
                    logger.error("NIST RMM ResultCount is smaller than its page data")
                    return []
                if skip >= result_count:
                    break
            if len(records) < _PAGE_SIZE and not isinstance(result_count, int):
                break

        return results[:max_results]

    @staticmethod
    def _inside_window(
        publication_date: str | None,
        date_from: str | None,
        date_to: str | None,
    ) -> bool:
        if publication_date is None:
            return False
        if date_from and publication_date < date_from:
            return False
        if date_to and publication_date > date_to:
            return False
        return True

    @staticmethod
    def _parse_record(record: object) -> NormalizedResult | None:
        if not isinstance(record, dict):
            logger.warning("NIST RMM record was not an object; skipping it")
            return None
        title = record.get("title")
        if not isinstance(title, str) or not title.strip():
            logger.warning("NIST RMM record has no title; skipping it")
            return None
        identifier = _stable_identifier(record)
        if identifier is None:
            logger.warning("NIST RMM record has no trustworthy stable identifier; skipping it")
            return None
        external_id, doi = identifier

        record_url = record.get("url")
        if doi:
            url = f"https://doi.org/{doi}"
        elif isinstance(record_url, str) and record_url.startswith(("https://", "http://")):
            url = record_url
        else:
            # The current OpenAPI specifies only the response envelope, so it does
            # not guarantee a landing-page alias. Do not invent one from an
            # identifier or API path.
            url = ""

        return NormalizedResult(
            source_repository="nist_rmm",
            external_id=external_id,
            doi=doi,
            title=title.strip(),
            authors=_authors(record.get("authors")),
            abstract=None,
            publication_date=_date_value(record.get("publication_date")),
            url=url,
            categories=[],
        )


def _register() -> None:
    from .api_registry import register_client
    register_client("nist_rmm", NistRmmClient)


_register()
