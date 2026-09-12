"""Real isolated HTTP/MCP and parser ownership boundaries for Evidence.

The suite drives 12 Evidence endpoint guards and selected effects plus two old
MCP reads. Full prior-tool execution is not implied by the inventory census.
"""
from __future__ import annotations

import ast
from contextlib import contextmanager
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import socket
import sqlite3
import subprocess
import sys
import threading
import time
import uuid
from urllib.parse import urlencode

import httpx
import pytest

# Reuse the existing real-socket, explicitly isolated Library fixture. It inherits
# the phase runner's unchanged guard environment; do not replace PYTHONPATH.
from test_library_boundary import http_library  # noqa: F401
from test_evidence_pdf import ALPHA, BETA, two_pages

HEADERS = {'Origin': 'http://127.0.0.1:12345', 'X-Resmon-Library': '1'}
ROOT = '/api/evidence/projects'
P = '11111111-1111-4111-8111-111111111111'
F = '22222222-2222-4222-8222-222222222222'
N = '33333333-3333-4333-8333-333333333333'
ROUTES = {
    ('GET', ROOT), ('POST', ROOT), ('GET', ROOT + '/{project_id}'),
    ('PATCH', ROOT + '/{project_id}'), ('GET', ROOT + '/{project_id}/files'),
    ('POST', ROOT + '/{project_id}/files'),
    ('DELETE', ROOT + '/{project_id}/files/{file_id}'),
    ('GET', ROOT + '/{project_id}/notes'), ('POST', ROOT + '/{project_id}/notes'),
    ('PATCH', ROOT + '/{project_id}/notes/{note_id}'),
    ('GET', ROOT + '/{project_id}/reader/{file_id}'),
    ('POST', ROOT + '/{project_id}/bundle'),
}
EXPECTED_WRITES = {'run_sweep', 'create_routine', 'run_routine', 'activate_routine',
                   'deactivate_routine', 'update_settings', 'create_watch_profile'}
EXPECTED_READS = {'health', 'search_corpus', 'find_similar', 'list_sources',
                  'list_routines', 'get_routine', 'list_executions', 'get_execution',
                  'get_execution_results', 'get_search_record', 'explain_match',
                  'get_paper_lifecycle', 'get_analytics', 'get_watchdog_findings',
                  'export_references', 'list_watch_profiles', 'get_watch_profile',
                  'get_profile_matches'}


def _source_root() -> Path:
    # Valid after integration into resmon_scripts/verification_scripts only.
    result = Path(__file__).resolve().parents[2]
    assert (result / 'resmon_scripts' / 'resmon.py').is_file()
    return result


def _json(response, expected=200):
    assert response.status_code == expected, response.text
    return response.json()


def _reason(response):
    value = response.json()['detail']
    return value['reason'] if isinstance(value, dict) else value


def _snapshot(database: str) -> tuple:
    """Stable synthetic row state, excluding backend timing/log metadata."""
    with sqlite3.connect(database) as conn:
        return tuple((table, tuple(conn.execute(f'SELECT * FROM {table} ORDER BY id')))
                     for table in ('evidence_projects', 'evidence_project_files', 'evidence_notes'))


def _setup(client, record, tmp, *, pdf=False):
    parent = tmp / ('pdf-vault-parent' if pdf else 'text-vault-parent')
    parent.mkdir()
    vault = _json(client.post('/api/library/vault', headers=HEADERS,
                             json={'parent_directory': str(parent)}), 201)['vault']
    vid = vault['vault_id']
    raw = two_pages() if pdf else 'Exact 😀 evidence\r\nsecond e\u0301 line\rfinal'.encode('utf-8')
    original = tmp / ('original.pdf' if pdf else 'original.txt')
    original.write_bytes(raw)
    item = _json(client.post('/api/library/files', headers={**HEADERS, 'Content-Type': 'application/octet-stream'},
                            params={'expected_vault_id': vid, 'filename': original.name}, content=raw), 201)['file']
    project = _json(client.post(ROOT, headers=HEADERS,
                               json={'expected_vault_id': vid, 'name': 'Synthetic Evidence project'}), 201)['project']
    pid = project['project_id']
    added = _json(client.post(f'{ROOT}/{pid}/files', headers=HEADERS,
                             json={'expected_vault_id': vid, 'expected_revision': project['revision'],
                                   'file_id': item['file_id'], 'version_id': item['version_id']}))
    return {'client': client, 'record': record, 'tmp': tmp, 'vault_id': vid, 'project_id': pid,
            'file_id': item['file_id'], 'version_id': item['version_id'],
            'revision': added['project']['revision'], 'original': original, 'raw': raw,
            'retained': parent / vault['label'] / item['relative_path']}


