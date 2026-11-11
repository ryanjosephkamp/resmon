"""Source stops and every run ending preserve the account of stored papers."""
from __future__ import annotations

import sqlite3
import threading
from pathlib import Path

import pytest

from implementation_scripts import sweep_engine as se, watch_profiles
from implementation_scripts.api_base import Author, NormalizedResult, search_outcome
from implementation_scripts.database import get_execution_by_id, get_execution_sources, init_db
from implementation_scripts.progress import ProgressStore, progress_store
from implementation_scripts.source_coverage import build


def paper(slug: str) -> NormalizedResult:
    return NormalizedResult(source_repository=slug, external_id='one', doi='10.1000/graphs',
                            publication_date=None, title='Graph networks and learning',
                            authors=[Author('Jane Doe', orcid='0000-0002-1825-0097')],
                            abstract='Graph learning and network structure.', url='https://example.invalid/paper')


@pytest.fixture
def run_case(monkeypatch, tmp_path):
    monkeypatch.setattr(se, 'REPORTS_DIR', tmp_path)
    monkeypatch.setattr(se, '_HEARTBEAT_SECONDS', 0.01)
    monkeypatch.setattr(se, 'required_credential_for_sweep', lambda slug: None)
    conn = sqlite3.connect(':memory:', check_same_thread=False)
    init_db(conn=conn)
    engine = se.SweepEngine(conn, {})
    owned: list[int] = []

    def prepare(slugs: list[str], params: dict | None = None) -> int:
        eid = engine.prepare_execution('deep_sweep', slugs, params or {'query': 'graphs'})
        progress_store.register(eid)
        owned.append(eid)
        return eid

    yield conn, engine, prepare
    for eid in owned:
        progress_store.cleanup(eid)
    conn.close()


@pytest.mark.parametrize('body', [
    {}, {'source': ['plos']}, {'sources': None}, {'sources': []},
    {'all': False}, {'all': 1}, {'all': 'true'}, {'all': None},
    {'sources': ['plos'], 'all': True}, {'sources': ['plos'], 'extra': 1},
    {'sources': [42]}, {'sources': ['']},
])
def test_stop_body_is_explicit_and_invalid_bodies_do_not_signal(body):
    import resmon
    from fastapi.testclient import TestClient

    progress_store.register(997)
    progress_store.register_sources(997, ['plos'])
    try:
        reply = TestClient(resmon.app).post('/api/executions/997/stop-sources', json=body)
        assert reply.status_code == 422, reply.text
        assert not progress_store.source_stop_flag(997, 'plos').is_set()
    finally:
        progress_store.cleanup(997)


def test_unknown_run_and_unknown_sources_have_distinct_errors(run_case, monkeypatch):
    import resmon
    from fastapi.testclient import TestClient

    conn, _, prepare = run_case
    monkeypatch.setattr(resmon, '_get_db', lambda: conn)
    monkeypatch.setattr(resmon, '_close_db', lambda connection: None)
    eid = prepare(['plos'])
    progress_store.register_sources(eid, ['plos'])
    client = TestClient(resmon.app)
    missing = client.post('/api/executions/9999999/stop-sources', json={'all': True})
    assert missing.status_code == 404
    unknown = client.post(f'/api/executions/{eid}/stop-sources', json={'sources': ['typo', 'other']})
    assert unknown.status_code == 422 and 'typo' in unknown.text and 'other' in unknown.text
    assert not progress_store.source_stop_flag(eid, 'plos').is_set()


def test_queued_owner_stop_survives_a_whole_run_stop_with_eight_workers(run_case, monkeypatch):
    conn, engine, prepare = run_case
    slugs = [f'source-{i}' for i in range(9)]
    eid = prepare(slugs)
    barrier = threading.Barrier(8)
    called: list[str] = []

    class Client:
        def __init__(self, slug):
            self.slug = slug

        def search(self, **kwargs):
            called.append(self.slug)
            barrier.wait(3)
            if self.slug == slugs[0]:
                assert progress_store.request_source_stop(eid, [slugs[-1]])[0]
                progress_store.request_cancel(eid)
            assert progress_store._cancel_flags[eid].wait(3)
            return []

    monkeypatch.setattr(se, 'get_client', lambda slug, **kwargs: Client(slug))
    engine.run_prepared(eid)
    assert slugs[-1] not in called
    row = next(s for s in build(get_execution_by_id(conn, eid), get_execution_sources(conn, eid))['sources']
               if s['source'] == slugs[-1])
    assert row['label'] == 'stopped by you'
    assert row['result_count'] == 0 and '0 requests' in row['note']


@pytest.mark.parametrize('kept', [False, True, 'invalid'])
def test_stopped_source_with_records_contributes_beside_a_failed_source(run_case, monkeypatch, kept):
    conn, engine, prepare = run_case
    eid = prepare(['arxiv', 'plos'])

    class Client:
        def __init__(self, slug):
            self.slug = slug

        def search(self, **kwargs):
            if self.slug == 'arxiv':
                raise RuntimeError('Authored source failure')
            assert progress_store.request_source_stop(eid, ['plos'])[0]
            record = paper('plos')
            if kept == 'invalid':
                record.title = ''
            return [record] if kept else []

    monkeypatch.setattr(se, 'get_client', lambda slug, **kwargs: Client(slug))
    engine.run_prepared(eid)
    row = get_execution_by_id(conn, eid)
    assert row['status'] == ('completed' if kept is True else 'failed')
    assert 'stopped by you' in build(row, get_execution_sources(conn, eid))['summary']


