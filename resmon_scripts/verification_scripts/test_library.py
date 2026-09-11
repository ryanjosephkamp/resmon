"""Managed bytes, durable UUIDs and preservation at real filesystem/SQL seams."""
import hashlib
import json
import os
from pathlib import Path
import sqlite3
import uuid
from concurrent.futures import ThreadPoolExecutor
import pytest
from implementation_scripts import database as db, library as lib, library_export


@pytest.fixture
def vault(tmp_path):
    c = db.get_connection(tmp_path / 'catalog.db'); db.init_db(conn=c)
    parent = tmp_path / 'parent'; parent.mkdir()
    status = lib.create_vault(c, str(parent))
    vid = status['vault']['vault_id']; root = parent / status['vault']['label']
    yield c, vid, root
    c.close()


def put(c, vid, name='paper.txt', content=b'authored text', document_id=None):
    with lib.Import(c, vid, name, document_id) as upload:
        upload.write(content)
        return upload.finish()


def test_constants_and_no_implicit_creation(tmp_path):
    assert (lib.MAX_FILE_BYTES, lib.MAX_BATCH_FILES, lib.MAX_VAULT_BYTES, lib.MAX_ITEMS) == (67108864, 20, 1073741824, 10000)
    assert library_export.MAX_EXPORT_BYTES == 8388608
    c = db.get_connection(tmp_path / 'empty.db'); db.init_db(conn=c)
    assert lib.status(c)['status'] == 'unconfigured'
    assert not list(tmp_path.glob('resmon-library-*'))
    c.close()


def test_formats_duplicates_changed_bytes_and_media(vault):
    c, vid, root = vault
    for name, content in [('x.pdf', b'%PDF-1.4\nsynthetic'), ('x.txt', 'λ\r\nhello'.encode()), ('x.md', b'# title\n')]:
        item = put(c, vid, name, content)['file']
        assert (root / item['relative_path']).read_bytes() == content
        assert item['sha256'] == hashlib.sha256(content).hexdigest()
        assert put(c, vid, 'renamed.' + name.split('.')[-1], content)['file'] == item
        assert lib.open_request(c, vid, item['file_id'], item['version_id'])['path'] == str(root / item['relative_path'])
    assert lib.counts(c)['items'] == 3
    changed = put(c, vid, 'x.txt', b'new bytes')['file']
    assert changed['file_id'] != lib.list_files(c, vid)['files'][-1]['file_id']
    with pytest.raises(lib.LibraryError, match='media interpretation'):
        put(c, vid, 'x.md', b'new bytes')
    with pytest.raises(lib.LibraryError, match='already has a vault'):
        lib.create_vault(c, str(root.parent))


@pytest.mark.parametrize('name,content', [('a/b.txt', b'x'), ('a\\b.md', b'x'), ('x\x01.txt', b'x'), ('x.exe', b'x'), ('x.txt', b''), ('x.txt', b'\xff'), ('x.md', b'a\0b'), ('x.pdf', b'not pdf'), ('x.txt', b'\xf0\x9f')])
def test_invalid_uploads_publish_nothing(vault, name, content):
    c, vid, root = vault
    with pytest.raises(lib.LibraryError):
        put(c, vid, name, content)
    assert lib.counts(c)['items'] == 0
    assert sorted(p.name for p in root.iterdir()) == ['files', 'vault.json']


def test_real_stream_bound_capacity_duplicate_and_original(vault, tmp_path, monkeypatch):
    c, vid, root = vault
    original = tmp_path / 'original.txt'; original.write_bytes(b'abcd'); old = original.read_bytes()
    first = put(c, vid, content=original.read_bytes())
    monkeypatch.setattr(lib, 'MAX_FILE_BYTES', 5)
    with pytest.raises(lib.LibraryError, match='64 MiB'):
        with lib.Import(c, vid, 'overflow.txt') as stream:
            stream.write(b'abc'); stream.write(b'def')
    monkeypatch.setattr(lib, 'MAX_ITEMS', 1)
    monkeypatch.setattr(lib, 'MAX_VAULT_BYTES', 4)
    assert put(c, vid, content=b'abcd')['duplicate']
    with pytest.raises(lib.LibraryError, match='capacity'):
        put(c, vid, content=b'new')
    assert original.read_bytes() == old
    assert (root / first['file']['relative_path']).read_bytes() == old