@pytest.fixture
def selected(http_library):
    return _setup(*http_library)


def _reader_path(ctx):
    return f"{ROOT}/{ctx['project_id']}/reader/{ctx['file_id']}"


def _reader_query(ctx, **changes):
    return {'expected_vault_id': ctx['vault_id'], 'version_id': ctx['version_id'],
            'page': '1', 'representation': 'text', **changes}


def test_exact_twelve_evidence_route_inventory():
    tree = ast.parse((_source_root() / 'resmon_scripts' / 'resmon.py').read_text())
    actual = set()
    decorators = 0
    for node in ast.walk(tree):
        if not isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
            continue
        for deco in node.decorator_list:
            if (isinstance(deco, ast.Call) and isinstance(deco.func, ast.Attribute)
                    and isinstance(deco.func.value, ast.Name) and deco.func.value.id == 'app'
                    and deco.args and isinstance(deco.args[0], ast.Constant)
                    and isinstance(deco.args[0].value, str)
                    and deco.args[0].value.startswith('/api/evidence/')):
                decorators += 1
                actual.add((deco.func.attr.upper(), deco.args[0].value))
    assert decorators == 12 and actual == ROUTES
    # The complete 158 HTTP decorator census belongs to final source comparison;
    # this asserts this phase's 12 routes, including absence of a deletion API.


@pytest.mark.parametrize('headers', [
    {}, {'Origin': 'null', 'X-Resmon-Library': '1'},
    {'Origin': 'https://other.invalid', 'X-Resmon-Library': '1'},
    {'Origin': 'http://localhost:12345', 'X-Resmon-Library': '1'},
    {'Origin': 'http://127.0.0.1:12345/', 'X-Resmon-Library': '1'},
    {'Origin': 'http://user@127.0.0.1:12345', 'X-Resmon-Library': '1'},
    {'Origin': 'http://127.0.0.1:12345'},
    {'Origin': 'http://127.0.0.1:12345', 'X-Resmon-Library': 'true'},
    [('Origin', 'http://127.0.0.1:12345'), ('Origin', 'http://127.0.0.1:12345'), ('X-Resmon-Library', '1')],
    [('Origin', 'http://127.0.0.1:12345'), ('X-Resmon-Library', '1'), ('X-Resmon-Library', '1')],
])
def test_twelve_routes_refuse_origin_before_parsing_or_effects(http_library, headers):
    client, record, tmp = http_library
    before = _snapshot(record['database'])
    for method, pattern in sorted(ROUTES):
        path = pattern.format(project_id=P, file_id=F, note_id=N)
        response = client.request(method, path, headers=headers, content=b'not valid JSON')
        assert response.status_code == 403 and _reason(response) == 'origin_refused'
        assert response.headers['cache-control'] == 'no-store'
    assert _snapshot(record['database']) == before
    assert _json(client.get('/api/library', headers=HEADERS))['vault'] is None
    assert not list(tmp.rglob('resmon-library-*'))


