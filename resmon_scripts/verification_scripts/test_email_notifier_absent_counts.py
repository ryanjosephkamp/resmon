# resmon_scripts/verification_scripts/test_email_notifier_absent_counts.py
"""A count the composer was not given is reported as absent, not as zero.

``compose_notification`` read ``execution_data.get("new_count", 0)``, so a
caller that supplied neither key got the line ``New results: 0`` -- a number
resmon had no basis for. That is the one thing this codebase says it will not
do: a field it cannot know is labelled, not guessed.

It was not hypothetical. ``email_sender`` read ``new_count`` from a row of the
``executions`` table, whose column is ``new_result_count``, so the key was
absent on every real send and every routine completion email said "New results:
0" however many papers the run found. Fixing the caller removed that instance;
it did not remove the default that turned a missing key into a confident zero
for the next caller to get it wrong.

The column is ``INTEGER DEFAULT 0``, so a row loaded from the database always
carries a number and these cases are about callers that hand over something
else -- the engine's return dict, a partial payload, a future queue entry.
``delivery._atom_feed`` already renders the same absence as "an unrecorded
number"; this is the same sentence in the email.

What this does not establish: that any current caller omits the key. The two
in the tree (``email_sender.send_routine_completion_email`` and
``email_notifier.send_test_email``) both supply it, and nothing here drives
SMTP.
"""

from __future__ import annotations

import sys
from pathlib import Path

import pytest

PROJECT_ROOT = Path(__file__).resolve().parent.parent.parent
sys.path.insert(0, str(PROJECT_ROOT / "resmon_scripts"))

from implementation_scripts.email_notifier import compose_notification  # noqa: E402


def _body(message) -> str:
    """The decoded text part.

    ``MIMEText`` picks base64 as soon as the body carries a non-ASCII
    character -- the ``—`` placeholder the composer uses for a missing
    timestamp is enough -- so ``get_payload()`` alone returns base64 and every
    substring assertion below would pass vacuously.
    """
    part = message.get_payload()[0]
    return part.get_payload(decode=True).decode(part.get_content_charset() or "utf-8")


# The two counts the body reports. Both were read with a ``0`` default and
# both are the same defect; the denominator is the two ``…_count`` lines in
# ``compose_notification``'s ``body_lines``.
COUNT_LINES = {"new_count": "New results", "result_count": "Total results"}


@pytest.mark.parametrize("key,label", sorted(COUNT_LINES.items()))
def test_an_absent_count_is_not_rendered_as_zero(key, label):
    """The defect: no key supplied, and the email states a number anyway."""
    data = {
        "routine_name": "Partial Payload Routine",
        "start_time": "2026-10-19T08:00:00Z",
        "end_time": "2026-10-19T08:01:00Z",
        "status": "completed",
        **{other: 7 for other in COUNT_LINES if other != key},
    }
    body = _body(compose_notification(data, ai_summary=None))

    assert f"{label}: 0" not in body, (
        f"{key} was never supplied and the email reported zero anyway:\n{body}")
    assert f"{label}: not recorded" in body, body


@pytest.mark.parametrize("key,label", sorted(COUNT_LINES.items()))
def test_an_explicit_none_is_also_absent(key, label):
    """``None`` is how a database row carries "no value", not "zero".

    ``dict.get`` returns ``None`` rather than the default when the key is
    present and null, so a fix that only changed the default would still
    render ``New results: None`` to a user.
    """
    data = {
        "routine_name": "Null Column Routine",
        "status": "completed",
        **{other: 7 for other in COUNT_LINES},
        key: None,
    }
    body = _body(compose_notification(data, ai_summary=None))

    assert f"{label}: not recorded" in body, body
    assert f"{label}: None" not in body
    assert f"{label}: 0" not in body


@pytest.mark.parametrize("key,label", sorted(COUNT_LINES.items()))
def test_a_real_zero_still_reads_as_zero(key, label):
    """"Nothing new" is a finding, and it has to stay distinguishable.

    This is the assertion that makes the pair meaningful: rendering every
    count as "not recorded" would also satisfy the test above.
    """
    data = {
        "routine_name": "Quiet Week Routine",
        "status": "completed",
        **{other: 0 for other in COUNT_LINES},
    }
    body = _body(compose_notification(data, ai_summary=None))

    assert f"{label}: 0" in body, body
    assert f"{label}: not recorded" not in body


def test_supplied_counts_are_unchanged():
    """The ordinary path keeps reading exactly as it did."""
    data = {
        "routine_name": "Email Test Routine",
        "start_time": "2026-10-19T08:00:00Z",
        "end_time": "2026-10-19T08:05:00Z",
        "status": "completed",
        "result_count": 42,
        "new_count": 10,
    }
    body = _body(compose_notification(data, ai_summary=None))

    assert "Total results: 42" in body
    assert "New results: 10" in body
