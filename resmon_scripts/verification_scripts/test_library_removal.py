"""Removing a Library file holds it, and Undo or Restore puts back exactly what went.

Every folder here is a pytest temporary folder. Nothing is sent to a system
Trash: the release route only hands back a path, and the test moves the file
out of the Library folder itself, where a desktop's Trash would.
"""
import hashlib
import json
import os
from pathlib import Path
import shutil

import pytest

from implementation_scripts import database as db, evidence as ev, library as lib, library_removal as rm, library_thumbs


@pytest.fixture
def world(tmp_path):
    c = db.get_connection(tmp_path / 'catalog.db'); db.init_db(conn=c)
    parent = tmp_path / 'parent'; parent.mkdir()
    status = lib.create_vault(c, str(parent))
    vid = status['vault']['vault_id']; root = parent / status['vault']['label']
    docs = [db.insert_document(c, {'source_repository': 'synthetic', 'external_id': str(i), 'title': f'Paper {i}',
                                   'metadata_hash': f'h{i}'}) for i in range(2)]
    c.commit()
    yield c, vid, root, docs
    c.close()


def put(c, vid, name, content, document_id=None):
    with lib.Import(c, vid, name, document_id) as upload:
        upload.write(content)
        return upload.finish()['file']


def project_with(c, vid, file, notes=1):
    made = ev.create_project(c, vid, 'Stability')['project']
    added = ev.add_file(c, vid, made['project_id'], made['revision'], file['file_id'], file['version_id'])
    revision = added['project']['revision']
    for i in range(notes):
        saved = ev.create_note(c, vid, made['project_id'], revision, file['file_id'], file['version_id'], 'note', f'note {i}')
        revision = saved['project']['revision']
    return made['project_id']


def rows(c, file_id):
    return {table: [tuple(r) for r in c.execute(f'SELECT * FROM {table} WHERE file_id=? ORDER BY rowid', (file_id,))]
            for table in ('library_files', 'library_file_documents', 'evidence_project_files', 'evidence_notes')}


def test_a_lone_file_is_held_and_undo_puts_back_the_folder_and_rows(world):
    c, vid, root, docs = world
    file = put(c, vid, 'paper.pdf', b'%PDF-1.4\nsynthetic', docs[0])
    before = rows(c, file['file_id'])
    folder = root / 'files' / file['file_id']
    stored = (folder / Path(file['relative_path']).name).read_bytes()
    assert rm.summary(c, vid, file['file_id'], file['version_id'])['needs_confirmation'] is False

    removed = rm.remove(c, vid, file['file_id'], file['version_id'], cascade=False)['removed']
    assert removed['bytes'] == 'held' and removed['links'] == 1 and removed['projects'] == []
    assert not folder.exists()
    held = root / 'removed' / file['file_id'] / Path(file['relative_path']).name
    assert held.read_bytes() == stored
    assert all(v == [] for v in rows(c, file['file_id']).values())
    assert lib.counts(c)['items'] == 0 and lib.counts(c)['removed'] == 1
    assert lib.status(c)['status'] == 'ready'
    assert [f['file_id'] for f in lib.list_files(c, vid)['files']] == []

    restored = rm.restore(c, vid, file['file_id'])['file']
    assert restored['file_id'] == file['file_id'] and restored['id'] == file['id']
    assert rows(c, file['file_id']) == before
    assert (folder / Path(file['relative_path']).name).read_bytes() == stored
    assert not (root / 'removed' / file['file_id']).exists()
    assert lib.counts(c)['removed'] == 0
    assert lib.open_request(c, vid, file['file_id'], file['version_id'])['path'].endswith('.pdf')


