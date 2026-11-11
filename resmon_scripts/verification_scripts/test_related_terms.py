"""Collection-only term offers, ranked against that collection's wording."""
from __future__ import annotations

import sys
import sqlite3
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import resmon as app_module
from implementation_scripts.database import insert_document
from implementation_scripts import paper_collections


@pytest.fixture
def client() -> TestClient:
    app_module._db_path = ":memory:"
    app_module._shared_conn = None
    app_module._db_initialized = False
    return TestClient(app_module.app)


def paper(conn: sqlite3.Connection, key: str, title: str, abstract: str, collection_id: int | None = None) -> int:
    stored = insert_document(conn, {"source_repository": "arxiv", "external_id": key,
        "title": title, "abstract": abstract, "metadata_hash": key}, collection_id=collection_id)
    assert stored is not None
    return int(stored)


def test_related_terms_are_distinctive_local_words_and_pairs(client: TestClient, monkeypatch: pytest.MonkeyPatch) -> None:
    from implementation_scripts import related_terms
    original = related_terms.suggest

    def read_only(connection: sqlite3.Connection, term: str, collection_id: int) -> dict:
        connection.execute('PRAGMA query_only=ON')
        try:
            return original(connection, term, collection_id)
        finally:
            connection.execute('PRAGMA query_only=OFF')

    monkeypatch.setattr(related_terms, 'suggest', read_only)
    conn = app_module._get_db()
    paper(conn, "a", "Graph convolution", "Graph convolution spectral filters spectral filters common common")
    paper(conn, "b", "Graph convolution", "Graph convolution spectral filters common common")
    for n in range(12):
        paper(conn, str(n), "Common wording", "common common common common ocean currents")
    conn.commit()
    before = conn.total_changes
    response = client.get('/api/collection/related-terms', params={"term": "GRAPH"})
    assert response.status_code == 200
    body = response.json()
    assert body['matched_papers'] == 2
    assert 0 < len(body['suggestions']) <= 6
    assert 'spectral filters' in body['suggestions']
    assert 'graph' not in body['suggestions']
    assert not {'the', 'and', 'papers'} & set(body['suggestions'])
    assert body['suggestions'].index('spectral filters') < body['suggestions'].index('common') if 'common' in body['suggestions'] else True
    assert conn.total_changes == before


def test_missing_empty_stop_words_and_literal_phrase_matching(client: TestClient) -> None:
    conn = app_module._get_db()
    paper(conn, "a", "Graph convolution", "spectral filters")
    paper(conn, "b", "Graphs convolve", "other wording")
    conn.commit()
    for term in ('missing', 'the', 'graph convolve', '%', '" OR 1=1 --'):
        response = client.get('/api/collection/related-terms', params={'term': term})
        assert response.status_code == 200
        assert response.json()['matched_papers'] == 0
        assert response.json()['suggestions'] == []
    assert client.get('/api/collection/related-terms', params={'term': 'graph convolution'}).json()['matched_papers'] == 1
    # No term looks nothing up; it prepares the counts (below).
    assert client.get('/api/collection/related-terms', params={'term': '  '}).json() == {
        'term': '', 'matched_papers': 0, 'suggestions': []}


def test_collection_scope_and_cache_follow_text_and_membership_changes(client: TestClient) -> None:
    conn = app_module._get_db()
    other = paper_collections.create(conn, 'Other')['id']
    doc = paper(conn, 'a', 'Graph convolution', 'spectral filters')
    paper(conn, 'b', 'Graph convolution', 'marine plankton', other)
    conn.commit()
    read = lambda **q: client.get('/api/collection/related-terms', params={'term': 'graph', **q}).json()
    assert 'marine' not in read()['suggestions']
    assert 'spectral' not in read(collection='Other')['suggestions']
    conn.execute('UPDATE documents SET abstract = ? WHERE id = ?', ('crystal lattices', doc))
    conn.commit()
    assert 'crystal' in read()['suggestions']
    assert 'spectral' not in read()['suggestions']
    paper_collections.move(conn, 1, other, [doc])
    conn.commit()
    assert read()['matched_papers'] == 0
    assert read(collection=str(other))['matched_papers'] == 2
    assert client.get('/api/collection/related-terms', params={'term': 'graph', 'collection': 'Absent'}).status_code == 404


def test_later_lookups_reuse_packed_tokens_for_every_matching_class(client: TestClient, monkeypatch: pytest.MonkeyPatch) -> None:
    from implementation_scripts import related_terms
    conn = app_module._get_db()
    for n in range(20):
        paper(conn, str(n), 'Graph convolution', 'spectral filters' if n < 19 else 'marine plankton')
    conn.commit()
    client.get('/api/collection/related-terms', params={'term': 'spectral'})
    calls = []
    original = related_terms._document_terms
    monkeypatch.setattr(related_terms, '_document_terms', lambda *text: (calls.append(text), original(*text))[1])
    body = client.get('/api/collection/related-terms', params={'term': 'graph'}).json()
    assert body['matched_papers'] == 20
    assert calls == []  # Every paper matches: the stored baseline is the class.
    body = client.get('/api/collection/related-terms', params={'term': 'spectral'}).json()
    assert body['matched_papers'] == 19
    assert calls == []  # A partial class also sums stored tokens without tokenizing.


def test_short_input_and_whitespace_still_match_literal_papers(client: TestClient) -> None:
    conn = app_module._get_db()
    paper(conn, 'a', 'AI in graph\nconvolution', 'spectral filters')
    conn.commit()
    for term in ('AI', 'graph convolution'):
        body = client.get('/api/collection/related-terms', params={'term': term}).json()
        assert body['matched_papers'] == 1
        assert 'spectral' in body['suggestions']
        assert term.lower() not in body['suggestions']


def test_an_empty_term_prepares_the_counts_so_the_first_real_lookup_tokenizes_nothing(
        client: TestClient, monkeypatch: pytest.MonkeyPatch) -> None:
    from implementation_scripts import related_terms
    conn = app_module._get_db()
    for n in range(12):
        paper(conn, f'w{n}', 'Graph convolution', 'spectral filters' if n % 2 else 'marine plankton')
    conn.commit()
    calls = []
    original = related_terms._document_terms
    monkeypatch.setattr(related_terms, '_document_terms', lambda *text: (calls.append(text), original(*text))[1])
    assert client.get('/api/collection/related-terms').json() == {'term': '', 'matched_papers': 0, 'suggestions': []}
    assert len(calls) == 12  # Every paper's words are counted once, here.
    calls.clear()
    body = client.get('/api/collection/related-terms', params={'term': 'spectral'}).json()
    assert body['matched_papers'] == 6 and body['suggestions']
    assert calls == []  # The first lookup a person waits on counts nothing again.