@pytest.mark.parametrize('raw', [
    b'{"name":"x"}', b'[]', b'null', b'{', b'\xff',
    b'{"expected_vault_id":VID,"name":"x","name":"y"}',
    b'{"expected_vault_id":VID,"name":"x","source_path":"/fixture-only/unknown"}',
    b'{"expected_vault_id":VID,"name":true}',
    b'{"expected_vault_id":VID,"name":"\\u0000"}',
    b'{"expected_vault_id":VID,"name":"\\ud800"}',
    b'{"expected_vault_id":VID,"name":' + b'[' * 2000 + b'0' + b']' * 2000 + b'}',
])
def test_strict_create_bodies_have_zero_effects(selected, raw):
    ctx = selected
    raw = raw.replace(b'VID', json.dumps(ctx['vault_id']).encode('ascii'))
    before = _snapshot(ctx['record']['database'])
    response = ctx['client'].post(ROOT, headers={**HEADERS, 'Content-Type': 'application/json'}, content=raw)
    assert response.status_code == 422, response.text
    assert response.headers['cache-control'] == 'no-store'
    assert _snapshot(ctx['record']['database']) == before


@pytest.mark.parametrize('revision', [True, 1.0, '1', None, 0, -1])
def test_revision_body_never_coerces(selected, revision):
    ctx = selected
    before = _snapshot(ctx['record']['database'])
    response = ctx['client'].patch(f"{ROOT}/{ctx['project_id']}", headers=HEADERS,
                                  json={'expected_vault_id': ctx['vault_id'], 'expected_revision': revision, 'name': 'must not save'})
    assert response.status_code == 422, response.text
    assert _snapshot(ctx['record']['database']) == before


def test_project_name_limit_applies_after_boundary_trim(selected):
    ctx = selected
    canonical = 'x' * 120
    created = _json(ctx['client'].post(ROOT, headers=HEADERS,
                    json={'expected_vault_id': ctx['vault_id'], 'name': '  ' + canonical + '  '}), 201)
    assert created['project']['name'] == canonical
    renamed = _json(ctx['client'].patch(f"{ROOT}/{ctx['project_id']}", headers=HEADERS,
                    json={'expected_vault_id': ctx['vault_id'], 'expected_revision': ctx['revision'],
                          'name': '\t' + canonical + '\n'}))
    assert renamed['project']['name'] == canonical


@pytest.mark.parametrize('extra', [
    [('limit', '0')], [('limit', '51')], [('limit', 'true')], [('limit', '1.0')],
    [('limit', '+1')], [('limit', '01')], [('limit', ' 1')], [('limit', '-1')],
    [('limit', '1'), ('limit', '1')], [('source_path', '/fixture-only/unknown')],
])
def test_query_types_duplicate_and_unknown_keys_refuse(selected, extra):
    ctx = selected
    before = _snapshot(ctx['record']['database'])
    response = ctx['client'].get(ROOT, headers=HEADERS,
                                 params=[('expected_vault_id', ctx['vault_id']), *extra])
    assert response.status_code == 422, response.text
    assert _snapshot(ctx['record']['database']) == before


def test_missing_wrong_and_duplicate_vault_never_select_ambient_state(selected):
    ctx = selected
    before = _snapshot(ctx['record']['database'])
    for params, code in [({}, 422), ({'expected_vault_id': str(uuid.uuid4())}, 409),
                         ([('expected_vault_id', ctx['vault_id']), ('expected_vault_id', ctx['vault_id'])], 422)]:
        response = ctx['client'].get(ROOT, headers=HEADERS, params=params)
        assert response.status_code == code, response.text
    assert _snapshot(ctx['record']['database']) == before


def test_streamed_body_limit_and_incomplete_transport_leave_rows_unchanged(selected):
    ctx = selected
    before = _snapshot(ctx['record']['database'])
    # Counts actual streamed chunks; no trusting Content-Length or limiting only
    # the model after buffering. The body need not be valid JSON to hit the cap.
    def chunks():
        for _ in range(5):
            yield b'x' * 65536
    response = ctx['client'].post(ROOT, headers={**HEADERS, 'Content-Type': 'application/json'}, content=chunks())
    assert response.status_code == 413 and _reason(response) == 'body_limit'
    port = ctx['record']['port']
    assert port != 8742
    with socket.create_connection(('127.0.0.1', port), timeout=5) as connection:
        request = (f'POST {ROOT} HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\n'
                   f'Origin: {HEADERS["Origin"]}\r\nX-Resmon-Library: 1\r\n'
                   'Content-Type: application/json\r\nContent-Length: 10000\r\n\r\n{"partial":').encode()
        connection.sendall(request)
    # A subsequent request traverses the live backend after the disconnect.
    assert _json(ctx['client'].get(ROOT, headers=HEADERS, params={'expected_vault_id': ctx['vault_id']}))['vault_id'] == ctx['vault_id']
    assert _snapshot(ctx['record']['database']) == before


