"""The Library folder moved outside resmon, found again; and moved by resmon, on one disk or two.

Every folder is a pytest temporary folder. A move across disks is the same
code a real second disk takes, reached by refusing the one-rename path with
``EXDEV`` exactly as the operating system does.
"""
import errno
import os
from pathlib import Path

import pytest

from implementation_scripts import database as db, library as lib, library_folder as lf, library_removal as rm


@pytest.fixture
def kept(tmp_path):
    c = db.get_connection(tmp_path / 'catalog.db'); db.init_db(conn=c)
    parent = tmp_path / 'first'; parent.mkdir()
    status = lib.create_vault(c, str(parent))
    vid = status['vault']['vault_id']; root = parent / status['vault']['label']
    files = []
    for name, content in [('a.pdf', b'%PDF-1.4\na'), ('b.md', b'# b\n'), ('c.tex', b'$x^2$')]:
        with lib.Import(c, vid, name) as upload:
            upload.write(content)
            files.append(upload.finish()['file'])
    yield c, vid, root, files
    c.close()


def bytes_of(root, files):
    return {f['file_id']: (root / f['relative_path']).read_bytes() for f in files}


def test_status_says_where_the_folder_is_and_that_it_is_missing(kept, tmp_path):
    c, vid, root, files = kept
    status = lib.status(c)
    assert status['vault']['path'] == str(root) and status['status'] == 'ready'
    moved = tmp_path / 'elsewhere'; moved.mkdir()
    root.rename(moved / root.name)
    status = lib.status(c)
    assert (status['status'], status['reason']) == ('missing', 'folder_missing')
    assert status['vault']['path'] == str(root) and status['counts']['items'] == 3
    with pytest.raises(FileNotFoundError):
        lib.open_request(c, vid, files[0]['file_id'], files[0]['version_id'])


@pytest.mark.parametrize('chosen', ['the folder', 'its parent'])
def test_relink_records_the_folder_where_it_is_now_and_changes_nothing_in_it(kept, tmp_path, chosen):
    c, vid, root, files = kept
    before = bytes_of(root, files)
    moved_parent = tmp_path / 'elsewhere'; moved_parent.mkdir()
    moved = moved_parent / root.name
    root.rename(moved)
    status = lf.relink(c, vid, str(moved if chosen == 'the folder' else moved_parent))
    assert status['status'] == 'ready' and status['vault']['path'] == str(moved)
    assert bytes_of(moved, files) == before
    assert lib.open_request(c, vid, files[0]['file_id'], files[0]['version_id'])['path'].startswith(str(moved))


def test_relink_refuses_another_library_and_a_folder_that_is_not_there(kept, tmp_path):
    c, vid, root, files = kept
    other = db.get_connection(tmp_path / 'other.db'); db.init_db(conn=other)
    (tmp_path / 'other').mkdir()
    foreign = lib.create_vault(other, str(tmp_path / 'other'))
    other.close()
    foreign_root = tmp_path / 'other' / foreign['vault']['label']
    impostor = tmp_path / 'impostor'; impostor.mkdir()
    os.rename(foreign_root, impostor / root.name)       # another Library under this one's name
    with pytest.raises(lib.LibraryError) as refused:
        lf.relink(c, vid, str(impostor / root.name))
    assert refused.value.reason == 'mismatch'
    with pytest.raises(lib.LibraryError) as absent:
        lf.relink(c, vid, str(tmp_path / 'nowhere'))
    assert absent.value.reason == 'not_found'
    assert lib.status(c)['vault']['path'] == str(root)


def test_move_on_one_disk_is_one_rename(kept, tmp_path):
    c, vid, root, files = kept
    rm.remove(c, vid, files[2]['file_id'], files[2]['version_id'], cascade=False)
    before = bytes_of(root, files[:2])
    target = tmp_path / 'second'; target.mkdir()
    status = lf.move(c, vid, str(target))
    new_root = target / root.name
    assert status['moved'] == {'previous': str(root), 'path': str(new_root), 'same_disk': True, 'old_folder_kept': None}
    assert status['status'] == 'ready' and status['vault']['path'] == str(new_root)
    assert not root.exists()
    assert bytes_of(new_root, files[:2]) == before
    assert sorted(p.name for p in new_root.iterdir()) == ['files', 'removed', 'vault.json']
    rm.restore(c, vid, files[2]['file_id'])
    assert lib.open_request(c, vid, files[2]['file_id'], files[2]['version_id'])['path'].startswith(str(new_root))


