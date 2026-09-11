"""Portable persisted transcripts, with no settings, runtime launch or file write."""
from __future__ import annotations

import json
import re
from typing import Any

MAX_EXPORT_BYTES = 8 * 1024 * 1024
LIMITATIONS = [
    "Persisted messages only; not guaranteed to include a final turn or future messages.",
    "Live-only stream fragments and pending approval cards are not included.",
    "Historical completion, approval decisions, effects and current effort are unknown.",
    "Tokens and cost are recorded values, possibly absent; they do not establish billed cost.",
    "Session IDs are corpus-local, not globally unique.",
    "Includes saved messages and tool data; review before sharing.",
]


def _reject_constant(value: str) -> None:
    raise ValueError("Non-JSON numeric constant: " + value)


def tool_data(raw: Any) -> dict:
    if raw is None:
        return {"data": None, "unreadable": False}
    try:
        return {"data": json.loads(raw, parse_constant=_reject_constant), "unreadable": False}
    except (ValueError, TypeError):
        return {"data": None, "unreadable": True, "raw": raw}


def literal(value: Any) -> str:
    # A fence longer than any run in the text cannot be closed by that text.
    # Everything untrusted (including titles and timestamps) stays in a block.
    text = value if isinstance(value, str) else json.dumps(value, ensure_ascii=False, indent=2)
    fence = "`" * max(3, 1 + max((len(x) for x in re.findall(r"`+", text)), default=0))
    return fence + "\n" + text + "\n" + fence + "\n"


def export_snapshot(snapshot: dict, fmt: str, observations: dict) -> dict:
    if fmt not in ("json", "markdown"):
        raise ValueError("Choose JSON or Markdown.")
    session = {k: snapshot['session'][k] for k in
               ('id', 'runtime', 'model', 'created_at', 'updated_at')}
    session['title'] = snapshot['stored_title']
    messages = []
    for raw in snapshot['raw_messages']:
        m = {k: raw[k] for k in ('id', 'role', 'content', 'created_at',
                                 'input_tokens', 'output_tokens', 'cost_usd')}
        m.update({k: tool_data(raw[k]) for k in ('tool_calls', 'tool_results')})
        messages.append(m)
    document = {'version': 1, 'session': session, 'messages': messages,
                'choices_version': 1, 'choices': snapshot['session'].get('choices'),
                'turn_choices': snapshot.get('turn_choices', []),
                'snapshot': snapshot['snapshot'], 'activity_observation': observations,
                'completion_status': 'unknown', 'limitations': LIMITATIONS}
    if fmt == 'json':
        text = json.dumps(document, ensure_ascii=False, indent=2) + '\n'
    else:
        parts = ['# Saved conversation\n', '\n'.join('- ' + x for x in LIMITATIONS) + '\n',
                 '## Session\n', literal(session), '## Snapshot\n', literal(snapshot['snapshot']),
                 '## Separately observed current activity\n', literal(observations),
                 'Historical completion status: unknown.\n']
        parts.extend(['## Requested choices and literal runtime reports\n',
                      'Historical settings are unknown. Requests are not proof of execution; runtime-reported effort is not available.\n',
                      literal({'choices_version': 1, 'choices': document['choices'], 'turn_choices': document['turn_choices']})])
        for message in messages:
            parts.extend(['## Message\n', literal({k: v for k, v in message.items() if k != 'content'}),
                          '### Saved text\n', literal(message['content'])])
        text = '\n'.join(parts)
    if len(text.encode('utf-8')) > MAX_EXPORT_BYTES:
        raise ValueError("This transcript exceeds the 8 MiB export limit for this format. Nothing was truncated.")
    sid = session['id']
    return {'session_id': sid, 'format': fmt, 'filename': f"resmon-chat-{sid}." + ('json' if fmt == 'json' else 'md'),
            'content_type': 'application/json' if fmt == 'json' else 'text/markdown',
            'text': text, 'snapshot': snapshot['snapshot']}
