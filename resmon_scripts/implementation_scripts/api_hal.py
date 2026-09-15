# resmon_scripts/implementation_scripts/api_hal.py
"""HAL (Hyper Articles en Ligne) API client — REST JSON API."""

import logging
import time

from .api_base import BaseAPIClient, NormalizedResult, RateLimiter, note_parse_failure, safe_request

logger = logging.getLogger(__name__)

_HAL_API_URL = "https://api.archives-ouvertes.fr/search/"

# One cooperative I/O budget covers every page, retry and limiter wait. A
# per-phase HTTPX timeout alone allowed retry exhaustion beyond the live test's
# 120-second watchdog. DNS shutdown/CPU scheduling remain platform limitations.
_SEARCH_BUDGET_SECONDS = 45.0
_REQUEST_TIMEOUT_SECONDS = 10.0
_MAX_RETRIES = 1

# HAL does not publish strict rate limits; use 2 req/s as polite default
_RATE_LIMITER = RateLimiter(requests_per_second=2.0)


class HalClient(BaseAPIClient):
    """HAL repository API client (Tier 2)."""

    def get_name(self) -> str:
        return "HAL"

    def search(
        self,
        query: str,
        date_from: str | None = None,
        date_to: str | None = None,
        max_results: int = 100,
        **kwargs,
    ) -> list[NormalizedResult]:
        results: list[NormalizedResult] = []
        deadline = time.monotonic() + _SEARCH_BUDGET_SECONDS
        start = 0
        page_size = min(max_results, 100)

        while len(results) < max_results:
            # Build Solr-style query
            fq_parts: list[str] = []
            if date_from or date_to:
                d_from = date_from or "*"
                d_to = date_to or "*"
                fq_parts.append(f"producedDate_tdate:[{d_from}T00:00:00Z TO {d_to}T23:59:59Z]")

            params = {
                "q": query,
                "fl": "docid,title_s,authFullName_s,abstract_s,producedDateY_i,producedDate_tdate,uri_s,halId_s,doiId_s,domain_s",
                "rows": min(page_size, max_results - len(results)),
                "start": start,
                "sort": "producedDate_tdate desc",
                "wt": "json",
            }
            if fq_parts:
                params["fq"] = " AND ".join(fq_parts)

            try:
                response = safe_request(
                    "GET", _HAL_API_URL,
                    params=params,
                    rate_limiter=_RATE_LIMITER,
                    timeout=_REQUEST_TIMEOUT_SECONDS,
                    max_retries=_MAX_RETRIES,
                    deadline=deadline,
                )
                if response.status_code != 200:
                    logger.error("HAL API returned %d", response.status_code)
                    break
            except Exception:
                logger.exception("HAL API request failed")
                break

            try:
                data = response.json()
                payload = data["response"]
                docs = payload["docs"]
                if not isinstance(docs, list):
                    raise ValueError("HAL docs is not an array")
            except (ValueError, TypeError, KeyError):
                note_parse_failure()
                logger.warning("HAL returned an unreadable search response")
                break
            if not docs:
                break

            for doc in docs:
                if not isinstance(doc, dict):
                    logger.warning("HAL returned a malformed record; skipped")
                    continue
                title = doc.get("title_s")
                if isinstance(title, list):
                    title = title[0] if title else ""
                if not title:
                    continue

                authors = doc.get("authFullName_s", [])
                if isinstance(authors, str):
                    authors = [authors]

                abstract = doc.get("abstract_s")
                if isinstance(abstract, list):
                    abstract = abstract[0] if abstract else None

                pub_date = doc.get("producedDate_tdate")
                if pub_date:
                    pub_date = str(pub_date)[:10]
                elif doc.get("producedDateY_i"):
                    pub_date = f"{doc['producedDateY_i']}-01-01"

                hal_id = doc.get("halId_s", str(doc.get("docid", "")))
                url = doc.get("uri_s", f"https://hal.science/{hal_id}")

                domains = doc.get("domain_s", [])
                if isinstance(domains, str):
                    domains = [domains]

                results.append(NormalizedResult(
                    source_repository="hal",
                    external_id=hal_id,
                    doi=doc.get("doiId_s"),
                    title=title,
                    authors=authors,
                    abstract=abstract,
                    publication_date=pub_date,
                    url=url,
                    categories=domains,
                ))

            start += len(docs)
            if len(docs) < params["rows"]:
                break

        return results[:max_results]


# ---------------------------------------------------------------------------
# Registry auto-registration
# ---------------------------------------------------------------------------
def _register():
    from .api_registry import register_client
    register_client("hal", HalClient)

_register()