def test_move_across_disks_copies_checks_and_leaves_the_old_folder(kept, tmp_path, monkeypatch):
    c, vid, root, files = kept
    rm.remove(c, vid, files[2]['file_id'], files[2]['version_id'], cascade=False)
    before = bytes_of(root, files[:2])
    real_rename = os.rename

    def cross_device(src, dst, *, src_dir_fd=None, dst_dir_fd=None):
        if src == root.name:
            raise OSError(errno.EXDEV, 'Invalid cross-device link')
        return real_rename(src, dst, src_dir_fd=src_dir_fd, dst_dir_fd=dst_dir_fd)
    monkeypatch.setattr(lf.os, 'rename', cross_device)
    target = tmp_path / 'second'; target.mkdir()
    status = lf.move(c, vid, str(target))
    monkeypatch.undo()
    new_root = target / root.name
    assert status['moved'] == {'previous': str(root), 'path': str(new_root), 'same_disk': False, 'old_folder_kept': str(root)}
    assert bytes_of(new_root, files[:2]) == before and bytes_of(root, files[:2]) == before
    assert not (root / '.import.lock').exists() and not (new_root / '.import.lock').exists()
    assert (new_root / 'removed' / files[2]['file_id']).is_dir()
    assert lib.status(c)['vault']['path'] == str(new_root)
    rm.restore(c, vid, files[2]['file_id'])
    assert (new_root / files[2]['relative_path']).read_bytes() == b'$x^2$'


def test_a_copy_that_fails_takes_back_only_what_it_made(kept, tmp_path, monkeypatch):
    c, vid, root, files = kept
    before = bytes_of(root, files)
    (root / files[1]['relative_path']).write_bytes(b'# changed outside resmon\n')
    real_rename = os.rename

    def cross_device(src, dst, *, src_dir_fd=None, dst_dir_fd=None):
        if src == root.name:
            raise OSError(errno.EXDEV, 'Invalid cross-device link')
        return real_rename(src, dst, src_dir_fd=src_dir_fd, dst_dir_fd=dst_dir_fd)
    monkeypatch.setattr(lf.os, 'rename', cross_device)
    target = tmp_path / 'second'; target.mkdir()
    (target / 'theirs.txt').write_text('a file of the person’s own')
    with pytest.raises(lib.LibraryError) as refused:
        lf.move(c, vid, str(target))
    assert refused.value.reason == 'changed_content'
    assert sorted(p.name for p in target.iterdir()) == ['theirs.txt']
    assert lib.status(c)['vault']['path'] == str(root)
    assert bytes_of(root, [files[0], files[2]]) == {k: v for k, v in before.items() if k != files[1]['file_id']}
    assert not (root / '.import.lock').exists()


def test_move_refuses_a_folder_that_already_has_one_and_its_own_inside(kept, tmp_path):
    c, vid, root, files = kept
    target = tmp_path / 'second'; (target / root.name).mkdir(parents=True)
    with pytest.raises(lib.LibraryError) as exists:
        lf.move(c, vid, str(target))
    assert exists.value.reason == 'exists'
    with pytest.raises(lib.LibraryError) as same:
        lf.move(c, vid, str(root.parent))
    assert same.value.reason == 'same_folder'
    (root / 'files' / 'x').mkdir()
    with pytest.raises(lib.LibraryError):
        lf.move(c, vid, str(root / 'files'))
    assert lib.status(c)['vault']['path'] == str(root)


def _across_disks(monkeypatch, root):
    real_rename = os.rename

    def cross_device(src, dst, *, src_dir_fd=None, dst_dir_fd=None):
        if src == root.name:
            raise OSError(errno.EXDEV, 'Invalid cross-device link')
        return real_rename(src, dst, src_dir_fd=src_dir_fd, dst_dir_fd=dst_dir_fd)
    monkeypatch.setattr(lf.os, 'rename', cross_device)


def test_a_relink_is_refused_while_a_move_runs_and_the_status_says_so(kept, tmp_path, monkeypatch):
    import threading
    c, vid, root, files = kept
    _across_disks(monkeypatch, root)
    copying, release = threading.Event(), threading.Event()
    real_copy = lf._copy

    def slow_copy(*args, **kwargs):
        copying.set()
        assert release.wait(10)
        return real_copy(*args, **kwargs)
    monkeypatch.setattr(lf, '_copy', slow_copy)
    target = tmp_path / 'second'; target.mkdir()
    db_path = c.execute('PRAGMA database_list').fetchone()[2]
    outcome = {}

    def mover():
        own = db.get_connection(db_path)
        try:
            outcome['moved'] = lf.move(own, vid, str(target))
        except BaseException as exc:  # noqa: BLE001 — reported to the test below
            outcome['error'] = exc
        finally:
            own.close()
    thread = threading.Thread(target=mover)
    thread.start()
    try:
        assert copying.wait(10)
        # The half-made copy is a folder of this Library's name with its marker: a relink would accept it.
        with pytest.raises(lib.LibraryError) as refused:
            lf.relink(c, vid, str(target / root.name))
        assert refused.value.reason == 'changing'
        assert str(refused.value) == 'The Library folder is being moved. Try again when the move has finished.'
        assert lib.status(c)['changing'] == 'moving'
        with pytest.raises(lib.LibraryError) as again:
            lf.move(c, vid, str(tmp_path))
        assert again.value.reason == 'changing'
    finally:
        release.set()
        thread.join(30)
    assert 'error' not in outcome, outcome.get('error')
    assert outcome['moved']['vault']['path'] == str(target / root.name)
    assert 'changing' not in outcome['moved'] and 'changing' not in lib.status(c)


