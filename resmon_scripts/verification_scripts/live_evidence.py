"""Current-run source evidence and crash-tolerant live-suite reporting."""

from __future__ import annotations

import hashlib
import json
import math
import os
import platform
import re
import sys
import time
import uuid
from dataclasses import asdict, dataclass, replace
from datetime import date, datetime, timedelta, timezone
from pathlib import Path
from typing import Iterable


_SECRET = re.compile(
    r"(?i)([\"']?(?:authorization|api[_-]?key|token|password)[\"']?"
    r"\s*[:=]\s*[\"']?)(?:Bearer\s+)?([^\"'\s,}&]+)"
)
_BEARER = re.compile(r"(?i)\bBearer\s+[A-Za-z0-9._~+/=-]+")
_RESULTS = {"answered_nonempty", "answered_empty", "raised", "unfinished"}
_OUTCOME_KEYS = (
    "attempts", "failures", "last_call_failed", "last_status", "last_detail",
    "retained_cooldown_status", "explicit_reason", "explicit_detail",
)
_SOURCE_CONTRACT_KEYS = {
    "module", "markexpr", "catalog_sources", "expected_nodeids",
    "excluded_keyed_nodeids", "query_ids",
}
_SOURCE_ROW_KEYS = {
    "schema", "source_session_id", "candidate_sha", "source_selection_id",
    "slug", "nodeid", "query_id", "started_at", "finished_at", "result",
    "returned_count", "outcome", "error_type", "error_message",
}
_SOURCE_AGGREGATE_KEYS = {
    "schema", "source_session_id", "candidate_sha", "source_selection_id",
    "nodeid", "source_contract", "expected", "excluded_keyed", "answered",
    "partial", "minimum", "record_count", "query_set_hash", "threshold_pass",
}
_SOURCE_BINDING_KEYS = {"evidence_run_id", "suite_selection_id", "checkout_sha"}
_KEYED_SOURCE_SLUGS = {"core", "nasa_ads", "springer"}
_AUTHOR_NODE = re.compile(
    r"(?:^|/)resmon_scripts/verification_scripts/test_entity_search_live\.py::"
    r"test_a_real_source_answers_a_real_author_query\[([^]\r\n]+)\]$"
)
_AGGREGATE_NODE = re.compile(
    r"(?:^|/)resmon_scripts/verification_scripts/test_entity_search_live\.py::"
    r"test_at_least_most_sources_answered$"
)


# ---------------------------------------------------------------------------
# Provider-outage quarantine
# ---------------------------------------------------------------------------
#
# One provider's outage should not decide whether the rest of the live suite
# counts. In September 2026, OAPEN's server answered HTTP 500 intermittently,
# to GitHub runners and to a workstation alike. The weekly job failed 1 case
# of 92 for three days on a fault no client change could fix. The answer is
# not to skip that case, and not to retry it until it passes. It is a small,
# dated list of cases whose failure is excused only when it has a named shape.
#
# A quarantined case still runs and still asserts. It is excused only when
# the assertion failed *and* the source outcome the case recorded shows its
# search ended on a failed call whose failure history contains the entry's
# signature. Any other failure counts: a different status, a timeout alone,
# a wrong shape, out-of-window dates, a crash. A pass is reported as a
# recovery, so the entry gets lifted. An expired entry is ignored, and the
# case fails as it would without one.
#
# The guards are part of the policy, not decoration. At most two entries,
# because a quarantine that can grow stops meaning anything. At most thirty
# days, because an outage that lasts longer is a source question, not a test
# question. Admission needs the excused status captured from two vantage
# points, so resmon's own network cannot be mistaken for the provider's.

QUARANTINE_FILE = Path(__file__).resolve().with_name("live_quarantine.json")
QUARANTINE_SCHEMA = "resmon.live-quarantine.v1"
QUARANTINE_MAX_ENTRIES = 2
QUARANTINE_MAX_DAYS = 30
QUARANTINE_DISPOSITIONS = ("excused", "unmatched", "recovered", "expired")
# The categories ``api_base.SearchOutcome`` writes, and no other words.
_FAILURE_TOKEN = re.compile(
    r"(?:http_[1-5][0-9]{2}|rate_limited|timeout|connect|request_error|operation_deadline)"
)
_SOURCE_SLUG = re.compile(r"[a-z][a-z0-9_]{0,63}")
_QUARANTINE_ENTRY_KEYS = {
    "nodeid", "source", "signature", "first_observed", "expires", "reason", "evidence",
}
_OBSERVATION_KEYS = {"vantage", "observed", "status", "reference"}
_HISTORY_LIMIT = 8


def utc_today() -> date:
    return datetime.now(timezone.utc).date()


@dataclass(frozen=True)
class QuarantineEntry:
    nodeid: str
    source: str
    signature: str
    first_observed: date
    expires: date
    reason: str
    evidence: tuple[dict, ...]

    def active(self, today: date) -> bool:
        return today <= self.expires

    def label(self) -> str:
        return (
            f"{self.source}, since {self.first_observed.isoformat()}, "
            f"{self.signature}, expires {self.expires.isoformat()}"
        )

    def record(self, today: date) -> dict:
        """The allowlisted facts a run's evidence keeps about this entry."""
        return {
            "nodeid": self.nodeid, "source": self.source,
            "signature": self.signature,
            "first_observed": self.first_observed.isoformat(),
            "expires": self.expires.isoformat(), "active": self.active(today),
        }


def _iso_date(value: object, field: str) -> date:
    if not isinstance(value, str) or not re.fullmatch(r"\d{4}-\d{2}-\d{2}", value):
        raise AssertionError(f"quarantine {field} must be an ISO date")
    try:
        return date.fromisoformat(value)
    except ValueError:
        raise AssertionError(f"quarantine {field} must be an ISO date") from None


def _quarantine_entry(value: object) -> QuarantineEntry:
    if not isinstance(value, dict) or set(value) != _QUARANTINE_ENTRY_KEYS:
        raise AssertionError("quarantine entry must have the exact structured schema")
    nodeid = _bounded_string(value["nodeid"], "quarantine node id", 4096)
    if "::" not in nodeid:
        raise AssertionError("quarantine node id must name a test")
    source = value["source"]
    if not isinstance(source, str) or not _SOURCE_SLUG.fullmatch(source):
        raise AssertionError("quarantine source must be a catalog slug")
    signature = value["signature"]
    if not isinstance(signature, str) or not _FAILURE_TOKEN.fullmatch(signature):
        raise AssertionError("quarantine signature must be one failure category")
    first = _iso_date(value["first_observed"], "first_observed")
    expires = _iso_date(value["expires"], "expires")
    if expires < first:
        raise AssertionError("quarantine expires before it was first observed")
    if expires > first + timedelta(days=QUARANTINE_MAX_DAYS):
        raise AssertionError(
            f"quarantine may last at most {QUARANTINE_MAX_DAYS} days after first observed")
    reason = _bounded_string(value["reason"], "quarantine reason", 512)
    evidence = value["evidence"]
    if not isinstance(evidence, list) or not 2 <= len(evidence) <= 8:
        raise AssertionError("quarantine evidence must list two to eight observations")
    observations = []
    for item in evidence:
        if not isinstance(item, dict) or set(item) != _OBSERVATION_KEYS:
            raise AssertionError("quarantine observation must have the exact structured schema")
        status = item["status"]
        if not isinstance(status, str) or not _FAILURE_TOKEN.fullmatch(status):
            raise AssertionError("quarantine observation status must be one failure category")
        observations.append({
            "vantage": _bounded_string(item["vantage"], "quarantine vantage", 128),
            "observed": _iso_date(item["observed"], "observed").isoformat(),
            "status": status,
            "reference": _bounded_string(item["reference"], "quarantine reference", 256),
        })
    if min(item["observed"] for item in observations) != first.isoformat():
        raise AssertionError("quarantine first_observed must be its earliest observation")
    vantages = {item["vantage"] for item in observations if item["status"] == signature}
    if len(vantages) < 2:
        raise AssertionError(
            "quarantine admission needs the excused status captured from two vantage points")
    return QuarantineEntry(
        nodeid=nodeid, source=source, signature=signature, first_observed=first,
        expires=expires, reason=reason, evidence=tuple(observations),
    )


