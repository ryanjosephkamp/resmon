"""Current-run source evidence and crash-tolerant live-suite reporting."""

from __future__ import annotations

import hashlib
import json
import os
import platform
import re
import sys
import time
import uuid
from dataclasses import asdict, dataclass, replace
from pathlib import Path
from typing import Iterable


_SECRET = re.compile(
    r"(?i)([\"']?(?:authorization|api[_-]?key|token|password)[\"']?"
    r"\s*[:=]\s*[\"']?)(?:Bearer\s+)?([^\"'\s,}&]+)"
)
_BEARER = re.compile(r"(?i)\bBearer\s+[A-Za-z0-9._~+/=-]+")
_RESULTS = {"answered_nonempty", "answered_empty", "raised", "unfinished"}


def stable_hash(value: object) -> str:
    encoded = json.dumps(value, sort_keys=True, separators=(",", ":")).encode()
    return hashlib.sha256(encoded).hexdigest()


def _now() -> float:
    return time.time()


def _safe_text(value: object, limit: int = 512) -> str:
    text = _SECRET.sub(r"\1[REDACTED]", str(value))
    text = _BEARER.sub("Bearer [REDACTED]", text)
    return text[:limit]


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
    outcome: str | None = None
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
        self.selection_id = selection_id
        self.query_ids = dict(query_ids)
        self.nodeids = dict(nodeids)
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
        outcome: str | None = None,
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
            outcome=_safe_text(outcome) if outcome else None,
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
        minimum = max(1, len(self.expected) // 2)
        return {
            "session_id": self.session_id,
            "candidate_head": self.candidate_head,
            "selection_id": self.selection_id,
            "expected": list(self.expected),
            "answered": answered,
            "minimum": minimum,
            "records": [asdict(record) for record in records],
        }

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

    def collection(self, nodeids: Iterable[str], selection: str) -> None:
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
        value = {
            "schema": "resmon.live-selection.v1",
            "run_id": self.run_id,
            "selection": _safe_text(selection, 512),
            "selection_id": stable_hash(selected),
            "selected_count": len(selected),
            "nodeids": selected,
            "identity": self.identity,
        }
        self._write_json(self.root / "SELECTION.json", value)
        self._append({"event": "collection", **value})

    def start(self, nodeid: str) -> None:
        self._append({"event": "start", "run_id": self.run_id, "nodeid": nodeid, "at": _now()})

    def report(self, report) -> None:
        properties = {}
        for name, value in getattr(report, "user_properties", []):
            if name == "returned" and isinstance(value, (int, float)):
                properties["returned"] = value
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
