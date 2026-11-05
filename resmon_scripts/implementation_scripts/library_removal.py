"""Removing a file from the Library, and putting it back. Nothing here deletes a person's file.

Removing renames the file's folder, ``files/<file id>/``, to ``removed/<file id>/``
inside the same Library folder: one rename on one disk, so it is all or nothing
and copies no bytes. Its catalog row, and every row that referenced it (the
papers it was linked to, the Evidence projects it was in and the notes saved on
it), move into one ``library_removed`` record, kept as they were. Undo and
Restore rename the folder back and put every row back with its own id, so a
note's anchor, a project's membership and a paper's link are the same rows they
were. A project a removal or a restore changed gets a new revision, as any
other change to it does.

Why a folder inside the Library rather than the system Trash: the Trash has no
way back that resmon can drive (Electron can put a file there and cannot take
one out, and on macOS reading the Trash needs Full Disk Access), and the engine
has no Trash call of its own on every platform without a new dependency. A
rename inside the Library folder is undone exactly, by resmon, on every platform,
and is tested with temporary folders only. A held file leaves the Library for
good only when the person sends it to the Trash themselves (Settings › Library,
through the desktop's own Trash), and then it is in the Trash, not gone.

A file in an Evidence project, or with notes, is not removed until the request
says ``cascade``: the person is shown what goes with it first.
"""
from __future__ import annotations

from contextlib import contextmanager
import json
import os
from pathlib import Path
import sqlite3
from typing import Iterator

from . import library
from .library import LibraryError

#: The columns of each table a removal takes rows from, in table order, so a
#: record is written and read back by the same names.
_TABLES = {
    'library_file_documents': ('file_id', 'document_id', 'linked_at_utc'),
    'evidence_project_files': ('id', 'project_id', 'file_id', 'version_id', 'added_at_utc'),
    'evidence_notes': ('id', 'note_id', 'project_id', 'file_id', 'version_id', 'kind', 'body', 'page_number',
                       'extraction_contract', 'page_text_sha256', 'start_codepoint', 'end_codepoint', 'quote',
                       'revision', 'created_at_utc', 'updated_at_utc'),
}
_FILE_COLUMNS = ('id', 'file_id', 'version_id', 'vault_id', 'sha256', 'byte_size', 'media_type',
                 'original_name', 'relative_path', 'created_at_utc')


@contextmanager
def _locked(conn: sqlite3.Connection, expected: str) -> Iterator[tuple[dict, int]]:
    """The vault, its folder open, and the one lock an import also takes."""
    with library.checked_vault(conn, expected) as (vault, root):
        try:
            lock = library._regular('.import.lock', root, os.O_WRONLY | os.O_CREAT | os.O_EXCL)
        except FileExistsError:
            raise LibraryError('busy', 'An import or another change to the Library is still finishing. Try again in a moment.') from None
        try:
            yield vault, root
        finally:
            os.close(lock)
            os.unlink('.import.lock', dir_fd=root)


def _what_goes(conn: sqlite3.Connection, file_id: str) -> dict:
    links = [dict(r) for r in conn.execute(
        'SELECT l.document_id, d.title FROM library_file_documents l JOIN documents d ON d.id=l.document_id '
        'WHERE l.file_id=? ORDER BY l.document_id', (file_id,))]
    projects = []
    for row in conn.execute(
            '''SELECT p.project_id, p.name,
                      EXISTS(SELECT 1 FROM evidence_project_files m WHERE m.project_id=p.project_id AND m.file_id=?) AS member,
                      (SELECT count(*) FROM evidence_notes n WHERE n.project_id=p.project_id AND n.file_id=? AND n.kind='note') AS notes,
                      (SELECT count(*) FROM evidence_notes n WHERE n.project_id=p.project_id AND n.file_id=? AND n.kind='passage') AS passages
               FROM evidence_projects p
               WHERE EXISTS(SELECT 1 FROM evidence_project_files m WHERE m.project_id=p.project_id AND m.file_id=?)
                  OR EXISTS(SELECT 1 FROM evidence_notes n WHERE n.project_id=p.project_id AND n.file_id=?)
               ORDER BY p.id''', (file_id,) * 5):
        projects.append({'project_id': row['project_id'], 'name': row['name'], 'member': bool(row['member']),
                         'notes': row['notes'], 'passages': row['passages']})
    return {'links': links, 'projects': projects,
            'needs_confirmation': bool(projects)}


def summary(conn: sqlite3.Connection, expected: str, file_id: str, version_id: str) -> dict:
    """What would go with this file if it were removed, so the person can be asked first."""
    library.vault_row(conn, expected)
    row = library.file_row(conn, file_id, version_id)
    if row['vault_id'] != expected:
        raise LibraryError('wrong_vault', 'This file belongs to another vault.')
    return {'version': 1, 'vault_id': expected, 'file_id': file_id, 'version_id': version_id,
            'original_name': row['original_name'], **_what_goes(conn, file_id)}


