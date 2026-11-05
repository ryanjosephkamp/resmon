"""Where the Library folder is: pointing at it where it is now, or moving it.

The database records one folder, ``resmon-library-<vault id>``, by its absolute
path. Two things change that path, and both keep the folder's name, because the
name is how a folder is paired with its database (``library.vault_row``):

* **Relink** is for a folder that moved without resmon: dragged elsewhere in the
  Finder, or on a disk mounted under another name. The person points at it; its
  ``vault.json`` must name this vault and its ``files/`` must be the catalog's,
  and only then is the new path recorded. Nothing in the folder is changed.
* **Move** is for putting the Library somewhere else on purpose. On the same disk
  it is one rename of the whole folder. On another disk the files are copied, each
  one checked against its recorded hash, and the new path is recorded only once
  every byte is there; the old folder is then left where it was, whole, for the
  person to delete when they are sure, because resmon does not delete their files.
"""
from __future__ import annotations

import errno
import hashlib
import json
import os
from pathlib import Path
import sqlite3

from . import library
from .library import LibraryError


def _child(vault_id: str) -> str:
    return 'resmon-library-' + vault_id


def _candidate(chosen: str, vault_id: str) -> str:
    """The folder the person meant: the Library folder itself, or the folder it is in."""
    if not isinstance(chosen, str) or not os.path.isabs(chosen) or '\x00' in chosen:
        raise LibraryError('invalid_root', 'Choose an existing folder.', 400)
    path = Path(chosen)
    if path.name == _child(vault_id):
        return str(path)
    return str(path / _child(vault_id))


def _marker_ok(root: int, vault_id: str) -> None:
    fd = library._regular('vault.json', root)
    try:
        raw = os.read(fd, library.MARKER_LIMIT + 1)
    finally:
        os.close(fd)
    try:
        marker = json.loads(raw) if len(raw) <= library.MARKER_LIMIT else None
    except (ValueError, UnicodeError):
        marker = None
    if marker != {'version': 1, 'vault_id': vault_id} or type(marker.get('version')) is not int:
        raise LibraryError('mismatch', 'That folder is another Library, not this one; nothing was changed.')


def relink(conn: sqlite3.Connection, expected: str, chosen: str) -> dict:
    """Record where the Library folder is now, after checking it is this Library's folder."""
    vault = library.vault_row(conn, expected)
    target = _candidate(chosen, expected)
    try:
        with library.directory(target) as root:
            _marker_ok(root, expected)
            library._catalog_tree(conn, root)
    except FileNotFoundError:
        raise LibraryError('not_found', f'There is no {_child(expected)} folder there. Choose the Library folder itself, '
                           'or the folder it is in.', 404) from None
    conn.execute('BEGIN IMMEDIATE')
    try:
        if library.vault_row(conn, expected)['root_path'] != vault['root_path']:
            raise LibraryError('wrong_vault', 'The Library folder changed while this was checked. Try again.')
        conn.execute('UPDATE library_vault SET root_path=? WHERE singleton=1', (target,))
        conn.commit()
    except BaseException:
        conn.rollback()
        raise
    return library.status(conn)


def _copy(source: int, name: str, target: int, expected_size: int | None = None,
          expected_sha: str | None = None) -> None:
    """One regular file, copied byte for byte, written and synced, and checked against its hash."""
    src = library._regular(name, source)
    dst = None
    done = False
    try:
        dst = library._regular(name, target, os.O_WRONLY | os.O_CREAT | os.O_EXCL)
        digest = hashlib.sha256()
        size = 0
        while True:
            chunk = os.read(src, 1024 * 1024)
            if not chunk:
                break
            digest.update(chunk)
            size += len(chunk)
            view = memoryview(chunk)
            while view:
                view = view[os.write(dst, view):]
        os.fsync(dst)
        if (expected_size is not None and size != expected_size) or (expected_sha is not None and digest.hexdigest() != expected_sha):
            raise LibraryError('changed_content', 'A kept file is not the bytes its record names, so the Library was '
                               'not moved. Nothing in the old folder was changed.')
        done = True
    finally:
        os.close(src)
        if dst is not None:
            os.close(dst)
            if not done:
                # This copy's own partial file, never the original.
                os.unlink(name, dir_fd=target)


