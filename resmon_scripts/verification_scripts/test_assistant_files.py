"""Library files attached to an Ask conversation, and the one tool that reads them.

The property this file exists to establish: Ask reads a Library file only when the
person attached it to the conversation, at the version they attached, and only in
that conversation. Every other file stays behind the renderer-only Library routes,
and a harness that starts resmon's MCP server is never offered the tool.

Part one drives the storage and the reader in-process, over a real Library folder
(``test_evidence.workspace``). Part two is a real backend on a real socket, with the
hermetic CLI double (``fixtures/fake_claude.py``), which runs the real ``mcp_server``
with the environment resmon's MCP config gives it. **No real ``claude`` is run.**
"""
from __future__ import annotations

import json
import os
import sqlite3
import sys
import uuid
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent))
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import mcp_server  # noqa: E402
from implementation_scripts import (  # noqa: E402
    assistant_api_runtime, assistant_choices as choices, assistant_files, assistant_runtime,
    assistant_store as store, database as db, library as lib,
)
from test_evidence import Workspace, canonical, put_file, workspace  # noqa: E402,F401
from test_evidence_pdf import text_pages  # noqa: E402


def cli(**changes):
    return {'version': 1, 'runtime': 'claude_cli', 'provider': 'claude_code', 'model': 'opus', 'effort': 'high',
            **changes}


def conversation(ws: Workspace, *files: dict) -> int:
    refs = [{'file_id': f['file_id'], 'version_id': f['version_id']} for f in files]
    return store.create_bound_session(ws.conn, choices.resolve({}, cli()), 'About a paper',
                                      assistant_files.attachable(ws.conn, refs))


# ---------------------------------------------------------------------------
# Part one: attaching, and reading what was attached
# ---------------------------------------------------------------------------

def test_a_conversation_keeps_the_files_attached_to_it_and_drops_them_with_it(workspace: Workspace) -> None:
    first, second = workspace.files[0], workspace.files[1]
    sid = conversation(workspace, first, second)
    session = store.get_session(workspace.conn, sid)
    assert [(f['file_id'], f['version_id'], f['original_name'], f['media_type']) for f in session['files']] == [
        (first['file_id'], first['version_id'], 'unicode.txt', 'text/plain'),
        (second['file_id'], second['version_id'], 'hostile.md', 'text/markdown')]
    assert all(f['attached_at_utc'] for f in session['files'])
    plain = store.create_bound_session(workspace.conn, choices.resolve({}, cli()))
    assert 'files' not in store.get_session(workspace.conn, plain)
    assert store.delete_session(workspace.conn, sid)
    assert workspace.conn.execute('SELECT count(*) FROM assistant_session_files').fetchone()[0] == 0


def test_without_a_version_the_current_one_is_attached(workspace: Workspace) -> None:
    item = workspace.files[0]
    (record,) = assistant_files.attachable(workspace.conn, [{'file_id': item['file_id']}])
    assert record['version_id'] == item['version_id']


@pytest.mark.parametrize('case', ['too_many', 'duplicate', 'unknown', 'wrong_version', 'not_an_id'])
def test_what_cannot_be_attached_is_refused_and_nothing_is_kept(workspace: Workspace, case: str) -> None:
    files = workspace.files
    refs = {
        'too_many': [{'file_id': f['file_id']} for f in files[:4]],
        'duplicate': [{'file_id': files[0]['file_id']}, {'file_id': files[0]['file_id']}],
        'unknown': [{'file_id': str(uuid.uuid4())}],
        'wrong_version': [{'file_id': files[0]['file_id'], 'version_id': str(uuid.uuid4())}],
        'not_an_id': [{'file_id': '../../etc/passwd'}],
    }[case]
    with pytest.raises(lib.LibraryError) as caught:
        assistant_files.attachable(workspace.conn, refs)
    assert caught.value.reason == {'too_many': 'too_many_files', 'duplicate': 'duplicate_file',
                                   'unknown': 'unknown_file', 'wrong_version': 'wrong_version',
                                   'not_an_id': caught.value.reason}[case]
    assert workspace.conn.execute('SELECT count(*) FROM assistant_session_files').fetchone()[0] == 0


