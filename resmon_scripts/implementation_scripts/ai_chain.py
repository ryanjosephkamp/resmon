# resmon_scripts/implementation_scripts/ai_chain.py
"""Running an ordered list of lanes, and recording what each one did.

1.8a made a chain *expressible*: configuration resolves to an ordered list of
lanes, and failures are classified as lane-fatal or document-local. This module
is what actually runs one.

The whole design is that those two failure kinds get opposite responses:

*Lane-fatal* — a rejected key, an exhausted quota, a model that does not exist.
The lane is demoted for the rest of the execution. Retrying it once per paper
would burn the run rediscovering the same fact two hundred times.

*Document-local* — an abstract past the context window, content the provider
declined. The next lane handles **that document only**; the original lane stays
primary for everything after it. Abandoning a working lane over one long
abstract silently downgrades every summary that follows.

One row per lane lands in ``execution_ai``, which is the shape that table was
built for. A lane that was never reached is recorded as ``skipped`` rather than
omitted, because "we never needed it" and "it was not configured" are different
facts and the user is entitled to both.

**There is no summarizer of last resort.** If every lane fails, the documents
have no AI summary and the stored rows say why. resmon has never had a
keyless extractive fallback -- the Master Plan said otherwise and was wrong --
so this module does not pretend to one.
"""

from __future__ import annotations

import logging
from typing import Any, Optional

from .ai_errors import AIError, classify_exception
from .ai_lanes import AILane
from .database import finish_ai_lane, start_ai_lane

logger = logging.getLogger(__name__)

__all__ = ["ChainRunner", "LaneState"]


class LaneState:
    """Mutable per-execution bookkeeping for one lane."""

    __slots__ = (
        "lane", "index", "demoted", "opened", "attempted", "succeeded",
        "last_error", "skip_reason", "_client", "_pipeline", "_built",
    )

    def __init__(self, lane: AILane, index: int) -> None:
        self.lane = lane
        self.index = index
        self.demoted = False
        self.opened = False
        self.attempted = 0
        self.succeeded = 0
        self.last_error: Optional[AIError] = None
        self.skip_reason: Optional[str] = None
        self._client: Any = None
        self._pipeline: Any = None
        self._built = False

    @property
    def outcome(self) -> str:
        if self.attempted == 0:
            return "skipped"
        if self.succeeded == self.attempted:
            return "ok"
        if self.succeeded > 0:
            return "partial"
        return "failed"