def move(conn: sqlite3.Connection, expected: str, parent: str) -> dict:
    """Move the Library folder into ``parent``, keeping its name."""
    with library.checked_vault(conn, expected) as (vault, old_root):
        old_path = Path(vault['root_path'])
        child = _child(expected)
        with library.directory(parent) as new_parent:
            if os.path.realpath(parent) == os.path.realpath(str(old_path.parent)):
                raise LibraryError('same_folder', 'The Library is already in that folder.', 400)
            try:
                os.stat(child, dir_fd=new_parent, follow_symlinks=False)
                raise LibraryError('exists', f'That folder already has a {child} folder; nothing was moved.')
            except FileNotFoundError:
                pass
            if os.path.realpath(parent).startswith(os.path.realpath(str(old_path)) + os.sep):
                raise LibraryError('inside', 'The Library cannot be moved into its own folder.', 400)
            try:
                lock = library._regular('.import.lock', old_root, os.O_WRONLY | os.O_CREAT | os.O_EXCL)
            except FileExistsError:
                raise LibraryError('busy', 'An import or another change to the Library is still finishing.') from None
            os.close(lock)
            try:
                library._catalog_tree(conn, old_root, locked=True)
                with library.directory(str(old_path.parent)) as old_parent:
                    try:
                        os.rename(child, child, src_dir_fd=old_parent, dst_dir_fd=new_parent)
                        same_disk = True
                    except OSError as exc:
                        if exc.errno != errno.EXDEV:
                            raise
                        same_disk = False
                    new_path = str(Path(parent) / child)
                    if same_disk:
                        os.fsync(new_parent)
                        os.fsync(old_parent)
                        try:
                            _record(conn, expected, vault['root_path'], new_path)
                        except BaseException:
                            os.rename(child, child, src_dir_fd=new_parent, dst_dir_fd=old_parent)
                            raise
                        kept = None
                    else:
                        _copy_tree(conn, expected, old_root, new_parent, child)
                        _record(conn, expected, vault['root_path'], new_path)
                        kept = vault['root_path']
            finally:
                # The descriptor follows the folder through a rename, so this is
                # the lock in whichever place the folder now is.
                os.unlink('.import.lock', dir_fd=old_root)
    result = library.status(conn)
    result['moved'] = {'previous': vault['root_path'], 'path': new_path, 'same_disk': kept is None, 'old_folder_kept': kept}
    return result


def _record(conn: sqlite3.Connection, expected: str, was: str, now: str) -> None:
    conn.execute('BEGIN IMMEDIATE')
    try:
        if library.vault_row(conn, expected)['root_path'] != was:
            raise LibraryError('wrong_vault', 'The Library folder changed while it was moved.')
        conn.execute('UPDATE library_vault SET root_path=? WHERE singleton=1', (now,))
        conn.commit()
    except BaseException:
        conn.rollback()
        raise


def _copy_tree(conn: sqlite3.Connection, expected: str, old_root: int, new_parent: int, child: str) -> None:
    """Copy the folder to another disk: the marker, every kept file checked by hash, and the held ones.

    On any failure, what this copy made is taken away again, file by file and
    folder by folder, and nothing else: the copy is resmon's own, the original
    untouched.
    """
    made: list[tuple[int, str, bool]] = []
    opened: list[int] = []

    def mkdir(name: str, parent: int) -> int:
        os.mkdir(name, 0o700, dir_fd=parent)
        made.append((parent, name, True))
        fd = library._open_dir(name, parent)
        opened.append(fd)
        return fd

    def copy(source: int, name: str, target: int, size: int | None = None, sha: str | None = None) -> None:
        _copy(source, name, target, size, sha)
        made.append((target, name, False))

    try:
        root = mkdir(child, new_parent)
        copy(old_root, 'vault.json', root)
        files = mkdir('files', root)
        old_files = library._open_dir('files', old_root)
        opened.append(old_files)
        for row in conn.execute('SELECT file_id, relative_path, byte_size, sha256 FROM library_files WHERE vault_id=?',
                                (expected,)).fetchall():
            try:
                source = library._open_dir(row['file_id'], old_files)
            except FileNotFoundError:
                continue  # Missing before the move, and still missing after it: said per file.
            opened.append(source)
            target = mkdir(row['file_id'], files)
            copy(source, Path(row['relative_path']).name, target, row['byte_size'], row['sha256'])
        try:
            old_removed = library._open_dir(library.REMOVED, old_root)
        except FileNotFoundError:
            old_removed = None
        if old_removed is not None:
            opened.append(old_removed)
            removed = mkdir(library.REMOVED, root)
            for name in os.listdir(old_removed):
                source = library._open_dir(name, old_removed)
                opened.append(source)
                target = mkdir(name, removed)
                for inner in os.listdir(source):
                    copy(source, inner, target)
        for parent, name, _ in made:
            os.fsync(parent)
    except BaseException:
        for parent, name, is_dir in reversed(made):
            try:
                if is_dir:
                    os.rmdir(name, dir_fd=parent)
                else:
                    os.unlink(name, dir_fd=parent)
            except OSError:
                pass
        raise
    finally:
        for fd in opened:
            os.close(fd)
