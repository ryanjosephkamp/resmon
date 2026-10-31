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
    "entity_unsupported",
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
    # 2.1. A source that cannot be asked about a person did not answer the
    # question, and a watch routine that listed it as searched would be
    # overstating its coverage in exactly the way this set exists to prevent.
    # It is not a failure either — seven of twenty-seven sources simply have no
    # author query, which the catalog records with its evidence.
    "entity_unsupported",
})


# The few words for each reason, where a sentence will not fit: a run's log
# line for the source, the coverage row's label. A source that answered and
# had nothing, and one that did not answer, are never given the same words.
_LABELS = {
    "answered_empty": "answered, zero",
    "rights_filtered": "answered; nothing storable",
    "records_unusable": "answered; nothing storable",
    "window_unanswerable": "could not answer this window",
    "upstream_failure": "did not answer",
    "parse_failure": "reply unreadable",
    "missing_key": "no API key configured",
    "retired": "withdrawn",
    "entity_unsupported": "entity unsupported",
    "not_recorded": "zero, reason not recorded",
}


def read_in_part(detail: dict | None) -> bool:
    """Did a search read some of a window in order before it stopped (``api_base.note_read``)?"""
    read = (detail or {}).get("read")
    return isinstance(read, dict) and int(read.get("records") or 0) > 0


def label(reason: str | None, detail: dict | None = None) -> str:
    """The few words for a zero and its reason.

    A search that read part of a window before it stopped is not said to have
    had no answer: the source answered every page it was asked for, and what
    is missing is the rest of the window.
    """
    if reason == "upstream_failure" and read_in_part(detail):
        return "read part of the window"
    return _LABELS.get(reason or "not_recorded", str(reason).replace("_", " "))


def answered(status: str, result_count: int, reason: str | None) -> bool:
    """Did this source reply to the query resmon sent it?

    The one rule, shared by the search record and the executions API so the
    two cannot disagree. A non-``ok`` status never answered. An ``ok`` row
    that returned records did. An ``ok / 0`` row depends entirely on why it is
    zero -- and a zero with no reason on record is **not** counted as an
    answer, because "resmon did not observe this" must never be rendered as
    "the source answered".
    """
    if status != "ok":
        return False
    if int(result_count or 0) > 0:
        return True
    if not reason or reason == "not_recorded":
        return False
    return reason not in DID_NOT_ANSWER


def _attempts(detail: dict) -> str:
    n = int(detail.get("attempts") or 0)
    return f"{n} attempt{'s' if n != 1 else ''}"


_MONTHS = ("January", "February", "March", "April", "May", "June", "July",
           "August", "September", "October", "November", "December")


def _day(iso: object) -> str | None:
    """``2013-11-07`` as "November 7, 2013"; None for anything that is not a day."""
    text = str(iso or "")[:10]
    try:
        year, month, day = (int(part) for part in text.split("-"))
        return f"{_MONTHS[month - 1]} {day}, {year}"
    except (ValueError, IndexError):
        return None


