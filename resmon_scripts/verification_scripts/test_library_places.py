"""One paper's recorded shelf, linked files, and current project memberships."""
from pathlib import Path
from contextlib import closing
from collections.abc import Iterator
import os
import sqlite3

import pytest
from fastapi.testclient import TestClient
from implementation_scripts import database as db, evidence, library
import resmon
from conftest import TEST_RENDERER_ORIGIN

HEADERS = {'X-Resmon-Library': '1', 'Origin': TEST_RENDERER_ORIGIN}


@pytest.fixture
def catalog(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Iterator[tuple[sqlite3.Connection, str, Path, int]]:
    conn = sqlite3.connect(tmp_path / 'catalog.db', check_same_thread=False)
    conn.row_factory = sqlite3.Row
    conn.execute('PRAGMA foreign_keys=ON')
    db.init_db(conn=conn)
    parent = tmp_path / 'parent'
    parent.mkdir()
    state = library.create_vault(conn, str(parent))
    vault = state['vault']['vault_id']
    document = db.insert_document(conn, {'source_repository': 'synthetic', 'external_id': 'places',
                                       'title': 'Same title', 'metadata_hash': 'places'})
    conn.commit()
    monkeypatch.setattr(resmon, '_get_db', lambda: conn)
    yield conn, vault, parent / state['vault']['label'], document
    conn.close()


def put(conn: sqlite3.Connection, vault: str, document: int, raw: bytes = b'%PDF-1.4\nsynthetic') -> dict:
    with library.Import(conn, vault, 'paper.pdf', document) as upload:
        upload.write(raw)
        return upload.finish()['file']


def test_places_route_reads_one_paper_without_inventory_scans(catalog, monkeypatch: pytest.MonkeyPatch) -> None:
    conn, vault, root, document = catalog
    item = put(conn, vault, document)
    other = db.insert_document(conn, {'source_repository': 'synthetic', 'external_id': 'other',
                                     'title': 'Same title', 'metadata_hash': 'other'})
    conn.execute("INSERT INTO reading_queue(document_id,status,saved_at,updated_at,read_at) VALUES (?,'read',?,?,?)",
                 (document, '2026-10-01T12:00:00Z', '2026-11-08T12:00:00Z', '2026-11-08T12:00:00Z'))
    conn.commit()
    put(conn, vault, other, b'%PDF-1.4\nother')
    current = evidence.create_project(conn, vault, 'Current')['project']
    former = evidence.create_project(conn, vault, 'Former')['project']
    for project in (current, former):
        added = evidence.add_file(conn, vault, project['project_id'], 1, item['file_id'], item['version_id'])['project']
        if project is former:
            evidence.create_note(conn, vault, project['project_id'], added['revision'], item['file_id'], item['version_id'], 'note', 'Kept note', None)
            evidence.remove_file(conn, vault, project['project_id'], added['revision'] + 1, item['file_id'], item['version_id'])
    def no_scan(*args, **kwargs):
        raise AssertionError('A paper lookup must not scan the Library inventory.')
    monkeypatch.setattr(library, 'list_files', no_scan)
    monkeypatch.setattr(library, 'present_files', no_scan)
    monkeypatch.setattr(library, '_catalog_tree', no_scan)
    with closing(TestClient(resmon.app)) as client:
        response = client.get(f'/api/library/papers/{document}/places', headers=HEADERS)
    assert response.status_code == 200, response.text
    result = response.json()
    assert result['document_id'] == document
    assert result['shelf']['read_at'] == '2026-11-08T12:00:00Z'
    assert result['shelf']['saved_at'] == '2026-10-01T12:00:00Z'
    assert [f['file_id'] for f in result['files']] == [item['file_id']]
    assert [p['name'] for p in result['projects']] == ['Current']
    assert str(root) not in response.text
    assert result['library']['status'] == 'ready'


def test_places_reports_unconfigured_and_unknown_paper(catalog) -> None:
    conn, vault, root, document = catalog
    conn.execute('DELETE FROM library_vault')
    conn.commit()
    with closing(TestClient(resmon.app)) as client:
        response = client.get(f'/api/library/papers/{document}/places', headers=HEADERS)
        assert response.status_code == 200, response.text
        assert response.json()['library']['status'] == 'unconfigured'
        assert response.json()['shelf'] is None
        assert client.get('/api/library/papers/999999/places', headers=HEADERS).status_code == 404
        assert client.get(f'/api/library/papers/{document}/places').status_code == 403
        assert client.get(f'/api/library/papers/{document}/places?extra=1', headers=HEADERS).status_code == 400


@pytest.mark.parametrize('missing', ['file', 'folder'])
def test_a_missing_pdf_is_never_added_to_a_project(catalog, missing: str) -> None:
    conn, vault, root, document = catalog
    item = put(conn, vault, document)
    project = evidence.create_project(conn, vault, 'Missing PDF')['project']
    retained = root / item['relative_path']
    retained.unlink()
    if missing == 'folder':
        retained.parent.rmdir()
    with pytest.raises(library.LibraryError, match='no longer in the Library folder'):
        evidence.add_file(conn, vault, project['project_id'], 1, item['file_id'], item['version_id'])
    assert conn.execute('SELECT count(*) FROM evidence_project_files').fetchone()[0] == 0
    assert evidence.detail(conn, vault, project['project_id'])['project']['revision'] == 1


def test_places_use_the_link_and_membership_indexes(catalog) -> None:
    from implementation_scripts import library_places
    conn, vault, root, document = catalog
    item = put(conn, vault, document)
    project = evidence.create_project(conn, vault, 'Indexed')['project']
    evidence.add_file(conn, vault, project['project_id'], 1, item['file_id'], item['version_id'])
    queries: list[str] = []
    conn.set_trace_callback(queries.append)
    library_places.places(conn, document)
    conn.set_trace_callback(None)
    links = next(q for q in queries if 'FROM library_file_documents l' in q)
    members = next(q for q in queries if 'FROM evidence_projects p' in q)
    plans = [' '.join(str(r[3]) for r in conn.execute('EXPLAIN QUERY PLAN ' + query)) for query in (links, members)]
    assert 'SEARCH l USING INDEX idx_library_file_documents_document' in plans[0]
    assert 'SEARCH m USING INDEX sqlite_autoindex_evidence_project_files' in plans[1]


@pytest.mark.parametrize('kind', ['busy', 'missing', 'mismatch', 'missing_file'])
def test_places_keep_the_shelf_when_the_folder_cannot_supply_a_file(catalog, kind: str) -> None:
    from implementation_scripts import library_places
    conn, vault, root, document = catalog
    item = put(conn, vault, document)
    if kind == 'busy':
        (root / '.import.lock').write_text('test')
    elif kind == 'missing':
        root.rename(root.with_name(root.name + '-moved'))
    elif kind == 'mismatch':
        (root / 'vault.json').write_text('{}')
    else:
        (root / item['relative_path']).unlink()
    result = library_places.places(conn, document)
    assert result['library']['status'] == ('ready' if kind == 'missing_file' else kind)
    assert result['files'][0]['file_id'] == item['file_id']
    if kind == 'missing_file':
        assert result['files'][0]['availability'] == 'missing'


@pytest.mark.parametrize('kind', ['hardlink', 'symlink_folder', 'symlink_file', 'permission', 'missing_files'])
def test_an_unavailable_linked_path_does_not_hide_other_places(catalog, monkeypatch: pytest.MonkeyPatch, kind: str) -> None:
    conn, vault, root, document = catalog
    odd = put(conn, vault, document)
    good = put(conn, vault, document, b'%PDF-1.4\na different retained file')
    project = evidence.create_project(conn, vault, 'Still here')['project']
    evidence.add_file(conn, vault, project['project_id'], 1, good['file_id'], good['version_id'])
    retained = root / odd['relative_path']
    if kind == 'hardlink':
        os.link(retained, root.parent / 'second-link.pdf')
    elif kind == 'symlink_folder':
        moved = root.parent / 'outside-folder'
        retained.parent.rename(moved)
        retained.parent.symlink_to(moved, target_is_directory=True)
    elif kind == 'symlink_file':
        moved = root.parent / 'outside.pdf'
        retained.rename(moved)
        retained.symlink_to(moved)
    elif kind == 'permission':
        normal = library._open_dir

        def denied(name: str, parent: int | None = None) -> int:
            if name == odd['file_id']:
                raise PermissionError('This retained folder cannot be read.')
            return normal(name, parent)

        monkeypatch.setattr(library, '_open_dir', denied)
    else:
        (root / 'files').rename(root / 'kept-files')
    changes = conn.total_changes
    with closing(TestClient(resmon.app)) as client:
        response = client.get(f'/api/library/papers/{document}/places', headers=HEADERS)
    assert response.status_code == 200, response.text
    result = response.json()
    assert result['library']['status'] == 'ready'
    by_id = {item['file_id']: item for item in result['files']}
    assert by_id[odd['file_id']]['availability'] == ('missing' if kind == 'missing_files' else 'unavailable')
    assert by_id[good['file_id']]['availability'] == ('missing' if kind == 'missing_files' else 'not_checked')
    assert [p['name'] for p in result['projects']] == ['Still here']
    assert conn.total_changes == changes
    assert str(root.parent) not in response.text
