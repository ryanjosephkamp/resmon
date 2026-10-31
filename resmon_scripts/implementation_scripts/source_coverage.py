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
    partial = bool(
        valid and status == "ok" and count > 0
        and reason in {"upstream_failure", "parse_failure"}
        and detail.get("partial") is True
        and detail.get("returned") == count
    )
    if valid:
        try:
            if partial:
                saved_message = detail.get("message")
                note = (
                    saved_message if isinstance(saved_message, str) and saved_message
                    else zero_reason.partial_sentence(source, reason, detail, count)
                )
            elif status == "ok" and count == 0:
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
    label = {"answered": "answered", "non_answer": "did not answer", "unknown": "unknown / unsupported recorded outcome"}[category]
    if valid and category == "unknown" and reason in (None, "not_recorded"):
        label = "zero, reason not recorded"
    if category == "answered" and count == 0:
        label = "answered, zero" if reason == "answered_empty" else "answered; nothing storable"
    if partial:
        label = "answered, partial"
    if valid and category == "non_answer":
        # Preserve the Search record's established distinctions, now rendered
        # once for both Markdown and React. A specific non-answer is more
        # useful than collapsing every reason into the same short label.
        if status != "ok":
            label = "withdrawn" if reason == "retired" else status.replace("_", " ")
        elif reason in zero_reason.DID_NOT_ANSWER:
            label = zero_reason.label(reason, detail)
    return {"source": source, "category": category, "label": label, "note": note,
            "outcome_recorded": True, "status": status, "result_count": count,
            "zero_reason": reason, "recorded_at": row.get("recorded_at"),
            "genuine_empty": category == "answered" and status == "ok" and count == 0 and reason == "answered_empty",
            "partial": partial}


def sent_no_terms(params: dict) -> bool:
    """Whether a run's saved parameters asked its sources for no words at all.

    Only where the words were saved and are empty: parameters that do not
    record a query or keywords say nothing about what was searched, and a run
    that follows a person (``entity``) searches by the person, not by words.
    """
    if not params or params.get("entity") is not None or params.get("entity_profile") is not None:
        return False
    if "query" not in params and "keywords" not in params:
        return False
    keywords = params.get("keywords")
    words = [k for k in keywords if str(k).strip()] if isinstance(keywords, list) else []
    query = params.get("query")
    return not words and not (isinstance(query, str) and query.strip())


def _http_status(row: dict) -> object:
    detail = row.get("zero_detail")
    if isinstance(detail, str):
        try:
            detail = json.loads(detail) if detail else {}
        except ValueError:
            return None
    return detail.get("status") if isinstance(detail, dict) else None


# Said of a source that answered HTTP 400 to a run with no search terms. The
# refusal is the source turning down an empty search, not the source being down,
# and the row's own sentence ("could not be queried") reads as the second.
NO_TERMS_REFUSAL = (
    " This run had no search terms, so resmon sent this source an empty search, "
    "and the 400 is the source refusing it."
)


def _counted(n: int, singular: str) -> str:
    return f"{n} {singular}" if n == 1 else f"{n} {singular}s"


def _non_answers(sources: list[dict], n: int) -> str:
    """The non-answer count, and why, in words that agree with the count.

    A source the run was still asking when it was cancelled did not fail to
    answer: the run stopped first, and the report says so in those words. Only
    the rest are said to have been unable to answer.
    """
    phrase = f"{n} recorded non-answer{'' if n == 1 else 's'}"
    if not n:
        return phrase
    cancelled = sum(s["category"] == "non_answer" and s["status"] == "cancelled" for s in sources)
    could_not = n - cancelled
    stopped = f"cancelled before {'it' if cancelled == 1 else 'they'} answered"
    if not cancelled:
        return f"{phrase} (could not answer)"
    if not could_not:
        return f"{phrase} ({stopped})"
    return f"{phrase} ({could_not} could not answer, {cancelled} {stopped})"


def build(execution: dict, rows: list[dict]) -> dict:
    selected, provenance = selection(execution.get("parameters"))
    recorded = {row["source"]: outcome(row) for row in rows}
    no_terms = sent_no_terms(parameters(execution.get("parameters")))
    refused_empty = 0
    if no_terms:
        for row in rows:
            said = recorded[row["source"]]
            if (said["category"] == "non_answer" and said["zero_reason"] == "upstream_failure"
                    and _http_status(row) == 400):
                said["note"] += NO_TERMS_REFUSAL
                refused_empty += 1
    basis = selected if selected is not None else list(recorded)
    sources = [recorded.get(slug, {"source": slug, "category": "unknown",
                "label": "unknown / outcome not recorded",
                "note": "Outcome not recorded; no attempt, failure or empty answer can be inferred.",
                "outcome_recorded": False, "status": None, "result_count": None,
                "zero_reason": None, "recorded_at": None, "genuine_empty": False,
                "partial": False}) for slug in basis]
    extra = [v for k, v in recorded.items() if selected is not None and k not in selected]
    counts = {key: sum(s["category"] == key for s in sources) for key in ("answered", "non_answer", "unknown")}
    counts["genuine_empty"] = sum(s["genuine_empty"] for s in sources)
    counts["partial"] = sum(bool(s.get("partial")) for s in sources)
    label = "selected sources" if selected is not None else "recorded sources"
    noun = "selected source" if selected is not None else "recorded source"
    summary = (f"{_counted(len(sources), noun)}: {counts['answered']} answered, "
               f"{_non_answers(sources, counts['non_answer'])}, {counts['unknown']} unknown.") if sources else "No source outcomes were recorded; the full selected set is unknown."
    unexplained = sum(s["outcome_recorded"] and s["category"] == "unknown" and s["result_count"] == 0
                      and s["zero_reason"] in (None, "not_recorded") for s in sources)
    if unexplained:
        summary += f" {unexplained} returned nothing for a reason resmon did not record."
    if counts["partial"]:
        summary += f" {counts['partial']} answered with retained partial results."
    if no_terms:
        summary += " This run had no search terms, so each source was sent an empty search"
        summary += (f"; the {refused_empty} that answered HTTP 400 refused it for that reason."
                    if refused_empty else ".")
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
