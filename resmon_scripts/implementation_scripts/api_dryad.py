"""Dryad dataset search client."""

import logging

from .api_base import BaseAPIClient, NormalizedResult, RateLimiter, safe_request

logger = logging.getLogger(__name__)

_DRYAD_API_URL = "https://datadryad.org/api/v2/search"

# Dryad documents no numeric API limit. One request per second is deliberately
# conservative for its public, unauthenticated search endpoint.
_RATE_LIMITER = RateLimiter(requests_per_second=1.0)


class DryadClient(BaseAPIClient):
    """Dryad published-dataset search client."""

    def get_name(self) -> str:
        return "Dryad"

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

        results: list[NormalizedResult] = []
        page = 1
        page_size = min(max_results, 100)
        seen_records = 0

        while len(results) < max_results:
            params = {
                "q": query.strip(),
                "page": page,
                "per_page": page_size,
            }
            if date_from:
                params["publishedSince"] = date_from
            if date_to:
                params["publishedBefore"] = date_to

            try:
                response = safe_request(
                    "GET",
                    _DRYAD_API_URL,
                    params=params,
                    rate_limiter=_RATE_LIMITER,
                )
                if response.status_code != 200:
                    logger.error("Dryad API returned %d", response.status_code)
                    break
                payload = response.json()
            except Exception:
                logger.exception("Dryad API request failed")
                break

            if not isinstance(payload, dict):
                logger.error("Dryad API returned a non-object response")
                break
            embedded = payload.get("_embedded")
            if not isinstance(embedded, dict):
                logger.error("Dryad API response has no embedded records")
                break
            records = embedded.get("stash:datasets")
            if not isinstance(records, list):
                logger.error("Dryad API response has no dataset list")
                break
            if not records:
                break

            for record in records:
                parsed = self._parse_record(record)
                if parsed is not None:
                    results.append(parsed)
                    if len(results) >= max_results:
                        break

            seen_records += len(records)
            total = payload.get("total")
            if isinstance(total, int) and seen_records >= total:
                break
            if len(records) < page_size:
                break
            page += 1

        return results[:max_results]

    @staticmethod
    def _parse_record(record: object) -> NormalizedResult | None:
        if not isinstance(record, dict):
            logger.warning("Dryad record was not an object; skipping it")
            return None

        raw_id = record.get("id")
        title = record.get("title")
        if not isinstance(raw_id, str) or not raw_id.strip() or not isinstance(title, str) or not title.strip():
            logger.warning("Dryad record has no stable id or title; skipping it")
            return None

        external_id = raw_id.strip()
        doi = external_id.removeprefix("doi:") if external_id.startswith("doi:") else None
        authors = DryadClient._author_names(record.get("authors"))
        abstract = record.get("abstract")
        publication_date = record.get("publicationDate")
        categories = record.get("keywords")

        return NormalizedResult(
            source_repository="dryad",
            external_id=external_id,
            doi=doi,
            title=title.strip(),
            authors=authors,
            abstract=abstract.strip() if isinstance(abstract, str) and abstract.strip() else None,
            publication_date=(
                publication_date.strip()
                if isinstance(publication_date, str) and publication_date.strip()
                else None
            ),
            url=(f"https://doi.org/{doi}" if doi else f"https://datadryad.org/dataset/{external_id}"),
            categories=[
                keyword.strip()
                for keyword in categories
                if isinstance(keyword, str) and keyword.strip()
            ][:10] if isinstance(categories, list) else [],
        )

    @staticmethod
    def _author_names(authors: object) -> list[str]:
        """Return names only: Dryad search records can include author email."""
        if not isinstance(authors, list):
            return []

        names: list[str] = []
        for author in authors:
            if not isinstance(author, dict):
                continue
            first_name = author.get("firstName")
            last_name = author.get("lastName")
            name = " ".join(
                value.strip()
                for value in (first_name, last_name)
                if isinstance(value, str) and value.strip()
            )
            if name:
                names.append(name)
        return names


def _register() -> None:
    from .api_registry import register_client
    register_client("dryad", DryadClient)


_register()
