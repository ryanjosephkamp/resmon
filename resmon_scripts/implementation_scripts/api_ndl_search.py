"""NDL Search open-metadata SRU client."""

import calendar
from dataclasses import dataclass
from datetime import date, timedelta
import logging
import re
from urllib.parse import urlsplit
import xml.etree.ElementTree as ET

from .api_base import BaseAPIClient, NormalizedResult, RateLimiter, safe_request

logger = logging.getLogger(__name__)

_NDL_SEARCH_API_URL = "https://ndlsearch.ndl.go.jp/api/sru"
_USER_AGENT = "resmon (+https://github.com/ryanjosephkamp/resmon/issues)"
_MAX_RECORDS = 500

# NDL publishes no numeric rate limit. It asks continuous users to identify
# themselves, restricts concurrent access, and may block heavy continuous
# traffic, so this deliberately conservative shared limiter is 0.5 req/s.
_RATE_LIMITER = RateLimiter(requests_per_second=0.5)

_SRU = "http://www.loc.gov/zing/srw/"
_RDF = "http://www.w3.org/1999/02/22-rdf-syntax-ns#"
_DCTERMS = "http://purl.org/dc/terms/"
_DCNDL = "http://ndl.go.jp/dcndl/terms/"
_FOAF = "http://xmlns.com/foaf/0.1/"
_NS = {
    "sru": _SRU,
    "rdf": _RDF,
    "dcterms": _DCTERMS,
    "dcndl": _DCNDL,
    "foaf": _FOAF,
}
_PARTIAL_DATE = re.compile(r"^\d{4}(?:-\d{2}(?:-\d{2})?)?$")
_BOOK_TOKEN = re.compile(r"^R\d{9}-[A-Za-z0-9][A-Za-z0-9._~-]*$")
_ALLOWED_RIGHTS = {
    "https://creativecommons.org/publicdomain/mark/1.0",
    "https://creativecommons.org/publicdomain/zero/1.0",
    "https://creativecommons.org/licenses/by/4.0",
}


@dataclass(frozen=True)
class _DateBound:
    """An input date with its exact accepted precision and closed day range."""

    raw: str
    start: date
    end: date


def _parse_date_bound(value: str | None) -> _DateBound | None:
    """Validate an NDL YYYY, YYYY-MM, or YYYY-MM-DD date argument."""
    if value is None:
        return _DateBound("", date.min, date.max)
    if not isinstance(value, str) or not _PARTIAL_DATE.fullmatch(value):
        return None
    try:
        year = int(value[:4])
        if not 1000 <= year <= 9999:
            return None
        if len(value) == 4:
            return _DateBound(value, date(year, 1, 1), date(year, 12, 31))
        month = int(value[5:7])
        last_day = calendar.monthrange(year, month)[1]
        if len(value) == 7:
            return _DateBound(value, date(year, month, 1), date(year, month, last_day))
        day = int(value[8:10])
        return _DateBound(value, date(year, month, day), date(year, month, day))
    except ValueError:
        return None


def _as_day(value: date) -> str:
    return value.isoformat()


def _cql_quote(value: str) -> str:
    """Quote user text as a single CQL value without changing its semantics."""
    return value.replace("\\", "\\\\").replace('"', '\\"')


def _normalized_rights_uri(value: str) -> str | None:
    """Accept only HTTP(S) plus one optional trailing slash normalization."""
    if not isinstance(value, str):
        return None
    normalized = value
    if normalized.startswith("http://"):
        normalized = "https://" + normalized[len("http://"):]
    elif not normalized.startswith("https://"):
        return None
    if normalized.endswith("/"):
        normalized = normalized[:-1]
    return normalized


def _no_records_diagnostic(root: ET.Element) -> str | None:
    """Return NDL's own wording when the response is a zero-match diagnostic.

    ``None`` when the response is not one, so a genuinely malformed body still
    falls through to the error path. Matching on the diagnostic's message
    rather than merely on the presence of a diagnostics block, because an SRU
    diagnostic can also report a real failure -- a bad query, a server fault --
    and those must not be flattened into "no results".
    """
    diagnostics = root.find("sru:diagnostics", _NS)
    if diagnostics is None:
        return None
    for diagnostic in diagnostics.iter():
        tag = diagnostic.tag.rsplit("}", 1)[-1]
        if tag != "message":
            continue
        message = (diagnostic.text or "").strip()
        if "does not exist" in message.lower():
            return message
    return None