def test_a_file_in_a_project_asks_first_and_cascades_only_on_confirm(world):
    c, vid, root, docs = world
    file = put(c, vid, 'notes.txt', b'kept text', docs[1])
    project_id = project_with(c, vid, file, notes=2)
    revision = ev.detail(c, vid, project_id)['project']['revision']
    before = rows(c, file['file_id'])

    said = rm.summary(c, vid, file['file_id'], file['version_id'])
    assert said['needs_confirmation'] is True
    assert said['projects'] == [{'project_id': project_id, 'name': 'Stability', 'member': True, 'notes': 2, 'passages': 0}]
    assert [link['document_id'] for link in said['links']] == [docs[1]]
    with pytest.raises(lib.LibraryError) as refused:
        rm.remove(c, vid, file['file_id'], file['version_id'], cascade=False)
    assert refused.value.reason == 'needs_confirmation'
    assert rows(c, file['file_id']) == before and (root / 'files' / file['file_id']).exists()
    assert not (root / '.import.lock').exists()

    removed = rm.remove(c, vid, file['file_id'], file['version_id'], cascade=True)['removed']
    assert removed['notes'] == 2 and removed['projects'] == [{'project_id': project_id, 'name': 'Stability', 'notes': 2}]
    after = ev.detail(c, vid, project_id)['project']
    assert (after['file_count'], after['note_count'], after['revision']) == (0, 0, revision + 1)

    rm.restore(c, vid, file['file_id'])
    assert rows(c, file['file_id']) == before
    back = ev.detail(c, vid, project_id)['project']
    assert (back['file_count'], back['note_count'], back['revision']) == (1, 2, revision + 2)
    notes = ev.list_notes(c, vid, project_id)['notes']
    assert [n['body'] for n in notes] == ['note 0', 'note 1'] and all(n['membership_state'] == 'member' for n in notes)


def test_a_file_deleted_outside_resmon_is_removed_as_a_record(world):
    c, vid, root, docs = world
    file = put(c, vid, 'gone.md', b'# gone')
    shutil.rmtree(root / 'files' / file['file_id'])
    removed = rm.remove(c, vid, file['file_id'], file['version_id'], cascade=False)['removed']
    assert removed['bytes'] == 'missing'
    assert not (root / 'removed').exists()
    rm.restore(c, vid, file['file_id'])
    assert lib.status(c)['counts']['missing'] == 1


def test_the_same_bytes_kept_again_block_a_restore_and_change_nothing(world):
    c, vid, root, docs = world
    file = put(c, vid, 'a.txt', b'same bytes')
    rm.remove(c, vid, file['file_id'], file['version_id'], cascade=False)
    again = put(c, vid, 'b.txt', b'same bytes')
    assert again['file_id'] != file['file_id']
    with pytest.raises(lib.LibraryError) as refused:
        rm.restore(c, vid, file['file_id'])
    assert refused.value.reason == 'kept_again' and '“b.txt”' in str(refused.value)
    assert (root / 'removed' / file['file_id']).exists()
    assert lib.counts(c)['removed'] == 1 and lib.counts(c)['items'] == 1


def test_release_names_the_file_for_the_trash_and_forget_waits_for_it_to_leave(world):
    c, vid, root, docs = world
    file = put(c, vid, 'Thesis chapter 3.pdf', b'%PDF-1.7\nchapter')
    rm.remove(c, vid, file['file_id'], file['version_id'], cascade=False)
    with pytest.raises(lib.LibraryError) as held:
        rm.forget(c, vid, file['file_id'])
    assert held.value.reason == 'still_held'

    released = rm.release_request(c, vid, file['file_id'])
    path = Path(released['path'])
    assert path == root / 'removed' / file['file_id'] / 'Thesis chapter 3.pdf'
    assert path.read_bytes() == b'%PDF-1.7\nchapter'
    # A release that never finished: Restore still finds the file, under either name.
    rm.restore(c, vid, file['file_id'])
    assert lib.open_request(c, vid, file['file_id'], file['version_id'])['path'].endswith(file['version_id'] + '.pdf')

    rm.remove(c, vid, file['file_id'], file['version_id'], cascade=False)
    path = Path(rm.release_request(c, vid, file['file_id'])['path'])
    trash = path.parents[3] / 'stand-in-for-the-trash'; trash.mkdir()
    path.rename(trash / path.name)                      # what the desktop's Trash does
    listed = rm.list_removed(c, vid)['removed']
    assert [r['bytes'] for r in listed] == ['gone']
    assert rm.forget(c, vid, file['file_id'])['forgotten'] is True
    assert not (root / 'removed' / file['file_id']).exists()
    assert lib.counts(c)['removed'] == 0
    assert (trash / 'Thesis chapter 3.pdf').read_bytes() == b'%PDF-1.7\nchapter'


def test_held_bytes_deleted_by_hand_cannot_be_restored_and_can_be_forgotten(world):
    c, vid, root, docs = world
    file = put(c, vid, 'x.txt', b'x')
    rm.remove(c, vid, file['file_id'], file['version_id'], cascade=False)
    shutil.rmtree(root / 'removed' / file['file_id'])
    assert lib.status(c)['status'] == 'ready'
    with pytest.raises(lib.LibraryError) as refused:
        rm.restore(c, vid, file['file_id'])
    assert refused.value.reason == 'held_missing'
    rm.forget(c, vid, file['file_id'])
    assert rm.list_removed(c, vid)['removed'] == []