def test_exact_byte_comparison_refuses_a_digest_collision(vault, monkeypatch):
    c, vid, root = vault
    first = put(c, vid, content=b'AAAA')['file']
    # Force only the incoming digest to collide; retained validation remains real.
    with pytest.raises(lib.LibraryError, match='different bytes'):
        with lib.Import(c, vid, 'other.txt') as upload:
            upload.write(b'BBBB')
            class Digest:
                def hexdigest(self): return first['sha256']
            upload.digest = Digest()
            upload.finish()
    assert lib.counts(c)['items'] == 1
    assert (root / first['relative_path']).read_bytes() == b'AAAA'


@pytest.mark.parametrize('kind', ['missing', 'wrong', 'malformed', 'oversize', 'symlink'])
def test_marker_refusal_never_recreates_or_adopts(vault, tmp_path, kind):
    c, vid, root = vault
    item = put(c, vid)['file']; marker = root / 'vault.json'
    if kind == 'missing': marker.unlink()
    elif kind == 'wrong': marker.write_text(json.dumps({'version': 1, 'vault_id': str(uuid.uuid4())}))
    elif kind == 'malformed': marker.write_text('[')
    elif kind == 'oversize': marker.write_bytes(b' ' * 4097)
    else:
        target = tmp_path / 'foreign-marker'; target.write_bytes(marker.read_bytes()); marker.unlink(); marker.symlink_to(target)
    with pytest.raises((lib.LibraryError, OSError)):
        lib.open_request(c, vid, item['file_id'], item['version_id'])
    with pytest.raises((lib.LibraryError, OSError)):
        put(c, vid, content=b'next')
    assert lib.counts(c)['items'] == 1
    assert (root / item['relative_path']).read_bytes() == b'authored text'


def test_ids_paths_corruption_and_symlink_are_refused(vault, tmp_path):
    c, vid, root = vault; item = put(c, vid)['file']
    with pytest.raises(lib.LibraryError): lib.detail(c, str(uuid.uuid4()), item['file_id'])
    with pytest.raises(lib.LibraryError): lib.detail(c, vid, str(uuid.uuid4()))
    with pytest.raises(lib.LibraryError): lib.open_request(c, vid, item['file_id'], str(uuid.uuid4()))
    retained = root / item['relative_path']; retained.write_bytes(b'changed bytes')
    with pytest.raises(lib.LibraryError): lib.open_request(c, vid, item['file_id'], item['version_id'])
    retained.unlink(); foreign = tmp_path / 'foreign'; foreign.write_bytes(b'authored text'); retained.symlink_to(foreign)
    with pytest.raises(OSError): lib.open_request(c, vid, item['file_id'], item['version_id'])
    assert foreign.read_bytes() == b'authored text'


def test_orphans_stale_lock_and_diverged_catalog_block(vault, tmp_path):
    c, vid, root = vault
    stale = root / '.import.lock'; stale.write_text('not our lock')
    with pytest.raises(lib.LibraryError, match='lock exists'): put(c, vid)
    assert stale.read_text() == 'not our lock'; stale.unlink()
    orphan = root / '.staging-unknown'; orphan.write_bytes(b'unknown')
    with pytest.raises(lib.LibraryError, match='Unexpected'): put(c, vid)
    assert orphan.read_bytes() == b'unknown'; orphan.unlink()
    clone = db.get_connection(tmp_path / 'clone.db'); c.backup(clone)
    put(c, vid)
    with pytest.raises(lib.LibraryError, match='catalog differ'): put(clone, vid, content=b'new')
    clone.close()