def _books_token(value: str | None) -> tuple[str, str] | None:
    """Return the source-provided NDL books token and its canonical URL."""
    if not isinstance(value, str):
        return None
    parsed = urlsplit(value)
    if (
        parsed.scheme != "https"
        or parsed.netloc != "ndlsearch.ndl.go.jp"
        or parsed.query
        or parsed.fragment
    ):
        return None
    prefix = "/books/"
    if not parsed.path.startswith(prefix):
        return None
    token = parsed.path[len(prefix):]
    if not _BOOK_TOKEN.fullmatch(token):
        return None
    return token, f"https://ndlsearch.ndl.go.jp/books/{token}"


class NDLSearchClient(BaseAPIClient):
    """Search per-record validated open NDL Search metadata through SRU."""

    def get_name(self) -> str:
        return "NDL Search"

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

        lower = _parse_date_bound(date_from)
        upper = _parse_date_bound(date_to)
        if lower is None or upper is None or lower.start > upper.end:
            logger.error("NDL Search received invalid or inverted publication dates")
            return []

        if date_from and date_to and len(lower.raw) != len(upper.raw):
            cql_from, cql_to = _as_day(lower.start), _as_day(upper.end)
        else:
            cql_from = lower.raw if date_from else None
            cql_to = upper.raw if date_to else None

        if max_results <= _MAX_RECORDS:
            fetched = self._fetch(query, cql_from, cql_to, max_results)
            if fetched is None:
                return []
            return self._deduplicate(fetched[1])[:max_results]

        if not date_from or not date_to:
            logger.error(
                "NDL Search cannot honestly retrieve more than %d results without a bounded date interval",
                _MAX_RECORDS,
            )
            return []

        partitioned = self._collect_partitions(query, lower.start, upper.end)
        if partitioned is None:
            return []
        return self._deduplicate(partitioned)[:max_results]

    def _collect_partitions(
        self,
        query: str,
        lower: date,
        upper: date,
    ) -> list[NormalizedResult] | None:
        """Recursively split an inclusive date window when NDL reports >500 hits."""
        fetched = self._fetch(query, _as_day(lower), _as_day(upper), _MAX_RECORDS)
        if fetched is None:
            return None
        total, records = fetched
        if total <= _MAX_RECORDS:
            return records
        if lower == upper:
            logger.error(
                "NDL Search has %d records on %s, exceeding the documented %d-record ceiling",
                total, lower.isoformat(), _MAX_RECORDS,
            )
            return None

        midpoint = lower + timedelta(days=(upper - lower).days // 2)
        left = self._collect_partitions(query, lower, midpoint)
        if left is None:
            return None
        right = self._collect_partitions(query, midpoint + timedelta(days=1), upper)
        if right is None:
            return None
        return left + right

    def _fetch(
        self,
        query: str,
        date_from: str | None,
        date_to: str | None,
        maximum_records: int,
    ) -> tuple[int, list[NormalizedResult]] | None:
        cql = self._build_cql(query, date_from, date_to)
        try:
            response = safe_request(
                "GET",
                _NDL_SEARCH_API_URL,
                params={
                    "operation": "searchRetrieve",
                    "version": "1.2",
                    "query": cql,
                    "startRecord": 1,
                    "maximumRecords": min(maximum_records, _MAX_RECORDS),
                    "recordPacking": "xml",
                    "recordSchema": "dcndl_v3",
                },
                headers={"User-Agent": _USER_AGENT},
                rate_limiter=_RATE_LIMITER,
            )
        except Exception:
            logger.exception("NDL Search API request failed")
            return None

        if response.status_code != 200:
            logger.error("NDL Search API returned %d", response.status_code)
            return None
        try:
            root = ET.fromstring(response.text)

            # A query that matches nothing comes back as an SRU *diagnostic*
            # rather than an empty result set: no numberOfRecords element at
            # all, and "Record does not exist" in the message. That is a
            # well-formed answer meaning zero, and treating it as malformed XML
            # -- which is what shipped -- reports an upstream fault that did not
            # happen. It also matters downstream: the watchdog reads a source
            # error differently from a legitimate zero, and one of these is a
            # fact about NDL while the other is a fact about the query.
            diagnostic = _no_records_diagnostic(root)
            if diagnostic is not None:
                logger.info(
                    "NDL Search returned no records for this query (%s)", diagnostic,
                )
                return 0, []

            total_text = root.findtext("sru:numberOfRecords", namespaces=_NS)
            total = int(total_text) if total_text is not None else None
            if total is None or total < 0:
                raise ValueError("missing or invalid numberOfRecords")
            expected_records = min(total, min(maximum_records, _MAX_RECORDS))
            raw_records = root.findall(".//sru:record", _NS)
            if len(raw_records) != expected_records:
                logger.error(
                    "NDL Search API returned an incomplete SRU page: expected %d raw records, got %d",
                    expected_records,
                    len(raw_records),
                )
                return None
            return total, self._parse_records(root)
        except (ET.ParseError, ValueError, TypeError):
            logger.exception("NDL Search API returned malformed SRU XML")
            return None

    @staticmethod
    def _build_cql(query: str, date_from: str | None, date_to: str | None) -> str:
        clauses = [
            'dpid = "open"',
            f'anywhere = "{_cql_quote(query.strip())}"',
        ]
        if date_from:
            clauses.append(f'from = "{date_from}"')
        if date_to:
            clauses.append(f'until = "{date_to}"')
        return " AND ".join(clauses)

    @classmethod
    def _parse_records(cls, root: ET.Element) -> list[NormalizedResult]:
        records: list[NormalizedResult] = []
        for record_data in root.findall(".//sru:recordData", _NS):
            rdf_root = record_data.find("rdf:RDF", _NS)
            if rdf_root is None:
                logger.warning("NDL Search record has no RDF payload; skipping it")
                continue
            resources = {
                resource.get(f"{{{_RDF}}}about"): resource
                for resource in rdf_root.findall("dcndl:BibResource", _NS)
                if resource.get(f"{{{_RDF}}}about")
            }
            for admin in rdf_root.findall("dcndl:BibAdminResource", _NS):
                parsed = cls._parse_admin_record(admin, resources)
                if parsed is not None:
                    records.append(parsed)
        return records

    @classmethod
    def _parse_admin_record(
        cls,
        admin: ET.Element,
        resources: dict[str, ET.Element],
    ) -> NormalizedResult | None:
        provider = (admin.findtext("dcndl:bibRecordCategory", namespaces=_NS) or "").strip()
        identity = _books_token(admin.get(f"{{{_RDF}}}about"))
        record_link = admin.find("dcndl:record", _NS)
        linked_resource = (
            record_link.get(f"{{{_RDF}}}resource") if record_link is not None else None
        )
        rights = [
            _normalized_rights_uri(right.get(f"{{{_RDF}}}resource", ""))
            for right in admin.findall("dcndl:rights", _NS)
        ]
        if (
            not provider
            or identity is None
            or not linked_resource
            or linked_resource != f"{identity[1]}#material"
            or len(rights) != 1
            or rights[0] not in _ALLOWED_RIGHTS
        ):
            logger.warning("NDL Search record lacks a validated open metadata provenance; skipping it")
            return None
        resource = resources.get(linked_resource)
        if resource is None:
            logger.warning("NDL Search admin record does not link to a BibResource; skipping it")
            return None
        return cls._normalize_resource(identity[0], identity[1], resource)

    @staticmethod
    def _normalize_resource(
        token: str,
        url: str,
        resource: ET.Element,
    ) -> NormalizedResult | None:
        title = (resource.findtext("dcterms:title", namespaces=_NS) or "").strip()
        if not title:
            title = (
                resource.findtext("dcterms:title/rdf:value", namespaces=_NS) or ""
            ).strip()
        if not title:
            logger.warning("NDL Search record has no title; skipping it")
            return None

        authors: list[str] = []
        for name in resource.findall("dcterms:creator/foaf:Agent/foaf:name", _NS):
            author = (name.text or "").strip()
            if author and author not in authors:
                authors.append(author)

        abstract = (resource.findtext("dcterms:abstract", namespaces=_NS) or "").strip() or None
        issued = (resource.findtext("dcterms:issued", namespaces=_NS) or "").strip() or None
        doi = None
        for identifier in resource.findall("dcterms:identifier", _NS):
            datatype = identifier.get(f"{{{_RDF}}}datatype", "")
            candidate = (identifier.text or "").strip()
            if datatype == "http://ndl.go.jp/dcndl/terms/DOI" and candidate:
                doi = candidate
                break

        return NormalizedResult(
            source_repository="ndl_search",
            external_id=token,
            doi=doi,
            title=title,
            authors=authors,
            abstract=abstract,
            publication_date=issued,
            url=url,
            categories=[],
        )

    @staticmethod
    def _deduplicate(records: list[NormalizedResult]) -> list[NormalizedResult]:
        unique: list[NormalizedResult] = []
        seen: set[str] = set()
        for record in records:
            if record.external_id not in seen:
                seen.add(record.external_id)
                unique.append(record)
        return unique


def _register() -> None:
    from .api_registry import register_client
    register_client("ndl_search", NDLSearchClient)


_register()
