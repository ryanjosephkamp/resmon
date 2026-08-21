"""Corpus lifecycle: papers change after you find them.

resmon's corpus is frozen at discovery time. A paper you read in March can be
retracted in June, a bioRxiv preprint from eight months ago can now be in a
journal, an arXiv entry can be three versions further on — and nothing in the
app would ever say so. Discovering that a paper you built on was retracted
*after* submission is a career-grade problem, and no monitoring tool in the
field checks for any of it.

Three checks, all against identifiers resmon already stores:

============================  ==========================  ====================
Check                         Source                      Notice
============================  ==========================  ====================
Retraction / concern /        Crossref ``updated-by`` on   the notice's own DOI
correction / withdrawal       the paper's DOI
Preprint reached a journal    bioRxiv API ``published``    the published DOI
New version posted            bioRxiv version count,       the versioned page
                              arXiv ``vN`` in the id
============================  ==========================  ====================

Crossref has distributed the Retraction Watch database openly since 2023, and
marks each update record with whether it came from Retraction Watch or from the
publisher. That provenance is carried through to the interface rather than
flattened, because a reader weighing a claim should know its origin.

The rule that shapes everything here
------------------------------------
**resmon never asserts a lifecycle event on its own authority.** Every finding
carries a resolvable link to the notice behind it, and a finding that cannot
produce one is not recorded at all. A false retraction flag is defamatory, and
"we inferred it from the metadata" is not a defence.

Two consequences that look like limitations and are not:

* The upstream's own ``label`` is stored and displayed verbatim. resmon does not
  translate "Correction" into "Retraction", or soften "Retraction" into
  "Update", because the wording is the claim.
* An **expression of concern** is its own severity, weaker than a retraction and
  said so. Crossref documents that its coverage of non-retraction update types
  is less comprehensive than for retractions, so absence of one means less than
  absence of the other, and the interface says that too.

Nothing here runs on its own. Lifecycle checks make outbound requests, and a
literature monitor that quietly phones a third party about every paper you have
ever collected would be doing something the user did not ask for. The check is
explicit, bounded, and resumable.
"""

from __future__ import annotations

import json
import logging
import re
import sqlite3
from dataclasses import dataclass, field
from datetime import datetime, timezone

from .api_base import RateLimiter, safe_request
from .database import (
    MissingNoticeError,
    record_lifecycle_check,
    record_lifecycle_finding,
)

logger = logging.getLogger(__name__)

# Crossref's polite pool. The same limiter the CrossRef search client uses.
_CROSSREF_URL = "https://api.crossref.org/works"
_CROSSREF_LIMITER = RateLimiter(requests_per_second=10.0)
_CROSSREF_MAILTO = "resmon@example.com"

_BIORXIV_URL = "https://api.biorxiv.org/details"
_BIORXIV_LIMITER = RateLimiter(requests_per_second=2.0)

# DOIs go out in batches. Crossref's ``filter=doi:A,doi:B`` returns them
# together, which turns a thousand-paper corpus from a thousand requests into
# twenty-five. Kept modest so the request URL stays well inside any proxy's
# limit and one failure costs little.
CROSSREF_BATCH = 40

# Default ceiling on one run of the check. The corpus can be large and each
# paper costs an outbound request, so the check is bounded and resumable rather
# than open-ended: it takes the least recently checked papers first and reports
# how many remain.
DEFAULT_LIMIT = 200

# How long a check stays fresh. Retractions are not urgent to the minute, and
# re-asking Crossref about the same paper daily is discourteous.
RECHECK_AFTER_DAYS = 30

# Crossref update types → how strongly resmon is willing to speak.
#
# ``critical`` is reserved for the paper being withdrawn from the record.
# ``caution`` is for a registered concern that is explicitly not a retraction.
# Everything else is informational: a correction is normal scholarly upkeep, not
# a warning, and colouring it like one would train users to ignore the colour.
_SEVERITY_BY_TYPE = {
    "retraction": "critical",
    "withdrawal": "critical",
    "removal": "critical",
    "expression_of_concern": "caution",
    "expression-of-concern": "caution",
    "concern": "caution",
    "correction": "informational",
    "corrigendum": "informational",
    "erratum": "informational",
    "addendum": "informational",
    "clarification": "informational",
    "new_edition": "informational",
    "new_version": "informational",
    "partial_retraction": "critical",
}

_ARXIV_VERSION_RE = re.compile(r"^(?P<base>.+?)v(?P<version>\d+)$")


# ---------------------------------------------------------------------------
# Findings
# ---------------------------------------------------------------------------


