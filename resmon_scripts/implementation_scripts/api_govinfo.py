"""GovInfo Search Service: official bibliographic fields, no document text.

Request/pagination: https://www.govinfo.gov/features/search-service-overview
Keys/limits: https://github.com/usgpo/api#keys
Operators: https://www.govinfo.gov/help/search-operators
Storage/copyright: https://www.govinfo.gov/about/policies
"""

import logging
import re

from .api_base import (
    BaseAPIClient, NormalizedResult, RateLimiter, note_filtered,
    note_parse_failure, note_parse_failure_unless_transport, safe_request,
)
from .api_openlibrary import _date_interval
from .credential_manager import get_credential_for

logger = logging.getLogger(__name__)
_URL = "https://api.govinfo.gov/search"
# Below GPO's 36,000/hour, 1,200/minute and 40/second default key limits.
# DEMO_KEY is only supplied explicitly by tests, never used as a runtime fallback.
_RATE_LIMITER = RateLimiter(requests_per_second=1.0)
_PAGE_SIZE = 100
_MIN_SCAN_BUDGET = 10000
_ID = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._~-]*$")


class GovinfoClient(BaseAPIClient):
    """Query with the user's API.data.gov key through the execution key scope."""

    def get_name(self) -> str:
        return "GovInfo"

    def search(
        self, query: str, date_from: str | None = None,
        date_to: str | None = None, max_results: int = 100, **kwargs: object,
    ) -> list[NormalizedResult]:
        if max_results <= 0:
            return []
        key = get_credential_for(self._exec_id, "govinfo_api_key")
        if not key:
            logger.warning("GovInfo requires an API key")
            return []  # The sweep's existing catalog gate records missing_key.
        lower = _date_interval(date_from) if date_from else None
        upper = _date_interval(date_to) if date_to else None
        if ((date_from and lower is None) or (date_to and upper is None)
                or (lower and upper and lower[0] > upper[1])):
            logger.warning("GovInfo search received an invalid date window")
            return []  # No invented HTTP or year-granularity reason.
        start, end = lower[0] if lower else None, upper[1] if upper else None
        search_query = query
        if start or end:
            # Use the documented range syntax with closed calendar endpoints.
            clause = f"publishdate:range({start or '0001-01-01'},{end or '9999-12-31'})"
            search_query = f"({query}) AND {clause}" if query.strip() else clause
        cursor = "*"
        cursors: set[str] = set()
        seen: set[str] = set()
        results: list[NormalizedResult] = []
        raw_count = 0
        incomplete = 0
        page_size = min(max_results, _PAGE_SIZE)
        # The scan budget is independent of how many rows survive normalization.
        # This bounds streams of distinct records with missing required dates.
        scan_budget = max(max_results, _MIN_SCAN_BUDGET)
        while len(results) < max_results and raw_count < scan_budget:
            try:
                response = safe_request(
                    "POST", _URL, headers={"X-Api-Key": key},
                    json={"query": search_query, "pageSize": page_size, "offsetMark": cursor,
                          "sorts": [{"field": "score", "sortOrder": "DESC"}]},
                    rate_limiter=_RATE_LIMITER,
                )
                if response.status_code != 200:
                    logger.error("GovInfo returned HTTP %d", response.status_code)
                    return []
                payload = response.json()
            except Exception as exc:
                # Do not log request headers, bodies or credential values.
                logger.warning("GovInfo request failed (%s)", type(exc).__name__)
                note_parse_failure_unless_transport(exc)
                return []
            records = payload.get("results") if isinstance(payload, dict) else None
            total = payload.get("count") if isinstance(payload, dict) else None
            if (not isinstance(records, list) or type(total) is not int or total < 0
                    or len(records) > page_size or total < raw_count + len(records)):
                logger.error("GovInfo returned an invalid page or count")
                note_parse_failure()
                return []
            duplicates = 0
            for record in records:
                parsed = self._parse_record(record)
                if parsed is None:
                    incomplete += 1
                    continue
                if parsed.external_id in seen:
                    duplicates += 1
                    continue
                seen.add(parsed.external_id)
                published = parsed.publication_date
                if (start or end) and not published:
                    incomplete += 1
                    continue
                if published and ((start and published < start) or (end and published > end)):
                    logger.error("GovInfo returned a date outside its requested publishdate filter")
                    note_parse_failure()
                    return []
                results.append(parsed)
                if len(results) == max_results:
                    return results
            raw_count += len(records)
            if raw_count >= total:
                if incomplete and not results:
                    note_filtered(raw_count, 0, "records_unusable", rights=0, incomplete=incomplete)
                return results
            next_cursor = payload.get("offsetMark")
            if (not records or not isinstance(next_cursor, str) or not next_cursor
                    or next_cursor == cursor or next_cursor in cursors or duplicates == len(records)):
                logger.error("GovInfo response cannot advance to its declared total")
                note_parse_failure()
                return []
            cursors.add(cursor)
            cursor = next_cursor
        logger.warning("govinfo metadata scan budget reached after %d rows; retained %d", raw_count, len(results))
        if not results and incomplete:
            note_filtered(raw_count, 0, "records_unusable", rights=0, incomplete=incomplete)
        return results

    @staticmethod
    def _parse_record(record: object) -> NormalizedResult | None:
        if not isinstance(record, dict):
            logger.warning("Skipping non-object GovInfo record")
            return None
        package, granule, title = record.get("packageId"), record.get("granuleId"), record.get("title")
        if (not isinstance(package, str) or not _ID.fullmatch(package)
                or not isinstance(title, str) or not title.strip()
                or (granule is not None and (not isinstance(granule, str) or not _ID.fullmatch(granule)))):
            logger.warning("Skipping GovInfo record with incomplete identity or title")
            return None
        value = record.get("dateIssued")
        interval = _date_interval(value) if isinstance(value, str) else None
        published = value if interval and len(value) == 10 else None
        authors = record.get("governmentAuthor")
        authors = [v for v in authors if isinstance(v, str) and v.strip()] if isinstance(authors, list) else []
        collection = record.get("collectionCode")
        # Granules in one package are distinct search hits. Neither summary API
        # URLs (which need a key) nor untrusted download links become user URLs.
        identity = f"{package}/{granule}" if granule else package
        path = f"app/details/{package}/{granule}" if granule else f"app/details/{package}"
        return NormalizedResult(
            source_repository="govinfo", external_id=identity, doi=None,
            title=title.strip(), authors=authors, abstract=None,
            publication_date=published, url=f"https://www.govinfo.gov/{path}",
            categories=[collection] if isinstance(collection, str) and collection else [],
        )


def _register() -> None:
    from .api_registry import register_client
    register_client("govinfo", GovinfoClient)


_register()