def _rows(conn: sqlite3.Connection, table: str, file_id: str) -> list[dict]:
    columns = _TABLES[table]
    order = 'document_id' if table == 'library_file_documents' else 'id'
    return [dict(zip(columns, r)) for r in conn.execute(
        f'SELECT {",".join(columns)} FROM {table} WHERE file_id=? ORDER BY {order}', (file_id,))]


def _exists(name: str, parent: int) -> bool:
    try:
        os.stat(name, dir_fd=parent, follow_symlinks=False)
        return True
    except FileNotFoundError:
        return False


def _removed_dir(root: int, create: bool) -> int | None:
    try:
        return library._open_dir(library.REMOVED, root)
    except FileNotFoundError:
        if not create:
            return None
        os.mkdir(library.REMOVED, 0o700, dir_fd=root)
        os.fsync(root)
        return library._open_dir(library.REMOVED, root)


def _bump(conn: sqlite3.Connection, project_ids: set[str]) -> None:
    from . import evidence  # noqa: PLC0415 - evidence imports library
    for project_id in sorted(project_ids):
        evidence.changed(conn, project_id)


def remove(conn: sqlite3.Connection, expected: str, file_id: str, version_id: str, cascade: bool) -> dict:
    """Take a file out of the Library, holding its bytes and its record for Undo and Restore."""
    with _locked(conn, expected) as (_, root):
        conn.execute('BEGIN IMMEDIATE')
        moved = False
        files = removed = None
        try:
            row = library.file_row(conn, file_id, version_id)
            if row['vault_id'] != expected:
                raise LibraryError('wrong_vault', 'This file belongs to another vault.')
            goes = _what_goes(conn, file_id)
            if goes['needs_confirmation'] and not cascade:
                raise LibraryError('needs_confirmation', 'This file is in an Evidence project or has notes. Confirm '
                                   'to remove them with it; Undo puts them back.', 409)
            record = {'file': {k: row[k] for k in _FILE_COLUMNS},
                      **{table: _rows(conn, table, file_id) for table in _TABLES}}
            files = library._open_dir('files', root)
            held = _exists(file_id, files)
            if held:
                removed = _removed_dir(root, create=True)
                if _exists(file_id, removed):
                    raise LibraryError('needs_attention', 'The removed folder already holds a folder of this name; '
                                       'nothing was moved.')
                # One rename inside the Library folder: the whole folder or nothing.
                os.rename(file_id, file_id, src_dir_fd=files, dst_dir_fd=removed)
                moved = True
                os.fsync(removed)
                os.fsync(files)
            now = library.utc_now()
            projects = {r['project_id'] for r in record['evidence_project_files']} | {
                r['project_id'] for r in record['evidence_notes']}
            conn.execute('DELETE FROM evidence_notes WHERE file_id=?', (file_id,))
            conn.execute('DELETE FROM evidence_project_files WHERE file_id=?', (file_id,))
            conn.execute('DELETE FROM library_file_documents WHERE file_id=?', (file_id,))
            conn.execute('DELETE FROM library_files WHERE file_id=?', (file_id,))
            conn.execute('''INSERT INTO library_removed (file_id, version_id, vault_id, original_name, media_type,
                byte_size, sha256, bytes_state, record_json, removed_at_utc) VALUES (?,?,?,?,?,?,?,?,?,?)''',
                         (file_id, version_id, expected, row['original_name'], row['media_type'], row['byte_size'],
                          row['sha256'], 'held' if held else 'missing',
                          json.dumps(record, ensure_ascii=False, sort_keys=True), now))
            _bump(conn, projects)
            conn.commit()
        except BaseException:
            conn.rollback()
            if moved:
                # The catalog still names the file: put its folder back where it names it.
                os.rename(file_id, file_id, src_dir_fd=removed, dst_dir_fd=files)
            raise
        finally:
            for fd in (removed, files):
                if fd is not None:
                    os.close(fd)
    return {'version': 1, 'vault_id': expected, 'removed': removed_view(conn, expected, file_id)}


def _record(conn: sqlite3.Connection, expected: str, file_id: str) -> dict:
    library.identity(file_id)
    row = conn.execute('SELECT * FROM library_removed WHERE file_id=?', (file_id,)).fetchone()
    if row is None:
        raise LibraryError('unknown_removed', 'This file is not among the removed files.', 404)
    row = dict(row)
    if row['vault_id'] != expected:
        raise LibraryError('wrong_vault', 'This removed file belongs to another vault.')
    try:
        record = json.loads(row['record_json'])
        if (not isinstance(record, dict) or set(record) != {'file', *_TABLES}
                or record['file'].get('file_id') != file_id or record['file'].get('version_id') != row['version_id']):
            raise ValueError
    except (ValueError, TypeError, AttributeError):
        raise LibraryError('corrupt_record', 'The record of this removed file cannot be read; nothing was changed.') from None
    row['record'] = record
    return row


