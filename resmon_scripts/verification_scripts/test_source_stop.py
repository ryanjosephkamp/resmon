"""Stopping selected sources keeps their records and lets the run finish."""
from __future__ import annotations

import sqlite3
import threading

import pytest

from implementation_scripts import api_base, sweep_engine as se
from implementation_scripts.api_base import NormalizedResult, search_outcome
from implementation_scripts.database import get_execution_by_id, get_execution_sources, init_db
from implementation_scripts.progress import ProgressStore, progress_store
from implementation_scripts.source_coverage import build


def test_source_stop_gate_keeps_acceptance_and_refuses_finished_sources():
    store = ProgressStore()
    store.register(1)
    store.register_sources(1, ['arxiv', 'plos'])
    store.finish_source(1, 'arxiv')
    assert store.request_source_stop(1, ['arxiv'])[0] is False
    accepted, _, slugs = store.request_source_stop(1, None)
    assert accepted and slugs == ['plos']
    assert store.source_stop_flag(1, 'plos').is_set()
    assert store.finish_source(1, 'plos') is True
    assert not store.should_cancel(1)
    assert store.begin_finishing(1)
    assert store.request_source_stop(1, ['plos'])[0] is False
    store.register(1)
    assert not store.source_stop_flag(1, 'plos').is_set()


def test_stopped_source_retains_partial_papers_without_answer_or_failure(monkeypatch, tmp_path):
    monkeypatch.setattr(se, 'REPORTS_DIR', tmp_path)
    monkeypatch.setattr(se, '_HEARTBEAT_SECONDS', 0.01)
    stopped = threading.Event()

    class Client:
        def __init__(self, slug: str):
            self.slug = slug

        def search(self, **kwargs):
            outcome = search_outcome()
            outcome.note_attempt()
            if self.slug == 'plos':
                # The stop is accepted while this search owns an unfinished source.
                assert progress_store.request_source_stop(exec_id, ['plos'])[0]
                assert outcome.stop.wait(2)
                stopped.set()
            return [NormalizedResult(source_repository=self.slug, external_id='one',
                                     doi=None, publication_date=None, title=f'Paper from {self.slug}', authors=['A Researcher'],
                                     abstract='An abstract about graphs.', url='https://example.org/paper')]

    monkeypatch.setattr(se, 'get_client', lambda slug, **kwargs: Client(slug))
    conn = sqlite3.connect(':memory:')
    init_db(conn=conn)
    engine = se.SweepEngine(db_conn=conn, config={})
    exec_id = engine.prepare_execution('deep_sweep', ['arxiv', 'plos'], {'query': 'graphs'})
    progress_store.register(exec_id)
    try:
        engine.run_prepared(exec_id)
        execution = get_execution_by_id(conn, exec_id)
        coverage = build(execution, get_execution_sources(conn, exec_id))
        assert stopped.is_set()
        assert execution['status'] == 'completed'
        assert execution['result_count'] == 2
        assert conn.execute('SELECT count(*) FROM execution_documents').fetchone()[0] == 2
        assert coverage['counts']['answered'] == 1
        row = next(s for s in coverage['sources'] if s['source'] == 'plos')
        assert row['category'] == 'non_answer'
        assert row['result_count'] == 1
        assert row['label'] == 'stopped by you'
        assert '1 record' in row['note'] and '1 request' in row['note']
        assert 'PLOS was stopped by you' in coverage['summary']
        assert any(e['type'] == 'repo_stopped' for e in progress_store.get_events(exec_id))
    finally:
        progress_store.cleanup(exec_id)
        conn.close()


def test_safe_request_stops_before_transport_and_does_not_claim_failure():
    api_base.reset_search_outcome()
    outcome = search_outcome()
    outcome.stop.set()
    try:
        with pytest.raises(api_base.SearchStopped):
            api_base.safe_request('GET', 'http://127.0.0.1:9/never', max_retries=0)
        assert outcome.attempts == 0 and outcome.failures == 0
    finally:
        api_base.reset_search_outcome()


