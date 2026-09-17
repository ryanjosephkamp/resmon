# resmon_scripts/implementation_scripts/api_dblp.py
"""DBLP API client — JSON, f/h pagination."""

import logging
import time

from .api_base import (
    BaseAPIClient,
    NormalizedResult,
    RateLimiter,
    note_parse_failure,
    note_parse_failure_unless_transport,
    safe_request,
)

logger = logging.getLogger(__name__)

_DBLP_API_URL = "https://dblp.org/search/publ/api"
_SEARCH_BUDGET_SECONDS = 45.0
_REQUEST_TIMEOUT_SECONDS = 10.0
_MAX_RESPONSE_ATTEMPTS = 2
_TRANSIENT_CODES = {429, 500, 502, 503, 504}

# Conservative: 2 req/s
_RATE_LIMITER = RateLimiter(requests_per_second=2.0)


def _looks_like_access_challenge(response) -> bool:
    """Recognize the observed DBLP HTML challenge without trying to bypass it."""
    headers = getattr(response, "headers", {}) or {}
    content_type = str(headers.get("content-type", "")).lower()
    body = str(getattr(response, "text", ""))[:4096].lower()
    return "text/html" in content_type and (
        "making sure you are not a bot" in body or "anubis" in body
    )


def _request_json(params: dict[str, object], deadline: float) -> dict | None:
    """Read one DBLP page, preserving access challenges as failed answers."""
    for attempt in range(_MAX_RESPONSE_ATTEMPTS):
        try:
            response = safe_request(
                "GET",
                _DBLP_API_URL,
                params=params,
                rate_limiter=_RATE_LIMITER,
                timeout=_REQUEST_TIMEOUT_SECONDS,
                max_retries=0,
                deadline=deadline,
            )
        except Exception as exc:
            if attempt + 1 < _MAX_RESPONSE_ATTEMPTS:
                logger.warning("DBLP API request failed; retrying once: %s", exc)
                continue
            logger.exception("DBLP API request failed")
            return None

        if response.status_code != 200:
            if (
                response.status_code in _TRANSIENT_CODES
                and attempt + 1 < _MAX_RESPONSE_ATTEMPTS
            ):
                logger.warning(
                    "DBLP API returned %d; retrying once",
                    response.status_code,
                )
                continue
            logger.error("DBLP API returned %d", response.status_code)
            return None

        if _looks_like_access_challenge(response):
            note_parse_failure("access_challenge")
            logger.error("DBLP API returned an access-challenge page")
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
                parsed = self._parse_info(info, date_from, date_to)
                if parsed is not None:
                    results.append(parsed)

            first += len(hit_list)
            if first >= total or len(hit_list) < params["h"]:
                break

        return results[:max_results]

    @staticmethod
    def _parse_info(
        info: object,
        date_from: str | None = None,
        date_to: str | None = None,
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
            if date_from and year_str < date_from[:4]:
                return None
            if date_to and year_str > date_to[:4]:
                return None

        external_id = info.get("key", "")
        if external_id is None:
            external_id = ""
        if not isinstance(external_id, str):
            note_parse_failure("malformed_json_shape")
            logger.warning("DBLP hit key had an invalid type; skipping it")
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