def removed_view(conn: sqlite3.Connection, expected: str, file_id: str, *, held: set[str] | None = None) -> dict:
    """One removed file as a list shows it. ``bytes`` is ``held``, ``missing`` (there were
    none to hold: the file was already gone when it was removed) or ``gone`` (held once,
    and no longer in the removed folder: sent to the Trash, or deleted outside resmon)."""
    row = _record(conn, expected, file_id)
    record = row['record']
    projects = {}
    for r in record['evidence_project_files'] + record['evidence_notes']:
        projects.setdefault(r['project_id'], 0)
    for r in record['evidence_notes']:
        projects[r['project_id']] += 1
    names = {p['project_id']: p['name'] for p in conn.execute(
        f'SELECT project_id, name FROM evidence_projects WHERE project_id IN ({",".join("?" * len(projects))})',
        tuple(projects))} if projects else {}
    state = row['bytes_state']
    if state == 'held' and held is not None and file_id not in held:
        state = 'gone'
    return {'file_id': file_id, 'version_id': row['version_id'], 'original_name': row['original_name'],
            'media_type': row['media_type'], 'byte_size': row['byte_size'], 'sha256': row['sha256'],
            'removed_at_utc': row['removed_at_utc'], 'bytes': state,
            'links': len(record['library_file_documents']),
            'projects': [{'project_id': p, 'name': names.get(p), 'notes': n} for p, n in projects.items()],
            'notes': len(record['evidence_notes'])}


def held_names(conn: sqlite3.Connection, expected: str) -> set[str]:
    """The removed files whose held folder still has a file in it."""
    with library.checked_vault(conn, expected) as (_, root):
        removed = _removed_dir(root, create=False)
        if removed is None:
            return set()
        held = set()
        try:
            for name in library.listing(removed):
                try:
                    folder = library._open_dir(name, removed)
                except OSError:
                    continue
                try:
                    if library.listing(folder):
                        held.add(name)
                finally:
                    os.close(folder)
            return held
        finally:
            os.close(removed)


def list_removed(conn: sqlite3.Connection, expected: str) -> dict:
    """Every removed file still on record, newest first, and whether its bytes are still held."""
    held = held_names(conn, expected)
    rows = conn.execute('SELECT file_id FROM library_removed WHERE vault_id=? ORDER BY id DESC', (expected,)).fetchall()
    items = [removed_view(conn, expected, r[0], held=held) for r in rows]
    return {'version': 1, 'vault_id': expected, 'removed': items,
            'bytes': sum(i['byte_size'] for i in items if i['bytes'] == 'held')}


def restore(conn: sqlite3.Connection, expected: str, file_id: str) -> dict:
    """Put a removed file back exactly: its folder, its row and every row that went with it."""
    with _locked(conn, expected) as (_, root):
        conn.execute('BEGIN IMMEDIATE')
        moved = False
        files = removed = None
        try:
            row = _record(conn, expected, file_id)
            record = row['record']
            kept = conn.execute('SELECT original_name FROM library_files WHERE vault_id=? AND sha256=?',
                                (expected, row['sha256'])).fetchone()
            if kept is not None:
                raise LibraryError('kept_again', f'The same file is in the Library again, as “{kept[0]}”, kept after '
                                   'this one was removed; nothing was put back.')
            files = library._open_dir('files', root)
            if row['bytes_state'] == 'held':
                removed = _removed_dir(root, create=False)
                if removed is None or not _exists(file_id, removed):
                    raise LibraryError('held_missing', 'This file’s bytes are no longer in the Library folder’s '
                                       'removed folder, so it cannot be put back.', 404)
                if _exists(file_id, files):
                    raise LibraryError('needs_attention', 'The Library already has a folder of this name; nothing was moved.')
                # A release that was asked for and never finished left the file
                # under the name it was imported as: back to its version name first.
                folder = library._open_dir(file_id, removed)
                try:
                    name = _held_name(folder, row)
                    stored = Path(record['file']['relative_path']).name
                    if name != stored:
                        os.rename(name, stored, src_dir_fd=folder, dst_dir_fd=folder)
                        os.fsync(folder)
                finally:
                    os.close(folder)
                os.rename(file_id, file_id, src_dir_fd=removed, dst_dir_fd=files)
                moved = True
                os.fsync(files)
                os.fsync(removed)
            f = record['file']
            conn.execute(f'INSERT INTO library_files ({",".join(_FILE_COLUMNS)}) VALUES ({",".join("?" * len(_FILE_COLUMNS))})',
                         tuple(f[k] for k in _FILE_COLUMNS))
            library.file_row(conn, file_id, row['version_id'])
            documents = {r[0] for r in conn.execute('SELECT id FROM documents WHERE id IN ({})'.format(
                ','.join(str(int(r['document_id'])) for r in record['library_file_documents']) or 'NULL'))}
            for table, columns in _TABLES.items():
                for r in record[table]:
                    # A paper deleted since (an erased collection) takes its link with it, as it would have.
                    if table == 'library_file_documents' and r['document_id'] not in documents:
                        continue
                    conn.execute(f'INSERT INTO {table} ({",".join(columns)}) VALUES ({",".join("?" * len(columns))})',
                                 tuple(r[c] for c in columns))
            conn.execute('DELETE FROM library_removed WHERE file_id=?', (file_id,))
            _bump(conn, {r['project_id'] for r in record['evidence_project_files'] + record['evidence_notes']})
            conn.commit()
        except BaseException:
            conn.rollback()
            if moved:
                os.rename(file_id, file_id, src_dir_fd=files, dst_dir_fd=removed)
            raise
        finally:
            for fd in (removed, files):
                if fd is not None:
                    os.close(fd)
    restored = library.file_row(conn, file_id, row['version_id'])
    return {'version': 1, 'vault_id': expected, 'file': library.projection(conn, restored)}