@pytest.mark.parametrize('failure', ['enospc', 'publish', 'commit', 'disconnect'])
def test_caught_failure_removes_only_its_unpublished_bytes(vault, monkeypatch, failure):
    c, vid, root = vault; first = put(c, vid)['file']; before = (root / first['relative_path']).read_bytes()
    class CommitFailure:
        def __getattr__(self, name): return getattr(c, name)
        def commit(self): raise sqlite3.OperationalError('authored commit failure')
    conn = CommitFailure() if failure == 'commit' else c
    def fail(*args, **kwargs): raise OSError(28, 'authored full disk')
    if failure == 'enospc': monkeypatch.setattr(os, 'write', fail)
    with pytest.raises((OSError, sqlite3.Error, RuntimeError)):
        with lib.Import(conn, vid, 'new.txt') as upload:
            upload.write(b'new retained bytes')
            if failure == 'publish': monkeypatch.setattr(os, 'link', fail)
            if failure == 'disconnect': raise RuntimeError('authored disconnect')
            upload.finish()
    assert lib.counts(c)['items'] == 1
    assert (root / first['relative_path']).read_bytes() == before
    assert sorted(p.name for p in root.iterdir()) == ['files', 'vault.json']
    assert [p.name for p in (root / 'files').iterdir()] == [first['file_id']]


def test_lock_excludes_an_independent_process(vault):
    import subprocess, sys
    c, vid, root = vault
    path = c.execute('PRAGMA database_list').fetchone()[2]
    with lib.Import(c, vid, 'first.txt') as upload:
        upload.write(b'first')
        script = '''import sys
from implementation_scripts import database as d,library as l
c=d.get_connection(sys.argv[1])
try:
 with l.Import(c,sys.argv[2],'other.txt') as u:u.write(b'other');u.finish()
except l.LibraryError as e:
 assert e.reason=='busy';print('blocked')
else:raise AssertionError('concurrent publication')
finally:c.close()
'''
        env = dict(os.environ); env['PYTHONPATH'] = str(Path(__file__).parents[1]) + os.pathsep + env.get('PYTHONPATH', '')
        result = subprocess.run([sys.executable, '-c', script, path, vid], env=env, capture_output=True, text=True, timeout=20)
        assert result.returncode == 0, result.stderr
        assert result.stdout.strip() == 'blocked'
        upload.finish()
    assert lib.counts(c)['items'] == 1


def test_keyset_123_inventory_links_delete_reuse_and_restart(vault, monkeypatch):
    c, vid, root = vault
    for i in range(123): put(c, vid, f'{i:03} %_ literal.txt', str(i).encode())
    c.execute("UPDATE library_files SET created_at_utc='authored-same-timestamp'");c.commit()
    first = lib.list_files(c, vid); put(c, vid, content=b'newer than ceiling')
    all_items = list(first['files']); page = first
    while page['has_more']:
        page = lib.list_files(c, vid, through_id=first['through_id'], before_id=page['next_before_id'])
        all_items += page['files']
    assert len(all_items) == len({x['file_id'] for x in all_items}) == 123
    assert len(lib.list_files(c, vid, q='%_', limit=100)['files']) == 100
    item = first['files'][0]
    ids = []
    for i in range(2):
        ids.append(db.insert_document(c, {'source_repository': 'synthetic', 'external_id': str(i), 'title': f'Local {i}', 'metadata_hash': str(i)}))
    c.commit()
    for doc in ids: lib.add_link(c, vid, item['file_id'], doc)
    lib.add_link(c, vid, item['file_id'], ids[0]); assert len(lib.links(c, item['file_id'])) == 2
    with pytest.raises(lib.LibraryError): lib.add_link(c, vid, item['file_id'], 999999)
    c.execute('DELETE FROM documents WHERE id=?', (ids[0],)); c.commit()
    c.execute('INSERT INTO documents(id,source_repository,external_id,title,metadata_hash) VALUES (?,?,?,?,?)', (ids[0], 'synthetic', 'reused', 'Reused ID', 'new')); c.commit()
    assert [l['document_id'] for l in lib.links(c, item['file_id'])] == ids[1:]
    c.execute("INSERT OR REPLACE INTO app_settings(key,value) VALUES ('library_test_unrelated_setting','synthetic-private-setting-sentinel')");c.commit()
    inventory = library_export.export_inventory(c, vid)
    parsed = json.loads(inventory['text']); assert len(parsed['files']) == 124
    assert 'synthetic-private-setting-sentinel' not in inventory['text']
    assert str(root) not in inventory['text'] and 'root_path' not in inventory['text']
    assert all(x['availability'] == 'not_checked' for x in parsed['files'])
    monkeypatch.setattr(library_export, 'MAX_EXPORT_BYTES', 20)
    with pytest.raises(lib.LibraryError, match='nothing was truncated'): library_export.export_inventory(c, vid)
    path = c.execute('PRAGMA database_list').fetchone()[2]
    other = db.get_connection(path); db.init_db(conn=other)
    assert lib.detail(other, vid, item['file_id'])['file']['version_id'] == item['version_id']
    other.close()