def test_a_failed_commit_puts_the_folder_back(world, monkeypatch):
    c, vid, root, docs = world
    file = put(c, vid, 'x.txt', b'x')

    class Failing:
        def __getattr__(self, name): return getattr(c, name)
        def commit(self): raise db.sqlite3.OperationalError('authored commit failure')
    with pytest.raises(db.sqlite3.OperationalError):
        rm.remove(Failing(), vid, file['file_id'], file['version_id'], cascade=False)
    assert (root / 'files' / file['file_id']).exists() and not (root / 'removed' / file['file_id']).exists()
    assert lib.counts(c)['items'] == 1 and lib.counts(c)['removed'] == 0
    assert not (root / '.import.lock').exists()


def test_removal_waits_for_an_import(world):
    c, vid, root, docs = world
    file = put(c, vid, 'x.txt', b'x')
    (root / '.import.lock').write_text('another import')
    with pytest.raises(lib.LibraryError) as busy:
        rm.remove(c, vid, file['file_id'], file['version_id'], cascade=False)
    assert busy.value.reason == 'busy'
    assert (root / '.import.lock').read_text() == 'another import'


def test_the_record_is_the_rows_as_they_were(world):
    c, vid, root, docs = world
    file = put(c, vid, 'x.txt', b'x', docs[0])
    rm.remove(c, vid, file['file_id'], file['version_id'], cascade=False)
    record = json.loads(c.execute('SELECT record_json FROM library_removed').fetchone()[0])
    assert record['file']['sha256'] == hashlib.sha256(b'x').hexdigest()
    assert [r['document_id'] for r in record['library_file_documents']] == [docs[0]]
    # A paper erased since takes its link with it, as erasing it would have.
    c.execute('DELETE FROM documents WHERE id=?', (docs[0],)); c.commit()
    rm.restore(c, vid, file['file_id'])
    assert lib.links(c, file['file_id']) == []


def test_pictures_are_kept_by_version_and_forgotten_with_the_record(world, tmp_path):
    c, vid, root, docs = world
    file = put(c, vid, 'p.pdf', b'%PDF-1.4\npicture')
    webp = b'RIFF\x10\x00\x00\x00WEBPVP8 ' + b'\x00' * 8
    with pytest.raises(lib.LibraryError) as none:
        library_thumbs.read(c, vid, file['file_id'], file['version_id'])
    assert none.value.reason == 'no_picture'
    kept = library_thumbs.write(c, vid, file['file_id'], file['version_id'], 'image/webp', webp)
    assert kept['byte_size'] == len(webp)
    assert library_thumbs.read(c, vid, file['file_id'], file['version_id']) == ('image/webp', webp)
    assert (tmp_path / 'catalog.db-library-pictures' / f"{file['version_id']}.webp").read_bytes() == webp
    png = b'\x89PNG\r\n\x1a\n' + b'\x00' * 8
    library_thumbs.write(c, vid, file['file_id'], file['version_id'], 'image/png', png)
    assert library_thumbs.read(c, vid, file['file_id'], file['version_id']) == ('image/png', png)
    for media, data, reason in [('image/png', webp, 'invalid_picture'), ('image/gif', b'GIF89a', 'invalid_picture'),
                                ('image/png', b'\x89PNG\r\n\x1a\n' + b'\x00' * (512 * 1024), 'picture_limit')]:
        with pytest.raises(lib.LibraryError) as refused:
            library_thumbs.write(c, vid, file['file_id'], file['version_id'], media, data)
        assert refused.value.reason == reason
    text = put(c, vid, 't.txt', b't')
    with pytest.raises(lib.LibraryError):
        library_thumbs.write(c, vid, text['file_id'], text['version_id'], 'image/png', png)
    with pytest.raises(lib.LibraryError):
        library_thumbs.read(c, vid, file['file_id'], text['version_id'])
    rm.remove(c, vid, file['file_id'], file['version_id'], cascade=False)
    path = Path(rm.release_request(c, vid, file['file_id'])['path'])
    os.unlink(path)
    rm.forget(c, vid, file['file_id'])
    assert not list((tmp_path / 'catalog.db-library-pictures').glob(f"{file['version_id']}.*"))