def quarantine_path() -> Path:
    """The policy file. The override exists for the suite's own proofs."""
    override = os.environ.get("RESMON_LIVE_QUARANTINE_FILE")
    return Path(override) if override else QUARANTINE_FILE


def load_quarantine(path: Path | None = None) -> list[QuarantineEntry]:
    """Read and validate the quarantine list. An invalid file raises.

    Node ids are checked against a real collection by ``test_live_suite.py``.
    This loader does not collect, because the reporter calls it from inside a
    pytest run.
    """
    value = json.loads((path or quarantine_path()).read_text(encoding="utf-8"))
    if not isinstance(value, dict) or set(value) != {"schema", "policy", "entries"}:
        raise AssertionError("quarantine file must have the exact structured schema")
    if value["schema"] != QUARANTINE_SCHEMA:
        raise AssertionError("unknown quarantine schema")
    _bounded_string(value["policy"], "quarantine policy", 1024)
    entries = value["entries"]
    if not isinstance(entries, list):
        raise AssertionError("quarantine entries must be a list")
    if len(entries) > QUARANTINE_MAX_ENTRIES:
        raise AssertionError(
            f"at most {QUARANTINE_MAX_ENTRIES} live cases may be quarantined at once")
    parsed = [_quarantine_entry(entry) for entry in entries]
    if len({entry.nodeid for entry in parsed}) != len(parsed):
        raise AssertionError("a live case may be quarantined only once")
    return parsed


def record_label(record: dict) -> str:
    return (
        f"{record['source']}, since {record['first_observed']}, "
        f"{record['signature']}, expires {record['expires']}"
    )


def asserted_line(total: int, records: Iterable[dict]) -> str:
    """"N of M asserted; Q quarantined (...)". M is always a collection's size."""
    active = [record for record in records if record["active"]]
    line = f"{total - len(active)} of {total} asserted; {len(active)} quarantined"
    if active:
        line += " (" + "; ".join(record_label(record) for record in active) + ")"
    return line


def quarantine_line(nodeids: Iterable[str], entries: Iterable[QuarantineEntry], today: date) -> str:
    """The denominator sentence for a collection. Entries outside it do not count."""
    selected = set(nodeids)
    return asserted_line(
        len(selected),
        [entry.record(today) for entry in entries if entry.nodeid in selected],
    )


def _canonical_history(history: object, omitted: object) -> dict:
    if (
        not isinstance(history, list) or len(history) > _HISTORY_LIMIT
        or not all(isinstance(item, str) and _FAILURE_TOKEN.fullmatch(item) for item in history)
    ):
        raise AssertionError("invalid source failure history")
    if not isinstance(omitted, int) or isinstance(omitted, bool) or omitted < 0:
        raise AssertionError("invalid source failure history omission count")
    return {"failure_history": list(history), "failure_history_omitted": omitted}


def source_outcome_property(source: str, snapshot: dict) -> dict:
    """What a live case records about its source, for the quarantine and the evidence.

    It carries the same allowlisted outcome facts as a source-ledger row, plus
    the failure history. Every value is a count, a status or a category word.
    None of it is text from the reply or the URL.
    """
    if not isinstance(source, str) or not _SOURCE_SLUG.fullmatch(source):
        raise AssertionError("source outcome needs a catalog slug")
    safe = _canonical_outcome(_safe_outcome(snapshot))
    history = _canonical_history(
        snapshot.get("failure_history", []), snapshot.get("failure_history_omitted", 0))
    return {"source": source, **safe, **history}


def _canonical_source_outcome(value: object) -> dict:
    keys = {"source", *_OUTCOME_KEYS, "failure_history", "failure_history_omitted"}
    if not isinstance(value, dict) or set(value) != keys:
        raise AssertionError("source outcome property must have the exact structured schema")
    source = value["source"]
    if not isinstance(source, str) or not _SOURCE_SLUG.fullmatch(source):
        raise AssertionError("invalid source outcome slug")
    base = _canonical_outcome({key: value[key] for key in _OUTCOME_KEYS})
    history = _canonical_history(value["failure_history"], value["failure_history_omitted"])
    return {"source": source, **base, **history}


def quarantine_disposition(
    entry: QuarantineEntry,
    today: date,
    *,
    call_outcome: str,
    assertion_failure: bool,
    recorded: list[object],
) -> tuple[str | None, list[str]]:
    """Decide what one quarantined case's call means. Returns (disposition, history).

    ``recorded`` is every ``source_outcome`` property the case recorded. The
    history is reported whatever the disposition. A skipped call has no
    disposition, because nothing was asserted.
    """
    outcomes = []
    for value in recorded:
        try:
            outcomes.append(_canonical_source_outcome(value))
        except AssertionError:
            outcomes.append(None)
    mine = [value for value in outcomes if value is not None and value["source"] == entry.source]
    history = mine[0]["failure_history"] if len(mine) == 1 else []
    if call_outcome not in {"passed", "failed"}:
        return None, history
    if not entry.active(today):
        return "expired", history
    if call_outcome == "passed":
        return "recovered", history
    excused = (
        assertion_failure
        and len(outcomes) == 1
        and len(mine) == 1
        and mine[0]["last_call_failed"] is True
        and entry.signature in mine[0]["failure_history"]
    )
    return ("excused" if excused else "unmatched"), history


def disposition_sentence(nodeid: str, disposition: str, record: dict, history: list[str]) -> str:
    """One line for the terminal and the run summary. The words carry the rule."""
    label = record_label(record)
    observed = " -> ".join(history) if history else "none recorded"
    if disposition == "excused":
        return (
            f"QUARANTINED {nodeid}: failed with the excused signature "
            f"(observed {observed}); not counted as a failure. Quarantine: {label}."
        )
    if disposition == "unmatched":
        return (
            f"NOT EXCUSED {nodeid}: failed, but not with the excused signature "
            f"(observed {observed}); counted as a failure. Quarantine: {label}."
        )
    if disposition == "recovered":
        return (
            f"RECOVERED {nodeid}: passed while quarantined ({label}); "
            "lift the quarantine."
        )
    if disposition == "expired":
        return (
            f"EXPIRED {nodeid}: the quarantine ({label}) has expired and was "
            f"ignored; the case counted as normal (observed {observed})."
        )
    raise ValueError(f"no sentence for quarantine disposition {disposition!r}")


def _canonical_quarantine_record(value: object) -> dict:
    keys = {"nodeid", "source", "signature", "first_observed", "expires", "active"}
    if not isinstance(value, dict) or set(value) != keys:
        raise AssertionError("quarantine record must have the exact structured schema")
    if not isinstance(value["active"], bool):
        raise AssertionError("invalid quarantine record activity")
    if not isinstance(value["source"], str) or not _SOURCE_SLUG.fullmatch(value["source"]):
        raise AssertionError("invalid quarantine record source")
    if not isinstance(value["signature"], str) or not _FAILURE_TOKEN.fullmatch(value["signature"]):
        raise AssertionError("invalid quarantine record signature")
    return {
        "nodeid": _bounded_string(value["nodeid"], "quarantine node id", 4096),
        "source": value["source"], "signature": value["signature"],
        "first_observed": _iso_date(value["first_observed"], "first_observed").isoformat(),
        "expires": _iso_date(value["expires"], "expires").isoformat(),
        "active": value["active"],
    }