def test_a_move_whose_new_place_cannot_be_recorded_takes_its_copy_away(kept, tmp_path, monkeypatch):
    c, vid, root, files = kept
    before = bytes_of(root, files)
    _across_disks(monkeypatch, root)

    def refused(*_args):
        raise lib.LibraryError('wrong_vault', 'The Library folder changed while it was moved.')
    monkeypatch.setattr(lf, '_record', refused)
    target = tmp_path / 'second'; target.mkdir()
    (target / 'theirs.txt').write_text('a file of the person’s own')
    with pytest.raises(lib.LibraryError) as failed:
        lf.move(c, vid, str(target))
    assert failed.value.reason == 'wrong_vault'
    assert sorted(p.name for p in target.iterdir()) == ['theirs.txt']
    assert bytes_of(root, files) == before and lib.status(c)['vault']['path'] == str(root)
    assert lib.vault_changing() is None


def test_a_move_to_a_disk_without_room_is_refused_before_anything_is_copied(kept, tmp_path, monkeypatch):
    c, vid, root, files = kept
    _across_disks(monkeypatch, root)
    real_statvfs = os.fstatvfs

    class Disk:
        def __init__(self, free):
            self.f_bavail, self.f_frsize = free, 1

    sizes = sum(f['byte_size'] for f in files) + (root / 'vault.json').stat().st_size
    monkeypatch.setattr(lf.os, 'fstatvfs', lambda fd: Disk(sizes + lib.FREE_SPACE_FLOOR - 1))
    target = tmp_path / 'second'; target.mkdir()
    with pytest.raises(lib.LibraryError) as full:
        lf.move(c, vid, str(target))
    assert (full.value.reason, full.value.status) == ('disk_full', 507)
    assert str(full.value).endswith('and 512 MB to spare; nothing was moved.')
    assert list(target.iterdir()) == []
    # Exactly enough room is room.
    monkeypatch.setattr(lf.os, 'fstatvfs', lambda fd: Disk(sizes + lib.FREE_SPACE_FLOOR))
    assert lf.move(c, vid, str(target))['moved']['same_disk'] is False
    monkeypatch.setattr(lf.os, 'fstatvfs', real_statvfs)


METADATA = ['.DS_Store', '._a.pdf', 'Thumbs.db', 'desktop.ini', 'Icon\r']


@pytest.mark.parametrize('name', METADATA)
def test_the_operating_systems_metadata_never_stops_the_library(kept, tmp_path, monkeypatch, name):
    c, vid, root, files = kept
    rm.remove(c, vid, files[2]['file_id'], files[2]['version_id'], cascade=False)
    held = root / 'removed' / files[2]['file_id']
    for folder in (root, root / 'files', root / 'removed', held, root / files[0]['relative_path']):
        place = folder.parent if folder.is_file() else folder
        (place / name).write_bytes(b'\x00\x00\x00\x01Bud1')
    status = lib.status(c)
    assert status['status'] == 'ready' and status['counts']['missing'] == 0
    assert lib.list_files(c, vid)['files']
    assert rm.list_removed(c, vid)['removed'][0]['bytes'] == 'held'
    # Moving it to the Trash asks for the held file by its own name; a release then forgets it.
    asked = rm.release_request(c, vid, files[2]['file_id'])
    assert Path(asked['path']).name == files[2]['original_name']
    # Put back, across a .DS_Store in the held folder.
    rm.restore(c, vid, files[2]['file_id'])
    assert (root / files[2]['relative_path']).read_bytes() == b'$x^2$'
    # A move to another disk copies the files and passes over the metadata.
    rm.remove(c, vid, files[1]['file_id'], files[1]['version_id'], cascade=False)
    (root / 'removed' / files[1]['file_id'] / name).write_bytes(b'Bud1')
    _across_disks(monkeypatch, root)
    target = tmp_path / 'second'; target.mkdir()
    moved = lf.move(c, vid, str(target))
    assert moved['status'] == 'ready'
    new_root = target / root.name
    assert (new_root / files[0]['relative_path']).read_bytes() == b'%PDF-1.4\na'
    assert not (new_root / name).exists()
    # A held file sent to the Trash leaves only metadata behind: the record is forgotten, the folder with it.
    monkeypatch.undo()
    held_now = new_root / 'removed' / files[1]['file_id']
    for inner in held_now.iterdir():
        if not lib.os_metadata(inner.name):
            inner.unlink()
    (held_now / name).write_bytes(b'Bud1')
    assert rm.forget(c, vid, files[1]['file_id'])['forgotten'] is True
    assert not held_now.exists()