@dataclass
class Finding:
    """One lifecycle event, complete with the notice a reader can check."""

    kind: str
    severity: str
    notice_key: str
    notice_url: str
    label: str | None = None
    notice_doi: str | None = None
    notice_date: str | None = None
    detail: str | None = None
    provider: str = "crossref"
    provider_source: str | None = None


@dataclass
class CheckOutcome:
    """What one paper's check produced."""

    document_id: int
    status: str  # ok | no_identifier | error
    providers: list[str] = field(default_factory=list)
    findings: list[Finding] = field(default_factory=list)
    error_message: str | None = None


def _doi_url(doi: str) -> str:
    return f"https://doi.org/{doi.strip()}"


def _severity_for(update_type: str) -> str:
    key = (update_type or "").strip().lower().replace(" ", "_").replace("-", "_")
    return _SEVERITY_BY_TYPE.get(key, "informational")


def _kind_for(update_type: str) -> str:
    key = (update_type or "").strip().lower().replace(" ", "_").replace("-", "_")
    if key in _SEVERITY_BY_TYPE:
        return key
    return "other_update"


def _date_from_parts(updated: dict | None) -> str | None:
    """Crossref dates arrive as ``{"date-parts": [[Y, M, D]]}``."""
    if not isinstance(updated, dict):
        return None
    parts = updated.get("date-parts")
    if not isinstance(parts, list) or not parts or not isinstance(parts[0], list):
        return None
    nums = [int(n) for n in parts[0] if isinstance(n, (int, float))]
    if not nums:
        return None
    y = nums[0]
    m = nums[1] if len(nums) > 1 else 1
    d = nums[2] if len(nums) > 2 else 1
    try:
        return f"{y:04d}-{m:02d}-{d:02d}"
    except (ValueError, TypeError):  # pragma: no cover - defensive
        return None


# ---------------------------------------------------------------------------
# Parsers — pure, so the tests can run against real recorded payloads
# ---------------------------------------------------------------------------


def findings_from_crossref(work: dict) -> list[Finding]:
    """Read the ``updated-by`` block Crossref attaches to an updated work.

    Each entry names the notice's own DOI, which is what makes this reportable
    at all: an update with no DOI is dropped rather than asserted, because there
    would be nothing for the user to open.
    """
    findings: list[Finding] = []
    for update in (work or {}).get("updated-by") or []:
        if not isinstance(update, dict):
            continue
        doi = (update.get("DOI") or "").strip()
        if not doi:
            # No notice, no claim.
            logger.debug("Crossref update with no DOI on %s", work.get("DOI"))
            continue
        update_type = update.get("type") or ""
        findings.append(Finding(
            kind=_kind_for(update_type),
            severity=_severity_for(update_type),
            notice_key=doi.lower(),
            notice_url=_doi_url(doi),
            # Verbatim. The wording is the claim, and paraphrasing it would be
            # resmon putting words in a publisher's mouth.
            label=update.get("label") or update_type or None,
            notice_doi=doi,
            notice_date=_date_from_parts(update.get("updated")),
            provider="crossref",
            provider_source=update.get("source"),
        ))
    return findings


def findings_from_biorxiv(detail: dict, *, stored_version: int | None = None) -> list[Finding]:
    """Read bioRxiv's version list and its link to the published article.

    ``published`` is the DOI of the journal article when one exists and the
    literal string ``"NA"`` when it does not, which is the single most useful
    field in this whole feature: a preprint reaching a journal is exactly the
    change a researcher wants to know about and no monitor reports.
    """
    collection = (detail or {}).get("collection")
    if not isinstance(collection, list) or not collection:
        return []

    latest = collection[-1]
    if not isinstance(latest, dict):
        return []

    findings: list[Finding] = []

    published = str(latest.get("published") or "").strip()
    if published and published.upper() != "NA":
        findings.append(Finding(
            kind="preprint_published",
            severity="informational",
            notice_key=published.lower(),
            notice_url=_doi_url(published),
            label="Published in a journal",
            notice_doi=published,
            notice_date=str(latest.get("date") or "") or None,
            detail=(
                "This preprint has since appeared as a journal article. Cite "
                "the published version where you can — it is the one that was "
                "peer reviewed."
            ),
            provider="biorxiv",
        ))

    try:
        latest_version = int(latest.get("version"))
    except (TypeError, ValueError):
        latest_version = None

    if (
        latest_version is not None
        and stored_version is not None
        and latest_version > stored_version
    ):
        doi = str(latest.get("doi") or "").strip()
        if doi:
            findings.append(Finding(
                kind="new_version",
                severity="informational",
                notice_key=f"v{latest_version}",
                notice_url=f"{_doi_url(doi)}v{latest_version}",
                label=f"Version {latest_version} posted",
                notice_doi=doi,
                notice_date=str(latest.get("date") or "") or None,
                detail=(
                    f"You have version {stored_version}; the preprint server is "
                    f"now on version {latest_version}."
                ),
                provider="biorxiv",
            ))

    return findings


