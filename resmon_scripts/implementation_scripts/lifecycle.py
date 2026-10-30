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
"we inferred it from the metadata" is not a defense.

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
from typing import Optional, Sequence

from .api_base import RateLimiter, safe_request
from .database import (
    BIORXIV_PUBLISHED_DETAIL,
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

# Module-level like the two above and like every source client's, so each is
# read when a request is made and a test can point the check at a loopback
# server, which is how the suite exercises the whole path without the network.
_ARXIV_URL = "https://export.arxiv.org/api/query"

# The names a reader sees for each service, in the run's account of what did
# not answer.
SERVICE_NAMES = {"crossref": "Crossref", "biorxiv": "bioRxiv", "arxiv": "arXiv"}

# DOIs go out in batches. Crossref's ``filter=doi:A,doi:B`` returns them
# together, which turns a thousand-paper corpus from a thousand requests into
# twenty-five. Kept modest so the request URL stays well inside any proxy's
# limit and one failure costs little.
CROSSREF_BATCH = 40

# arXiv accepts a comma-separated ``id_list``, so version checks batch exactly
# like Crossref DOIs do. Without this a corpus of five thousand arXiv papers was
# five thousand separate requests, which is what made a full pass impractical
# rather than merely slow.
ARXIV_BATCH = 50

# Default ceiling on one run of the check. Raised from the 200 this feature was
# first written with, which never shipped: at 200 a
# 15,000-paper corpus needed seventy-nine presses of the button, which is not a
# bounded operation, it is an unusable one. With Crossref and arXiv both batching
# a thousand papers is a handful of requests, and ``run_until_done`` exists for
# users who simply want the whole corpus covered.
DEFAULT_LIMIT = 1000

# How long a check stays fresh. Retractions are not urgent to the minute, and
# re-asking Crossref about the same paper daily is discourteous.
RECHECK_AFTER_DAYS = 30

# Crossref update types → how strongly resmon is willing to speak.
#
# ``critical`` is reserved for the paper being withdrawn from the record.
# ``caution`` is for a registered concern that is explicitly not a retraction.
# Everything else is informational: a correction is normal scholarly upkeep, not
# a warning, and coloring it like one would train users to ignore the color.
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
            detail=BIORXIV_PUBLISHED_DETAIL,
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


class ServiceDidNotAnswer(RuntimeError):
    """A service replied with something other than an answer."""


def _answered(response, service: str):
    """The response, when it is an answer at all.

    ``safe_request`` hands a non-2xx response back rather than raising, which
    is right for a search client and wrong here. An arXiv error page holds no
    entries, so a 503 from arXiv read as "no newer version" and every paper in
    the batch was recorded as checked. Crossref's and bioRxiv's error pages
    were refused only because they happened not to parse as the JSON expected;
    a JSON error body with no ``items`` would have read as "Crossref knows none
    of these DOIs". The status decides now, not the body: a service that did
    not answer is a reason to leave the paper unchecked, never a clean result.
    """
    if not 200 <= response.status_code < 300:
        raise ServiceDidNotAnswer(
            f"{SERVICE_NAMES.get(service, service)} answered HTTP "
            f"{response.status_code}")
    return response


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
        body = _answered(response, self.name).json()
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
        return _answered(response, self.name).json()


class ArxivLifecycleProvider:
    """Fetches the current version arXiv serves, for one id or many."""

    name = "arxiv"

    def fetch(self, base_id: str) -> str:
        return self.fetch_many([base_id])

    def fetch_many(self, base_ids: list[str]) -> str:
        """One request for up to ``ARXIV_BATCH`` ids.

        The Atom feed comes back with one ``<entry>`` per id, and
        ``findings_from_arxiv`` already matches entries against the id it was
        asked about, so the batched response is parsed exactly like a single one.
        """
        if not base_ids:
            return ""
        response = safe_request(
            "GET", _ARXIV_URL,
            params={
                "id_list": ",".join(base_ids),
                "max_results": len(base_ids),
            },
        )
        return _answered(response, self.name).text


# ---------------------------------------------------------------------------
# Orchestration
# ---------------------------------------------------------------------------


def documents_due(
    conn: sqlite3.Connection, limit: int = DEFAULT_LIMIT,
    document_ids: Optional[Sequence[int]] = None,
) -> list[dict]:
    """The papers most worth checking next.

    Never-checked papers first, then the least recently checked, and only those
    past the re-check interval. That ordering makes the bounded check resumable:
    running it repeatedly walks the corpus rather than re-reading its head.

    ``document_ids`` narrows the same selection to a named set — 2.1's
    ``retractions`` watch mode checks the papers matched to one profile rather
    than the whole corpus. It is a *restriction* and never a widening: a paper
    in the set that is not due is still not checked, so a watch routine firing
    daily does not re-ask Crossref about the same paper every morning. An empty
    set selects nothing, which is why the caller must distinguish "this profile
    has no papers" from "this profile's papers are all up to date" — see
    ``check_documents``.
    """
    if document_ids is not None:
        ids = [int(i) for i in document_ids]
        if not ids:
            return []
        placeholders = ",".join("?" for _ in ids)
        rows = conn.execute(
            f"""
            SELECT d.id, d.doi, d.source_repository, d.external_id, d.title,
                   c.checked_at AS checked_at
            FROM documents d
            LEFT JOIN document_lifecycle_checks c ON c.document_id = d.id
            WHERE d.id IN ({placeholders})
              AND (c.checked_at IS NULL
                   OR julianday('now') - julianday(c.checked_at) >= ?)
            ORDER BY (c.checked_at IS NOT NULL), c.checked_at ASC, d.id ASC
            LIMIT ?
            """,
            (*ids, RECHECK_AFTER_DAYS, int(limit)),
        ).fetchall()
        return [dict(row) for row in rows]

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
    arxiv_feeds: dict[str, str],
    biorxiv: BiorxivLifecycleProvider | None,
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

    if source == "arxiv" and external_id:
        base_id, stored_version = arxiv_version(external_id)
        if stored_version is not None and base_id in arxiv_feeds:
            providers.append("arxiv")
            findings.extend(findings_from_arxiv(
                arxiv_feeds[base_id], base_id=base_id,
                stored_version=stored_version,
            ))

    if not providers:
        # Honest rather than optimistic: a paper with no DOI and no supported
        # identifier was not cleared, it was never looked at.
        return CheckOutcome(document_id, "no_identifier", [], [])

    return CheckOutcome(document_id, "ok", providers, findings)


def _biorxiv_stored_version(external_id: str) -> tuple[str, int | None]:
    """bioRxiv ids sometimes carry a ``vN`` suffix, sometimes not."""
    base, version = arxiv_version(external_id)
    return base, version


@dataclass
class _Pass:
    """What one bounded slice did, and what it could not do."""

    checked: int = 0
    errors: list[dict] = field(default_factory=list)
    #: Papers recorded as checked, whatever the outcome.
    recorded: set[int] = field(default_factory=set)
    #: How each recorded check ended. ``checked`` counts all three, and only
    #: an ``ok`` one looked at anything: a paper with no identifier was
    #: recorded without a request, and an ``error`` one was not answered.
    outcomes: dict[str, int] = field(
        default_factory=lambda: {"ok": 0, "no_identifier": 0, "error": 0})
    #: Service -> the papers left unchecked because it did not answer.
    unanswered: dict[str, set[int]] = field(default_factory=dict)
    #: Service -> what it said, or what happened, instead of answering.
    reasons: dict[str, str] = field(default_factory=dict)
    #: Papers never asked about because the check was told to stop.
    not_asked: set[int] = field(default_factory=set)
    stopped: bool = False

    def merge(self, other: "_Pass") -> None:
        self.checked += other.checked
        self.errors.extend(other.errors)
        self.recorded |= other.recorded
        for status, n in other.outcomes.items():
            self.outcomes[status] = self.outcomes.get(status, 0) + n
        for service, ids in other.unanswered.items():
            self.unanswered.setdefault(service, set()).update(ids)
        self.reasons.update(other.reasons)
        self.not_asked |= other.not_asked
        self.stopped = self.stopped or other.stopped

    def unanswered_list(self) -> list[dict]:
        """Each service that did not answer, with the papers it left unchecked.

        A paper that failed in one pass and was recorded in a later one is no
        longer counted: it is not unchecked.
        """
        out: list[dict] = []
        for service in sorted(self.unanswered):
            left = self.unanswered[service] - self.recorded
            if left:
                out.append({
                    "service": service,
                    "name": SERVICE_NAMES.get(service, service),
                    "papers": len(left),
                    "reason": self.reasons.get(service),
                })
        return out


def _reason(exc: BaseException) -> str:
    """What a failure says, or what kind of failure it was when it says nothing."""
    return str(exc).strip() or type(exc).__name__


def check_corpus(
    conn: sqlite3.Connection,
    *,
    limit: int = DEFAULT_LIMIT,
    crossref: CrossrefLifecycleProvider | None = None,
    biorxiv: BiorxivLifecycleProvider | None = None,
    arxiv: ArxivLifecycleProvider | None = None,
    run_until_done: bool = False,
    should_stop=None,
) -> dict:
    """Check the corpus and record what came back.

    With ``run_until_done`` the bounded slice repeats until the corpus is
    covered, ``should_stop`` returns true, or a pass makes no progress. Without
    it a single slice runs, exactly as before. ``should_stop`` is asked before
    every request, so a stop takes effect part-way through a pass as well as
    between passes.

    The summary says what could not be done as well as what was: ``unanswered``
    names each service that did not answer, how many papers that left
    unchecked, and why; ``stopped`` and ``not_asked`` say whether the check was
    stopped and how many papers it never asked about as a result.

    Providers are injectable so the suite can exercise the whole path against
    recorded payloads without touching the network. In production the defaults
    are used.
    """
    crossref = crossref or CrossrefLifecycleProvider()
    biorxiv = biorxiv or BiorxivLifecycleProvider()
    arxiv = arxiv or ArxivLifecycleProvider()

    total = _Pass()
    while True:
        one = _check_one_pass(
            conn, limit, crossref, biorxiv, arxiv, should_stop=should_stop,
        )
        total.merge(one)
        if one.stopped:
            break
        # Stop when asked to do one pass, when the corpus is covered, or when a
        # pass made no progress at all -- the last guard is what stops a run
        # spinning forever on papers that cannot be advanced.
        if not run_until_done or one.checked == 0 or _remaining(conn) == 0:
            break
        if should_stop is not None and should_stop():
            total.stopped = True
            break

    return _summary(conn, total)


def check_documents(
    conn: sqlite3.Connection,
    document_ids: Sequence[int],
    *,
    limit: int = DEFAULT_LIMIT,
    crossref: CrossrefLifecycleProvider | None = None,
    biorxiv: BiorxivLifecycleProvider | None = None,
    arxiv: ArxivLifecycleProvider | None = None,
) -> dict:
    """Check a named set of papers, one bounded slice, through the same path.

    2.1's ``retractions`` watch mode. It is deliberately ``check_corpus`` with a
    narrower selection and **no new provider**: the rule that resmon never
    asserts a lifecycle event on its own authority is at its most load-bearing
    when the event is attached to a named person, so the retraction claims a
    watch routine surfaces are exactly the ones ``document_lifecycle`` already
    holds, recorded from a resolvable notice.

    The two numbers a caller needs are separated here rather than left to be
    inferred. ``selected`` is how many of the named papers were *due*;
    ``eligible`` is how many were named at all. Nothing checked because nothing
    was due and nothing checked because the profile has no papers look identical
    in a bare zero, and only one of them means "come back later".
    """
    crossref = crossref or CrossrefLifecycleProvider()
    biorxiv = biorxiv or BiorxivLifecycleProvider()
    arxiv = arxiv or ArxivLifecycleProvider()

    ids = [int(i) for i in document_ids]
    due = documents_due(conn, limit=limit, document_ids=ids)
    one = _check_one_pass(
        conn, limit, crossref, biorxiv, arxiv, document_ids=ids,
    )
    return {
        "checked_now": one.checked,
        "eligible": len(ids),
        "selected": len(due),
        "errors": one.errors,
        "unanswered": one.unanswered_list(),
        "checked_at": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
    }


def _check_one_pass(
    conn: sqlite3.Connection,
    limit: int,
    crossref,
    biorxiv,
    arxiv,
    document_ids: Optional[Sequence[int]] = None,
    should_stop=None,
) -> _Pass:
    """One bounded slice: select, fetch in batches, record.

    **A paper is recorded as checked only when every service due to be asked
    about it answered.** A paper with a DOI needs Crossref, which is where
    retractions come from; an arXiv paper held at a version needs arXiv. If
    either did not answer, nothing is recorded and the paper is asked about
    again on the next run. Recording it was worse than useless: an arXiv paper
    with a DOI whose Crossref batch failed was recorded as checked against
    Crossref, and an arXiv paper whose arXiv batch failed as carrying no
    identifier at all, and neither was asked about again for thirty days.
    """
    result = _Pass()
    documents = documents_due(conn, limit=limit, document_ids=document_ids)
    if not documents:
        return result

    def stopping() -> bool:
        # Asked before every request, not only between passes: a pass is up to
        # a thousand papers, and a stop that waited for it to end was a stop in
        # name only.
        if not result.stopped and should_stop is not None and should_stop():
            result.stopped = True
        return result.stopped

    # One Crossref round trip per batch of DOIs rather than one per paper.
    crossref_works: dict[str, dict] = {}
    # The DOIs Crossref answered for, whether or not it knew them. Crossref not
    # *knowing* a DOI and Crossref not *answering* are completely different
    # facts, and only the second is a reason to leave a paper unchecked.
    # Conflating them was a livelock: a corpus holding one DOI Crossref has no
    # record of would have re-selected the same papers on every run and never
    # advanced.
    answered: set[str] = set()
    failed: set[str] = set()
    dois = [d["doi"].strip() for d in documents if (d.get("doi") or "").strip()]
    for start in range(0, len(dois), CROSSREF_BATCH):
        if stopping():
            break
        batch = dois[start:start + CROSSREF_BATCH]
        try:
            crossref_works.update(crossref.fetch(batch))
        except Exception as exc:
            # A failed batch must not be recorded as "checked, nothing found".
            # Leaving those papers unchecked is what keeps the coverage figure
            # honest on the next run.
            logger.warning("Crossref lifecycle batch failed: %s", exc)
            failed.update(doi.lower() for doi in batch)
            result.reasons["crossref"] = _reason(exc)
            continue
        answered.update(doi.lower() for doi in batch)

    # arXiv batches too. One request per fifty ids rather than one per paper is
    # the difference between a full pass being minutes and being hours.
    arxiv_feeds: dict[str, str] = {}
    arxiv_failed: set[str] = set()
    arxiv_ids: list[str] = []
    for d in documents:
        if (d.get("source_repository") or "") != "arxiv":
            continue
        base_id, version = arxiv_version((d.get("external_id") or "").strip())
        if version is not None and base_id:
            arxiv_ids.append(base_id)
    for start in range(0, len(arxiv_ids), ARXIV_BATCH):
        if stopping():
            break
        batch = arxiv_ids[start:start + ARXIV_BATCH]
        try:
            atom = arxiv.fetch_many(batch)
        except Exception as exc:
            # Same rule as a failed Crossref batch: learn nothing, claim nothing.
            logger.warning("arXiv lifecycle batch failed: %s", exc)
            arxiv_failed.update(batch)
            result.reasons["arxiv"] = _reason(exc)
            continue
        for base_id in batch:
            arxiv_feeds[base_id] = atom

    def leave(document_id: int, service: str | None) -> None:
        """Leave a paper unchecked: a service did not answer, or none was asked."""
        if service is None:
            result.not_asked.add(document_id)
        else:
            result.unanswered.setdefault(service, set()).add(document_id)

    for document in documents:
        document_id = int(document["id"])
        doi = (document.get("doi") or "").strip().lower()
        source = (document.get("source_repository") or "").strip()
        if doi and doi not in answered:
            # Nothing was learned about retractions. Not cleared — skipped.
            leave(document_id, "crossref" if doi in failed else None)
            continue
        if source == "arxiv":
            base_id, version = arxiv_version(
                (document.get("external_id") or "").strip())
            if version is not None and base_id and base_id not in arxiv_feeds:
                leave(document_id, "arxiv" if base_id in arxiv_failed else None)
                continue
        if source == "biorxiv" and doi and stopping():
            # Its own request is still to be made, and the check was stopped.
            leave(document_id, None)
            continue

        outcome = _outcome_for(document, crossref_works, arxiv_feeds, biorxiv)
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
        result.checked += 1
        result.recorded.add(document_id)
        result.outcomes[outcome.status] = result.outcomes.get(outcome.status, 0) + 1
        if outcome.status == "error":
            result.errors.append({
                "document_id": outcome.document_id,
                "title": document.get("title"),
                "error": outcome.error_message,
            })

    return result


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


def _summary(conn: sqlite3.Connection, done: _Pass) -> dict:
    return {
        "checked_now": done.checked,
        "outcomes": dict(done.outcomes),
        "remaining": _remaining(conn),
        "errors": done.errors,
        "unanswered": done.unanswered_list(),
        "stopped": done.stopped,
        "not_asked": len(done.not_asked - done.recorded),
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
