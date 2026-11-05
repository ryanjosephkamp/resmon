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
