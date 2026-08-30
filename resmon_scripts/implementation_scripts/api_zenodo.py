# resmon_scripts/implementation_scripts/api_zenodo.py
"""Zenodo records API client."""

import logging
from html.parser import HTMLParser

from .api_base import BaseAPIClient, NormalizedResult, RateLimiter, safe_request

logger = logging.getLogger(__name__)

_ZENODO_API_URL = "https://zenodo.org/api/records"

# Zenodo limits search REST endpoints to 30 requests per minute.
_RATE_LIMITER = RateLimiter(requests_per_second=0.5)


class _DescriptionParser(HTMLParser):
    """Extract readable text from Zenodo's HTML descriptions."""

    _BLOCK_TAGS = {
        "br", "div", "h1", "h2", "h3", "h4", "h5", "h6", "li", "p", "tr",
    }

    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self._parts: list[str] = []

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        if tag in self._BLOCK_TAGS:
            self._parts.append(" ")

    def handle_endtag(self, tag: str) -> None:
        if tag in self._BLOCK_TAGS:
            self._parts.append(" ")

    def handle_data(self, data: str) -> None:
        self._parts.append(data)

    def text(self) -> str:
        return " ".join("".join(self._parts).split())


def _strip_html(value: str | None) -> str | None:
    if not value:
        return None
    parser = _DescriptionParser()
    parser.feed(value)
    parser.close()
    return parser.text() or None


def _total_hits(value: object) -> int | None:
    if isinstance(value, dict):
        value = value.get("value")
    try:
        return int(value)
    except (TypeError, ValueError):
        return None


class ZenodoClient(BaseAPIClient):
    """Zenodo published-record search client."""

    def get_name(self) -> str:
        return "Zenodo"

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

        search_query = query.strip()
        if date_from or date_to:
            date_clause = (
                f"publication_date:[{date_from or '*'} TO {date_to or '*'}]"
            )
            search_query = (
                f"({search_query}) AND {date_clause}"
                if search_query else date_clause
            )

        results: list[NormalizedResult] = []
        page = 1
        seen_hits = 0
        page_size = min(max_results, 25)

        while len(results) < max_results:
            # Page numbers are offsets over a fixed page size. Shrinking size
            # on the final request would move page 2 back into page 1's range.
            requested_size = page_size
            params = {
                "q": search_query,
                "size": requested_size,
                "page": page,
                "sort": "bestmatch",
            }
            try:
                response = safe_request(
                    "GET",
                    _ZENODO_API_URL,
                    params=params,
                    rate_limiter=_RATE_LIMITER,
                )
                if response.status_code != 200:
                    logger.error("Zenodo API returned %d", response.status_code)
                    break
                payload = response.json()
            except Exception:
                logger.exception("Zenodo API request failed")
                break

            if not isinstance(payload, dict):
                logger.error("Zenodo API returned a non-object response")
                break
            hits_node = payload.get("hits")
            if not isinstance(hits_node, dict):
                logger.error("Zenodo API response has no hits object")
                break
            hits = hits_node.get("hits")
            if not isinstance(hits, list):
                logger.error("Zenodo API response has no hits list")
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
            total = _total_hits(hits_node.get("total"))
            if total is not None and seen_hits >= total:
                break
            if len(hits) < requested_size:
                break
            page += 1

        return results[:max_results]

    @staticmethod
    def _parse_record(record: dict) -> NormalizedResult | None:
        if not isinstance(record, dict):
            logger.warning("Zenodo record was not an object; skipping it")
            return None

        metadata = record.get("metadata")
        if not isinstance(metadata, dict):
            logger.warning("Zenodo record %r has no metadata object; skipping it", record.get("id"))
            return None

        record_id = record.get("id")
        title = metadata.get("title")
        if record_id is None or not isinstance(title, str) or not title.strip():
            logger.warning("Zenodo record %r has no stable id or title; skipping it", record_id)
            return None

        doi_value = record.get("doi")
        doi = str(doi_value).strip() if doi_value else None

        authors: list[str] = []
        creators = metadata.get("creators")
        if isinstance(creators, list):
            for creator in creators:
                if not isinstance(creator, dict):
                    continue
                name = creator.get("name")
                if isinstance(name, str) and name.strip():
                    authors.append(name.strip())

        description = metadata.get("description")
        abstract = _strip_html(description if isinstance(description, str) else None)

        publication_date_value = metadata.get("publication_date")
        publication_date = (
            str(publication_date_value) if publication_date_value else None
        )

        categories: list[str] = []
        keywords = metadata.get("keywords")
        if isinstance(keywords, list):
            categories.extend(
                keyword.strip()
                for keyword in keywords
                if isinstance(keyword, str) and keyword.strip()
            )
        resource_type = metadata.get("resource_type")
        if isinstance(resource_type, dict):
            resource_title = resource_type.get("title")
            if isinstance(resource_title, str) and resource_title.strip():
                categories.append(resource_title.strip())

        links = record.get("links")
        self_html = links.get("self_html") if isinstance(links, dict) else None
        external_id = str(record_id)
        url = self_html or (
            f"https://doi.org/{doi}"
            if doi else f"https://zenodo.org/records/{external_id}"
        )

        return NormalizedResult(
            source_repository="zenodo",
            external_id=external_id,
            doi=doi,
            title=title.strip(),
            authors=authors,
            abstract=abstract,
            publication_date=publication_date,
            url=url,
            categories=categories[:10],
        )


def _register() -> None:
    from .api_registry import register_client
    register_client("zenodo", ZenodoClient)


_register()