def arxiv_version(external_id: str) -> tuple[str, int | None]:
    """Split an arXiv id into its base and version.

    resmon already stores the versioned form (``2604.12345v1``) because the
    arXiv client keeps the id exactly as the Atom feed gives it, so the version
    a user actually holds is on disk and needs no extra request to learn.
    """
    text = (external_id or "").strip()
    match = _ARXIV_VERSION_RE.match(text)
    if not match:
        return text, None
    try:
        return match.group("base"), int(match.group("version"))
    except (TypeError, ValueError):  # pragma: no cover - regex guarantees digits
        return text, None


def findings_from_arxiv(
    atom_text: str, *, base_id: str, stored_version: int | None,
) -> list[Finding]:
    """Compare the version resmon holds against the one arXiv now serves."""
    if stored_version is None or not atom_text:
        return []
    ids = re.findall(r"<id>\s*(http[^<]*abs/[^<\s]+)\s*</id>", atom_text)
    for raw in ids:
        candidate = raw.rsplit("/", 1)[-1]
        candidate_base, candidate_version = arxiv_version(candidate)
        if candidate_base != base_id or candidate_version is None:
            continue
        if candidate_version > stored_version:
            return [Finding(
                kind="new_version",
                severity="informational",
                notice_key=f"v{candidate_version}",
                notice_url=f"https://arxiv.org/abs/{base_id}v{candidate_version}",
                label=f"Version {candidate_version} posted",
                notice_date=None,
                detail=(
                    f"You have version {stored_version}; arXiv is now serving "
                    f"version {candidate_version}."
                ),
                provider="arxiv",
            )]
    return []


# ---------------------------------------------------------------------------
# Providers — the only part that touches the network
# ---------------------------------------------------------------------------


class CrossrefLifecycleProvider:
    """Fetches ``updated-by`` for a batch of DOIs."""

    name = "crossref"

    def __init__(self, mailto: str | None = None):
        self._mailto = mailto or _CROSSREF_MAILTO

    def fetch(self, dois: list[str]) -> dict[str, dict]:
        """Return ``{lowercased doi: work}`` for whichever DOIs Crossref knows.

        Crossref lowercases DOIs in its responses, and DOIs are
        case-insensitive by specification, so the mapping back to documents is
        keyed on the lowered form. Matching on the stored casing silently
        matched nothing for any publisher that uses capitals — Elsevier's
        ``10.1016/S0140-6736(97)11096-0`` among them.
        """
        if not dois:
            return {}
        response = safe_request(
            "GET", _CROSSREF_URL,
            rate_limiter=_CROSSREF_LIMITER,
            params={
                "filter": ",".join(f"doi:{doi}" for doi in dois),
                "rows": len(dois),
                "mailto": self._mailto,
            },
            headers={"User-Agent": f"resmon (mailto:{self._mailto})"},
        )
        body = response.json()
        items = ((body or {}).get("message") or {}).get("items") or []
        out: dict[str, dict] = {}
        for item in items:
            doi = (item.get("DOI") or "").strip().lower()
            if doi:
                out[doi] = item
        return out


class BiorxivLifecycleProvider:
    """Fetches a preprint's version list and journal link."""

    name = "biorxiv"

    def fetch(self, doi: str, server: str = "biorxiv") -> dict:
        response = safe_request(
            "GET", f"{_BIORXIV_URL}/{server}/{doi}",
            rate_limiter=_BIORXIV_LIMITER,
        )
        return response.json()


class ArxivLifecycleProvider:
    """Fetches the current version arXiv serves for an id."""

    name = "arxiv"

    def fetch(self, base_id: str) -> str:
        response = safe_request(
            "GET", "https://export.arxiv.org/api/query",
            params={"id_list": base_id, "max_results": 1},
        )
        return response.text


# ---------------------------------------------------------------------------
# Orchestration
# ---------------------------------------------------------------------------


