"""P7 — what a turn costs, held to a ceiling the measurement set.

Two numbers, two jobs, both from the same table
(``workspace/handbacks/2.0/evidence/assistant-cost.md``):

* ``assistant_runtime.TURN_BUDGET_USD`` = **$0.75**, four times the dearest of
  the ten canonical requests, passed to the CLI as ``--max-budget-usd``. A
  runaway stop the product enforces on itself.
* ``REGRESSION_CEILING_USD`` = **$0.375**, twice the dearest. The detector: a
  change that makes an ordinary question twice as expensive fails here, well
  before a user's answer is ever cut off.

**Twice, not the measured maximum.** One run per request gives no variance
figure, and a guard that fires on ordinary day-to-day variation is a guard
somebody deletes. This is the method 1.8.5's flip gate arrived at after its
first version thresholded the wrong quantity: measure, then set the threshold
from the measurement, and say what the threshold is protecting.

Marked ``live_network``: it drives the real CLI and spends the user's own
window. Three of the ten requests, not all ten — the full table is the
measurement script's job, and this is the guard.

**The hermetic half is not here**, because a module-level ``live_network`` mark
cannot be lifted for one test:
``test_assistant_runtime.py::test_the_two_ceilings_are_derived_from_the_measurement``
asserts the arithmetic relating the two numbers, and it runs on every CI job. A
ceiling raised quietly to make a failing guard pass fails *that*.
"""

from __future__ import annotations

import json
import os
import socket
import subprocess
import sys
import time
from pathlib import Path

import httpx
import pytest

PROJECT_ROOT = Path(__file__).resolve().parent.parent.parent
sys.path.insert(0, str(PROJECT_ROOT / "resmon_scripts"))

from implementation_scripts import ai_cli, assistant_runtime  # noqa: E402

# ``needs_agent_cli`` as well: this needs the CLI the *person* installed and
# signed into. The weekly live job cannot run it and its summary says so.
pytestmark = [pytest.mark.live_network, pytest.mark.needs_agent_cli]

# Twice the dearest of the ten measured (create-routine, $0.1875).
REGRESSION_CEILING_USD = 0.375

# The dearest measured, kept so the relationship between the two numbers is a
# fact in the code rather than arithmetic in a comment.
DEAREST_MEASURED_USD = 0.1875

# Three of the ten, chosen to span the range: the cheapest kind (one tool), a
# middling one (several tools), and the dearest (a write, proposed and denied).
GUARDED = [
    ("routines", "What monitoring routines do I have?"),
    ("last-run", "What did my most recent run find?"),
    ("create-routine", "Set up a weekly arXiv routine on quantum error correction."),
]


def _free_port() -> int:
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        return sock.getsockname()[1]


@pytest.fixture(scope="module")
def backend(tmp_path_factory):
    found = ai_cli.discover_cli("claude_code")
    if not found.found:
        pytest.skip("the claude CLI is not installed on this machine")

    state = tmp_path_factory.mktemp("assistant-budget")
    port = _free_port()
    env = {
        **os.environ,
        "RESMON_DB_PATH": str(state / "resmon.db"),
        "RESMON_REPORTS_DIR": str(state / "reports"),
        "RESMON_PORT_FILE": str(state / "resmon.port"),
        "RESMON_DISABLE_SCHEDULER": "1",
        "RESMON_PORT": str(port),
        "PYTHONPATH": str(PROJECT_ROOT / "resmon_scripts"),
    }
    proc = subprocess.Popen(
        [sys.executable, str(PROJECT_ROOT / "resmon_scripts" / "resmon.py"), str(port)],
        env=env, stdout=subprocess.DEVNULL, stderr=subprocess.STDOUT,
        cwd=str(PROJECT_ROOT),
    )
    base = f"http://127.0.0.1:{port}"
    try:
        deadline = time.monotonic() + 60
        while time.monotonic() < deadline:
            try:
                if httpx.get(f"{base}/api/health", timeout=1.0).status_code == 200:
                    break
            except httpx.HTTPError:
                time.sleep(0.3)
        else:
            raise RuntimeError("backend did not become ready")
        httpx.put(f"{base}/api/settings/ai",
                  json={"settings": {"ai_cli_path": found.path}}, timeout=20)
        httpx.post(f"{base}/api/routines", json={
            "name": "Graphene (weekly)", "schedule_cron": "0 9 * * 1",
            "parameters": {"query": "graphene", "repositories": ["arxiv"]},
            "is_active": False,
        }, timeout=20)
        yield base
    finally:
        proc.terminate()
        try:
            proc.wait(timeout=20)
        except subprocess.TimeoutExpired:
            proc.kill()


@pytest.mark.parametrize("label,prompt", GUARDED, ids=[g[0] for g in GUARDED])
def test_a_canonical_request_stays_under_the_ceiling(backend, label, prompt):
    session = httpx.post(f"{backend}/api/assistant/sessions", json={}, timeout=30)
    if session.status_code == 409:
        pytest.skip(f"no assistant runtime: {session.text}")
    session_id = session.json()["id"]

    events: list[dict] = []
    with httpx.stream("POST", f"{backend}/api/assistant/sessions/{session_id}/messages",
                      json={"text": prompt}, timeout=600) as response:
        for line in response.iter_lines():
            if not line.startswith("data: "):
                continue
            event = json.loads(line[6:])
            events.append(event)
            if event.get("type") == "permission_request":
                # Denied, so what is measured is the cost of working out what to
                # propose — the part that happens whichever way a person answers.
                httpx.post(f"{backend}/api/assistant/permissions/{event['request_id']}",
                           json={"allow": False, "reason": "budget guard"}, timeout=30)
            if event.get("type") == "closed":
                break

    blob = " ".join(str(e.get("message", "")) + str(e.get("text", "")) for e in events)
    if any(p in blob.lower() for p in
           ("not signed in", "not logged in", "usage limit", "please run /login")):
        pytest.skip(f"the claude CLI is not usable right now: {blob[:200]}")

    done = next((e for e in events if e["type"] == "done"), None)
    assert done is not None, f"{label} produced no result: {events[-3:]}"
    assert not done.get("is_error"), f"{label} failed: {done}"

    cost = done.get("cost_usd")
    if cost is None:
        # Not a pass. A run that reports no cost cannot be held to a ceiling,
        # and saying so is the honest outcome rather than treating silence as
        # zero — which is the whole reason the store keeps NULL.
        pytest.skip(f"{label}: the CLI reported no cost, so nothing can be held to a ceiling")

    assert cost <= REGRESSION_CEILING_USD, (
        f"{label} cost ${cost:.4f}, over the ${REGRESSION_CEILING_USD:.4f} ceiling "
        f"set from the measurement (dearest measured ${DEAREST_MEASURED_USD:.4f}). "
        f"Re-run measure_assistant_cost.py before moving the ceiling."
    )