def test_distinct_database_vaults_never_accept_foreign_file_or_pairing(vault, tmp_path):
    first, first_id, first_root = vault
    retained = put(first, first_id)['file']
    other = db.get_connection(tmp_path / 'other.db'); db.init_db(conn=other)
    parent = tmp_path / 'other-parent'; parent.mkdir()
    status = lib.create_vault(other, str(parent)); other_id = status['vault']['vault_id']
    other_root = parent / status['vault']['label']
    assert other_id != first_id
    try:
        for conn, vid, fid in [(first, other_id, retained['file_id']), (other, first_id, retained['file_id']), (other, other_id, retained['file_id'])]:
            with pytest.raises(lib.LibraryError): lib.open_request(conn, vid, fid, retained['version_id'])
        assert lib.counts(other)['items'] == 0
        assert list((other_root / 'files').iterdir()) == []
        assert (first_root / retained['relative_path']).read_bytes() == b'authored text'
    finally:
        other.close()


def test_existing_destination_is_never_overwritten_or_cleaned(vault, monkeypatch):
    c, vid, root = vault
    prior = put(c, vid)['file']; before = (root / prior['relative_path']).read_bytes()
    with pytest.raises(FileExistsError):
        with lib.Import(c, vid, 'different.txt') as upload:
            upload.write(b'new content')
            # Collide only the future publication file UUID, after staging exists.
            monkeypatch.setattr(lib.uuid, 'uuid4', lambda: uuid.UUID(prior['file_id']))
            upload.finish()
    assert lib.counts(c)['items'] == 1
    assert (root / prior['relative_path']).read_bytes() == before
    assert lib.status(c)['status'] == 'ready'


@pytest.mark.parametrize('component', ['root', 'files', 'folder', 'hardlink', 'fifo'])
def test_managed_components_and_nonregular_objects_refuse(vault, tmp_path, component):
    c, vid, root = vault; item = put(c, vid)['file']; stored = root / item['relative_path']
    if component in ('root', 'files', 'folder'):
        target = {'root': root, 'files': root / 'files', 'folder': stored.parent}[component]
        held = target.with_name(target.name + '-held'); target.rename(held); target.symlink_to(held, target_is_directory=True)
    elif component == 'hardlink':
        os.link(stored, tmp_path / 'other-link')
    else:
        held = stored.with_suffix('.held'); stored.rename(held); os.mkfifo(stored)
    with pytest.raises((lib.LibraryError, OSError)):
        lib.open_request(c, vid, item['file_id'], item['version_id'])
    assert lib.counts(c)['items'] == 1
    if component == 'fifo': assert held.read_bytes() == b'authored text'
    else: assert stored.read_bytes() == b'authored text'


def test_changed_retained_size_blocks_import_without_rewriting_prior_bytes(vault):
    c, vid, root = vault; item = put(c, vid)['file']; retained = root / item['relative_path']
    retained.write_bytes(b'authored external size change, kept for owner inspection')
    altered = retained.read_bytes()
    assert lib.status(c)['status'] == 'needs_attention'
    with pytest.raises(lib.LibraryError, match='recorded quota'):
        put(c, vid, 'another.txt', b'new selection')
    assert lib.counts(c)['items'] == 1 and retained.read_bytes() == altered
    assert not (root / '.import.lock').exists()