def _canonical_quarantine_property(value: object) -> dict:
    if not isinstance(value, dict) or set(value) != {"entry", "disposition", "history"}:
        raise AssertionError("quarantine property must have the exact structured schema")
    if value["disposition"] not in QUARANTINE_DISPOSITIONS:
        raise AssertionError("invalid quarantine disposition")
    history = _canonical_history(value["history"], 0)["failure_history"]
    return {
        "entry": _canonical_quarantine_record(value["entry"]),
        "disposition": value["disposition"], "history": history,
    }


def stable_hash(value: object) -> str:
    encoded = json.dumps(value, sort_keys=True, separators=(",", ":")).encode()
    return hashlib.sha256(encoded).hexdigest()


def _now() -> float:
    return time.time()


def _safe_text(value: object, limit: int = 512) -> str:
    text = _SECRET.sub(r"\1[REDACTED]", str(value))
    text = _BEARER.sub("Bearer [REDACTED]", text)
    return text[:limit]


def _safe_outcome(value: object) -> dict | None:
    """Keep only bounded source-outcome facts used by the live contract."""
    if value is None:
        return None
    if not isinstance(value, dict):
        raise AssertionError("source outcome must be a structured snapshot")
    clean = {key: value.get(key) for key in _OUTCOME_KEYS}
    for key in ("attempts", "failures"):
        if not isinstance(clean[key], int) or isinstance(clean[key], bool) or clean[key] < 0:
            raise AssertionError(f"invalid source outcome {key}")
    if not isinstance(clean["last_call_failed"], bool):
        raise AssertionError("invalid source outcome last_call_failed")
    for key in ("last_status", "retained_cooldown_status"):
        if clean[key] is not None and (
            not isinstance(clean[key], int) or isinstance(clean[key], bool)
            or not 100 <= clean[key] <= 599
        ):
            raise AssertionError(f"invalid source outcome {key}")
    for key in ("last_detail", "explicit_reason"):
        if clean[key] is not None:
            clean[key] = _safe_text(clean[key], 128)
    detail = clean["explicit_detail"]
    clean["explicit_detail"] = (
        {str(k)[:64]: _safe_text(v, 128) for k, v in detail.items()}
        if isinstance(detail, dict) else {}
    )
    return clean



def _bounded_string(value: object, field: str, limit: int, *, nullable: bool = False) -> str | None:
    if value is None and nullable:
        return None
    if not isinstance(value, str) or not value or len(value) > limit or "\n" in value or "\r" in value:
        raise AssertionError(f"invalid {field}")
    return _safe_text(value, limit)


def _canonical_outcome(value: object) -> dict | None:
    if value is None:
        return None
    if not isinstance(value, dict) or set(value) != set(_OUTCOME_KEYS):
        raise AssertionError("source outcome must have the exact structured schema")
    clean: dict[str, object] = {}
    for key in ("attempts", "failures"):
        item = value[key]
        if not isinstance(item, int) or isinstance(item, bool) or item < 0:
            raise AssertionError(f"invalid source outcome {key}")
        clean[key] = item
    if clean["failures"] > clean["attempts"]:
        raise AssertionError("source outcome failures exceed attempts")
    if not isinstance(value["last_call_failed"], bool):
        raise AssertionError("invalid source outcome last_call_failed")
    clean["last_call_failed"] = value["last_call_failed"]
    for key in ("last_status", "retained_cooldown_status"):
        item = value[key]
        if item is not None and (
            not isinstance(item, int) or isinstance(item, bool) or not 100 <= item <= 599
        ):
            raise AssertionError(f"invalid source outcome {key}")
        clean[key] = item
    for key in ("last_detail", "explicit_reason"):
        item = value[key]
        if item is not None and not isinstance(item, str):
            raise AssertionError(f"invalid source outcome {key}")
        clean[key] = _safe_text(item, 128) if item is not None else None
    detail = value["explicit_detail"]
    if not isinstance(detail, dict) or len(detail) > 16:
        raise AssertionError("invalid source outcome explicit_detail")
    cleaned_detail = {}
    for key, item in detail.items():
        if not isinstance(key, str) or not key or len(key) > 64 or not isinstance(item, str) or len(item) > 128:
            raise AssertionError("invalid source outcome explicit_detail entry")
        cleaned_detail[_safe_text(key, 64)] = _safe_text(item, 128)
    clean["explicit_detail"] = cleaned_detail
    if clean["last_call_failed"] and clean["failures"] == 0:
        raise AssertionError("failed last source call requires a failure count")
    return clean


def _string_list(value: object, field: str, *, limit: int = 128) -> list[str]:
    if not isinstance(value, list) or len(value) != len(set(value)):
        raise AssertionError(f"invalid {field}")
    clean = [_bounded_string(item, field, limit) for item in value]
    if clean != sorted(clean):
        raise AssertionError(f"{field} must be sorted")
    return clean


def _string_map(value: object, field: str, *, value_limit: int) -> dict[str, str]:
    if not isinstance(value, dict):
        raise AssertionError(f"invalid {field}")
    clean = {}
    for key, item in value.items():
        clean[_bounded_string(key, f"{field} key", 128)] = _bounded_string(item, field, value_limit)
    if list(clean) != sorted(clean):
        raise AssertionError(f"{field} must be sorted")
    return clean


def _canonical_source_contract(value: object) -> dict:
    if not isinstance(value, dict) or set(value) != _SOURCE_CONTRACT_KEYS:
        raise AssertionError("source contract must have the exact structured schema")
    contract = {
        "module": _bounded_string(value["module"], "source module", 128),
        "markexpr": _safe_text(value["markexpr"], 512) if isinstance(value["markexpr"], str) else None,
        "catalog_sources": _string_list(value["catalog_sources"], "catalog sources"),
        "expected_nodeids": _string_map(value["expected_nodeids"], "expected node ids", value_limit=4096),
        "excluded_keyed_nodeids": _string_map(value["excluded_keyed_nodeids"], "excluded keyed node ids", value_limit=4096),
        "query_ids": _string_map(value["query_ids"], "query ids", value_limit=128),
    }
    if contract["markexpr"] is None:
        raise AssertionError("invalid source mark expression")
    expected = set(contract["expected_nodeids"])
    excluded = set(contract["excluded_keyed_nodeids"])
    if expected & excluded or expected | excluded != set(contract["catalog_sources"]):
        raise AssertionError("source contract does not partition the catalog")
    if excluded != _KEYED_SOURCE_SLUGS & set(contract["catalog_sources"]):
        raise AssertionError("source contract keyed exclusions do not match the canonical keyed sources")
    if expected != set(contract["query_ids"]):
        raise AssertionError("source contract query map does not match expected sources")
    return contract