def documents_due(
    conn: sqlite3.Connection, limit: int = DEFAULT_LIMIT,
) -> list[dict]:
    """The papers most worth checking next.

    Never-checked papers first, then the least recently checked, and only those
    past the re-check interval. That ordering makes the bounded check resumable:
    running it repeatedly walks the corpus rather than re-reading its head.
    """
    rows = conn.execute(
        """
        SELECT d.id, d.doi, d.source_repository, d.external_id, d.title,
               c.checked_at AS checked_at
        FROM documents d
        LEFT JOIN document_lifecycle_checks c ON c.document_id = d.id
        WHERE c.checked_at IS NULL
           OR julianday('now') - julianday(c.checked_at) >= ?
        ORDER BY (c.checked_at IS NOT NULL), c.checked_at ASC, d.id ASC
        LIMIT ?
        """,
        (RECHECK_AFTER_DAYS, int(limit)),
    ).fetchall()
    return [dict(row) for row in rows]


def _outcome_for(
    document: dict,
    crossref_works: dict[str, dict],
    biorxiv: BiorxivLifecycleProvider | None,
    arxiv: ArxivLifecycleProvider | None,
) -> CheckOutcome:
    document_id = document["id"]
    doi = (document.get("doi") or "").strip()
    source = (document.get("source_repository") or "").strip()
    external_id = (document.get("external_id") or "").strip()

    providers: list[str] = []
    findings: list[Finding] = []

    if doi:
        providers.append("crossref")
        work = crossref_works.get(doi.lower())
        if work:
            findings.extend(findings_from_crossref(work))

    if source == "biorxiv" and doi and biorxiv is not None:
        providers.append("biorxiv")
        try:
            detail = biorxiv.fetch(doi)
            _, stored_version = _biorxiv_stored_version(external_id)
            findings.extend(
                findings_from_biorxiv(detail, stored_version=stored_version)
            )
        except Exception as exc:
            return CheckOutcome(document_id, "error", providers, findings, str(exc))

    if source == "arxiv" and external_id and arxiv is not None:
        base_id, stored_version = arxiv_version(external_id)
        if stored_version is not None:
            providers.append("arxiv")
            try:
                atom = arxiv.fetch(base_id)
                findings.extend(findings_from_arxiv(
                    atom, base_id=base_id, stored_version=stored_version,
                ))
            except Exception as exc:
                return CheckOutcome(
                    document_id, "error", providers, findings, str(exc))

    if not providers:
        # Honest rather than optimistic: a paper with no DOI and no supported
        # identifier was not cleared, it was never looked at.
        return CheckOutcome(document_id, "no_identifier", [], [])

    return CheckOutcome(document_id, "ok", providers, findings)


def _biorxiv_stored_version(external_id: str) -> tuple[str, int | None]:
    """bioRxiv ids sometimes carry a ``vN`` suffix, sometimes not."""
    base, version = arxiv_version(external_id)
    return base, version


def check_corpus(
    conn: sqlite3.Connection,
    *,
    limit: int = DEFAULT_LIMIT,
    crossref: CrossrefLifecycleProvider | None = None,
    biorxiv: BiorxivLifecycleProvider | None = None,
    arxiv: ArxivLifecycleProvider | None = None,
) -> dict:
    """Check a bounded slice of the corpus and record what came back.

    Providers are injectable so the suite can exercise the whole path against
    recorded payloads without touching the network. In production the defaults
    are used.
    """
    crossref = crossref or CrossrefLifecycleProvider()
    biorxiv = biorxiv or BiorxivLifecycleProvider()
    arxiv = arxiv or ArxivLifecycleProvider()

    documents = documents_due(conn, limit=limit)
    if not documents:
        return _summary(conn, checked=0, remaining=_remaining(conn), errors=[])

    # One Crossref round trip per batch of DOIs rather than one per paper.
    crossref_works: dict[str, dict] = {}
    # DOIs whose batch never came back. Crossref not *knowing* a DOI and
    # Crossref not *answering* are completely different facts, and only the
    # second is a reason to leave a paper unchecked. Conflating them was a
    # livelock: a corpus holding one DOI Crossref has no record of would have
    # re-selected the same papers on every run and never advanced.
    unanswered: set[str] = set()
    dois = [d["doi"].strip() for d in documents if (d.get("doi") or "").strip()]
    for start in range(0, len(dois), CROSSREF_BATCH):
        batch = dois[start:start + CROSSREF_BATCH]
        try:
            crossref_works.update(crossref.fetch(batch))
        except Exception as exc:
            # A failed batch must not be recorded as "checked, nothing found".
            # Leaving those papers unchecked is what keeps the coverage figure
            # honest on the next run.
            logger.warning("Crossref lifecycle batch failed: %s", exc)
            unanswered.update(doi.lower() for doi in batch)

    checked = 0
    errors: list[dict] = []
    for document in documents:
        doi = (document.get("doi") or "").strip()
        if doi and doi.lower() in unanswered and not _other_provider(document):
            # Nothing was learned about this paper. Not cleared — skipped.
            continue

        outcome = _outcome_for(document, crossref_works, biorxiv, arxiv)
        for finding in outcome.findings:
            try:
                record_lifecycle_finding(
                    conn, outcome.document_id,
                    kind=finding.kind,
                    severity=finding.severity,
                    notice_key=finding.notice_key,
                    notice_url=finding.notice_url,
                    label=finding.label,
                    notice_doi=finding.notice_doi,
                    notice_date=finding.notice_date,
                    detail=finding.detail,
                    provider=finding.provider,
                    provider_source=finding.provider_source,
                )
            except MissingNoticeError:
                # Loud in the log, absent from the interface. Never asserted.
                logger.exception(
                    "Refused a lifecycle finding with no notice: doc=%s kind=%s",
                    outcome.document_id, finding.kind,
                )
        record_lifecycle_check(
            conn, outcome.document_id,
            status=outcome.status,
            providers=outcome.providers,
            error_message=outcome.error_message,
        )
        checked += 1
        if outcome.status == "error":
            errors.append({
                "document_id": outcome.document_id,
                "title": document.get("title"),
                "error": outcome.error_message,
            })

    return _summary(conn, checked=checked, remaining=_remaining(conn), errors=errors)


