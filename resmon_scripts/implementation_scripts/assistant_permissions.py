"""The gate between an assistant's write and the person who has to allow it.

**Every write the assistant makes waits here.** Not because the model was asked
nicely to check first — because the only path from the model to a write tool
runs through ``claude``'s ``--permission-prompt-tool``, which calls a tool
resmon controls and does not execute anything until that tool answers. The
model cannot call the permission tool itself: it is not in the tool list the
session is given. Verified against the installed CLI, both ways: on allow, the
tool server's log shows the permission call and *then* the write; on deny, it
shows the permission call and nothing else.

The broker is the resmon-side half of that. It is process-local and in memory
on purpose: a pending approval is meaningful only while the CLI that asked for
it is still waiting, so surviving a restart would mean resurrecting a question
whose asker is gone.

Timing out **denies**. A gate that opened because nobody was looking is not a
gate, and the caller is told the timeout is what happened rather than being
handed a bare refusal.
"""

from __future__ import annotations

import asyncio
import logging
import time
import uuid
from dataclasses import dataclass, field
from typing import Optional

logger = logging.getLogger(__name__)

__all__ = ["DEFAULT_TIMEOUT_SECONDS", "PermissionBroker", "PermissionRequest", "broker"]

# How long a card may sit unanswered before it is denied. Generous, because the
# person may be reading what the call would do; finite, because a `claude`
# subprocess is blocked on the answer and an unbounded wait is a hung panel with
# a live process behind it.
DEFAULT_TIMEOUT_SECONDS = 300.0


@dataclass
class PermissionRequest:
    """One pending "may I?", and its answer once there is one."""

    id: str
    session_id: int
    tool_name: str
    tool_input: dict
    tool_use_id: Optional[str]
    requested_at: float
    event: asyncio.Event = field(repr=False)
    decision: Optional[str] = None          # "allow" | "deny"
    reason: Optional[str] = None

    def to_event(self) -> dict:
        """The shape the panel receives on the SSE stream."""
        return {
            "type": "permission_request",
            "request_id": self.id,
            "tool_name": self.tool_name,
            "input": self.tool_input,
            "tool_use_id": self.tool_use_id,
        }


class PermissionBroker:
    """Pending approvals, keyed by request id.

    Every method is called from the event loop — the MCP permission server and
    the panel both reach it through async endpoints — so the state needs no lock
    of its own. That is a property of *where it is called from*, not of the
    class, so it is written down rather than assumed: a caller from a worker
    thread would break it, and there is deliberately no such caller.
    """

    def __init__(self) -> None:
        self._pending: dict[str, PermissionRequest] = {}

    def open(
        self,
        *,
        session_id: int,
        tool_name: str,
        tool_input: Optional[dict],
        tool_use_id: Optional[str] = None,
    ) -> PermissionRequest:
        request = PermissionRequest(
            id=uuid.uuid4().hex,
            session_id=session_id,
            tool_name=tool_name,
            tool_input=dict(tool_input or {}),
            tool_use_id=tool_use_id,
            requested_at=time.monotonic(),
            event=asyncio.Event(),
        )
        self._pending[request.id] = request
        return request

    def get(self, request_id: str) -> Optional[PermissionRequest]:
        return self._pending.get(request_id)

    def pending_for(self, session_id: int) -> list[PermissionRequest]:
        return [r for r in self._pending.values()
                if r.session_id == session_id and r.decision is None]

    def answer(self, request_id: str, *, allow: bool,
               reason: Optional[str] = None) -> bool:
        """Record the person's answer. Returns False if there is nothing to answer.

        A second answer to the same request is ignored rather than overwriting
        the first: two taps on a card must not turn a deny into an allow.
        """
        request = self._pending.get(request_id)
        if request is None or request.decision is not None:
            return False
        request.decision = "allow" if allow else "deny"
        request.reason = reason
        request.event.set()
        return True

    async def wait(
        self, request: PermissionRequest, timeout: float = DEFAULT_TIMEOUT_SECONDS,
    ) -> tuple[str, str]:
        """Block until answered or the timeout expires. Returns (decision, message).

        The timeout denies, and says that is what happened. A gate that opened
        because nobody was looking is not a gate.
        """
        try:
            await asyncio.wait_for(request.event.wait(), timeout=timeout)
        except asyncio.TimeoutError:
            request.decision = "deny"
            request.reason = (
                f"Nobody answered within {int(timeout)} seconds, so resmon said no. "
                f"Ask again if you still want this."
            )
            logger.info(
                "Assistant permission request %s (%s) timed out and was denied",
                request.id, request.tool_name,
            )
        finally:
            self._pending.pop(request.id, None)

        if request.decision == "allow":
            return "allow", request.reason or "Allowed by the user."
        return "deny", request.reason or "The user did not allow this."

    def cancel_session(self, session_id: int) -> int:
        """Deny everything still pending for a session that is going away.

        Called when a turn is cancelled or its process dies. Without it the
        blocked HTTP request from the permission server would sit until the
        timeout, and the panel would show a card for a conversation that has
        already ended.
        """
        count = 0
        for request in list(self._pending.values()):
            if request.session_id == session_id and request.decision is None:
                self.answer(request.id, allow=False,
                            reason="The conversation was cancelled.")
                count += 1
        return count


broker = PermissionBroker()