def test_reader_identity_bytes_and_literal_basis(selected):
    ctx = selected
    response = ctx['client'].get(_reader_path(ctx), headers=HEADERS, params=_reader_query(ctx))
    body = _json(response)
    canonical = ctx['raw'].decode('utf-8').replace('\r\n', '\n').replace('\r', '\n')
    assert body['contract_version'] == 1 and body['status'] == 'extracted'
    for key in ('vault_id', 'project_id', 'file_id', 'version_id'):
        assert body[key] == ctx[key]
    assert body['text'] == canonical and body['page_number'] == body['page_count'] == 1
    assert body['page_text_sha256'] == hashlib.sha256(canonical.encode()).hexdigest()
    assert body['examined_pages'] == [1] and body['remaining_pages'] == 'not_examined'
    assert response.headers['cache-control'] == 'no-store'
    for changes, expected in [({'page': '2'}, 422), ({'page': '1.0'}, 422),
                              ({'version_id': str(uuid.uuid4())}, 409),
                              ({'representation': 'html'}, 422)]:
        failed = ctx['client'].get(_reader_path(ctx), headers=HEADERS, params=_reader_query(ctx, **changes))
        assert failed.status_code == expected and 'text' not in failed.json()
    assert ctx['original'].read_bytes() == ctx['retained'].read_bytes() == ctx['raw']


def test_pdf_representation_is_exact_inert_bytes(http_library):
    ctx = _setup(*http_library, pdf=True)
    response = ctx['client'].get(_reader_path(ctx), headers=HEADERS,
                                 params=_reader_query(ctx, representation='pdf'))
    assert response.status_code == 200 and response.content == ctx['raw']
    assert response.headers['content-type'].split(';')[0] == 'application/octet-stream'
    assert response.headers['x-content-type-options'] == 'nosniff'
    assert response.headers['cache-control'] == 'no-store'
    for key, header in [('vault_id', 'x-resmon-vault'), ('project_id', 'x-resmon-project'),
                        ('file_id', 'x-resmon-file'), ('version_id', 'x-resmon-version')]:
        assert response.headers[header] == ctx[key]
    assert response.headers['x-resmon-sha256'] == hashlib.sha256(ctx['raw']).hexdigest()
    page = _json(ctx['client'].get(_reader_path(ctx), headers=HEADERS, params=_reader_query(ctx, page='2')))
    assert page['text'] == BETA and page['page_count'] == 2 and page['examined_pages'] == [2]


def test_nested_anchor_duplicate_key_is_rejected_without_save(selected):
    ctx = selected
    before = _snapshot(ctx['record']['database'])
    payload = {'expected_vault_id': ctx['vault_id'], 'expected_revision': ctx['revision'],
               'file_id': ctx['file_id'], 'version_id': ctx['version_id'], 'kind': 'passage', 'body': '',
               'anchor': {'page_number': 1, 'extraction_contract': 'library-text-lf/v1',
                          'page_text_sha256': 'a' * 64, 'start_codepoint': 0, 'end_codepoint': 1, 'quote': 'x'}}
    raw = json.dumps(payload).replace('"page_number": 1', '"page_number": 1, "page_number": 2').encode()
    response = ctx['client'].post(f"{ROOT}/{ctx['project_id']}/notes", headers=HEADERS, content=raw)
    assert response.status_code == 422 and _snapshot(ctx['record']['database']) == before