def _canonical_source_row(value: object) -> dict:
    if not isinstance(value, dict) or set(value) != _SOURCE_ROW_KEYS:
        raise AssertionError("source ledger row must have the exact structured schema")
    if value["schema"] != "resmon.source-ledger-row.v1":
        raise AssertionError("invalid source ledger row schema")
    started = value["started_at"]
    finished = value["finished_at"]
    if any(not isinstance(item, (int, float)) or isinstance(item, bool) or not math.isfinite(item) for item in (started, finished)):
        raise AssertionError("invalid source ledger timestamps")
    if finished < started:
        raise AssertionError("source ledger finish precedes start")
    returned = value["returned_count"]
    CurrentRunSourceLedger._validate_result(value["result"], returned, finished=True)
    error_type = value["error_type"]
    error_message = value["error_message"]
    if value["result"] == "raised":
        error_type = _bounded_string(error_type, "source error type", 128)
        if not isinstance(error_message, str) or len(error_message) > 512:
            raise AssertionError("invalid source error message")
        error_message = _safe_text(error_message, 512)
    elif error_type is not None or error_message is not None:
        raise AssertionError("answered source row cannot carry error fields")
    return {
        "schema": value["schema"],
        "source_session_id": _bounded_string(value["source_session_id"], "source session id", 128),
        "candidate_sha": _bounded_string(value["candidate_sha"], "candidate sha", 128),
        "source_selection_id": _bounded_string(value["source_selection_id"], "source selection id", 128),
        "slug": _bounded_string(value["slug"], "source slug", 128),
        "nodeid": _bounded_string(value["nodeid"], "source node id", 4096),
        "query_id": _bounded_string(value["query_id"], "source query id", 128),
        "started_at": float(started), "finished_at": float(finished),
        "result": value["result"], "returned_count": returned,
        "outcome": _canonical_outcome(value["outcome"]),
        "error_type": error_type, "error_message": error_message,
    }