def release_request(conn: sqlite3.Connection, expected: str, file_id: str) -> dict:
    """The held file's path, for the desktop to send to the system Trash.

    The held file is renamed to the name it was imported under first, inside its
    own held folder, so the Trash shows the person a name they know rather than
    an id. Restore finds it under either name.
    """
    with _locked(conn, expected) as (vault, root):
        row = _record(conn, expected, file_id)
        removed = _removed_dir(root, create=False)
        if row['bytes_state'] != 'held' or removed is None or not _exists(file_id, removed):
            raise LibraryError('held_missing', 'This file’s bytes are no longer held in the Library folder.', 404)
        try:
            folder = library._open_dir(file_id, removed)
            try:
                name = _held_name(folder, row)
                fd = library._regular(name, folder)
                os.close(fd)
                friendly = row['original_name']
                library.name_and_media(friendly)
                if name != friendly:
                    if _exists(friendly, folder):
                        raise LibraryError('needs_attention', 'The held folder has an unexpected file; nothing was moved.')
                    os.rename(name, friendly, src_dir_fd=folder, dst_dir_fd=folder)
                    os.fsync(folder)
            finally:
                os.close(folder)
        finally:
            os.close(removed)
        path = str(Path(vault['root_path']) / library.REMOVED / file_id / row['original_name'])
    return {'version': 1, 'vault_id': expected, 'file_id': file_id, 'path': path}


def _held_name(folder: int, row: dict) -> str:
    """The held file's name now: its version name, or its original one after a release was asked for."""
    stored = Path(row['record']['file']['relative_path']).name
    names = library.listing(folder)
    if names == [stored] or names == [row['original_name']]:
        return names[0]
    raise LibraryError('needs_attention', 'The held folder does not hold exactly this file; nothing was changed.')


def forget(conn: sqlite3.Connection, expected: str, file_id: str) -> dict:
    """Drop a removed file's record once its bytes have left the Library folder.

    Refused while the bytes are still held: the record is the only way back to
    them from resmon. The held folder, empty by then, is removed with it.
    """
    with _locked(conn, expected) as (_, root):
        conn.execute('BEGIN IMMEDIATE')
        try:
            row = _record(conn, expected, file_id)
            removed = _removed_dir(root, create=False)
            if removed is not None:
                try:
                    if _exists(file_id, removed):
                        folder = library._open_dir(file_id, removed)
                        try:
                            if library.listing(folder):
                                raise LibraryError('still_held', 'This file is still held in the Library folder. '
                                                   'Restore it, or move it to the Trash first.')
                            # Only the operating system's metadata is left (a .DS_Store the Finder
                            # wrote while showing the file): it goes with the empty folder.
                            for name in os.listdir(folder):
                                try:
                                    os.unlink(name, dir_fd=folder)
                                except OSError:
                                    raise LibraryError('needs_attention', 'The held folder holds something resmon did '
                                                       'not put there; nothing was changed.') from None
                        finally:
                            os.close(folder)
                        os.rmdir(file_id, dir_fd=removed)
                finally:
                    os.close(removed)
            conn.execute('DELETE FROM library_removed WHERE file_id=?', (file_id,))
            conn.commit()
        except BaseException:
            conn.rollback()
            raise
    from . import library_thumbs  # noqa: PLC0415
    library_thumbs.forget(conn, row['version_id'])
    return {'version': 1, 'vault_id': expected, 'file_id': file_id, 'forgotten': True}