def test_source_stop_route_returns_engine_refusals_and_acceptance():
    import resmon
    from fastapi.testclient import TestClient

    client = TestClient(resmon.app)
    progress_store.register(997)
    progress_store.register_sources(997, ['arxiv', 'plos'])
    try:
        progress_store.finish_source(997, 'arxiv')
        refused = client.post('/api/executions/997/stop-sources', json={'sources': ['arxiv']})
        assert refused.status_code == 409 and 'has finished' in refused.json()['detail']
        accepted = client.post('/api/executions/997/stop-sources', json={'all': True})
        assert accepted.status_code == 200 and accepted.json()['sources'] == ['plos']
        assert progress_store.source_stop_flag(997, 'plos').is_set()
        assert progress_store.begin_finishing(997)
        assert client.post('/api/executions/997/stop-sources', json={'sources': ['plos']}).status_code == 409
    finally:
        progress_store.cleanup(997)


def test_stop_interrupts_a_real_limiter_wait_without_using_a_slot():
    import time

    limiter = api_base.RateLimiter(requests_per_second=0.01)
    api_base.reset_search_outcome()
    limiter.acquire()
    seen: dict = {}
    ready = threading.Event()

    def wait_for_pace() -> None:
        api_base.reset_search_outcome()
        seen['outcome'] = search_outcome()
        ready.set()
        try:
            limiter.acquire()
        except api_base.SearchStopped:
            seen['stopped'] = True

    thread = threading.Thread(target=wait_for_pace)
    thread.start()
    assert ready.wait(2)
    before = limiter._last_call
    seen['outcome'].stop.set()
    thread.join(2)
    assert not thread.is_alive()
    assert seen.get('stopped') is True
    assert limiter._last_call == before
    assert seen['outcome'].attempts == 0
    api_base.reset_search_outcome()


def test_queued_source_stop_prevents_its_first_search(monkeypatch, tmp_path):
    monkeypatch.setattr(se, 'REPORTS_DIR', tmp_path)
    monkeypatch.setattr(se, '_SOURCE_CONCURRENCY', 1)
    called: list[str] = []

    class Client:
        def __init__(self, slug: str):
            self.slug = slug

        def search(self, **kwargs):
            called.append(self.slug)
            assert progress_store.request_source_stop(exec_id, ['plos'])[0]
            search_outcome().note_attempt()
            return []

    monkeypatch.setattr(se, 'get_client', lambda slug, **kwargs: Client(slug))
    conn = sqlite3.connect(':memory:')
    init_db(conn=conn)
    engine = se.SweepEngine(db_conn=conn, config={})
    exec_id = engine.prepare_execution('deep_sweep', ['arxiv', 'plos'], {'query': 'graphs'})
    progress_store.register(exec_id)
    try:
        engine.run_prepared(exec_id)
        assert called == ['arxiv']
        row = next(s for s in build(get_execution_by_id(conn, exec_id), get_execution_sources(conn, exec_id))['sources'] if s['source'] == 'plos')
        assert row['label'] == 'stopped by you' and row['result_count'] == 0
        assert '0 requests' in row['note']
    finally:
        progress_store.cleanup(exec_id)
        conn.close()


def test_a_whole_run_stop_keeps_an_already_accepted_source_stop(monkeypatch, tmp_path):
    monkeypatch.setattr(se, 'REPORTS_DIR', tmp_path)
    monkeypatch.setattr(se, '_HEARTBEAT_SECONDS', 0.01)
    release = threading.Event()

    class Client:
        def search(self, **kwargs):
            search_outcome().note_attempt()
            assert progress_store.request_source_stop(exec_id, ['plos'])[0]
            progress_store.request_cancel(exec_id)
            release.wait(2)
            return []

    monkeypatch.setattr(se, 'get_client', lambda *args, **kwargs: Client())
    conn = sqlite3.connect(':memory:')
    init_db(conn=conn)
    engine = se.SweepEngine(db_conn=conn, config={})
    exec_id = engine.prepare_execution('deep_sweep', ['plos'], {'query': 'graphs'})
    progress_store.register(exec_id)
    try:
        engine.run_prepared(exec_id)
        row = get_execution_by_id(conn, exec_id)
        assert row['status'] == 'cancelled'
        coverage = build(row, get_execution_sources(conn, exec_id))
        assert coverage['sources'][0]['label'] == 'stopped by you'
        assert '1 request' in coverage['sources'][0]['note']
    finally:
        release.set()
        progress_store.cleanup(exec_id)
        conn.close()