def test_cancel_after_canonical_read_prevents_note_transaction(selected, monkeypatch):
    # Deliberately pause/cancel at the real read-to-write seam. This is a domain
    # race fixture, not a claim that every HTTP disconnect arrives before commit.
    from implementation_scripts import evidence, evidence_reader, database
    ctx = selected
    before = _snapshot(ctx['record']['database'])
    basis = _json(ctx['client'].get(_reader_path(ctx), headers=HEADERS, params=_reader_query(ctx)))
    cancel = threading.Event()
    original_read = evidence_reader.read_text
    def cancel_after_actual_read(*args, **kwargs):
        value = original_read(*args, **kwargs)
        cancel.set()
        return value
    monkeypatch.setattr(evidence_reader, 'read_text', cancel_after_actual_read)
    anchor = {'page_number': 1, 'extraction_contract': basis['extraction_contract'],
              'page_text_sha256': basis['page_text_sha256'], 'start_codepoint': 0,
              'end_codepoint': len(basis['text']), 'quote': basis['text']}
    conn = database.get_connection(ctx['record']['database'])
    try:
        with pytest.raises(evidence.EvidenceError):
            evidence.create_note(conn, ctx['vault_id'], ctx['project_id'], ctx['revision'],
                                 ctx['file_id'], ctx['version_id'], 'passage', '', anchor, cancel=cancel)
    finally:
        conn.close()
    assert cancel.is_set() and _snapshot(ctx['record']['database']) == before


def test_parser_pre_cancelled_request_never_spawns(monkeypatch):
    from implementation_scripts import evidence, evidence_pdf as supervisor
    cancel = threading.Event(); cancel.set()
    def must_not_spawn(*args, **kwargs):
        raise AssertionError('A pre-cancelled parser request launched a child')
    monkeypatch.setattr(supervisor.subprocess, 'Popen', must_not_spawn)
    with pytest.raises(evidence.EvidenceError) as refused:
        supervisor.extract(two_pages(), 1, cancel=cancel)
    assert refused.value.reason == 'cancelled'


def test_parser_cleanup_error_cannot_permanently_hold_lease(tmp_path, monkeypatch):
    from implementation_scripts import evidence_pdf as supervisor
    original_temp = supervisor.tempfile.TemporaryDirectory
    class CleanupFailure:
        def __init__(self, *args, **kwargs):
            kwargs['dir'] = tmp_path
            self.owned = original_temp(*args, **kwargs)
            self.name = self.owned.name
        def cleanup(self):
            self.owned.cleanup()
            raise OSError('synthetic failure after owned scratch removal')
    # Actual child completion occurs before this solely synthetic cleanup error.
    # Restore the test-owned leaked lock on failure so later tests are not poisoned.
    try:
        with monkeypatch.context() as patch:
            patch.setattr(supervisor.tempfile, 'TemporaryDirectory', CleanupFailure)
            try:
                supervisor.extract(two_pages(), 1)
            except OSError as exc:
                assert str(exc) == 'synthetic failure after owned scratch removal'
        acquired = supervisor._LEASE.acquire(blocking=False)
        if acquired:
            supervisor._LEASE.release()
        assert acquired, 'Owned child is reaped, but cleanup error leaked the single-parser lease'
    finally:
        if supervisor._LEASE.locked():
            supervisor._LEASE.release()
    assert supervisor.extract(two_pages(), 2)['text'] == BETA