def _canonical_source_aggregate(value: object) -> dict:
    if not isinstance(value, dict) or set(value) != _SOURCE_AGGREGATE_KEYS:
        raise AssertionError("source aggregate must have the exact structured schema")
    if value["schema"] != "resmon.source-ledger-aggregate.v1":
        raise AssertionError("invalid source aggregate schema")
    contract = _canonical_source_contract(value["source_contract"])
    expected = _string_list(value["expected"], "expected sources")
    excluded = _string_list(value["excluded_keyed"], "excluded keyed sources")
    answered = _string_list(value["answered"], "answered sources")
    partial = _string_list(value["partial"], "partial sources")
    if expected != sorted(contract["expected_nodeids"]) or excluded != sorted(contract["excluded_keyed_nodeids"]):
        raise AssertionError("aggregate denominator does not match source contract")
    if not set(partial) <= set(answered) <= set(expected):
        raise AssertionError("aggregate source classifications are inconsistent")
    minimum = value["minimum"]
    record_count = value["record_count"]
    if any(
        not isinstance(item, int) or isinstance(item, bool)
        for item in (minimum, record_count)
    ):
        raise AssertionError("aggregate denominator counts must be integers")
    if minimum != max(1, len(expected) // 2) or record_count != len(expected):
        raise AssertionError("aggregate denominator counts are inconsistent")
    query_map = {slug: {"query_id": contract["query_ids"][slug], "nodeid": contract["expected_nodeids"][slug]} for slug in expected}
    if value["query_set_hash"] != stable_hash(query_map):
        raise AssertionError("aggregate query mapping hash mismatch")
    if value["source_selection_id"] != stable_hash(contract):
        raise AssertionError("aggregate source selection mismatch")
    if not isinstance(value["threshold_pass"], bool) or value["threshold_pass"] != (len(answered) >= minimum):
        raise AssertionError("aggregate threshold disposition mismatch")
    return {
        "schema": value["schema"],
        "source_session_id": _bounded_string(value["source_session_id"], "source session id", 128),
        "candidate_sha": _bounded_string(value["candidate_sha"], "candidate sha", 128),
        "source_selection_id": value["source_selection_id"],
        "nodeid": _bounded_string(value["nodeid"], "aggregate node id", 4096),
        "source_contract": contract, "expected": expected, "excluded_keyed": excluded,
        "answered": answered, "partial": partial, "minimum": minimum,
        "record_count": record_count, "query_set_hash": value["query_set_hash"],
        "threshold_pass": value["threshold_pass"],
    }


def _bind_source_property(value: dict, *, run_id: str, suite_selection_id: str, checkout_sha: str) -> dict:
    return {**value, "evidence_run_id": run_id, "suite_selection_id": suite_selection_id, "checkout_sha": checkout_sha}


def _validate_bound_source_property(value: object, *, aggregate: bool, run_id: str, suite_selection_id: str, checkout_sha: str) -> dict:
    base_keys = _SOURCE_AGGREGATE_KEYS if aggregate else _SOURCE_ROW_KEYS
    if not isinstance(value, dict) or set(value) != base_keys | _SOURCE_BINDING_KEYS:
        raise AssertionError("bound source property has the wrong schema")
    for key, expected in (("evidence_run_id", run_id), ("suite_selection_id", suite_selection_id), ("checkout_sha", checkout_sha)):
        if value[key] != expected:
            raise AssertionError(f"bound source property has wrong {key}")
    base = {key: value[key] for key in base_keys}
    canonical = _canonical_source_aggregate(base) if aggregate else _canonical_source_row(base)
    return _bind_source_property(canonical, run_id=run_id, suite_selection_id=suite_selection_id, checkout_sha=checkout_sha)


def _outcome_is_partial(outcome: dict | None) -> bool:
    if not outcome:
        return False
    return bool(
        outcome.get("explicit_reason") == "parse_failure"
        or (outcome.get("failures") and outcome.get("last_call_failed"))
        or outcome.get("retained_cooldown_status")
    )


@dataclass(frozen=True)
class SourceQueryEvidence:
    session_id: str
    candidate_head: str
    selection_id: str
    slug: str
    nodeid: str
    query_id: str
    started_at: float
    finished_at: float | None = None
    result: str = "unfinished"
    returned_count: int | None = None
    outcome: dict | None = None
    error_type: str | None = None
    error_message: str | None = None


class CurrentRunSourceLedger:
    """Write-once in-memory evidence for existing per-source live cases."""

    def __init__(
        self,
        expected: Iterable[str],
        *,
        candidate_head: str,
        selection_id: str,
        query_ids: dict[str, str],
        nodeids: dict[str, str],
        session_id: str | None = None,
        source_contract: dict | None = None,
    ) -> None:
        supplied = tuple(expected)
        if len(supplied) != len(set(supplied)):
            raise ValueError("duplicate expected source")
        self.expected = tuple(sorted(supplied))
        if (
            not self.expected
            or set(self.expected) != set(query_ids)
            or set(self.expected) != set(nodeids)
        ):
            raise ValueError(
                "expected sources, query identities, and node ids must match exactly"
            )
        self.candidate_head = candidate_head
        self.query_ids = dict(sorted(query_ids.items()))
        self.nodeids = dict(sorted(nodeids.items()))
        self.source_contract = _canonical_source_contract(source_contract or {
            "module": "test_entity_search_live.py", "markexpr": "",
            "catalog_sources": list(self.expected),
            "expected_nodeids": self.nodeids, "excluded_keyed_nodeids": {},
            "query_ids": self.query_ids,
        })
        computed_selection = stable_hash(self.source_contract)
        if selection_id != computed_selection:
            raise ValueError("source selection identity does not match source contract")
        self.selection_id = selection_id
        self.session_id = session_id or uuid.uuid4().hex
        self._records: dict[str, SourceQueryEvidence] = {}

    def start(self, slug: str, *, nodeid: str, query_id: str) -> None:
        if slug not in self.query_ids:
            raise AssertionError(f"unexpected source evidence: {slug}")
        if slug in self._records:
            raise AssertionError(f"duplicate source evidence: {slug}")
        if query_id != self.query_ids[slug]:
            raise AssertionError(f"wrong query identity for {slug}")
        if nodeid != self.nodeids[slug]:
            raise AssertionError(f"wrong source case node id for {slug}")
        self._records[slug] = SourceQueryEvidence(
            session_id=self.session_id,
            candidate_head=self.candidate_head,
            selection_id=self.selection_id,
            slug=slug,
            nodeid=nodeid,
            query_id=query_id,
            started_at=_now(),
        )

    def finish(
        self,
        slug: str,
        *,
        result: str,
        returned_count: int | None,
        outcome: dict | None = None,
        error: Exception | None = None,
    ) -> None:
        self._validate_result(result, returned_count, finished=True)
        record = self._records.get(slug)
        if record is None:
            raise AssertionError(f"source evidence finished without start: {slug}")
        if record.finished_at is not None:
            raise AssertionError(f"duplicate terminal source evidence: {slug}")
        self._records[slug] = replace(
            record,
            finished_at=_now(),
            result=result,
            returned_count=returned_count,
            outcome=_safe_outcome(outcome),
            error_type=type(error).__name__ if error else None,
            error_message=_safe_text(error) if error else None,
        )

    @staticmethod
    def _validate_result(
        result: str,
        returned_count: int | None,
        *,
        finished: bool,
    ) -> None:
        if result not in _RESULTS:
            raise AssertionError(f"invalid source result: {result}")
        if returned_count is not None and (
            not isinstance(returned_count, int)
            or isinstance(returned_count, bool)
            or returned_count < 0
        ):
            raise AssertionError("returned count must be a non-negative integer")
        if result == "answered_nonempty" and (
            returned_count is None or returned_count <= 0
        ):
            raise AssertionError("answered_nonempty requires a positive count")
        if result == "answered_empty" and returned_count != 0:
            raise AssertionError("answered_empty requires a zero count")
        if result == "raised" and returned_count is not None:
            raise AssertionError("raised evidence cannot claim returned records")
        if finished and result == "unfinished":
            raise AssertionError("a terminal record cannot be unfinished")

    def accept(self, record: SourceQueryEvidence) -> None:
        """Accept a supplied record for pure stale/duplicate contract tests."""
        safe_outcome = _safe_outcome(record.outcome)
        if safe_outcome != record.outcome:
            record = replace(record, outcome=safe_outcome)
        if record.session_id != self.session_id:
            raise AssertionError(f"stale session evidence for {record.slug}")
        if record.candidate_head != self.candidate_head:
            raise AssertionError(f"wrong candidate head for {record.slug}")
        if record.selection_id != self.selection_id:
            raise AssertionError(f"wrong selection identity for {record.slug}")
        if record.query_id != self.query_ids.get(record.slug):
            raise AssertionError(f"wrong query identity for {record.slug}")
        if record.nodeid != self.nodeids.get(record.slug):
            raise AssertionError(f"wrong source case node id for {record.slug}")
        if record.slug in self._records:
            raise AssertionError(f"duplicate source evidence: {record.slug}")
        if record.finished_at is None:
            if record.result != "unfinished" or record.returned_count is not None:
                raise AssertionError(f"invalid unfinished evidence for {record.slug}")
        else:
            self._validate_result(record.result, record.returned_count, finished=True)
        self._records[record.slug] = record

    def summary(self) -> dict:
        observed = set(self._records)
        expected = set(self.expected)
        missing = sorted(expected - observed)
        extra = sorted(observed - expected)
        unfinished = sorted(
            slug for slug, record in self._records.items()
            if record.finished_at is None or record.result == "unfinished"
        )
        invalid = sorted(
            slug for slug, record in self._records.items()
            if (
                record.session_id != self.session_id
                or record.candidate_head != self.candidate_head
                or record.selection_id != self.selection_id
                or record.query_id != self.query_ids.get(slug)
                or record.nodeid != self.nodeids.get(slug)
                or (
                    record.finished_at is not None
                    and _invalid_result(record.result, record.returned_count)
                )
                or _invalid_outcome(record.outcome)
            )
        )
        if missing or extra or unfinished or invalid:
            raise AssertionError(
                "incomplete current-run source evidence: "
                f"session={self.session_id}, expected={len(self.expected)}, "
                f"observed={sorted(observed)}, missing={missing}, extra={extra}, "
                f"unfinished={unfinished}, invalid={invalid}"
            )
        records = [self._records[slug] for slug in self.expected]
        answered = [record.slug for record in records if record.result == "answered_nonempty"]
        partial = [
            record.slug for record in records
            if record.result == "answered_nonempty" and _outcome_is_partial(record.outcome)
        ]
        minimum = max(1, len(self.expected) // 2)
        return {
            "session_id": self.session_id,
            "candidate_head": self.candidate_head,
            "selection_id": self.selection_id,
            "expected": list(self.expected),
            "answered": answered,
            "partial": partial,
            "minimum": minimum,
            "records": [asdict(record) for record in records],
        }

    def record(self, slug: str) -> dict:
        record = self._records.get(slug)
        if record is None or record.finished_at is None:
            raise AssertionError(f"source evidence is not terminal: {slug}")
        return _canonical_source_row({
            "schema": "resmon.source-ledger-row.v1",
            "source_session_id": record.session_id,
            "candidate_sha": record.candidate_head,
            "source_selection_id": record.selection_id,
            "slug": record.slug, "nodeid": record.nodeid, "query_id": record.query_id,
            "started_at": record.started_at, "finished_at": record.finished_at,
            "result": record.result, "returned_count": record.returned_count,
            "outcome": record.outcome, "error_type": record.error_type,
            "error_message": record.error_message,
        })

    def durable_summary(self, *, nodeid: str) -> dict:
        summary = self.summary()
        query_map = {slug: {"query_id": self.query_ids[slug], "nodeid": self.nodeids[slug]} for slug in self.expected}
        return _canonical_source_aggregate({
            "schema": "resmon.source-ledger-aggregate.v1",
            "source_session_id": self.session_id,
            "candidate_sha": self.candidate_head,
            "source_selection_id": self.selection_id,
            "nodeid": nodeid,
            "source_contract": self.source_contract,
            "expected": summary["expected"],
            "excluded_keyed": sorted(self.source_contract["excluded_keyed_nodeids"]),
            "answered": summary["answered"], "partial": summary["partial"],
            "minimum": summary["minimum"], "record_count": len(summary["records"]),
            "query_set_hash": stable_hash(query_map),
            "threshold_pass": len(summary["answered"]) >= summary["minimum"],
        })

    def assert_threshold(self) -> dict:
        summary = self.summary()
        if len(summary["answered"]) < summary["minimum"]:
            raise AssertionError(
                f"only {len(summary['answered'])} of {len(summary['expected'])} "
                "keyless askable sources answered an author query at all: "
                f"{summary['answered']}. That is broad enough to be resmon rather than the weather."
            )
        return summary


def _invalid_result(result: str, returned_count: int | None) -> bool:
    try:
        CurrentRunSourceLedger._validate_result(
            result, returned_count, finished=True,
        )
    except AssertionError:
        return True
    return False


def _invalid_outcome(outcome: object) -> bool:
    try:
        _canonical_outcome(outcome)
    except AssertionError:
        return True
    return False


class LiveEvidenceWriter:
    """Append-only, flushed JSONL writer containing only allowlisted fields."""

    def __init__(self, root: Path, identity: dict[str, str]) -> None:
        self.root = root
        self.root.mkdir(parents=True, exist_ok=True)
        self.run_id = uuid.uuid4().hex
        self.identity = {key: _safe_text(value, 256) for key, value in identity.items()}
        self.events = self.root / "events.jsonl"
        self.integrity_error = False
        self.selected: list[str] = []
        self._append({"event": "run", "run_id": self.run_id, **self.identity})
        self._write_json(
            self.root / "RUN.json",
            {
                "schema": "resmon.live-evidence.v1",
                "run_id": self.run_id,
                "identity": self.identity,
                "python": platform.python_version(),
                "platform": platform.platform(),
            },
        )

    def _write_json(self, path: Path, value: object) -> None:
        temporary = path.with_suffix(path.suffix + ".tmp")
        temporary.write_text(json.dumps(value, indent=2, sort_keys=True) + "\n")
        temporary.replace(path)

    def _append(self, value: dict) -> None:
        with self.events.open("a", encoding="utf-8") as handle:
            handle.write(json.dumps(value, sort_keys=True) + "\n")
            handle.flush()
            os.fsync(handle.fileno())

    def safe(self, action, *args) -> None:
        try:
            action(*args)
        except Exception as exc:
            self.integrity_error = True
            print(
                f"live evidence reporter error: {type(exc).__name__}: {_safe_text(exc)}",
                file=sys.stderr,
            )

    def collection(
        self, nodeids: Iterable[str], selection: str,
        quarantine: Iterable[dict] = (),
    ) -> None:
        selected = sorted(nodeids)
        if len(selected) != len(set(selected)):
            raise AssertionError("duplicate selected live node id")
        if not all(
            isinstance(nodeid, str)
            and 0 < len(nodeid) <= 4096
            and "\n" not in nodeid
            and "\r" not in nodeid
            for nodeid in selected
        ):
            raise AssertionError("invalid selected node id")
        self.selected = selected
        records = sorted(
            (_canonical_quarantine_record(record) for record in quarantine),
            key=lambda record: record["nodeid"],
        )
        if any(record["nodeid"] not in selected for record in records):
            raise AssertionError("quarantine record names an unselected node")
        value = {
            "schema": "resmon.live-selection.v1",
            "run_id": self.run_id,
            "selection": _safe_text(selection, 512),
            "selection_id": stable_hash(selected),
            "selected_count": len(selected),
            "nodeids": selected,
            "identity": self.identity,
            "quarantine": records,
        }
        self._write_json(self.root / "SELECTION.json", value)
        self._append({"event": "collection", **value})

    def start(self, nodeid: str) -> None:
        self._append({"event": "start", "run_id": self.run_id, "nodeid": nodeid, "at": _now()})

    def report(self, report) -> None:
        properties = {}
        structured_names: set[str] = set()
        suite_selection_id = stable_hash(self.selected)
        checkout_sha = self.identity.get("checkout_sha") or ""
        candidate_sha = self.identity.get("candidate_sha") or ""
        for name, value in getattr(report, "user_properties", []):
            if name == "returned" and isinstance(value, (int, float)):
                properties["returned"] = value
            elif name in {"source_outcome", "quarantine"}:
                # Call-only facts. A property recorded during the call is
                # mirrored onto the teardown report by pytest; that copy is
                # not a second observation.
                if report.when != "call":
                    continue
                if name in structured_names:
                    raise AssertionError(f"duplicate structured report property: {name}")
                structured_names.add(name)
                properties[name] = (
                    _canonical_source_outcome(value) if name == "source_outcome"
                    else _canonical_quarantine_property(value)
                )
            elif name in {"source_ledger", "source_aggregate"}:
                if name in structured_names:
                    raise AssertionError(f"duplicate structured report property: {name}")
                structured_names.add(name)
                canonical = (
                    _canonical_source_row(value) if name == "source_ledger"
                    else _canonical_source_aggregate(value)
                )
                if report.when == "setup":
                    raise AssertionError("structured source property is forbidden during setup")
                if canonical["nodeid"] != report.nodeid:
                    raise AssertionError("structured source property belongs to another node")
                if canonical["candidate_sha"] != candidate_sha:
                    raise AssertionError("structured source property has wrong candidate")
                if report.when == "teardown":
                    continue
                if report.when != "call":
                    raise AssertionError("structured source property is call-only")
                properties[name] = _bind_source_property(
                    canonical, run_id=self.run_id,
                    suite_selection_id=suite_selection_id,
                    checkout_sha=checkout_sha,
                )
        longrepr = getattr(report, "longreprtext", "") or ""
        message = ""
        crash = getattr(getattr(report, "longrepr", None), "reprcrash", None)
        if crash is not None:
            message = _safe_text(getattr(crash, "message", ""))
        elif longrepr:
            message = _safe_text(next((line for line in reversed(longrepr.splitlines()) if line.strip()), ""))
        location = getattr(report, "location", None)
        safe_location = None
        if isinstance(location, tuple) and len(location) == 3:
            safe_location = [str(location[0]), int(location[1]), _safe_text(location[2], 256)]
        self._append({
            "event": "report",
            "run_id": self.run_id,
            "nodeid": report.nodeid,
            "phase": report.when,
            "outcome": report.outcome,
            "duration": float(report.duration),
            "location": safe_location,
            "message": message,
            "failure_hash": hashlib.sha256(longrepr.encode()).hexdigest() if longrepr else None,
            "properties": properties,
            "at": _now(),
        })

    def finish(self, exitstatus: int) -> dict:
        reduction = reduce_evidence(self.root, require_finish=False)
        self._append({
            "event": "finish",
            "run_id": self.run_id,
            "candidate_sha": self.identity.get("candidate_sha"),
            "checkout_sha": self.identity.get("checkout_sha"),
            "selection_id": stable_hash(self.selected),
            "exitstatus": int(exitstatus),
            "integrity_error": self.integrity_error,
            "unfinished": reduction["unfinished"],
            "at": _now(),
        })
        return reduction


def _read_events(path: Path, *, strict: bool) -> list[dict]:
    events = []
    for index, line in enumerate(path.read_text(encoding="utf-8").splitlines(), 1):
        try:
            value = json.loads(line)
        except json.JSONDecodeError:
            if strict:
                raise AssertionError(f"malformed evidence line {index}") from None
            break
        if not isinstance(value, dict):
            raise AssertionError(f"non-object evidence line {index}")
        events.append(value)
    return events



def _reduce_source_ledger(
    run: dict, selection: dict, reports: dict[str, list[dict]],
    *, unfinished: list[str], require_finish: bool,
) -> dict | None:
    run_id = run["run_id"]
    suite_selection_id = selection["selection_id"]
    checkout_sha = run["identity"].get("checkout_sha") or ""
    candidate_sha = run["identity"].get("candidate_sha") or ""
    rows = []
    aggregates = []
    selected_authors = {}
    aggregate_nodes = []
    for nodeid in selection["nodeids"]:
        match = _AUTHOR_NODE.search(nodeid)
        if match:
            slug = match.group(1)
            if slug in selected_authors:
                raise AssertionError(f"duplicate selected author source: {slug}")
            selected_authors[slug] = nodeid
        if _AGGREGATE_NODE.search(nodeid):
            aggregate_nodes.append(nodeid)
    for nodeid, items in reports.items():
        for item in items:
            props = item.get("properties") or {}
            structured = {"source_ledger", "source_aggregate"} & set(props)
            if structured and item.get("phase") != "call":
                raise AssertionError("structured source evidence is call-only")
            if "source_ledger" in props:
                rows.append((nodeid, item, _validate_bound_source_property(
                    props["source_ledger"], aggregate=False, run_id=run_id,
                    suite_selection_id=suite_selection_id, checkout_sha=checkout_sha,
                )))
            if "source_aggregate" in props:
                aggregates.append((nodeid, item, _validate_bound_source_property(
                    props["source_aggregate"], aggregate=True, run_id=run_id,
                    suite_selection_id=suite_selection_id, checkout_sha=checkout_sha,
                )))
    applicable = bool(selected_authors or aggregate_nodes)
    if not applicable:
        if rows or aggregates:
            raise AssertionError("structured source evidence has no selected source suite")
        return None
    if require_finish and not rows and not aggregates:
        raise AssertionError("selected source ledger suite has no structured evidence")
    if require_finish and len(aggregate_nodes) != 1:
        raise AssertionError(f"expected one selected source aggregate, found {len(aggregate_nodes)}")
    if len(aggregates) > 1 or (require_finish and len(aggregates) != 1):
        raise AssertionError(f"expected one source aggregate, found {len(aggregates)}")
    aggregate_node = aggregate_report = aggregate = contract = None
    derived_excluded = sorted(set(selected_authors) & _KEYED_SOURCE_SLUGS)
    derived_expected = sorted(set(selected_authors) - set(derived_excluded))
    expected_nodes = {slug: selected_authors[slug] for slug in derived_expected}
    excluded_nodes = {slug: selected_authors[slug] for slug in derived_excluded}
    if aggregates:
        aggregate_node, aggregate_report, aggregate = aggregates[0]
        if (
            not _AGGREGATE_NODE.search(aggregate_node)
            or aggregate["nodeid"] != aggregate_node
            or aggregate_node not in aggregate_nodes
        ):
            raise AssertionError("source aggregate is attached to the wrong node")
        contract = aggregate["source_contract"]
        expected_nodes = contract["expected_nodeids"]
        excluded_nodes = contract["excluded_keyed_nodeids"]
        if {**expected_nodes, **excluded_nodes} != dict(sorted(selected_authors.items())):
            raise AssertionError("source contract does not match selected author cases")
        if aggregate["candidate_sha"] != candidate_sha:
            raise AssertionError("source aggregate candidate does not match run")
        if aggregate["source_selection_id"] != stable_hash(contract):
            raise AssertionError("source aggregate selection is stale")
    unfinished_nodes = set(unfinished)
    by_slug = {}
    for nodeid, report, row in rows:
        slug = row["slug"]
        if slug in by_slug:
            raise AssertionError(f"duplicate source ledger row: {slug}")
        if row["nodeid"] != nodeid or expected_nodes.get(slug) != nodeid:
            raise AssertionError(f"source ledger row has wrong node: {slug}")
        if row["candidate_sha"] != candidate_sha:
            raise AssertionError(f"source ledger row has wrong candidate: {slug}")
        if contract is not None and row["query_id"] != contract["query_ids"].get(slug):
            raise AssertionError(f"source ledger row has wrong query: {slug}")
        if aggregate is not None:
            for key in ("source_session_id", "candidate_sha", "source_selection_id"):
                if row[key] != aggregate[key]:
                    raise AssertionError(f"source ledger row has stale {key}: {slug}")
        elif by_slug:
            prior = next(iter(by_slug.values()))[0]
            for key in ("source_session_id", "candidate_sha", "source_selection_id"):
                if row[key] != prior[key]:
                    raise AssertionError(f"source ledger rows disagree on {key}: {slug}")
        report_outcome = report.get("outcome")
        safe_outcome = (
            report_outcome
            if report_outcome in {"passed", "failed", "skipped"}
            else None
        )
        if row["result"] == "raised" and safe_outcome not in {None, "failed"}:
            raise AssertionError(f"raised source row must have a failed call: {slug}")
        by_slug[slug] = (row, safe_outcome)
    answered = sorted(slug for slug, (row, _) in by_slug.items() if row["result"] == "answered_nonempty")
    partial = sorted(slug for slug, (row, _) in by_slug.items() if row["result"] == "answered_nonempty" and _outcome_is_partial(row["outcome"]))
    expected = sorted(expected_nodes)
    missing = sorted(set(expected) - set(by_slug))
    sources = [
        {"slug": slug, "result": by_slug[slug][0]["result"],
         "returned_count": by_slug[slug][0]["returned_count"],
         "partial": slug in partial, "source_case_outcome": by_slug[slug][1]}
        for slug in expected if slug in by_slug
    ]
    aggregate_outcome = None
    if aggregate_report is not None and aggregate_report.get("outcome") in {
        "passed", "failed", "skipped",
    }:
        aggregate_outcome = aggregate_report["outcome"]
    if aggregate is not None and aggregate_outcome is not None:
        expected_aggregate_outcome = "passed" if aggregate["threshold_pass"] else "failed"
        if aggregate_outcome != expected_aggregate_outcome:
            raise AssertionError("source aggregate call outcome contradicts threshold")
    relevant_nodes = set(selected_authors.values()) | set(aggregate_nodes)
    incomplete_lifecycle = sorted(relevant_nodes & unfinished_nodes)
    complete = (
        len(aggregate_nodes) == 1
        and aggregate is not None
        and not missing
        and sorted(by_slug) == aggregate["expected"]
        and not incomplete_lifecycle
    )
    if not complete:
        if require_finish:
            raise AssertionError(
                "incomplete source ledger: "
                f"observed={sorted(by_slug)}, missing={missing}, "
                f"aggregate_present={aggregate is not None}"
            )
        return {
            "complete": False, "acceptance_available": False,
            "source_session_id": (
                aggregate["source_session_id"] if aggregate is not None
                else (next(iter(by_slug.values()))[0]["source_session_id"] if by_slug else None)
            ),
            "source_selection_id": (
                aggregate["source_selection_id"] if aggregate is not None
                else (next(iter(by_slug.values()))[0]["source_selection_id"] if by_slug else None)
            ),
            "suite_selection_id": suite_selection_id,
            "candidate_sha": candidate_sha, "checkout_sha": checkout_sha,
            "expected": expected, "excluded_keyed": sorted(excluded_nodes),
            "minimum": max(1, len(expected) // 2),
            "observed": sorted(by_slug), "missing": missing,
            "incomplete_lifecycle": incomplete_lifecycle,
            "answered": answered, "partial": partial,
            "aggregate_present": aggregate is not None,
            "threshold_pass": None,
            "aggregate_case_outcome": aggregate_outcome,
            "sources": sources,
        }
    if answered != aggregate["answered"] or partial != aggregate["partial"]:
        raise AssertionError("source aggregate classifications do not match rows")
    if aggregate["threshold_pass"] != (len(answered) >= aggregate["minimum"]):
        raise AssertionError("source aggregate threshold does not match rows")
    return {
        "complete": True, "acceptance_available": True,
        "source_session_id": aggregate["source_session_id"],
        "source_selection_id": aggregate["source_selection_id"],
        "suite_selection_id": suite_selection_id,
        "candidate_sha": candidate_sha, "checkout_sha": checkout_sha,
        "expected": aggregate["expected"], "excluded_keyed": aggregate["excluded_keyed"],
        "minimum": aggregate["minimum"], "answered": answered, "partial": partial,
        "observed": sorted(by_slug), "missing": [], "aggregate_present": True,
        "incomplete_lifecycle": [],
        "threshold_pass": aggregate["threshold_pass"],
        "aggregate_case_outcome": aggregate_outcome,
        "sources": sources,
    }


# Which pytest outcome each disposition must have. An excused failure is an
# xfail, so pytest reports it as skipped; anything else would mean the
# reporter and the exit status disagree about what happened.
_DISPOSITION_OUTCOMES = {
    "excused": {"skipped"}, "unmatched": {"failed"},
    "recovered": {"passed"}, "expired": {"passed", "failed"},
}


def _reduce_quarantine(selection: dict, reports: dict[str, list[dict]]) -> dict:
    """Cross-check the quarantine records against what each case reported."""
    records = [_canonical_quarantine_record(item) for item in selection.get("quarantine", [])]
    by_node = {record["nodeid"]: record for record in records}
    if len(by_node) != len(records) or not set(by_node) <= set(selection["nodeids"]):
        raise AssertionError("invalid quarantine records in selection")
    dispositions: dict[str, dict] = {}
    source_outcomes: dict[str, dict] = {}
    for nodeid, items in reports.items():
        for item in items:
            props = item.get("properties") or {}
            if ({"source_outcome", "quarantine"} & set(props)) and item.get("phase") != "call":
                raise AssertionError("source outcome and quarantine evidence are call-only")
            if "source_outcome" in props:
                source_outcomes[nodeid] = _canonical_source_outcome(props["source_outcome"])
            if "quarantine" in props:
                value = _canonical_quarantine_property(props["quarantine"])
                record = by_node.get(nodeid)
                if record is None or value["entry"] != record:
                    raise AssertionError("quarantine disposition has no matching selected entry")
                expected_active = value["disposition"] != "expired"
                if record["active"] != expected_active:
                    raise AssertionError("quarantine disposition contradicts the entry's expiry")
                dispositions[nodeid] = value
    # Checked against the call phase alone: the quarantine speaks only about
    # the call, and a setup or teardown failure is never excused by it.
    calls = {
        nodeid: item.get("outcome")
        for nodeid, items in reports.items()
        for item in items if item.get("phase") == "call"
    }
    for nodeid, value in dispositions.items():
        if calls.get(nodeid) not in _DISPOSITION_OUTCOMES[value["disposition"]]:
            raise AssertionError("quarantine disposition contradicts the call outcome")
    for nodeid, record in by_node.items():
        if record["active"] and calls.get(nodeid) == "failed" and nodeid not in dispositions:
            raise AssertionError("a failed quarantined call must say its failure was not excused")
    return {"entries": records, "dispositions": dispositions, "source_outcomes": source_outcomes}


def reduce_evidence(root: Path, *, require_finish: bool = True) -> dict:
    run = json.loads((root / "RUN.json").read_text())
    selection = json.loads((root / "SELECTION.json").read_text())
    events = _read_events(root / "events.jsonl", strict=require_finish)
    run_id = run["run_id"]
    if selection["run_id"] != run_id or selection["selection_id"] != stable_hash(selection["nodeids"]):
        raise AssertionError("run or selection identity mismatch")
    run_events: list[dict] = []
    collection_events: list[dict] = []
    starts: dict[str, int] = {}
    reports: dict[str, list[dict]] = {}
    finishes = []
    for event in events:
        if event.get("run_id") != run_id:
            raise AssertionError("stale or mixed run evidence")
        kind = event.get("event")
        nodeid = event.get("nodeid")
        if kind == "run":
            run_events.append(event)
        elif kind == "collection":
            collection_events.append(event)
            if (
                event.get("selection_id") != selection["selection_id"]
                or event.get("nodeids") != selection["nodeids"]
                or event.get("selection") != selection["selection"]
                or event.get("identity") != selection.get("identity")
                or event.get("quarantine", []) != selection.get("quarantine", [])
            ):
                raise AssertionError("collection event does not match selection receipt")
        elif kind == "start":
            starts[nodeid] = starts.get(nodeid, 0) + 1
        elif kind == "report":
            reports.setdefault(nodeid, []).append(event)
        elif kind == "finish":
            finishes.append(event)
        else:
            raise AssertionError(f"unknown evidence event: {kind!r}")
    selected = selection["nodeids"]
    if (
        not isinstance(selected, list)
        or len(selected) != len(set(selected))
        or selection.get("selected_count") != len(selected)
        or selection.get("identity") != run.get("identity")
        or run.get("identity", {}).get("selection") != selection.get("selection")
    ):
        raise AssertionError("invalid or mismatched selection receipt")
    extra = sorted((set(starts) | set(reports)) - set(selected))
    missing_starts = sorted(nodeid for nodeid in selected if starts.get(nodeid, 0) == 0)
    duplicate_starts = sorted(nodeid for nodeid in selected if starts.get(nodeid, 0) > 1)
    duplicate_phases = sorted(
        f"{nodeid}:{phase}"
        for nodeid, items in reports.items()
        for phase in {item.get("phase") for item in items}
        if sum(item.get("phase") == phase for item in items) != 1
    )
    outcomes = {}
    unfinished = []
    for nodeid in selected:
        if nodeid in missing_starts:
            unfinished.append(nodeid)
            continue
        phases = reports.get(nodeid, [])
        invalid_report = any(
            item.get("phase") not in {"setup", "call", "teardown"}
            or item.get("outcome") not in {"passed", "failed", "skipped"}
            for item in phases
        )
        by_phase = {item.get("phase"): item.get("outcome") for item in phases}
        setup = by_phase.get("setup")
        call = by_phase.get("call")
        teardown = by_phase.get("teardown")
        terminal_setup = setup in {"failed", "skipped"}
        lifecycle_complete = (
            not invalid_report
            and setup is not None
            and teardown is not None
            and ((setup == "passed" and call is not None) or (terminal_setup and call is None))
        )
        if not lifecycle_complete:
            unfinished.append(nodeid)
            continue
        if "failed" in by_phase.values():
            outcomes[nodeid] = "failed"
        elif "skipped" in by_phase.values():
            outcomes[nodeid] = "skipped"
        else:
            outcomes[nodeid] = "passed"
    if len(run_events) != 1 or len(collection_events) != 1:
        raise AssertionError(
            f"expected one run and collection event, found {len(run_events)} and "
            f"{len(collection_events)}"
        )
    expected_run_event = {"event": "run", "run_id": run_id, **run["identity"]}
    if run_events[0] != expected_run_event:
        raise AssertionError("run event does not match run receipt")
    if extra or duplicate_starts or duplicate_phases or (require_finish and missing_starts):
        raise AssertionError(
            "invalid node evidence: "
            f"extra={extra}, missing_starts={missing_starts}, "
            f"duplicate_starts={duplicate_starts}, "
            f"duplicate_phases={duplicate_phases}"
        )
    if require_finish and len(finishes) != 1:
        raise AssertionError(f"expected one finish event, found {len(finishes)}")
    source_ledger = _reduce_source_ledger(
        run, selection, reports, unfinished=unfinished,
        require_finish=require_finish,
    )
    quarantine = _reduce_quarantine(selection, reports)
    if len(finishes) == 1 and (
        finishes[0].get("candidate_sha") != run["identity"].get("candidate_sha")
        or finishes[0].get("checkout_sha") != run["identity"].get("checkout_sha")
        or finishes[0].get("selection_id") != selection["selection_id"]
    ):
        raise AssertionError("finish event identity mismatch")
    return {
        "run_id": run_id,
        "selected": len(selected),
        "outcomes": outcomes,
        "unfinished": unfinished,
        "finish": finishes[0] if len(finishes) == 1 else None,
        "source_ledger": source_ledger,
        "quarantine": quarantine,
    }


def validate_evidence(root: Path) -> dict:
    reduction = reduce_evidence(root, require_finish=True)
    finish = reduction["finish"]
    if reduction["unfinished"]:
        raise AssertionError(f"unfinished selected nodes: {reduction['unfinished']}")
    if finish["integrity_error"]:
        raise AssertionError("reporter integrity error")
    if finish.get("unfinished") != reduction["unfinished"]:
        raise AssertionError("finish event unfinished set mismatch")
    if not isinstance(finish.get("exitstatus"), int):
        raise AssertionError("finish event exit status is invalid")
    if finish["exitstatus"] == 0 and "failed" in reduction["outcomes"].values():
        raise AssertionError("zero pytest status contradicts failed test evidence")
    return reduction