def test_plos_keeps_a_complete_partial_page_and_sends_no_next_request(monkeypatch, tmp_path):
    import httpx
    from implementation_scripts import api_plos

    monkeypatch.setattr(se, 'REPORTS_DIR', tmp_path)
    monkeypatch.setattr(api_plos, '_PLOS_API_URL', 'http://127.0.0.1:9/authored')
    monkeypatch.setattr(api_plos, '_RATE_LIMITER', api_base.RateLimiter(requests_per_second=1000))
    calls: list[str] = []

    class Replies(httpx.BaseTransport):
        def handle_request(self, request):
            calls.append(str(request.url))
            assert progress_store.request_source_stop(exec_id, ['plos'])[0]
            return httpx.Response(200, json={'response': {'docs': [
                {'id': f'10.1000/graph-{n}', 'title': f'Graph learning {n}', 'author': ['A Researcher']}
                for n in range(100)]}})

    real_client = httpx.Client
    monkeypatch.setattr(api_base.httpx, 'Client', lambda **kwargs: real_client(transport=Replies(), **kwargs))
    conn = sqlite3.connect(':memory:')
    init_db(conn=conn)
    engine = se.SweepEngine(db_conn=conn, config={})
    exec_id = engine.prepare_execution('deep_sweep', ['plos'], {'query': 'graphs', 'max_results': 200})
    progress_store.register(exec_id)
    try:
        engine.run_prepared(exec_id)
        row = get_execution_by_id(conn, exec_id)
        assert row['status'] == 'completed' and row['result_count'] == 100
        assert len(calls) == 1
        outcome = build(row, get_execution_sources(conn, exec_id))['sources'][0]
        assert outcome['category'] == 'non_answer' and outcome['result_count'] == 100
        assert '1 request' in outcome['note']
        report = open(row['result_path']).read()
        assert '## Sources stopped by you' in report and 'PLOS was stopped by you' in report
    finally:
        progress_store.cleanup(exec_id)
        conn.close()


def test_an_old_worker_cannot_finish_a_new_run_that_reuses_its_id():
    store = ProgressStore()
    store.register(1)
    store.register_sources(1, ['plos'])
    old = store.source_stop_flag(1, 'plos')
    old.set()
    store.cleanup(1)
    store.register(1)
    store.register_sources(1, ['plos'])
    store.finish_source(1, 'plos', expected=old)
    accepted, _, stopped = store.request_source_stop(1, ['plos'])
    assert accepted and stopped == ['plos']


def test_a_stop_names_the_sources_it_stops():
    """One source is "arXiv will stop", never "the unfinished sources"; a list keeps its serial comma."""
    store = ProgressStore()
    store.register(1)
    store.register_sources(1, ['arxiv', 'biorxiv', 'crossref', 'plos', 'doaj'])
    accepted, said, _ = store.request_source_stop(1, ['arxiv'])
    assert accepted and said == "arXiv will stop at its next safe point; the run will keep going."
    accepted, said, _ = store.request_source_stop(1, ['biorxiv', 'crossref'])
    assert said == "bioRxiv and Crossref will stop at their next safe points; the run will keep going."
    accepted, said, stopped = store.request_source_stop(1, None)
    assert stopped == ['plos', 'doaj']
    assert said == "PLOS and DOAJ will stop at their next safe points; the run will keep going."


def test_a_stop_of_many_counts_them():
    from implementation_scripts.progress import stop_sentence

    slugs = ['arxiv', 'biorxiv', 'crossref', 'plos']
    assert stop_sentence(slugs[:3], named=True) == (
        "arXiv, bioRxiv, and Crossref will stop at their next safe points; the run will keep going.")
    assert stop_sentence(slugs, named=True) == (
        "These 4 sources will stop at their next safe points; the run will keep going.")
    assert stop_sentence(slugs, named=False) == (
        "The 4 unfinished sources will stop at their next safe points; the run will keep going.")