# A fixed test-only backend launcher can observe the actual parser without adding
# a production route. It preserves the parent runner's guard/PYTHONPATH. Only this
# authored fixed hang worker is selected in the failure fixture; no HTTP client
# can provide a command, path, environment, module or code payload.
_OBSERVED_SERVER = r'''
import datetime, hashlib, json, os, pathlib, socket, subprocess, sys, threading
import uvicorn, resmon
from implementation_scripts import evidence_pdf, runtime_identity
receipt, journal, worker = map(pathlib.Path, sys.argv[1:4])
lock = threading.Lock()
def emit(value):
    with lock:
        with journal.open('a', encoding='utf-8') as out:
            out.write(json.dumps(value) + '\n')
original_popen = subprocess.Popen
original_extract = evidence_pdf.extract
evidence_pdf._WORKER = worker

def observed_popen(*args, **kwargs):
    process = original_popen(*args, **kwargs)
    emit({'event':'spawn','pid':process.pid,'start':datetime.datetime.now(datetime.timezone.utc).isoformat(),
          'cwd':kwargs.get('cwd'),'worker':str(worker)})
    return process

def observed_extract(*args, **kwargs):
    try:
        return original_extract(*args, **kwargs)
    finally:
        emit({'event':'finished','run':dict(evidence_pdf.LAST_RUN)})
evidence_pdf.subprocess.Popen = observed_popen
evidence_pdf.extract = observed_extract
s = socket.socket(); s.bind(('127.0.0.1',0)); s.listen(128)
port = s.getsockname()[1]
assert port != 8742
record = {'pid':os.getpid(),'port':port,'source':os.getcwd(),
          'state':os.environ['RESMON_STATE_DIR'],'database':os.environ['RESMON_DB_PATH'],
          'start':resmon._STARTED_AT,'runtime_id':runtime_identity.current_runtime_id(),
          'source_sha256':hashlib.sha256(pathlib.Path('resmon.py').read_bytes()).hexdigest()}
receipt.write_text(json.dumps(record), encoding='utf-8')
uvicorn.Server(uvicorn.Config(resmon.app,log_level='error')).run(sockets=[s])
'''


def _journal(path):
    if not path.exists():
        return []
    records = []
    for line in path.read_text().splitlines():
        try:
            records.append(json.loads(line))
        except json.JSONDecodeError:
            pass  # Concurrent final incomplete append; next bounded read retries.
    return records


def _wait_until(check, timeout=5):
    end = time.monotonic() + timeout
    while time.monotonic() < end:
        result = check()
        if result:
            return result
        time.sleep(.02)
    raise AssertionError('Bounded observation did not arrive')


@contextmanager
def _observed_backend(tmp):
    source = _source_root() / 'resmon_scripts'
    state = tmp / 'state'; state.mkdir()
    for child in ('reports', 'scratch', 'originals', 'profile', 'export'):
        (tmp / child).mkdir()
    worker = tmp / 'fixed-hang-worker.py'
    worker.write_text('import sys,time\nsys.stdin.buffer.read()\ntime.sleep(60)\n')
    receipt, journal = tmp / 'identity.json', tmp / 'parser.jsonl'
    env = dict(os.environ)
    env.update({'RESMON_STATE_DIR': str(state), 'RESMON_DB_PATH': str(state / 'resmon.db'),
                'RESMON_REPORTS_DIR': str(tmp / 'reports'), 'RESMON_PORT_FILE': str(state / 'resmon.port'),
                'RESMON_DISABLE_SCHEDULER': '1', 'TMPDIR': str(tmp / 'scratch'),
                'PYTHON_KEYRING_BACKEND': 'keyring.backends.null.Keyring'})
    with (tmp / 'backend.log').open('w') as log:
        proc = subprocess.Popen([sys.executable, '-c', _OBSERVED_SERVER, str(receipt), str(journal), str(worker)],
                                cwd=source, env=env, stdout=log, stderr=log)
        try:
            _wait_until(lambda: receipt.exists() or proc.poll() is not None, timeout=10)
            assert proc.poll() is None, 'Observed backend exited during startup; inspect owned backend.log'
            record = json.loads(receipt.read_text())
            assert record['pid'] == proc.pid and record['port'] != 8742
            assert record['source'] == str(source) and record['database'] == str(state / 'resmon.db')
            assert record['source_sha256'] == hashlib.sha256((source / 'resmon.py').read_bytes()).hexdigest()
            with httpx.Client(base_url=f"http://127.0.0.1:{record['port']}", timeout=10, trust_env=False) as client:
                def ready():
                    try:
                        return client.get('/api/health', params={'expected_runtime_id': record['runtime_id']})
                    except httpx.ConnectError:
                        return None
                health = _wait_until(ready, timeout=15)
                value = _json(health)
                assert value['pid'] == proc.pid and value['started_at'] == record['start']
                assert value['identity']['runtime_id'] == record['runtime_id']
                print('EVIDENCE_BOUNDARY_IDENTITY', json.dumps(record), flush=True)
                yield client, record, journal
        finally:
            if proc.poll() is None:
                proc.terminate()
                try:
                    proc.wait(timeout=10)
                except subprocess.TimeoutExpired:
                    proc.kill()
            proc.wait(timeout=5)
            print('EVIDENCE_BOUNDARY_BACKEND_REAPED', proc.pid, proc.returncode, flush=True)


