"""OAPEN book/chapter metadata, under its CC0 metadata dedication.

Contract: https://www.oapen.org/article/8185269-search-using-a-rest-api
Pagination/date syntax: https://oapen.o172i.upcloudobjects.com/151b0a45669f429381cb46fe441f23b6.pdf
Metadata terms: https://www.oapen.org/oapen/posi-self-audit
"""

import logging
import re

from .api_base import (
    BaseAPIClient, NormalizedResult, RateLimiter, note_filtered,
    note_parse_failure, note_parse_failure_unless_transport,
    note_unanswerable, safe_request,
)
# These helpers preserve partial-date precision and select only whole years.
# OAPEN's indexed timestamps often originate from year-only dc.date.issued;
# asking for days would turn an index default into a publication-date claim.
from .api_openlibrary import _date_interval, _search_year_bounds

logger = logging.getLogger(__name__)
_URL = "https://library.oapen.org/rest/search"
# No numerical limit in OAPEN's REST guide; two seconds spaces concurrent sweeps.
_RATE_LIMITER = RateLimiter(requests_per_second=0.5)
_PAGE_SIZE = 100
_MIN_SCAN_BUDGET = 10000
_HANDLE = re.compile(r"^\d+(?:\.\d+)*/[A-Za-z0-9._~-]+$")


class OapenClient(BaseAPIClient):
    """Search metadata, retaining the source's publication-year precision."""

    def get_name(self) -> str:
        return "OAPEN Library"

    def search(
        self, query: str, date_from: str | None = None,
        date_to: str | None = None, max_results: int = 100, **kwargs: object,
    ) -> list[NormalizedResult]:
        if max_results <= 0:
            return []
        bounds = _search_year_bounds(date_from, date_to)
        if bounds is None:
            note_unanswerable("year_granularity")
            return []
        lower, upper, _, _ = bounds
        start = f"{lower:04d}-01-01T00:00:00Z" if lower else "*"
        end = f"{upper:04d}-12-31T23:59:59.999Z" if upper else "*"
        results: list[NormalizedResult] = []
        seen: set[str] = set()
        offset = 0
        incomplete = 0
        page_size = min(max_results, _PAGE_SIZE)
        # The scan budget is independent of how many rows survive normalization.
        # This bounds streams of distinct records with missing required dates.
        scan_budget = max(max_results, _MIN_SCAN_BUDGET)
        while len(results) < max_results and offset < scan_budget:
            params = {
                "query": query, "expand": "metadata", "limit": page_size,
                "offset": offset, "sort": "dc.date.issued_dt|desc",
            }
            if lower or upper:
                params["fq"] = f"dc.date.issued_dt:[{start} TO {end}]"
            try:
                response = safe_request("GET", _URL, params=params, rate_limiter=_RATE_LIMITER)
                if response.status_code != 200:
                    logger.error("OAPEN returned HTTP %d", response.status_code)
                    return []
                records = response.json()
            except Exception as exc:
                logger.warning("OAPEN request failed (%s)", type(exc).__name__)
                note_parse_failure_unless_transport(exc)
                return []
            if not isinstance(records, list) or len(records) > page_size:
                logger.error("OAPEN returned an invalid page")
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
                year = int(parsed.publication_date) if parsed.publication_date else None
                if (lower or upper) and year is None:
                    incomplete += 1
                    continue
                if year is not None and ((lower and year < lower) or (upper and year > upper)):
                    # The fq response contradicts the source's own issued year.
                    # Do not present a page that did not obey its query as empty.
                    logger.error("OAPEN returned a publication year outside its requested filter")
                    note_parse_failure()
                    return []
                results.append(parsed)
                if len(results) == max_results:
                    return results
            offset += len(records)  # Raw rows, not the number we could retain.
            if len(records) < page_size:
                if incomplete and not results:
                    note_filtered(offset, 0, "records_unusable", rights=0, incomplete=incomplete)
                return results
            if duplicates == len(records):
                # Repeating an entire page cannot establish an end or make
                # progress. Malformed rows instead consume the scan budget.
                logger.error("OAPEN pagination made no identifiable progress")
                note_parse_failure()
                return []
        logger.warning("oapen metadata scan budget reached after %d rows; retained %d", offset, len(results))
        if not results and incomplete:
            note_filtered(offset, 0, "records_unusable", rights=0, incomplete=incomplete)
        return results

    @staticmethod
    def _parse_record(record: object) -> NormalizedResult | None:
        if not isinstance(record, dict):
            logger.warning("Skipping non-object OAPEN record")
            return None
        handle = record.get("handle")
        title = record.get("name")
        metadata = record.get("metadata")
        if (not isinstance(handle, str) or not _HANDLE.fullmatch(handle)
                or not isinstance(title, str) or not title.strip()
                or not isinstance(metadata, list) or record.get("type") != "item"):
            logger.warning("Skipping OAPEN record with incomplete identity or metadata")
            return None
        if record.get("withdrawn") not in (False, "false"):
            logger.warning("Skipping OAPEN record not established as non-withdrawn")
            return None
        fields: dict[str, list[str]] = {}
        for field in metadata:
            if not isinstance(field, dict):
                continue
            key, value = field.get("key"), field.get("value")
            if isinstance(key, str) and isinstance(value, str) and value.strip():
                fields.setdefault(key, []).append(value.strip())
        issued = fields.get("dc.date.issued", [])
        # Year precision is deliberate, even when an item supplies a full date.
        years = {v[:4] for v in issued if _date_interval(v) is not None}
        year = next(iter(years)) if len(years) == 1 else None
        return NormalizedResult(
            source_repository="oapen", external_id=handle, doi=None,
            title=title.strip(), authors=fields.get("dc.contributor.author", []),
            abstract="\n\n".join(fields.get("dc.description.abstract", [])) or None,
            publication_date=year, url=f"https://library.oapen.org/handle/{handle}",
            categories=(fields.get("dc.subject.classification", []) + fields.get("dc.subject.other", []))[:10],
        )


def _register() -> None:
    from .api_registry import register_client
    register_client("oapen", OapenClient)


_register()
