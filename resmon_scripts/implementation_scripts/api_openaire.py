# resmon_scripts/implementation_scripts/api_openaire.py
"""OpenAIRE legacy publication Search API client."""

import logging
from urllib.parse import quote

from .api_base import (
    BaseAPIClient,
    NormalizedResult,
    RateLimiter,
    note_parse_failure_unless_transport,
    safe_request,
)

logger = logging.getLogger(__name__)

_OPENAIRE_API_URL = "https://api.openaire.eu/search/publications"

# OpenAIRE's current terms cap unauthenticated clients at 60 requests/hour.
# Spacing those calls evenly is slower than the brief's earlier 1 req/s figure.
_RATE_LIMITER = RateLimiter(requests_per_second=1.0 / 60.0)


def _as_list(node: object) -> list[object]:
    """Normalize XML-to-JSON object/list/null cardinality changes."""
    if node is None:
        return []
    if isinstance(node, list):
        return node
    if isinstance(node, dict):
        return [node]
    return []


class OpenAireClient(BaseAPIClient):
    """OpenAIRE publication Search API client."""

    def get_name(self) -> str:
        return "OpenAIRE"

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
        seen_records = 0
        page_size = min(max_results, 100)

        while len(results) < max_results:
            params: dict[str, object] = {
                "keywords": query.strip(),
                "size": page_size,
                "page": page,
                "format": "json",
            }
            if date_from:
                params["fromDateAccepted"] = date_from
            if date_to:
                params["toDateAccepted"] = date_to

            try:
                response = safe_request(
                    "GET",
                    _OPENAIRE_API_URL,
                    params=params,
                    rate_limiter=_RATE_LIMITER,
                )
                if response.status_code != 200:
                    logger.error("OpenAIRE API returned %d", response.status_code)
                    break
                payload = response.json()
            except Exception as exc:
                logger.exception("OpenAIRE API request failed")
                # A reply that arrived and would not parse is a
                # different fact from a source that never answered;
                # safe_request has already recorded the second kind.
                note_parse_failure_unless_transport(exc)
                break

            response_nodes = _as_list(
                payload.get("response") if isinstance(payload, dict) else None
            )
            if not response_nodes or not isinstance(response_nodes[0], dict):
                logger.error("OpenAIRE API response has no response object")
                break
            response_node = response_nodes[0]

            total_hits = None
            header_nodes = _as_list(response_node.get("header"))
            if header_nodes and isinstance(header_nodes[0], dict):
                total_nodes = _as_list(header_nodes[0].get("total"))
                if total_nodes and isinstance(total_nodes[0], dict):
                    total_value = total_nodes[0].get("$")
                    try:
                        total_hits = int(total_value)
                    except (TypeError, ValueError):
                        total_hits = None

            results_nodes = _as_list(response_node.get("results"))
            if not results_nodes or not isinstance(results_nodes[0], dict):
                if total_hits == 0:
                    break
                logger.error("OpenAIRE API response has no results object")
                break
            record_nodes = _as_list(results_nodes[0].get("result"))
            if not record_nodes:
                break

            for record in record_nodes:
                parsed = self._parse_record(record)
                if parsed is None:
                    continue
                results.append(parsed)
                if len(results) >= max_results:
                    break

            seen_records += len(record_nodes)
            if total_hits is not None and seen_records >= total_hits:
                break
            if len(record_nodes) < page_size:
                break
            page += 1

        return results[:max_results]

    @staticmethod
    def _parse_record(record: object) -> NormalizedResult | None:
        record_nodes = _as_list(record)
        if not record_nodes or not isinstance(record_nodes[0], dict):
            logger.warning("OpenAIRE result was not an object; skipping it")
            return None
        record_node = record_nodes[0]

        external_id = None
        header_nodes = _as_list(record_node.get("header"))
        if header_nodes and isinstance(header_nodes[0], dict):
            identifier_nodes = _as_list(
                header_nodes[0].get("dri:objIdentifier")
            )
            for identifier_node in identifier_nodes:
                if not isinstance(identifier_node, dict):
                    continue
                value = identifier_node.get("$")
                if isinstance(value, str) and value.strip():
                    external_id = value.strip()
                    break

        metadata_nodes = _as_list(record_node.get("metadata"))
        if not metadata_nodes or not isinstance(metadata_nodes[0], dict):
            logger.warning("OpenAIRE result %r has no metadata; skipping it", external_id)
            return None
        entity_nodes = _as_list(metadata_nodes[0].get("oaf:entity"))
        if not entity_nodes or not isinstance(entity_nodes[0], dict):
            logger.warning("OpenAIRE result %r has no entity; skipping it", external_id)
            return None
        result_nodes = _as_list(entity_nodes[0].get("oaf:result"))
        if not result_nodes or not isinstance(result_nodes[0], dict):
            logger.warning("OpenAIRE result %r has no result metadata; skipping it", external_id)
            return None
        result_node = result_nodes[0]

        doi = None
        for pid_node in _as_list(result_node.get("pid")):
            if not isinstance(pid_node, dict) or pid_node.get("@classid") != "doi":
                continue
            value = pid_node.get("$")
            if isinstance(value, str) and value.strip():
                doi = value.strip()
                break

        title = None
        for title_node in _as_list(result_node.get("title")):
            if (
                not isinstance(title_node, dict)
                or title_node.get("@classid") != "main title"
            ):
                continue
            value = title_node.get("$")
            if isinstance(value, str) and value.strip():
                title = value.strip()
                break

        if not external_id or not title:
            logger.warning(
                "OpenAIRE result %r has no stable id or main title; skipping it",
                external_id,
            )
            return None

        authors: list[str] = []
        for creator_node in _as_list(result_node.get("creator")):
            if not isinstance(creator_node, dict):
                continue
            value = creator_node.get("$")
            if isinstance(value, str) and value.strip():
                authors.append(value.strip())

        abstract = None
        for description_node in _as_list(result_node.get("description")):
            if not isinstance(description_node, dict):
                continue
            value = description_node.get("$")
            if isinstance(value, str) and value.strip():
                abstract = value.strip()
                break

        publication_date = None
        for date_node in _as_list(result_node.get("dateofacceptance")):
            if not isinstance(date_node, dict):
                continue
            value = date_node.get("$")
            if value is not None and str(value).strip():
                publication_date = str(value).strip()
                break

        categories: list[str] = []
        for subject_node in _as_list(result_node.get("subject")):
            if not isinstance(subject_node, dict):
                continue
            value = subject_node.get("$")
            if isinstance(value, str) and value.strip():
                categories.append(value.strip())
                if len(categories) >= 10:
                    break

        url = (
            f"https://doi.org/{doi}"
            if doi
            else (
                "https://explore.openaire.eu/search/publication?articleId="
                f"{quote(external_id, safe='')}"
            )
        )
        return NormalizedResult(
            source_repository="openaire",
            external_id=external_id,
            doi=doi,
            title=title,
            authors=authors,
            abstract=abstract,
            publication_date=publication_date,
            url=url,
            categories=categories,
        )


def _register() -> None:
    from .api_registry import register_client
    register_client("openaire", OpenAireClient)


_register()
