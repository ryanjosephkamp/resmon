"""Source arrivals are stored before the slowest source finishes."""
from __future__ import annotations

import sqlite3
import threading
import time

import pytest

from implementation_scripts import sweep_engine as se
from implementation_scripts.api_base import NormalizedResult
from implementation_scripts.database import get_execution_by_id, init_db
from implementation_scripts.progress import progress_store


@pytest.mark.parametrize('cancel_run', [False, True])
def test_arrivals_are_linked_live_and_a_cancel_keeps_the_stored_record(monkeypatch, tmp_path, cancel_run):
    monkeypatch.setattr(se, 'REPORTS_DIR', tmp_path)
    monkeypatch.setattr(se, '_HEARTBEAT_SECONDS', 0.01)
    saw_arrival = threading.Event()
    embedded: list[list[int]] = []

    class Client:
        def __init__(self, slug: str):
            self.slug = slug

        def search(self, **kwargs):
            if self.slug == 'plos':
                until = time.monotonic() + 1
                while time.monotonic() < until:
                    if any(e['type'] == 'source_stored' for e in progress_store.get_events(exec_id)):
                        saw_arrival.set()
                        if cancel_run:
                            progress_store.request_cancel(exec_id)
                        break
                    time.sleep(0.005)
                if cancel_run:
                    # This source has not answered when the whole run stops.
                    while not progress_store.should_cancel(exec_id):
                        if time.monotonic() > until:
                            break
                        time.sleep(0.005)
                    return []
            return [NormalizedResult(source_repository=self.slug, external_id='one', doi=None,
                                     publication_date=None, title=f'Graph networks from {self.slug}',
                                     authors=['A Researcher'], abstract='Graph learning and network structure.',
                                     url='https://example.org/paper')]

    monkeypatch.setattr(se, 'get_client', lambda slug, **kwargs: Client(slug))
    monkeypatch.setattr(se.SweepEngine, '_embed_linked_documents',
                        lambda self, eid, store, log, ids: embedded.append(list(ids)))
    conn = sqlite3.connect(':memory:')
    init_db(conn=conn)
    engine = se.SweepEngine(db_conn=conn, config={})
    exec_id = engine.prepare_execution('deep_sweep', ['arxiv', 'plos'], {'query': 'graphs'})
    progress_store.register(exec_id)
    try:
        engine.run_prepared(exec_id)
        assert saw_arrival.is_set(), 'the first source was not stored until the last one returned'
        row = get_execution_by_id(conn, exec_id)
        assert row['status'] == ('cancelled' if cancel_run else 'completed')
        stored = conn.execute('SELECT count(*) FROM execution_documents WHERE execution_id=?', (exec_id,)).fetchone()[0]
        assert stored >= 1
        assert row['dedup_new'] == stored
        assert embedded and embedded[0]
        if cancel_run:
            report = open(row['result_path']).read()
            assert f'({stored} new)' in report
            assert row['result_count'] == stored
    finally:
        progress_store.cleanup(exec_id)
        conn.close()
