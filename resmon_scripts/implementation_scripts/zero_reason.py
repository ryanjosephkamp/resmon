# resmon_scripts/implementation_scripts/zero_reason.py
"""Why a source returned nothing — the taxonomy, and the sentences for it.

A source that comes back with zero results is the most common thing a user
sees and the least explained. The reason usually exists and resmon usually
knows it: a key that was never configured, a window the source filters too
coarsely to answer, an upstream that returned 503, a reply that would not
parse, records dropped because their rights statement is not one resmon may
store. Until this module all of those arrived as the same row -- ``ok`` with
``result_count = 0`` -- and the user was left to guess.

**The rule this module exists to hold.** A zero reason is either a *recorded
fact* with a named source of truth, or it is ``not_recorded``. There is no
third state and there is no inference. Rendering a plausible reason resmon did
not observe would be the overclaim this project rejects everywhere else, and
it would be worst here, because a wrong explanation is more damaging than no
explanation: it stops the user looking.

Every row written before schema 10 reads ``not_recorded``. There is no
backfill and there must not be one -- the information was never captured, and
a reason reconstructed after the fact is exactly the kind of plausible
fabrication the rule above forbids.

The sentences live here, in one place, and the backend renders them. The
renderer displays the rendered sentence rather than composing its own, so
there is no second copy of this vocabulary to drift.
"""

from __future__ import annotations

# The complete set. ``_render`` raises on anything else on purpose: a new
# reason with no sentence would otherwise reach a user as a bare slug.
ZERO_REASONS = (
    "missing_key",
    "retired",
    "window_unanswerable",
    "upstream_failure",
    "parse_failure",
    "rights_filtered",
    "records_unusable",
    "answered_empty",
    "not_recorded",
)

# The reasons that mean *the source did not answer*, as opposed to *the source
# answered and had nothing*. The difference is the whole point of the phase:
# a search strategy that lists a source as searched when it 503'd is
# overstating its coverage, and the watchdog reads the two differently.
DID_NOT_ANSWER = frozenset({
    "missing_key",
    "retired",
    "window_unanswerable",
    "upstream_failure",
    "parse_failure",
})


def _attempts(detail: dict) -> str:
    n = int(detail.get("attempts") or 0)
    return f"{n} attempt{'s' if n != 1 else ''}"


def sentence(source: str, reason: str | None, detail: dict | None = None) -> str:
    """The user-facing sentence for one zero, or for a row that has no reason.

    ``source`` is the display name where one is known and the slug otherwise.
    ``detail`` is the structured fact the sentence is built from; a sentence
    is never composed from anything else.
    """
    detail = detail or {}
    if not reason:
        reason = "not_recorded"

    if reason == "not_recorded":
        return f"resmon did not record whether {source} answered on this run."

    if reason == "missing_key":
        return (
            "Selected, but the API key it requires was not configured, so this "
            "source returned nothing. It did not contribute to the search."
        )

    if reason == "retired":
        # The registry's own text, verbatim -- it is the reason a user is
        # entitled to and it is already written for them.
        return str(detail.get("detail") or f"{source} is no longer available.")

    if reason == "window_unanswerable":
        return (
            f"{source} filters by publication year only, so a window shorter "
            "than one whole calendar year cannot be answered. resmon did not "
            "widen your window."
        )

    if reason == "upstream_failure":
        kind = str(detail.get("detail") or "")
        if kind == "timeout":
            what = f"the request timed out after {_attempts(detail)}"
        elif kind == "connect":
            what = f"resmon could not open a connection after {_attempts(detail)}"
        elif kind == "request_error":
            what = f"the request failed after {_attempts(detail)}"
        else:
            status = detail.get("status")
            what = (
                f"HTTP {status} after {_attempts(detail)}" if status
                else f"the request failed after {_attempts(detail)}"
            )
        return (
            f"{source} could not be queried: {what}. This is not a zero — the "
            "source did not answer."
        )

    if reason == "parse_failure":
        return (
            f"{source} answered (HTTP 200), and resmon could not read the reply."
        )

    if reason == "rights_filtered":
        matched = int(detail.get("matched") or 0)
        kept = int(detail.get("kept") or 0)
        return (
            f"{source} matched {matched} records; {matched - kept} were not "
            "kept because their rights statement is not one resmon can store."
        )

    if reason == "records_unusable":
        # Not in the phase brief's taxonomy. It exists because the brief's
        # ``rights_filtered`` sentence names rights as the cause, and NDL can
        # drop a record for a second reason -- an incomplete or unlinked
        # record -- in the same reply. Attributing those to rights would be a
        # false statement about someone else's licensing, so a mixed drop gets
        # its own sentence with both counts rather than being folded in.
        matched = int(detail.get("matched") or 0)
        kept = int(detail.get("kept") or 0)
        rights = int(detail.get("rights") or 0)
        incomplete = int(detail.get("incomplete") or 0)
        return (
            f"{source} matched {matched} records and resmon kept {kept}: "
            f"{rights} were not kept because their rights statement is not one "
            f"resmon can store, and {incomplete} because the record was "
            "incomplete."
        )

    if reason == "answered_empty":
        return (
            f"{source} answered (HTTP 200) and resmon found no records in the "
            "reply."
        )

    raise ValueError(f"no sentence for zero reason {reason!r}")


def derive(snapshot: dict | None) -> tuple[str, dict]:
    """Turn one search's outcome channel into a reason and its detail.

    Called only when a search returned **zero** results. The order is the
    order of certainty:

    1. What the client said explicitly, because it knows something the HTTP
       status cannot express.
    2. A failed last call, because that is what ended the search.
    3. At least one call, all of which answered -- the source answered and had
       nothing.
    4. No call at all and nothing said: ``not_recorded``. This is the honest
       floor and it must stay the default. Defaulting to ``answered_empty``
       would make resmon claim a source answered when nothing observed it.
    """
    if not snapshot:
        return "not_recorded", {}

    explicit = snapshot.get("explicit_reason")
    if explicit:
        return explicit, dict(snapshot.get("explicit_detail") or {})

    if snapshot.get("failures") and snapshot.get("last_call_failed"):
        return "upstream_failure", {
            "detail": snapshot.get("last_detail") or "request_error",
            "status": snapshot.get("last_status"),
            "attempts": snapshot.get("attempts") or 0,
        }

    if (snapshot.get("attempts") or 0) >= 1:
        return "answered_empty", {"attempts": snapshot.get("attempts") or 0}

    return "not_recorded", {}