def test_the_only_attached_file_is_read_whole_with_its_digest(workspace: Workspace) -> None:
    item = workspace.files[0]
    sid = conversation(workspace, item)
    result = assistant_files.read(workspace.conn, sid, None, 1, 0)
    expected = canonical(workspace.raw[item['file_id']])
    assert result['status'] == 'extracted' and result['text'] == expected
    assert result['file']['file_id'] == item['file_id'] and result['file']['version_id'] == item['version_id']
    assert (result['page_number'], result['page_count'], result['offset'], result['next_offset']) == (1, 1, 0, None)
    assert result['page_characters'] == len(expected)
    assert result['extraction_contract'] == 'library-text-lf/v1'
    assert result['attached'] == [{'file_id': item['file_id'], 'version_id': item['version_id'],
                                   'original_name': 'unicode.txt', 'media_type': 'text/plain'}]


def test_a_long_page_is_read_in_parts_that_say_where_the_next_begins(workspace: Workspace, monkeypatch) -> None:
    item = workspace.files[0]
    sid = conversation(workspace, item)
    expected = canonical(workspace.raw[item['file_id']])
    monkeypatch.setattr(assistant_files, 'MAX_PART', 7)
    parts, offset = [], 0
    while offset is not None:
        result = assistant_files.read(workspace.conn, sid, item['file_id'], 1, offset)
        assert len(result['text']) <= 7 and result['offset'] == offset
        parts.append(result['text'])
        offset = result['next_offset']
    assert ''.join(parts) == expected and len(parts) == -(-len(expected) // 7)
    with pytest.raises(lib.LibraryError) as caught:
        assistant_files.read(workspace.conn, sid, item['file_id'], 1, len(expected))
    assert caught.value.reason == 'invalid_offset'


def test_with_several_attached_and_none_named_the_files_are_listed_and_nothing_is_read(workspace: Workspace) -> None:
    sid = conversation(workspace, workspace.files[0], workspace.files[1])
    result = assistant_files.read(workspace.conn, sid, None, 1, 0)
    assert result['status'] == 'choose_file' and result['text'] == '' and 'file' not in result
    assert [f['original_name'] for f in result['attached']] == ['unicode.txt', 'hostile.md']
    plain = store.create_bound_session(workspace.conn, choices.resolve({}, cli()))
    assert assistant_files.read(workspace.conn, plain, None, 1, 0)['status'] == 'no_file'


def test_a_file_not_attached_to_the_conversation_is_never_read(workspace: Workspace) -> None:
    sid = conversation(workspace, workspace.files[0])
    other = conversation(workspace, workspace.files[2])
    for file_id in (workspace.files[2]['file_id'], workspace.files[3]['file_id'], str(uuid.uuid4())):
        with pytest.raises(lib.LibraryError) as caught:
            assistant_files.read(workspace.conn, sid, file_id, 1, 0)
        assert (caught.value.reason, caught.value.status) == ('not_attached', 404)
    assert assistant_files.read(workspace.conn, other, workspace.files[2]['file_id'], 1, 0)['status'] == 'extracted'
    with pytest.raises(lib.LibraryError) as caught:
        assistant_files.read(workspace.conn, 999_999, None, 1, 0)
    assert caught.value.reason == 'unknown_conversation'


def test_a_file_changed_or_removed_since_it_was_attached_is_not_read(workspace: Workspace) -> None:
    item = workspace.files[0]
    sid = conversation(workspace, item)
    # Evidence's project rows point at the version too; a re-import is what changes it for real.
    workspace.conn.execute('PRAGMA foreign_keys=OFF')
    workspace.conn.execute('UPDATE library_files SET version_id=? WHERE file_id=?', (str(uuid.uuid4()), item['file_id']))
    with pytest.raises(lib.LibraryError) as caught:
        assistant_files.read(workspace.conn, sid, None, 1, 0)
    assert caught.value.reason == 'changed_file' and 'unicode.txt' in str(caught.value)
    workspace.conn.execute('DELETE FROM library_files WHERE file_id=?', (item['file_id'],))
    with pytest.raises(lib.LibraryError) as caught:
        assistant_files.read(workspace.conn, sid, None, 1, 0)
    assert (caught.value.reason, caught.value.status) == ('removed_file', 404)
    # The conversation still says what was attached.
    assert store.get_session(workspace.conn, sid)['files'][0]['original_name'] == 'unicode.txt'


def test_a_pdf_is_read_page_by_page_as_evidence_reads_it(workspace: Workspace) -> None:
    pdf = put_file(workspace, 'two-pages.pdf', text_pages(['First page of the paper.', 'Second page, with limits.']),
                   member=False)
    sid = conversation(workspace, pdf)
    first = assistant_files.read(workspace.conn, sid, None, 1, 0)
    second = assistant_files.read(workspace.conn, sid, None, 2, 0)
    assert (first['status'], first['page_count'], second['page_number']) == ('extracted', 2, 2)
    assert 'First page' in first['text'] and 'Second page' in second['text']
    assert first['extraction_contract'] == second['extraction_contract'] != 'library-text-lf/v1'
    with pytest.raises(lib.LibraryError):
        assistant_files.read(workspace.conn, sid, None, 201, 0)


def test_a_busy_page_reader_is_waited_for_briefly_then_said(workspace: Workspace, monkeypatch) -> None:
    pdf = put_file(workspace, 'busy.pdf', text_pages(['One page.']), member=False)
    sid = conversation(workspace, pdf)
    reads, asks = [], []
    real_retained = assistant_files.evidence_reader.retained_pdf

    def retained(*args, **kwargs):
        reads.append(1)
        return real_retained(*args, **kwargs)

    def busy(*args, **kwargs):
        asks.append(1)
        raise lib.LibraryError('reader_busy', 'Another bounded PDF page is being read.')

    monkeypatch.setattr(assistant_files.evidence_reader, 'retained_pdf', retained)
    monkeypatch.setattr(assistant_files.evidence_reader.evidence_pdf, 'extract', busy)
    monkeypatch.setattr(assistant_files, 'BUSY_WAIT_SECONDS', 0.5)
    with pytest.raises(lib.LibraryError) as caught:
        assistant_files.read(workspace.conn, sid, None, 1, 0)
    # The file is read and verified once; only the reader is asked again.
    assert caught.value.reason == 'reader_busy' and len(asks) >= 2 and reads == [1]


def test_a_page_the_reader_could_not_read_this_time_says_so_whatever_the_offset(workspace: Workspace,
                                                                              monkeypatch) -> None:
    pdf = put_file(workspace, 'timeout.pdf', text_pages(['One page.']), member=False)
    sid = conversation(workspace, pdf)
    monkeypatch.setattr(assistant_files.evidence_reader.evidence_pdf, 'extract',
                        lambda raw, page, cancel=None: {'status': 'timeout', 'page_number': page,
                                                        'page_count': None, 'text': ''})
    result = assistant_files.read(workspace.conn, sid, None, 1, 12_000)
    assert (result['status'], result['text'], result['next_offset']) == ('timeout', '', None)


# ---------------------------------------------------------------------------
# Who is offered the tool
# ---------------------------------------------------------------------------

def test_only_a_conversation_with_attached_files_is_offered_the_tool(monkeypatch) -> None:
    monkeypatch.delenv(mcp_server.CONVERSATION_ENV, raising=False)
    names = {t['name'] for t in mcp_server.offered_tools()}
    assert 'read_attached_file' not in names and len(names) == len(mcp_server.TOOLS) - 1
    refused = json.loads(mcp_server.call_tool('read_attached_file', {})['content'][0]['text'])
    assert refused['error'] == 'invalid_argument' and 'Nothing was read' in refused['message']
    with mcp_server.in_conversation(7):
        assert 'read_attached_file' in {t['name'] for t in mcp_server.offered_tools()}
        assert 'read_attached_file' in {t['name'] for t in assistant_api_runtime.tools_for_family('anthropic')}
    assert 'read_attached_file' not in {t['name'] for t in assistant_api_runtime.tools_for_family('anthropic')}
    monkeypatch.setenv(mcp_server.CONVERSATION_ENV, '7')
    assert mcp_server.turn_conversation() == 7
    monkeypatch.setenv(mcp_server.READ_ONLY_ENV, '1')
    assert 'read_attached_file' in {t['name'] for t in mcp_server.offered_tools()}
    for junk in ('', '0', '-3', 'seven', '7; rm', '\u00b2', '\u0667'):
        monkeypatch.setenv(mcp_server.CONVERSATION_ENV, junk)
        assert mcp_server.turn_conversation() is None
        assert 'read_attached_file' not in {t['name'] for t in mcp_server.offered_tools()}
    # The engine's own turns always say which conversation, if any: a value its
    # environment happens to hold is never read for a turn with none.
    monkeypatch.setenv(mcp_server.CONVERSATION_ENV, '7')
    with mcp_server.in_conversation(None):
        assert mcp_server.turn_conversation() is None
        assert 'read_attached_file' not in {t['function']['name'] for t in assistant_api_runtime.tools_for_family('openai')}


def test_the_tool_is_a_read_and_needs_no_card() -> None:
    assert 'read_attached_file' in mcp_server.READ_TOOLS
    assert mcp_server.CONVERSATION_TOOLS == frozenset({'read_attached_file'})


@pytest.mark.parametrize('args', [{'page': 0}, {'page': 201}, {'page': '2'}, {'page': True}, {'offset': -1},
                                  {'file_id': ''}, {'file_id': 3}])
def test_the_tool_refuses_a_page_or_offset_it_would_have_to_guess(args: dict) -> None:
    with mcp_server.in_conversation(7):
        refused = json.loads(mcp_server.call_tool('read_attached_file', args)['content'][0]['text'])
    assert refused['error'] == 'invalid_argument'


def test_both_cli_connections_hand_the_conversation_to_the_server_they_start(tmp_path) -> None:
    claude = assistant_runtime.ClaudeCliRuntime(cli_path='/bin/true', backend_port=8999)
    codex = assistant_runtime.CodexCliRuntime(cli_path='/bin/true', backend_port=8999)
    plain = claude.mcp_config(3, str(tmp_path))['mcpServers']['resmon']['env']
    assert mcp_server.CONVERSATION_ENV not in plain
    assert not any(mcp_server.CONVERSATION_ENV in o for o in codex.mcp_overrides())
    with mcp_server.in_conversation(3):
        env = claude.mcp_config(3, str(tmp_path))['mcpServers']['resmon']['env']
        assert env[mcp_server.CONVERSATION_ENV] == '3'
        assert f'mcp_servers.resmon.env.{mcp_server.CONVERSATION_ENV}="3"' in codex.mcp_overrides()
    assert 'mcp__resmon__read_attached_file' in claude.allowed_tools()


# ---------------------------------------------------------------------------
# Part two: a real backend, the CLI double, and the real MCP server
# ---------------------------------------------------------------------------

import test_assistant_api as api  # noqa: E402

_API = api._API


@pytest.fixture(scope='module')
def backend(tmp_path_factory):
    state = tmp_path_factory.mktemp('assistant-files')
    shim = state / 'claude-shim'
    shim.write_text(f'#!/bin/sh\nexec "{sys.executable}" "{api.FAKE_CLAUDE}" "$@"\n')
    shim.chmod(0o755)
    saved = {k: os.environ.get(k) for k in ('RESMON_AI_CLI_DISCOVERY', 'RESMON_STATE_DIR')}
    os.environ['RESMON_AI_CLI_DISCOVERY'] = 'configured-only'
    os.environ['RESMON_STATE_DIR'] = str(state / 'resmon-state')
    server = api.Backend(state)
    try:
        server.start()
    finally:
        for key, value in saved.items():
            if value is None:
                os.environ.pop(key, None)
            else:
                os.environ[key] = value
    try:
        _API.put(f'{server.base}/api/settings/ai', json={'settings': {'ai_cli_path': str(shim)}},
                 timeout=20).raise_for_status()
        yield server
    finally:
        server.stop()


@pytest.fixture(scope='module')
def library(backend, tmp_path_factory) -> dict:
    """A Library folder in the backend's own database, with a paper's PDF and a private note."""
    parent = tmp_path_factory.mktemp('library-parent')
    conn = db.get_connection(backend.db_path)
    try:
        vault = lib.create_vault(conn, str(parent))['vault']
        paper = db.insert_document(conn, {'source_repository': 'synthetic', 'external_id': 'attached-paper',
                                          'title': 'A paper with a file', 'metadata_hash': 'attached'})
        made = {}
        for name, raw in (('paper.pdf', text_pages(['Findings: the method works.', 'Limits: small samples.'])),
                          ('private-notes.md', b'# Not for Ask\nA note nobody attached.\n')):
            with lib.Import(conn, vault['vault_id'], name, paper) as upload:
                upload.write(raw)
                made[name] = upload.finish()['file']
        return made
    finally:
        conn.close()


def _tool_results(events: list[dict]) -> list[dict]:
    return [json.loads(e['content']) if isinstance(e.get('content'), str) else e
            for e in events if e.get('type') == 'tool_result']


def test_ask_reads_the_attached_file_and_nothing_else(backend, library) -> None:
    pdf, notes = library['paper.pdf'], library['private-notes.md']
    created = _API.post(f'{backend.base}/api/assistant/sessions', json={
        'title': 'A paper with a file', 'choices': cli(), 'files': [{'file_id': pdf['file_id']}]}, timeout=20)
    assert created.status_code == 201, created.text
    session = created.json()
    assert [f['original_name'] for f in session['files']] == ['paper.pdf']

    prompt = '\n'.join([
        'CALL:read_attached_file {"page": 2}',
        'CALL:read_attached_file {"file_id": "%s"}' % notes['file_id'],
        'SAY:read',
    ])
    events = api._turn(backend.base, session['id'], prompt)
    stored = _API.get(f'{backend.base}/api/assistant/sessions/{session["id"]}', timeout=20).json()
    results = [json.loads(r) if isinstance(r, str) else r
               for m in stored['messages'] if m['role'] == 'assistant'
               for r in (m.get('tool_results') or [])]
    text = json.dumps(results) + json.dumps(events)
    assert 'Limits: small samples.' in text
    assert 'not attached to this conversation' in text
    assert 'A note nobody attached' not in text
    assert stored['session']['files'][0]['file_id'] == pdf['file_id']

    # The route itself, as any holder of the local token would call it.
    route = f'{backend.base}/api/assistant/sessions/{session["id"]}/file-text'
    page = _API.get(route, params={'page': 1}, timeout=30)
    assert page.status_code == 200 and 'Findings' in page.json()['text']
    refused = _API.get(route, params={'file_id': notes['file_id']}, timeout=30)
    assert refused.status_code == 404 and refused.json()['detail']['reason'] == 'not_attached'


def test_an_ordinary_conversation_is_not_offered_the_tool(backend, library) -> None:
    created = _API.post(f'{backend.base}/api/assistant/sessions', json={'choices': cli()}, timeout=20)
    assert created.status_code == 201 and 'files' not in created.json()
    events = api._turn(backend.base, created.json()['id'], 'CALL:read_attached_file {}\nSAY:done')
    assert 'there is none here' in json.dumps(events) or 'Nothing was read' in json.dumps(events)
    route = f'{backend.base}/api/assistant/sessions/{created.json()["id"]}/file-text'
    assert _API.get(route, timeout=20).json()['status'] == 'no_file'


def test_a_file_outside_the_library_cannot_be_attached(backend, library) -> None:
    created = _API.post(f'{backend.base}/api/assistant/sessions', json={
        'choices': cli(), 'files': [{'file_id': str(uuid.uuid4())}]}, timeout=20)
    assert created.status_code == 404 and created.json()['detail']['reason'] == 'unknown_file'
    sessions = _API.get(f'{backend.base}/api/assistant/sessions', timeout=20).json()
    assert all(s.get('title') != 'never made' for s in sessions.get('sessions', []))