def _read_words(source: str, detail: dict) -> str:
    """What a search that stopped part-way through a window had read.

    "the first 1,200 of the 262,104 records bioRxiv lists for the window,
    posted between November 7, 2013 and January 20, 2014". The dates are the
    earliest and latest among the records read, whatever order the source
    listed them in.
    """
    read = detail.get("read") or {}
    records = int(read.get("records") or 0)
    total = read.get("total")
    head = (
        f"the first {records:,} of the {int(total):,} records {source} lists "
        "for the window"
        if isinstance(total, int) and total >= records
        else f"the first {records:,} records {source} listed for the window"
    )
    first, last = _day(read.get("first_date")), _day(read.get("last_date"))
    if first and last and first != last:
        return f"{head}, posted between {first} and {last}"
    if first:
        return f"{head}, posted on {first}"
    return head


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
        # Two windows NDL Search cannot answer at the size asked for. It returns
        # at most a fixed number of records a request, and resmon gets more by
        # splitting the date range, which an open start or one crowded day
        # defeats. Every other window_unanswerable is a year-only source.
        why = str(detail.get("detail") or "")
        limit = int(detail.get("records_per_request") or 0)
        if why == "needs_start_date" and limit:
            return (
                f"{source} returns at most {limit} records a request, and "
                "resmon asks for more by splitting the date range, which needs "
                f"a start date. This run asked for more than {limit} with no "
                f"start date, so resmon did not ask {source}. Set a start date, "
                f"or ask for {limit} or fewer."
            )
        if why == "day_over_record_cap" and limit:
            matched = int(detail.get("matched") or 0)
            return (
                f"{source} has {matched} records for this search on a single "
                f"day, more than the {limit} it returns in one request, and "
                "resmon cannot split a day. resmon kept none of the window "
                f"rather than an arbitrary {limit}."
            )
        return (
            f"{source} filters by publication year only, so a window shorter "
            "than one whole calendar year cannot be answered. resmon did not "
            "widen your window."
        )

    if reason == "upstream_failure":
        kind = str(detail.get("detail") or "")
        if kind == "server_cooldown":
            status = detail.get("status")
            status_text = f"HTTP {status} " if status else ""
            attempts = int(detail.get("attempts") or 0)
            if attempts:
                what = (
                    f"a retained server-directed {status_text}cooldown was still "
                    f"active after {_attempts(detail)}, so resmon sent no "
                    "additional request"
                )
            else:
                what = (
                    f"a retained server-directed {status_text}cooldown from an "
                    "earlier request was still active, so resmon sent no new request"
                )
        elif kind == "operation_deadline":
            what = f"the search operation budget expired after {_attempts(detail)}"
        elif kind == "timeout":
            what = f"the request timed out after {_attempts(detail)}"
        elif kind == "connect":
            what = f"resmon could not open a connection after {_attempts(detail)}"
        elif kind == "request_error":
            what = f"the request failed after {_attempts(detail)}"
        elif kind == "refused":
            what = f"it refused the request after {_attempts(detail)}"
        else:
            status = detail.get("status")
            what = (
                f"HTTP {status} after {_attempts(detail)}" if status
                else f"the request failed after {_attempts(detail)}"
            )
        waited = int(detail.get("waited_seconds") or 0)
        if waited > 0:
            what += (
                f", with {waited} second{'s' if waited != 1 else ''} of waiting "
                "between them"
            )
        if read_in_part(detail):
            # The source answered every page it was asked for; the search
            # stopped before the end of the window, and the sentence says how
            # far it got rather than that the source did not answer.
            return (
                f"{source} answered, and resmon stopped before the end of your "
                f"window: {what}. It had read {_read_words(source, detail)}, "
                "and none of them matched. The rest were not read, so this is "
                "not a zero for your window."
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

    if reason == "entity_unsupported":
        # 2.1. Two different cases share this sentence and it distinguishes
        # them, because "we checked and it cannot" and "we have not been able to
        # check" are different facts and only one of them is about the source.
        why = str(detail.get("detail") or "")
        if why == "unestablished":
            return (
                f"{source} was not asked about this person: resmon has not "
                "established whether it can answer an author query — its API "
                "needs a key resmon does not hold, or its endpoint was not "
                "answering when this was checked."
            )
        return (
            f"{source} was not asked about this person: it has no way to be "
            "asked. Its API takes a keyword query and a date window and offers "
            "no author search of any kind."
        )

    if reason == "answered_empty":
        return (
            f"{source} answered (HTTP 200) and resmon found no records in the "
            "reply."
        )

    raise ValueError(f"no sentence for zero reason {reason!r}")


def terminal_issue(snapshot: dict | None) -> tuple[str, dict] | None:
    """Return an observed terminal issue that can make retained results partial.

    This deliberately excludes empty-answer and filtering reasons. A positive
    result is partial only when the client observed a terminal parse failure,
    its last request invocation failed, or a retained server cooldown stopped
    it before another transport.

    **It does not fire on ``failures`` alone, and a branch that did was
    written and then removed on 2026-10-18.** The reasoning is worth keeping,
    because the gap it aimed at is real and the next reader will find it.

    ``note_attempt()`` clears ``last_call_failed``, so a search making several
    invocations can finish with a failed one behind it and the flag false --
    which is how PubMed's ``_efetch`` lost a 503 batch, finished the rest, and
    recorded ``ok`` over 300 of the 500 records the source held. Reading
    ``failures`` instead looked like the general repair.

    It is not, because of who actually produces that snapshot. Every client
    was driven through a transport that fails once and then succeeds, and the
    sequence of ``safe_request`` invocations recorded: 23 of 27 slugs make one
    invocation and stop. The five that make a second -- ``eric``, ``dblp``,
    ``biorxiv``, ``medrxiv`` and ``inspire_hep``, which run their documented
    "retry once" ladder *outside* ``safe_request`` with ``max_retries=0`` --
    re-issue the **same URL and the same params**. (``inspire_hep`` was missed
    on the first count, which asked for a module constant rather than for the
    behavior; ``test_client_failure_conformance.py`` now derives the set by
    running the probe, so the next one cannot be missed the same way.)
    ``arxiv`` joined them on October 30, 2026: it waits out a 429 or a 503
    itself, minutes rather than seconds, and asks for the same page again.
    That is a request that recovered, so
    nothing is missing, and calling it partial told the user *"ERIC returned 1
    usable record before a later HTTP 503 request failed"* about a source that
    answered. Meanwhile ``_efetch``'s ``break`` means no client abandons a
    failed request and goes on to a different one, so the case the branch was
    for cannot occur.

    A client that someday skips a failed page and keeps going would need this
    back. It would also be a defect in that client, and the fix belongs there:
    a search that silently drops records is not something this module can
    infer its way out of. Should it ever be reinstated, it must distinguish a
    failure followed by a success *for the same logical request* from one
    followed by a different request, and the guard has to reach the
    re-invocation ladder rather than only the retry inside one invocation.
    """
    if not snapshot:
        return None

    if snapshot.get("explicit_reason") == "parse_failure":
        return "parse_failure", {
            **dict(snapshot.get("explicit_detail") or {}),
            "attempts": snapshot.get("attempts") or 0,
        }

    if snapshot.get("failures") and snapshot.get("last_call_failed"):
        detail = {
            "detail": snapshot.get("last_detail") or "request_error",
            "status": snapshot.get("last_status"),
            "attempts": snapshot.get("attempts") or 0,
        }
        # Only a client that waits out a 429 or a 503 itself records this
        # (arXiv), and only then is it said: four attempts in ten seconds and
        # six over two and a half minutes are different stories.
        waited = round(float(snapshot.get("waited_seconds") or 0))
        if waited > 0:
            detail["waited_seconds"] = waited
        # A source read in order (bioRxiv, medRxiv) says how far it got, and
        # a search that stopped part-way through is recorded with it.
        read = snapshot.get("read")
        if isinstance(read, dict) and int(read.get("records") or 0) > 0:
            detail["read"] = dict(read)
        return "upstream_failure", detail

    if snapshot.get("retained_cooldown_status"):
        return "upstream_failure", {
            "detail": "server_cooldown",
            "status": snapshot.get("retained_cooldown_status"),
            "attempts": snapshot.get("attempts") or 0,
        }

    return None


def partial_sentence(
    source: str,
    reason: str,
    detail: dict | None,
    returned: int,
) -> str:
    """Describe usable records retained before an observed terminal issue."""
    detail = detail or {}
    count = int(returned)
    records = f"{count} usable record{'s' if count != 1 else ''}"
    if reason == "parse_failure":
        ending = "a later HTTP 200 reply could not be read"
    elif reason == "upstream_failure":
        kind = str(detail.get("detail") or "")
        status = detail.get("status")
        status_text = f"HTTP {status} " if status else ""
        if kind == "server_cooldown":
            ending = (
                f"a retained server-directed {status_text}cooldown prevented "
                "another request"
            )
        elif kind == "operation_deadline":
            ending = "the search operation budget expired"
        elif kind == "timeout":
            ending = "a later request timed out"
        elif kind == "connect":
            ending = "a later connection could not be opened"
        elif kind == "request_error":
            ending = "a later request failed"
        elif kind == "refused":
            ending = "a later request was refused"
        else:
            ending = f"a later {status_text}request failed" if status else "a later request failed"
    else:
        raise ValueError(f"no partial sentence for reason {reason!r}")
    read = (
        f" It had read {_read_words(source, detail)}."
        if reason == "upstream_failure" and read_in_part(detail) else ""
    )
    return (
        f"{source} returned {records} before {ending}.{read} "
        "The retained set may be incomplete."
    )


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

    issue = terminal_issue(snapshot)
    if issue:
        return issue

    if (snapshot.get("attempts") or 0) >= 1:
        return "answered_empty", {"attempts": snapshot.get("attempts") or 0}

    return "not_recorded", {}
