"""Read-time coverage over saved facts; never infer a past source selection."""
from __future__ import annotations

import json
import re
from . import zero_reason


def parameters(raw: object) -> dict:
    if isinstance(raw, str):
        try:
            raw = json.loads(raw)
        except (ValueError, TypeError):
            return {}
    return raw if isinstance(raw, dict) else {}


def _slug(value: object) -> bool:
    # Historical exact identifiers are retained; no catalog expansion or casing.
    return (isinstance(value, str) and bool(re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_-]*", value))
            and value.lower() not in {"all", "default", "defaults", "all_repositories"})


def selection(raw: object) -> tuple[list[str] | None, str]:
    params = parameters(raw)
    many, one = params.get("repositories"), params.get("repository")
    if "repositories" in params:
        if not isinstance(many, list) or not many or not all(_slug(s) for s in many):
            return None, "Saved source selection is empty or malformed; the full selected set is unknown."
        selected = list(dict.fromkeys(many))
        if "repository" in params and (not _slug(one) or selected != [one]):
            return None, "Saved list and singular source selection conflict; the full selected set is unknown."
        return selected, "Source selection comes from the saved repositories list, deduplicated by exact identifier."
    if _slug(one):
        return [one], "Source selection comes from the saved singular repository."
    return None, "No usable saved source selection; the full selected set is unknown."


def outcome(row: dict) -> dict:
    source = row["source"]
    count, status, reason = row.get("result_count"), row.get("status"), row.get("zero_reason")
    detail = row.get("zero_detail")
    malformed = False
    if isinstance(detail, str):
        try:
            detail = json.loads(detail) if detail else {}
        except ValueError:
            malformed = True
    if detail is None:
        detail = {}
    if not isinstance(detail, dict):
        malformed = True
    valid_count = isinstance(count, int) and not isinstance(count, bool) and count >= 0
    category, note = "unknown", "Recorded outcome is malformed or unsupported; whether this source answered is unknown."
    valid = (valid_count and status in {"ok", "error", "skipped_missing_key", "cancelled"}
             and (reason is None or reason in zero_reason.ZERO_REASONS) and not malformed)
    if valid:
        try:
            if status == "ok" and count == 0:
                note = zero_reason.sentence(source, reason, detail)
            elif status == "error" and reason == "retired":
                note = zero_reason.sentence(source, reason, detail)
            elif status == "error":
                note = "Recorded query failure: " + str(row.get("error_message") or "unknown error")
            elif status == "cancelled":
                note = "The run was cancelled while this source was being queried."
            elif status == "skipped_missing_key":
                note = zero_reason.sentence(source, "missing_key")
            else:
                note = "Recorded returned records; this is not the number newly added to the corpus."
            if zero_reason.answered(status, count, reason):
                category = "answered"
            elif status == "ok" and count == 0 and reason in (None, "not_recorded"):
                category = "unknown"
            else:
                category = "non_answer"
        except (ValueError, TypeError, OverflowError):
            note = "Recorded reason details are malformed; whether this source answered is unknown."
    return {"source": source, "category": category, "note": note,
            "outcome_recorded": True, "status": status, "result_count": count,
            "zero_reason": reason, "recorded_at": row.get("recorded_at"),
            "genuine_empty": category == "answered" and status == "ok" and count == 0 and reason == "answered_empty"}


def build(execution: dict, rows: list[dict]) -> dict:
    selected, provenance = selection(execution.get("parameters"))
    recorded = {row["source"]: outcome(row) for row in rows}
    basis = selected if selected is not None else list(recorded)
    sources = [recorded.get(slug, {"source": slug, "category": "unknown",
                "note": "Outcome not recorded; no attempt, failure or empty answer can be inferred.",
                "outcome_recorded": False, "status": None, "result_count": None,
                "zero_reason": None, "recorded_at": None, "genuine_empty": False}) for slug in basis]
    extra = [v for k, v in recorded.items() if selected is not None and k not in selected]
    counts = {key: sum(s["category"] == key for s in sources) for key in ("answered", "non_answer", "unknown")}
    counts["genuine_empty"] = sum(s["genuine_empty"] for s in sources)
    label = "selected sources" if selected is not None else "recorded sources"
    summary = (f"{len(sources)} {label}: {counts['answered']} answered, "
               f"{counts['non_answer']} recorded non-answer (could not answer), {counts['unknown']} unknown.") if sources else "No source outcomes were recorded; the full selected set is unknown."
    notes = [provenance]
    if extra:
        notes.append(f"{len(extra)} additional recorded sources fall outside the saved selection and are excluded from selected-source counts.")
    if execution.get("status") != "completed":
        notes.append("This run is not completed; its recorded coverage may be incomplete.")
    notes.extend([
        "A recorded non-answer means resmon could not count an answer to the query; an unreadable HTTP reply is a non-answer.",
        "Genuine empty answers are a subset of answered sources, not an additional category. Rights-filtered or unusable records do not mean no papers were found.",
        "Recorded timestamps are recording times, not proven attempt-start times. Saved terms, window and cap are requests, not proof of final provider URLs or exhausted results; a cap alone does not prove truncation.",
        "This account is generated from saved facts at read time. It does not rewrite an older report or PDF."])
    return {"execution_id": execution["id"], "basis": "selected" if selected is not None else "recorded",
            "basis_label": label, "selection_known": selected is not None, "total": len(sources),
            "counts": counts, "summary": summary, "sources": sources, "additional_sources": extra, "notes": notes}