def test_real_http_disconnect_reaps_hung_parser_and_busy_second_request(tmp_path):
    # Synthetic fixed-child hang on a real HTTP/backend/supervisor/OS process seam.
    # This does not claim a real PDF parser bug is equivalent to sleeping.
    with _observed_backend(tmp_path) as (client, record, journal):
        ctx = _setup(client, record, tmp_path, pdf=True)
        before = _snapshot(record['database'])
        path = _reader_path(ctx) + '?' + urlencode(_reader_query(ctx))
        port = record['port']; assert port != 8742
        with socket.create_connection(('127.0.0.1', port), timeout=5) as connection:
            wire = (f'GET {path} HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\n'
                    f'Origin: {HEADERS["Origin"]}\r\nX-Resmon-Library: 1\r\n\r\n').encode()
            connection.sendall(wire)
            spawned = _wait_until(lambda: next((r for r in _journal(journal) if r['event'] == 'spawn'), None))
            os.kill(spawned['pid'], 0)  # Observe alive while the first HTTP owner is connected.
            busy = client.get(_reader_path(ctx), headers=HEADERS, params=_reader_query(ctx, page='2'))
            assert busy.status_code == 409 and _reason(busy) == 'reader_busy'
            assert len([r for r in _journal(journal) if r['event'] == 'spawn']) == 1
        # Actual socket close, then observe the child cleanup receipt.
        finished = _wait_until(lambda: next((r['run'] for r in _journal(journal)
                              if r['event'] == 'finished' and r['run'].get('pid') == spawned['pid']), None))
        assert finished['status'] == 'cancelled'
        assert finished['reaped'] and finished['pipe_threads_stopped'] and finished['scratch_removed']
        assert not Path(finished['scratch']).exists()
        with pytest.raises(ProcessLookupError):
            os.kill(spawned['pid'], 0)
        assert _snapshot(record['database']) == before
        assert ctx['original'].read_bytes() == ctx['retained'].read_bytes() == ctx['raw']