def _other_provider(document: dict) -> bool:
    return (document.get("source_repository") or "") in ("arxiv", "biorxiv")


def _remaining(conn: sqlite3.Connection) -> int:
    return conn.execute(
        """
        SELECT COUNT(*)
        FROM documents d
        LEFT JOIN document_lifecycle_checks c ON c.document_id = d.id
        WHERE c.checked_at IS NULL
           OR julianday('now') - julianday(c.checked_at) >= ?
        """,
        (RECHECK_AFTER_DAYS,),
    ).fetchone()[0]


def _summary(conn: sqlite3.Connection, *, checked: int, remaining: int, errors: list) -> dict:
    return {
        "checked_now": checked,
        "remaining": remaining,
        "errors": errors,
        "checked_at": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        **report(conn),
    }


# ---------------------------------------------------------------------------
# Reporting
# ---------------------------------------------------------------------------


def report(conn: sqlite3.Connection) -> dict:
    """Everything recorded so far, plus how much of the corpus it covers.

    Coverage is not decoration. "No retractions found" means nothing unless the
    reader can also see that only a fifth of the corpus has been checked, and
    that a further slice carries no identifier that could be checked at all.
    """
    rows = conn.execute(
        """
        SELECT l.*, d.title AS title, d.doi AS document_doi,
               d.source_repository AS source_repository, d.url AS document_url,
               d.publication_date AS publication_date
        FROM document_lifecycle l
        JOIN documents d ON d.id = l.document_id
        ORDER BY CASE l.severity
                     WHEN 'critical' THEN 0
                     WHEN 'caution' THEN 1
                     ELSE 2
                 END,
                 l.notice_date DESC,
                 l.document_id
        """
    ).fetchall()
    findings = [dict(row) for row in rows]

    totals = conn.execute(
        """
        SELECT
            (SELECT COUNT(*) FROM documents),
            (SELECT COUNT(*) FROM document_lifecycle_checks WHERE status = 'ok'),
            (SELECT COUNT(*) FROM document_lifecycle_checks
                WHERE status = 'no_identifier'),
            (SELECT COUNT(*) FROM document_lifecycle_checks WHERE status = 'error'),
            (SELECT MAX(checked_at) FROM document_lifecycle_checks)
        """
    ).fetchone()
    corpus, ok, no_identifier, errored, last_checked = totals

    counts = {"critical": 0, "caution": 0, "informational": 0}
    for finding in findings:
        counts[finding["severity"]] = counts.get(finding["severity"], 0) + 1

    return {
        "findings": findings,
        "counts": counts,
        "coverage": {
            "corpus": corpus or 0,
            "checked": ok or 0,
            "no_identifier": no_identifier or 0,
            "errored": errored or 0,
            "unchecked": max(0, (corpus or 0) - (ok or 0) - (no_identifier or 0)
                             - (errored or 0)),
            "last_checked_at": last_checked,
            "recheck_after_days": RECHECK_AFTER_DAYS,
        },
        # False until something has actually been looked at. An empty findings
        # list on an unchecked corpus is not "nothing has been retracted".
        "sufficient": bool(ok),
    }
