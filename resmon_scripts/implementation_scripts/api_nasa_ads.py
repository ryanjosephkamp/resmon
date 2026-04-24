# resmon_scripts/implementation_scripts/api_nasa_ads.py
"""NASA ADS API client — JSON, Bearer token, Solr query syntax, graceful missing-key handling."""

import logging

from .api_base import BaseAPIClient, NormalizedResult, RateLimiter, safe_request
from .credential_manager import get_credential_for

logger = logging.getLogger(__name__)

_ADS_API_URL = "https://api.adsabs.harvard.edu/v1/search/query"

# Conservative: 1 req/s (5000 req/day with key)
_RATE_LIMITER = RateLimiter(requests_per_second=1.0)


class NasaAdsClient(BaseAPIClient):
    """NASA ADS repository API client."""

    def get_name(self) -> str:
        return "NASA ADS"

    def search(
        self,
        query: str,
        date_from: str | None = None,
        date_to: str | None = None,
        max_results: int = 100,
        **kwargs,
    ) -> list[NormalizedResult]:
        api_key = get_credential_for(self._exec_id, "nasa_ads_api_key")
        if not api_key:
            logger.warning("NASA ADS API key not configured — returning empty results")
            return []

        # Solr query with optional date filtering
        solr_query = query
        if date_from or date_to:
            d_from = date_from or "1900-01-01"
            d_to = date_to or "2099-12-31"
            # Convert to ADS pubdate format YYYY-MM
            d_from_ads = d_from[:7]  # YYYY-MM
            d_to_ads = d_to[:7]
            solr_query += f" pubdate:[{d_from_ads} TO {d_to_ads}]"

        results: list[NormalizedResult] = []
        start = 0
        page_size = min(max_results, 100)

        headers = {"Authorization": f"Bearer {api_key}"}

        while len(results) < max_results:
            params = {
                "q": solr_query,
                "fl": "bibcode,doi,title,author,abstract,pubdate,identifier,keyword",
                "start": start,
                "rows": min(page_size, max_results - len(results)),
                "sort": "date desc",
            }

            try:
                response = safe_request(
                    "GET", _ADS_API_URL,
                    params=params,
                    headers=headers,
                    rate_limiter=_RATE_LIMITER,
                )
                if response.status_code == 401:
                    logger.error("NASA ADS API key is invalid (401)")
                    break
                if response.status_code != 200:
                    logger.error("NASA ADS API returned %d", response.status_code)
                    break
            except Exception:
                logger.exception("NASA ADS API request failed")
                break

            data = response.json()
            docs = data.get("response", {}).get("docs", [])
            if not docs:
                break

            for doc in docs:
                parsed = self._parse_doc(doc)
                if parsed is not None:
                    results.append(parsed)

            start += len(docs)
            total = data.get("response", {}).get("numFound", 0)
            if start >= total or len(docs) < params["rows"]:
                break

        return results[:max_results]

    @staticmethod
    def _parse_doc(doc: dict) -> NormalizedResult | None:
        title_list = doc.get("title", [])
        title = title_list[0] if title_list else ""
        if not title:
            return None

        bibcode = doc.get("bibcode", "")
        external_id = bibcode

        doi_list = doc.get("doi", [])
        doi = doi_list[0] if doi_list else None

        authors = doc.get("author", [])

        abstract = doc.get("abstract")

        # Publication date — ADS returns "YYYY-MM-00" format
        pubdate = doc.get("pubdate", "")
        publication_date = None
        if pubdate:
            parts = pubdate.split("-")
            year = parts[0] if len(parts) > 0 else ""
            month = parts[1] if len(parts) > 1 else "01"
            day = parts[2] if len(parts) > 2 else "01"
            if day == "00":
                day = "01"
            if month == "00":
                month = "01"
            if year:
                publication_date = f"{year}-{month}-{day}"

        url = f"https://ui.adsabs.harvard.edu/abs/{bibcode}" if bibcode else ""

        categories = doc.get("keyword", []) or []

        return NormalizedResult(
            source_repository="nasa_ads",
            external_id=external_id,
            doi=doi,
            title=title,
            authors=authors,
            abstract=abstract,
            publication_date=publication_date,
            url=url,
            categories=categories[:10],
        )


# ---------------------------------------------------------------------------
# Registry auto-registration
# ---------------------------------------------------------------------------
def _register():
    from .api_registry import register_client
    register_client("nasa_ads", NasaAdsClient)

_register()