def _stdio(source, env, requests):
    """Actual bounded jsonlines MCP process; explicit named state/port only."""
    payload = ''.join(json.dumps(item) + '\n' for item in requests).encode()
    proc = subprocess.Popen([sys.executable, str(source / 'mcp_server.py')], cwd=source, env=env,
                            stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    try:
        stdout, stderr = proc.communicate(payload, timeout=20)
        assert proc.returncode == 0 and len(stdout) <= 1024 * 1024 and len(stderr) <= 65536
        return [json.loads(line) for line in stdout.decode('utf-8').splitlines()]
    finally:
        if proc.poll() is None:
            proc.kill()
        proc.wait(timeout=5)


def test_actual_stdio_inventory_and_two_old_expected_instance_reads(selected):
    from implementation_scripts import database
    ctx = selected
    health = _json(ctx['client'].get('/api/health'))
    assert health['pid'] == ctx['record']['pid']
    runtime = health['identity']['runtime_id']
    conn = database.get_connection(ctx['record']['database'])
    try:
        exec_id = database.insert_execution(conn, {'execution_type': 'deep_sweep',
            'parameters': json.dumps({'synthetic_marker': 'evidence-boundary-only'}),
            'start_time': datetime.now(timezone.utc).isoformat(), 'status': 'completed'})
    finally:
        conn.close()
    port = ctx['record']['port']; assert port != 8742
    source = _source_root() / 'resmon_scripts'
    state = Path(ctx['record']['state'])
    env = dict(os.environ)
    env.update({'RESMON_PORT': str(port), 'RESMON_PORT_FILE': str(state / 'mcp-explicit.port'),
                'RESMON_STATE_DIR': str(state), 'RESMON_DB_PATH': ctx['record']['database'],
                'RESMON_REPORTS_DIR': str(state / 'reports'), 'RESMON_DISABLE_SCHEDULER': '1',
                'PYTHON_KEYRING_BACKEND': 'keyring.backends.null.Keyring', 'NO_PROXY': '127.0.0.1'})
    requests = [
        {'jsonrpc': '2.0', 'id': 1, 'method': 'tools/list'},
        {'jsonrpc': '2.0', 'id': 2, 'method': 'tools/call', 'params': {'name': 'health', 'arguments': {'expected_runtime_id': runtime}}},
        {'jsonrpc': '2.0', 'id': 3, 'method': 'tools/call', 'params': {'name': 'get_execution', 'arguments': {'exec_id': exec_id, 'expected_runtime_id': runtime}}},
        {'jsonrpc': '2.0', 'id': 4, 'method': 'tools/call', 'params': {'name': 'get_execution', 'arguments': {'exec_id': exec_id, 'expected_runtime_id': str(uuid.uuid4())}}},
    ]
    replies = _stdio(source, env, requests)
    assert [r['id'] for r in replies] == [1, 2, 3, 4]
    tools = replies[0]['result']['tools']
    assert len(tools) == 25
    assert {t['name'] for t in tools if t['requires_confirmation']} == EXPECTED_WRITES
    assert {t['name'] for t in tools if not t['requires_confirmation']} == EXPECTED_READS
    assert len(EXPECTED_READS) == 18 and len(EXPECTED_WRITES) == 7
    for index in (1, 2):
        assert replies[index]['result']['isError'] is False
        value = json.loads(replies[index]['result']['content'][0]['text'])
        assert value['identity']['runtime_id'] == runtime
        if index == 2:
            assert value['id'] == exec_id and 'evidence-boundary-only' in value['parameters']
    mismatch = replies[3]['result']
    assert mismatch['isError'] is True
    text = mismatch['content'][0]['text']
    assert json.loads(text)['error'] == 'instance_mismatch' and 'evidence-boundary-only' not in text
    assert all('evidence' not in t['name'] for t in tools)


def test_named_mcp_unavailable_port_never_tries_default(tmp_path, monkeypatch):
    # No request to 8742 is sent. A pretransport spy refuses every address except
    # this exact synthetic, bound-but-not-listening ephemeral socket.
    import mcp_server as mcp
    from implementation_scripts import config
    with socket.socket() as reserved:
        reserved.bind(('127.0.0.1', 0))
        port = reserved.getsockname()[1]; assert port != 8742
        monkeypatch.setenv('RESMON_PORT', str(port))
        monkeypatch.setattr(config, 'PORT_FILE', tmp_path / 'absent-mcp.port')
        assert mcp._candidate_ports() == [port]
        actual_get = httpx.get
        attempts = []
        def only_named(url, *args, **kwargs):
            parsed = httpx.URL(url)
            assert parsed.host == '127.0.0.1' and parsed.port == port and parsed.port != 8742
            attempts.append(str(url))
            kwargs['trust_env'] = False
            return actual_get(url, *args, **kwargs)
        monkeypatch.setattr(mcp.httpx, 'get', only_named)
        backend = mcp.Backend()
        with pytest.raises(mcp.ToolError):
            backend.base_url()
        assert attempts == [f'http://127.0.0.1:{port}/api/health']
        assert backend._tried == [f'http://127.0.0.1:{port}']
    # This preserves the existing named-port refusal. It does not execute or
    # endorse the legacy no-configuration default path, which remains untouched.
