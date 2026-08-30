# resmon_scripts/implementation_scripts/api_inspire_hep.py
"""INSPIRE-HEP literature API client."""

import logging
import threading
import time

import httpx

from .api_base import BaseAPIClient, NormalizedResult, RateLimiter, safe_request
from .config import DEFAULT_BACKOFF_BASE, DEFAULT_MAX_RETRIES

logger = logging.getLogger(__name__)

_INSPIRE_API_URL = "https://inspirehep.net/api/literature"
_FIELDS = (
    "titles,dois,authors,abstracts,earliest_date,control_number,"
    "arxiv_eprints,inspire_categories"
)

# INSPIRE permits 15 anonymous requests per 5-second window. Two per second
# leaves headroom under that rolling ceiling.
_RATE_LIMITER = RateLimiter(requests_per_second=2.0)
_RETRYABLE_STATUS_CODES = {500, 502, 503, 504}
_RATE_LIMIT_COOLDOWN_SECONDS = 5.0
_REQUEST_LOCK = threading.Lock()
_cooldown_until = 0.0


def _single_request(params: dict[str, object]) -> httpx.Response:
    """Make one request while honoring a shared post-429 cooldown."""
    global _cooldown_until

    # Keep the gate around the HTTP call so a concurrent sweep cannot pass the
    # cooldown check while another in-flight request is receiving a 429.
    with _REQUEST_LOCK:
        cooldown_remaining = _cooldown_until - time.monotonic()
        if cooldown_remaining > 0:
            time.sleep(cooldown_remaining)
        response = safe_request(
            "GET",
            _INSPIRE_API_URL,
            params=params,
            rate_limiter=_RATE_LIMITER,
            # The module owns retries because the shared helper's first retry
            # occurs before INSPIRE's required five-second 429 cooldown.
            max_retries=0,
        )
        if response.status_code == 429:
            _cooldown_until = time.monotonic() + _RATE_LIMIT_COOLDOWN_SECONDS
        return response


def _request_page(params: dict[str, object]) -> httpx.Response:
    """Request one page without violating INSPIRE's 429 cooldown."""
    for attempt in range(DEFAULT_MAX_RETRIES + 1):
        try:
            response = _single_request(params)
        except (httpx.TimeoutException, httpx.ConnectError):
            if attempt >= DEFAULT_MAX_RETRIES:
                raise
            wait = DEFAULT_BACKOFF_BASE ** attempt
            logger.warning(
                "INSPIRE request failed; retry %d/%d in %.1fs",
                attempt + 1,
                DEFAULT_MAX_RETRIES,
                wait,
            )
            time.sleep(wait)
            continue

        if (
            response.status_code in _RETRYABLE_STATUS_CODES
            and attempt < DEFAULT_MAX_RETRIES
        ):
            wait = DEFAULT_BACKOFF_BASE ** attempt
            logger.warning(
                "INSPIRE returned %d; retry %d/%d in %.1fs",
                response.status_code,
                attempt + 1,
                DEFAULT_MAX_RETRIES,
                wait,
            )
            time.sleep(wait)
            continue
        return response

    raise RuntimeError("INSPIRE retry loop exited without a response")


class InspireHepClient(BaseAPIClient):
    """INSPIRE-HEP literature search client."""

    def get_name(self) -> str:
        return "INSPIRE-HEP"

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

        base_query = query.strip()
        query_parts = []
        if base_query:
            query_parts.append(
                f"({base_query})" if date_from or date_to else base_query
            )
        if date_from:
            query_parts.append(f"de>{date_from}")
        if date_to:
            query_parts.append(f"de<{date_to}")
        search_query = " and ".join(query_parts)

        results: list[NormalizedResult] = []
        page = 1
        seen_hits = 0
        page_size = min(max_results, 100)

        while len(results) < max_results:
            params = {
                "q": search_query,
                "size": page_size,
                "page": page,
                "sort": "mostrecent",
                "fields": _FIELDS,
            }
            try:
                response = _request_page(params)
                if response.status_code != 200:
                    logger.error("INSPIRE API returned %d", response.status_code)
                    break
                payload = response.json()
            except Exception:
                logger.exception("INSPIRE API request failed")
                break

            hits_node = payload.get("hits") if isinstance(payload, dict) else None
            if not isinstance(hits_node, dict):
                logger.error("INSPIRE API response has no hits object")
                break
            hits = hits_node.get("hits")
            if not isinstance(hits, list):
                logger.error("INSPIRE API response has no hits list")
                break
            if not hits:
                break

            for record in hits:
                parsed = self._parse_record(record)
                if parsed is None:
                    continue
                results.append(parsed)
                if len(results) >= max_results:
                    break

            seen_hits += len(hits)
            total = hits_node.get("total")
            if isinstance(total, dict):
                total = total.get("value")
            try:
                total_hits = int(total)
            except (TypeError, ValueError):
                total_hits = None
            if total_hits is not None and seen_hits >= total_hits:
                break
            if len(hits) < page_size:
                break
            page += 1

        return results[:max_results]

    @staticmethod
    def _parse_record(record: object) -> NormalizedResult | None:
        if not isinstance(record, dict):
            logger.warning("INSPIRE hit was not an object; skipping it")
            return None
        metadata = record.get("metadata")
        if not isinstance(metadata, dict):
            logger.warning("INSPIRE hit has no metadata object; skipping it")
            return None

        control_number = metadata.get("control_number")
        titles = metadata.get("titles")
        title = None
        if isinstance(titles, list) and titles and isinstance(titles[0], dict):
            title = titles[0].get("title")
        if control_number is None or not isinstance(title, str) or not title.strip():
            logger.warning(
                "INSPIRE record %r has no stable control number or title; skipping it",
                control_number,
            )
            return None

        doi = None
        dois = metadata.get("dois")
        if isinstance(dois, list) and dois and isinstance(dois[0], dict):
            doi_value = dois[0].get("value")
            if isinstance(doi_value, str) and doi_value.strip():
                doi = doi_value.strip()

        authors: list[str] = []
        author_nodes = metadata.get("authors")
        if isinstance(author_nodes, list):
            for author in author_nodes:
                if not isinstance(author, dict):
                    continue
                full_name = author.get("full_name")
                if isinstance(full_name, str) and full_name.strip():
                    authors.append(full_name)

        abstract = None
        abstracts = metadata.get("abstracts")
        if isinstance(abstracts, list) and abstracts and isinstance(abstracts[0], dict):
            abstract_value = abstracts[0].get("value")
            if isinstance(abstract_value, str) and abstract_value:
                abstract = abstract_value

        earliest_date = metadata.get("earliest_date")
        publication_date = str(earliest_date) if earliest_date else None

        categories: list[str] = []
        category_nodes = metadata.get("inspire_categories")
        if isinstance(category_nodes, list):
            for category in category_nodes:
                if not isinstance(category, dict):
                    continue
                term = category.get("term")
                if isinstance(term, str) and term.strip():
                    categories.append(term.strip())

        external_id = str(control_number)
        return NormalizedResult(
            source_repository="inspire_hep",
            external_id=external_id,
            doi=doi,
            title=title.strip(),
            authors=authors,
            abstract=abstract,
            publication_date=publication_date,
            url=f"https://inspirehep.net/literature/{external_id}",
            categories=categories,
        )


def _register() -> None:
    from .api_registry import register_client
    register_client("inspire_hep", InspireHepClient)


_register()