def test_progress_controls_follow_gate_not_display_outcomes():
    store = ProgressStore()
    store.register(1)
    store.register_sources(1, ['arxiv', 'plos', 'govinfo'])
    store.finish_source(1, 'govinfo')
    latest = store.get_events(1)[-1]
    assert latest['type'] == 'source_controls'
    assert latest['sources'] == {'arxiv': {'stoppable': True}, 'plos': {'stoppable': True}, 'govinfo': {'stoppable': False}}
    assert latest['can_stop_unfinished'] is False
    store.request_source_stop(1, ['plos'])
    assert store.get_events(1)[-1]['can_stop_unfinished'] is False
    store.finish_source(1, 'arxiv', answered=True)
    assert store.get_events(1)[-1]['can_stop_unfinished'] is False
    store.register_sources(1, ['arxiv', 'plos'])
    store.finish_source(1, 'arxiv', answered=True)
    assert store.get_events(1)[-1]['can_stop_unfinished'] is True
    store.request_cancel(1)
    assert not any(s['stoppable'] for s in store.get_events(1)[-1]['sources'].values())
    store.register(1)
    store.register_sources(1, ['plos'])
    store.begin_finishing(1)
    assert store.get_events(1)[-1]['sources']['plos']['stoppable'] is False


def test_cancel_does_not_store_a_reply_returned_after_stop(run_case, monkeypatch):
    conn, engine, prepare = run_case
    eid = prepare(['arxiv'])

    class Client:
        def search(self, **kwargs):
            progress_store.request_cancel(eid)
            return [paper('arxiv')]

    monkeypatch.setattr(se, 'get_client', lambda slug, **kwargs: Client())
    engine.run_prepared(eid)
    row = get_execution_by_id(conn, eid)
    assert row['status'] == 'cancelled'
    assert conn.execute('SELECT count(*) FROM documents').fetchone()[0] == 0
    assert row['result_count'] == 0


def test_cancel_uses_dedup_counts_in_report_row_and_final_event(run_case, monkeypatch):
    conn, engine, prepare = run_case
    eid = prepare(['arxiv'])

    class Client:
        def search(self, **kwargs):
            return [paper('arxiv'), paper('arxiv')]

    monkeypatch.setattr(se, 'get_client', lambda slug, **kwargs: Client())
    monkeypatch.setattr(engine, '_embed_linked_documents', lambda *args: progress_store.request_cancel(eid))
    engine.run_prepared(eid)
    row = get_execution_by_id(conn, eid)
    assert row['dedup_total'] == 2
    assert row['result_count'] == 2 and row['new_result_count'] == 1
    assert progress_store.get_events(eid)[-1]['result_count'] == 2
    report = Path(row['result_path']).read_text()
    assert '**Collected before the cancel:** 2 results (1 new)' in report


@pytest.mark.parametrize('kind', ['entity', 'find'])
@pytest.mark.parametrize('ending', ['cancelled', 'failed'])
def test_cancel_records_matches_for_papers_already_stored(run_case, monkeypatch, kind, ending):
    conn, engine, prepare = run_case
    params: dict = {'query': 'graphs'}
    if kind == 'entity':
        params['entity_profile'] = watch_profiles.create_profile(conn, {
            'display_name': 'Jane Doe', 'identifiers': {'orcid': {'value': '0000-0002-1825-0097'}}})
    else:
        params['find'] = {'kind': 'doi', 'value': '10.1000/graphs', 'typed': '10.1000/graphs'}
    eid = prepare(['arxiv'], params)

    class Client:
        def search_entity(self, *args, **kwargs):
            return [paper('arxiv')]

        def lookup(self, *args, **kwargs):
            return [paper('arxiv')]

    monkeypatch.setattr(se, 'get_client', lambda slug, **kwargs: Client())
    def end(*args):
        if ending == 'failed':
            raise RuntimeError('Authored failure after storage')
        progress_store.request_cancel(eid)

    monkeypatch.setattr(engine, '_embed_linked_documents', end)
    if ending == 'failed':
        with pytest.raises(RuntimeError, match='Authored failure after storage'):
            engine.run_prepared(eid)
    else:
        engine.run_prepared(eid)
    assert conn.execute('SELECT count(*) FROM execution_documents').fetchone()[0] == 1
    assert get_execution_by_id(conn, eid)['result_count'] == 1
    table = 'watch_profile_matches' if kind == 'entity' else 'execution_find_results'
    assert conn.execute(f'SELECT count(*) FROM {table}').fetchone()[0] == 1


def test_embedding_failure_defers_later_arrivals_to_one_final_attempt(run_case, monkeypatch):
    from implementation_scripts.embeddings import EmbeddingLane

    conn, engine, prepare = run_case
    monkeypatch.setattr(se, '_SOURCE_CONCURRENCY', 1)
    slugs = ['arxiv', 'plos', 'hal', 'zenodo']
    calls: list[tuple[int, int]] = []

    class Client:
        def __init__(self, slug):
            self.slug = slug

        def search(self, **kwargs):
            return [paper(self.slug)]

    def embed(connection, lane, ids, **kwargs):
        stored = connection.execute('SELECT count(*) FROM execution_documents').fetchone()[0]
        calls.append((stored, len(ids)))
        return {'embedded': 0, 'skipped_no_text': 0, 'reason': 'Authored embedding failure', 'cancelled': False}

    monkeypatch.setattr(se, 'get_client', lambda slug, **kwargs: Client(slug))
    monkeypatch.setattr(se, 'embed_documents', embed)
    engine.embedding_lane = EmbeddingLane(kind='local', provider='local', model='fixture', endpoint='http://127.0.0.1:9')
    eid = prepare(slugs)
    engine.run_prepared(eid)
    assert calls == [(1, 1), (4, 4)]
    log = Path(get_execution_by_id(conn, eid)['log_path']).read_text()
    assert 'Embedding per source is paused' in log