class ChainRunner:
    """Summarize documents through an ordered list of lanes.

    Construct one per execution, call :meth:`summarize_document` per paper, then
    :meth:`finish` once. ``finish`` is not optional -- it is what closes the
    ``execution_ai`` rows, and a row left open at ``running`` is how a crashed
    run announces itself.
    """

    def __init__(
        self,
        lanes: list[AILane],
        *,
        db,
        exec_id: int,
        prompt_params: Optional[dict] = None,
        ephemeral: Optional[dict] = None,
        primary_client: Any = None,
    ) -> None:
        self._states = [LaneState(lane, i) for i, lane in enumerate(lanes)]
        self._db = db
        self._exec_id = int(exec_id)
        self._prompt_params = prompt_params or {}
        self._ephemeral = ephemeral
        # A client the caller already built for lane 0. The sweep engine has
        # accepted an ``llm_client`` since long before lanes existed, and tests
        # construct one directly; honouring it keeps both working and avoids
        # building the same client twice.
        self._primary_client = primary_client
        self._finished = False

    # ------------------------------------------------------------------
    # Introspection
    # ------------------------------------------------------------------

    def __len__(self) -> int:
        return len(self._states)

    @property
    def usable(self) -> bool:
        """True when at least one lane could still produce a summary."""
        return any(not s.demoted for s in self._states)

    @property
    def active_label(self) -> str:
        """The label of the lane currently doing the work, for the report header."""
        for state in self._states:
            if not state.demoted and state.succeeded:
                return state.lane.label
        for state in self._states:
            if not state.demoted:
                return state.lane.label
        return ""

    def lane_summaries(self) -> list[dict]:
        """Per-lane counts, for logging and the completion message."""
        return [
            {
                "index": s.index,
                "label": s.lane.label,
                "outcome": s.outcome,
                "attempted": s.attempted,
                "succeeded": s.succeeded,
                "demoted": s.demoted,
                "reason": (s.last_error.message if s.last_error else s.skip_reason),
            }
            for s in self._states
        ]

    # ------------------------------------------------------------------
    # The run
    # ------------------------------------------------------------------

    def summarize_document(self, text: str) -> tuple[str, Optional[AIError]]:
        """Return ``(summary, error)`` for one document.

        ``summary`` is empty when every remaining lane failed on this document;
        ``error`` is then the last failure, already classified and sanitised.
        A successful call returns ``(summary, None)``.
        """
        last_error: Optional[AIError] = None

        for state in self._states:
            if state.demoted:
                continue

            # A capped lane stands down when it has done its share. This is
            # checked before the pipeline is built so a chain whose first lane
            # is already spent does not pay to construct it again.
            #
            # Standing down is not failing: there is no AIError, the lane's
            # outcome stays whatever its documents earned, and the recorded
            # reason says the cap was reached rather than implying something
            # went wrong. The chain simply continues with the next lane.
            cap = state.lane.doc_cap
            if cap is not None and state.attempted >= cap:
                state.demoted = True
                if not state.skip_reason:
                    state.skip_reason = (
                        f"Reached this lane's limit of {cap} documents for one "
                        f"run; the rest were passed to the next lane."
                    )
                logger.info(
                    "AI lane %d (%s) stood down at its %d-document cap.",
                    state.index, state.lane.label, cap,
                )
                self._open(state)
                continue

            pipeline = self._pipeline_for(state)
            if pipeline is None:
                # Could not be built -- no key, no model, or not implemented
                # yet. Demote so the next document does not retry it, and
                # record the reason rather than failing silently.
                state.demoted = True
                self._open(state)
                continue

            state.attempted += 1
            try:
                summary = pipeline.summarize_document(text)
            except Exception as exc:
                error = classify_exception(
                    exc,
                    lane_label=state.lane.label,
                    provider=state.lane.provider,
                    model=state.lane.model or "",
                    credential_alias=state.lane.credential_alias,
                )
                state.last_error = error
                last_error = error
                if error.lane_fatal:
                    state.demoted = True
                    logger.warning(
                        "AI lane %d (%s) demoted for this run: %s",
                        state.index, state.lane.label, error.kind.value,
                    )
                continue

            if isinstance(summary, str) and summary.strip():
                state.succeeded += 1
                return summary, None

            # A lane that returns nothing has not succeeded. Treated as
            # document-local: an empty completion is not evidence the lane is
            # broken, and demoting on it would throw away a working provider.
            state.last_error = AIError(
                kind=state.last_error.kind if state.last_error else _empty_kind(),
                message="The provider returned an empty summary.",
                lane_label=state.lane.label,
                provider=state.lane.provider,
                model=state.lane.model or "",
                credential_alias=state.lane.credential_alias,
            )
            last_error = state.last_error

        return "", last_error

    def finish(self) -> None:
        """Close every lane's ``execution_ai`` row. Safe to call twice."""
        if self._finished:
            return
        self._finished = True
        for state in self._states:
            if not state.opened:
                # Never reached. Record it anyway: "not needed" and "not
                # configured" are different facts and both are worth having.
                self._open(state)
            record = state.last_error.to_record() if state.last_error else {}
            if not record and state.skip_reason:
                record = {"safe_message": state.skip_reason}
            try:
                finish_ai_lane(
                    self._db, self._exec_id, state.index,
                    outcome=state.outcome,
                    docs_attempted=state.attempted,
                    docs_succeeded=state.succeeded,
                    **record,
                )
            except Exception:
                logger.exception(
                    "Could not close execution_ai row for lane %d", state.index,
                )

    # ------------------------------------------------------------------
    # Internals
    # ------------------------------------------------------------------

    def _open(self, state: LaneState) -> None:
        if state.opened:
            return
        state.opened = True
        try:
            start_ai_lane(
                self._db, self._exec_id, state.index,
                lane_label=state.lane.label,
                lane_kind=state.lane.kind,
                provider=state.lane.provider,
                model=state.lane.model,
                credential_alias=state.lane.credential_alias,
            )
        except Exception:
            # Bookkeeping must never take down a run that is otherwise
            # producing summaries.
            logger.exception(
                "Could not open execution_ai row for lane %d", state.index,
            )

    def _pipeline_for(self, state: LaneState):
        """Build (once) the summarization pipeline for a lane, or ``None``."""
        if state._built:
            return state._pipeline
        state._built = True

        client = None
        if state.index == 0 and self._primary_client is not None:
            client = self._primary_client
        else:
            try:
                from .llm_factory import build_client_for_lane

                client = build_client_for_lane(state.lane, ephemeral=self._ephemeral)
            except ValueError as exc:
                # Insecure custom base URL. A configuration mistake worth
                # naming rather than silently skipping past.
                state.skip_reason = str(exc)
                logger.warning("AI lane %d unusable: %s", state.index, exc)
                return None
            except Exception:
                logger.exception("AI lane %d could not be built", state.index)
                state.skip_reason = "The lane could not be initialized."
                return None

        if client is None:
            state.skip_reason = _why_unusable(state.lane)
            logger.info("AI lane %d skipped: %s", state.index, state.skip_reason)
            return None

        from .summarizer import SummarizationPipeline

        state._client = client
        state._pipeline = SummarizationPipeline(
            client, prompt_params=self._prompt_params,
        )
        self._open(state)
        return state._pipeline


def _empty_kind():
    from .ai_errors import AIErrorKind
    return AIErrorKind.UNKNOWN


def _why_unusable(lane: AILane) -> str:
    """A specific reason a lane produced no client, using presence not values.

    Never reads a credential. ``probe_credential`` answers present / absent /
    unreadable, which is the same three-state honesty the Repositories page
    already ships, and is all this needs to explain itself.
    """
    if lane.kind == "subscription":
        # Say which paths were looked at, not just that nothing was found. The
        # packaged app searches a different PATH than a terminal does, so
        # "not found" on its own sends people to reinstall a CLI that is
        # already installed.
        try:
            from .ai_cli import discover_cli

            discovery = discover_cli(lane.provider, lane.binary_path)
        except Exception:
            return "The command for this lane could not be located."
        return discovery.describe()
    if not lane.model:
        return "No model is configured for this lane."
    if lane.kind == "local":
        return "The local model could not be initialized."
    if lane.credential_alias:
        try:
            from .credential_manager import probe_credential

            status = probe_credential(lane.credential_alias)
        except Exception:
            status = "absent"
        if status == "unreadable":
            return (
                f"The keyring would not answer for {lane.credential_alias}; "
                "resmon cannot tell whether a key is stored."
            )
        if status != "present":
            return f"No API key is stored for {lane.credential_alias}."
    return "The lane produced no usable client."
