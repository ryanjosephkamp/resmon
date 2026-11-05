"""Owned immutable copies. No scientific identity inference or automatic recovery.

Descriptor-relative, no-follow operations are required. Platforms without these
primitives refuse Library filesystem operations rather than follow an unsafe path.
The local OS/user remains trusted; this is not hostile-local-process confinement.

The folder holds ``vault.json``, ``files/`` and, once a file has been removed,
``removed/``: a removed file's folder is renamed there whole, and Undo or Restore
renames it back (``library_removal``). Nothing here deletes a retained file.
"""
from __future__ import annotations

import codecs
from contextlib import contextmanager
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import sqlite3
import stat
import threading
import unicodedata
import uuid
from typing import Iterator

MAX_FILE_BYTES = 64 * 1024 * 1024
#: One limit for keeping a file and for every reader of it: the PDF reader, the
#: thumbnail drawn from its first page, and Evidence's page text. A file the
#: Library accepts is a file every part of the Library can open.
MAX_READ_BYTES = MAX_FILE_BYTES
#: An import that would leave less than this free on the Library folder's disk is
#: refused. The Library has no count or size cap of its own: the folder is the
#: person's, on their disk, and the disk is the limit that matters.
FREE_SPACE_FLOOR = 512 * 1024 * 1024
MARKER_LIMIT = 4096
MEDIA = {"pdf": "application/pdf", "txt": "text/plain", "md": "text/markdown", "tex": "text/x-tex"}
#: The kinds read as UTF-8 text: everything but a PDF.
TEXT_MEDIA = ("text/plain", "text/markdown", "text/x-tex")
REMOVED = 'removed'
#: What an operating system leaves in a folder without anyone putting it there:
#: the Finder's ``.DS_Store``, the ``._`` files it writes beside a file on a disk
#: that cannot hold its extra attributes, a custom folder icon's ``Icon\r``, and
#: Windows' ``Thumbs.db`` and ``desktop.ini``. Opening the Library folder in the
#: Finder writes one, so wherever the Library lists a folder it passes over them.
OS_METADATA = frozenset({'.DS_Store', 'Icon\r'})
OS_METADATA_FOLDED = frozenset({'thumbs.db', 'desktop.ini'})


def os_metadata(name: str) -> bool:
    return name in OS_METADATA or name.startswith('._') or name.lower() in OS_METADATA_FOLDED


def listing(fd: int) -> list[str]:
    """A folder's names, without the operating system's own metadata files."""
    return [name for name in os.listdir(fd) if not os_metadata(name)]


#: One change to where the Library folder is at a time, in this engine: a move
#: or a relink. A relink in the middle of a move to another disk could record
#: the half-made copy as the Library, and the move would then take that copy
#: away again.
_vault_change = threading.Lock()
_vault_changing: str | None = None
CHANGING_WORDS = {
    'moving': 'The Library folder is being moved. Try again when the move has finished.',
    'relinking': 'resmon is checking the Library folder you chose. Try again in a moment.',
}


@contextmanager
def vault_change(kind: str) -> Iterator[None]:
    global _vault_changing
    if not _vault_change.acquire(blocking=False):
        raise LibraryError('changing', CHANGING_WORDS.get(_vault_changing or '', CHANGING_WORDS['moving']))
    _vault_changing = kind
    try:
        yield
    finally:
        _vault_changing = None
        _vault_change.release()


def vault_changing() -> str | None:
    """``moving`` or ``relinking`` while one runs, else None."""
    return _vault_changing


class LibraryError(ValueError):
    def __init__(self, reason: str, message: str, status: int = 409):
        super().__init__(message)
        self.reason = reason
        self.status = status


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()


def identity(value: str) -> str:
    try:
        if str(uuid.UUID(value)) != value:
            raise ValueError()
    except (ValueError, AttributeError, TypeError):
        raise LibraryError("invalid_identity", "An exact canonical UUID is required.", 400) from None
    return value


def name_and_media(name: str) -> tuple[str, str]:
    if (not isinstance(name, str) or not 1 <= len(name) <= 255 or name in (".", "..")
            or any(c in '/\\' or unicodedata.category(c).startswith('C') for c in name)):
        raise LibraryError("invalid_name", "Choose a basename of 1–255 characters without separators or controls.", 400)
    extension = name.rsplit('.', 1)[-1].lower() if '.' in name else ''
    if extension not in MEDIA:
        raise LibraryError("unsupported_format", "Only PDF, TXT, MD and TeX files can be retained.", 415)
    return extension, MEDIA[extension]


def _primitives() -> None:
    if (not hasattr(os, 'O_NOFOLLOW') or not hasattr(os, 'O_DIRECTORY')
            or any(f not in os.supports_dir_fd for f in (os.open, os.mkdir, os.unlink, os.link, os.stat))
            or os.listdir not in os.supports_fd):
        raise LibraryError("unsupported_platform", "Safe descriptor-relative Library access is unavailable on this platform.", 503)


def _open_dir(name: str, parent: int | None = None) -> int:
    return os.open(name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=parent)


@contextmanager
def directory(path: str) -> Iterator[int]:
    """Walk from the filesystem root without following any symlink component."""
    _primitives()
    if not isinstance(path, str) or not os.path.isabs(path) or '\x00' in path:
        raise LibraryError("invalid_root", "Choose an existing absolute parent directory.", 400)
    parts = Path(path).parts
    if any(x in ('.', '..') for x in path.split('/')):
        raise LibraryError("invalid_root", "Directory traversal is refused.", 400)
    fd = _open_dir(parts[0])
    try:
        for part in parts[1:]:
            new = _open_dir(part, fd)
            os.close(fd)
            fd = new
        yield fd
    finally:
        os.close(fd)


def _regular(name: str, parent: int, flags: int = os.O_RDONLY) -> int:
    fd = os.open(name, flags | os.O_NOFOLLOW | os.O_NONBLOCK, 0o600, dir_fd=parent)
    info = os.fstat(fd)
    # A hard-linked mutable external object is not an owned immutable copy.
    if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1:
        os.close(fd)
        raise LibraryError("unsafe_file", "Expected a single-link regular retained file.")
    return fd


def vault_row(conn: sqlite3.Connection, expected: str | None = None) -> dict:
    row = conn.execute("SELECT * FROM library_vault WHERE singleton=1").fetchone()
    if not row:
        raise LibraryError("unconfigured", "Create a managed child vault first.")
    result = dict(row)
    identity(result['vault_id'])
    if expected is not None and identity(expected) != result['vault_id']:
        raise LibraryError("wrong_vault", "The selected vault changed. Refresh Library.")
    if Path(result['root_path']).name != 'resmon-library-' + result['vault_id']:
        raise LibraryError("mismatch", "The registered child name does not match its vault.")
    return result


@contextmanager
def checked_vault(conn: sqlite3.Connection, expected: str) -> Iterator[tuple[dict, int]]:
    row = vault_row(conn, expected)
    with directory(row['root_path']) as root:
        fd = _regular('vault.json', root)
        try:
            raw = os.read(fd, MARKER_LIMIT + 1)
        finally:
            os.close(fd)
        try:
            marker = json.loads(raw) if len(raw) <= MARKER_LIMIT else None
        except (ValueError, UnicodeError):
            marker = None
        if not isinstance(marker, dict) or marker != {'version': 1, 'vault_id': row['vault_id']} or type(marker.get('version')) is not int:
            raise LibraryError("mismatch", "The vault marker is malformed or belongs to another vault.")
        yield row, root


def _table(conn: sqlite3.Connection, name: str) -> bool:
    # The Library's own code also runs against a database a step behind (an
    # upgrade test builds schema 16's rows with it), where a later table is absent.
    return conn.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?", (name,)).fetchone() is not None


def counts(conn: sqlite3.Connection) -> dict:
    row = conn.execute("SELECT count(*),coalesce(sum(byte_size),0) FROM library_files").fetchone()
    removed = conn.execute("SELECT count(*) FROM library_removed").fetchone()[0] if _table(conn, 'library_removed') else 0
    return {'items': row[0], 'retained_bytes': row[1], 'basis': 'recorded_metadata', 'removed': removed}


def limits() -> dict:
    return {'file_bytes': MAX_FILE_BYTES, 'read_bytes': MAX_READ_BYTES, 'free_space_floor': FREE_SPACE_FLOOR}


def status(conn: sqlite3.Connection) -> dict:
    """The vault, where its folder is, and whether resmon can use it now.

    ``missing`` is the folder not being where the database recorded it: moved or
    deleted in the Finder, or on a disk that is not connected. It is recoverable
    by pointing at the folder where it is now (``library_folder.relink``), and it
    stops only the files: the reading queue does not live in the folder.
    ``counts.missing`` is how many recorded files have no folder in ``files/``;
    it is present only when the folder was read.
    """
    row = conn.execute("SELECT * FROM library_vault WHERE singleton=1").fetchone()
    result = {'version': 1, 'vault': None, 'status': 'unconfigured', 'counts': counts(conn), 'limits': limits()}
    if (changing := vault_changing()) is not None:
        result['changing'] = changing
    if row:
        result['vault'] = {'vault_id': row['vault_id'], 'label': Path(row['root_path']).name,
                           'path': row['root_path'], 'created_at_utc': row['created_at_utc']}
        try:
            with checked_vault(conn, row['vault_id']) as (_, root):
                if '.import.lock' in os.listdir(root):
                    result['status'] = 'busy'
                else:
                    result['counts']['missing'] = len(_catalog_tree(conn, root))
                    result['status'] = 'ready'
        except LibraryError as exc:
            result['status'] = 'mismatch' if exc.reason == 'mismatch' else 'needs_attention'
            result['reason'] = exc.reason
        except FileNotFoundError:
            result['status'] = 'missing'
            result['reason'] = 'folder_missing'
        except OSError:
            result['status'] = 'unavailable'
    return result


def create_vault(conn: sqlite3.Connection, parent: str) -> dict:
    with directory(parent) as parent_fd:
        conn.execute('BEGIN IMMEDIATE')
        child = 'resmon-library-' + str(uuid.uuid4())
        made = False
        root = None
        try:
            if conn.execute('SELECT 1 FROM library_vault').fetchone():
                raise LibraryError('already_configured', 'This database already has a vault; it cannot be switched here.')
            os.mkdir(child, 0o700, dir_fd=parent_fd)
            made = True
            root = _open_dir(child, parent_fd)
            vault_id = child[len('resmon-library-'):]
            marker_fd = _regular('vault.json', root, os.O_WRONLY | os.O_CREAT | os.O_EXCL)
            with os.fdopen(marker_fd, 'wb') as marker:
                marker.write(json.dumps({'version': 1, 'vault_id': vault_id}).encode())
                marker.flush()
                os.fsync(marker.fileno())
            os.mkdir('files', 0o700, dir_fd=root)
            os.fsync(root)
            os.fsync(parent_fd)
            conn.execute('INSERT INTO library_vault VALUES (1,?,?,?)',
                         (vault_id, str(Path(parent) / child), utc_now()))
            conn.commit()
        except BaseException:
            conn.rollback()
            if made and root is not None:
                # Only this exclusive creation owns these names; no recursive deletion.
                if 'files' in os.listdir(root):
                    os.rmdir('files', dir_fd=root)
                if 'vault.json' in os.listdir(root):
                    os.unlink('vault.json', dir_fd=root)
                os.rmdir(child, dir_fd=parent_fd)
            raise
        finally:
            if root is not None:
                os.close(root)
    return status(conn)


def file_row(conn: sqlite3.Connection, file_id: str, expected_version: str | None = None) -> dict:
    identity(file_id)
    row = conn.execute('SELECT * FROM library_files WHERE file_id=?', (file_id,)).fetchone()
    if row is None:
        raise LibraryError('unknown_file', 'This file is not in the selected vault.', 404)
    row = dict(row)
    identity(row['version_id'])
    if expected_version is not None and identity(expected_version) != row['version_id']:
        raise LibraryError('wrong_version', 'The selected immutable version does not match.')
    extension = next((ext for ext, media in MEDIA.items() if media == row['media_type']), None)
    if row['relative_path'] != f"files/{file_id}/{row['version_id']}.{extension}":
        raise LibraryError('mismatch', 'The recorded managed path does not match its immutable identity.')
    return row


def _catalog_tree(conn: sqlite3.Connection, root: int, *, locked: bool = False) -> set[str]:
    """This owned child's names against its catalog. Orphans are a stop, never adopted.

    Returns the recorded files whose folder is not in ``files/``: deleted or moved
    outside resmon. Those are said per file, as missing, rather than stopping the
    whole Library; a folder in ``files/`` the catalog does not record is still a
    stop, because publishing next to bytes nobody owns is how two files end up
    under one name.

    One directory listing, not a read of every file: at 10,000 files opening each
    one took 0.6 s on every status read and every import, and 3 s at 30,000.
    Each file's size and hash are checked when it is read (``retained``), which
    is where a changed file can do harm.
    """
    names = set(listing(root))
    allowed = {'vault.json', 'files', REMOVED} | ({'.import.lock'} if locked else set())
    if not {'vault.json', 'files'} <= names or names - allowed:
        raise LibraryError('needs_attention', 'Unexpected vault entries; import requires an owner recovery decision.')
    recorded = {r[0] for r in conn.execute('SELECT file_id FROM library_files')}
    files = _open_dir('files', root)
    try:
        present = set(listing(files))
    finally:
        os.close(files)
    if present - recorded:
        raise LibraryError('needs_attention', 'Retained directories and catalog differ; no automatic recovery.')
    return recorded - present


def present_files(conn: sqlite3.Connection, expected: str) -> set[str]:
    """The file ids with a folder in ``files/`` now: one listing, for marking missing ones."""
    with checked_vault(conn, expected) as (_, root):
        files = _open_dir('files', root)
        try:
            return set(listing(files))
        finally:
            os.close(files)


def links(conn: sqlite3.Connection, file_id: str) -> list[dict]:
    return [dict(r) for r in conn.execute('''SELECT l.document_id,d.title,
        'this app database only' AS identity_scope,'owner_association' AS basis
        FROM library_file_documents l JOIN documents d ON d.id=l.document_id
        WHERE l.file_id=? ORDER BY l.document_id''', (file_id,))]


def projection(conn: sqlite3.Connection, row: dict, availability: str = 'not_checked') -> dict:
    projects = conn.execute('SELECT count(*) FROM evidence_project_files WHERE file_id=?', (row['file_id'],)).fetchone()[0] \
        if _table(conn, 'evidence_project_files') else 0
    return {**{k: row[k] for k in ('id', 'file_id', 'version_id', 'vault_id', 'sha256',
                                  'byte_size', 'media_type', 'original_name', 'relative_path', 'created_at_utc')},
            'paper_links': links(conn, row['file_id']), 'project_count': projects, 'availability': availability}


def detail(conn: sqlite3.Connection, expected: str, file_id: str) -> dict:
    with checked_vault(conn, expected):
        row = file_row(conn, file_id)
        if row['vault_id'] != expected:
            raise LibraryError('wrong_vault', 'This item belongs to another vault.')
        return {'version': 1, 'vault_id': expected, 'file': projection(conn, row)}


#: How a file list can be ordered. ``newest`` is the keyset order, by id; the others page by offset.
FILE_SORTS = {
    'newest': 'id DESC',
    'oldest': 'id ASC',
    'name': 'lower(original_name) ASC, id DESC',
    'size': 'byte_size DESC, id DESC',
}
MAX_PAGE = 500


def list_files(conn: sqlite3.Connection, expected: str, q: str = '', through_id: int | None = None,
               before_id: int | None = None, limit: int = 50, sort: str = 'newest', offset: int = 0) -> dict:
    """One page of the files, under a fixed ceiling, ``through_id``.

    ``newest`` pages by ``before_id`` as it always has; every sort also pages by
    ``offset`` under the same ceiling, so a list read from the top in one order
    cannot gain a file halfway down. Each file says ``missing`` when its folder
    is not in ``files/`` now, from one listing of that folder.
    """
    if (len(q) > 200 or not 1 <= limit <= MAX_PAGE or sort not in FILE_SORTS or offset < 0
            or any(x is not None and x < 0 for x in (through_id, before_id))
            or (before_id is not None and (sort != 'newest' or offset))):
        raise LibraryError('invalid_page', f'Use a name filter up to 200 characters, a page size of 1–{MAX_PAGE}, '
                           'and before_id only with the newest-first order.', 400)
    present = present_files(conn, expected)
    ceiling = through_id if through_id is not None else conn.execute('SELECT coalesce(max(id),0) FROM library_files').fetchone()[0]
    rows = conn.execute(f'''SELECT * FROM library_files WHERE vault_id=? AND id<=? AND id<?
        AND instr(lower(original_name),lower(?))>0 ORDER BY {FILE_SORTS[sort]} LIMIT ? OFFSET ?''',
                        (expected, ceiling, before_id if before_id is not None else ceiling + 1, q,
                         limit + 1, offset)).fetchall()
    more = len(rows) > limit
    items = [projection(conn, dict(r), 'not_checked' if r['file_id'] in present else 'missing') for r in rows[:limit]]
    total = conn.execute('''SELECT count(*) FROM library_files WHERE vault_id=? AND id<=?
        AND instr(lower(original_name),lower(?))>0''', (expected, ceiling, q)).fetchone()[0]
    return {'version': 1, 'vault_id': expected, 'files': items, 'through_id': ceiling,
            'next_before_id': items[-1]['id'] if more and sort == 'newest' else None, 'has_more': more,
            'sort': sort, 'offset': offset, 'total': total}


def document_exists(conn: sqlite3.Connection, document_id: int) -> None:
    if type(document_id) is not int or document_id <= 0:
        raise LibraryError('invalid_document', 'A positive corpus-local paper ID is required.', 400)
    if not conn.execute('SELECT 1 FROM documents WHERE id=?', (document_id,)).fetchone():
        raise LibraryError('unknown_document', 'That paper ID is not in this app database.', 404)


def add_link(conn: sqlite3.Connection, expected: str, file_id: str, document_id: int) -> dict:
    with checked_vault(conn, expected):
        conn.execute('BEGIN IMMEDIATE')
        try:
            row = file_row(conn, file_id)
            if row['vault_id'] != expected:
                raise LibraryError('wrong_vault', 'This file belongs to another vault.')
            document_exists(conn, document_id)
            conn.execute('INSERT OR IGNORE INTO library_file_documents VALUES (?,?,?)', (file_id, document_id, utc_now()))
            conn.commit()
        except BaseException:
            conn.rollback()
            raise
        return {'version': 1, 'vault_id': expected, 'file_id': file_id, 'version_id': row['version_id'],
                'document_id': document_id, 'paper_links': links(conn, file_id)}


@contextmanager
def retained(conn: sqlite3.Connection, expected: str, file_id: str, expected_version: str,
             max_bytes: int = MAX_FILE_BYTES) -> Iterator[tuple[dict, int, str]]:
    """One resolver for Open, reading, removal, duplicate comparison and thumbnails."""
    with checked_vault(conn, expected) as (vault, root):
        row = file_row(conn, file_id, expected_version)
        if row['vault_id'] != expected:
            raise LibraryError('wrong_vault', 'This file belongs to another vault.')
        files = _open_dir('files', root)
        folder = None
        fd = None
        try:
            try:
                folder = _open_dir(file_id, files)
                fd = _regular(Path(row['relative_path']).name, folder)
            except FileNotFoundError:
                raise LibraryError('missing_file', 'This file is no longer in the Library folder: it was moved or '
                                   'deleted outside resmon. Remove it here to take it off the list.', 404) from None
            before = os.fstat(fd)
            if before.st_size > max_bytes or row['byte_size'] > max_bytes:
                raise LibraryError('too_large', 'This file exceeds the read limit; its full contents were not verified.', 413)
            if before.st_size != row['byte_size']:
                raise LibraryError('changed_content', 'Retained size differs from the catalog.')
            digest = hashlib.sha256()
            total = 0
            while True:
                chunk = os.read(fd, min(65536, max_bytes + 1 - total))
                if not chunk:
                    break
                total += len(chunk)
                if total > max_bytes:
                    raise LibraryError('too_large', 'Retained bytes exceed the read limit.', 413)
                digest.update(chunk)
            after = os.fstat(fd)
            if (total != row['byte_size'] or digest.hexdigest() != row['sha256']
                    or (before.st_mtime_ns, before.st_ctime_ns) != (after.st_mtime_ns, after.st_ctime_ns)):
                raise LibraryError('changed_content', 'Retained bytes differ from the recorded immutable version.')
            os.lseek(fd, 0, os.SEEK_SET)
            yield row, fd, str(Path(vault['root_path']) / row['relative_path'])
        finally:
            if fd is not None:
                os.close(fd)
            if folder is not None:
                os.close(folder)
            os.close(files)


def open_request(conn: sqlite3.Connection, expected: str, file_id: str, version: str) -> dict:
    with retained(conn, expected, file_id, version) as (row, _, path):
        return {'version': 1, 'vault_id': expected, 'file_id': row['file_id'], 'version_id': row['version_id'], 'path': path}


def read_bytes(conn: sqlite3.Connection, expected: str, file_id: str, version: str,
               media: tuple[str, ...] = ('application/pdf',)) -> tuple[dict, bytes]:
    """A kept file's whole bytes, verified against its recorded size and hash, up to the read limit.

    For the PDF reader outside Evidence: the same resolver and the same limit as
    every other read, and the bytes checked once more after they are read.
    """
    with retained(conn, expected, file_id, version, MAX_READ_BYTES) as (row, fd, _):
        if row['media_type'] not in media:
            raise LibraryError('unsupported', 'This reader opens PDF files only.', 415)
        data = bytearray()
        while len(data) <= MAX_READ_BYTES:
            chunk = os.read(fd, min(1024 * 1024, MAX_READ_BYTES + 1 - len(data)))
            if not chunk:
                break
            data.extend(chunk)
        if len(data) != row['byte_size'] or hashlib.sha256(data).hexdigest() != row['sha256']:
            raise LibraryError('changed_content', 'Retained bytes changed during the read.')
        return row, bytes(data)


class Import:
    """One streamed upload owns a lock, temp file, and publication transaction.

    A crash can strand its lock/bytes. Caught failures remove only this operation's
    unpublished bytes. Committed copies are never removed or overwritten.
    """
    def __init__(self, conn: sqlite3.Connection, expected: str, filename: str, document_id: int | None = None):
        self.conn, self.expected, self.filename, self.document_id = conn, expected, filename, document_id
        self.extension, self.media = name_and_media(filename)
        self.digest = hashlib.sha256()
        self.decoder = codecs.getincrementaldecoder('utf-8')('strict') if self.extension != 'pdf' else None
        self.size = 0
        self.prefix = b''
        self.temp_name = '.staging-' + str(uuid.uuid4())
        self.temp = None
        self.lock = None
        self.folder = None
        self.files = None
        self.new_file_id = None
        self.published = False
        self.committed = False

    def __enter__(self) -> Import:
        self.vault_context = checked_vault(self.conn, self.expected)
        _, self.root = self.vault_context.__enter__()
        try:
            try:
                self.lock = _regular('.import.lock', self.root, os.O_WRONLY | os.O_CREAT | os.O_EXCL)
            except FileExistsError:
                raise LibraryError('busy', 'An import lock exists. No stale-lock recovery is automatic.') from None
            self.conn.execute('BEGIN IMMEDIATE')
            _catalog_tree(self.conn, self.root, locked=True)
            if self.document_id is not None:
                document_exists(self.conn, self.document_id)
            self.temp = _regular(self.temp_name, self.root, os.O_RDWR | os.O_CREAT | os.O_EXCL)
            return self
        except BaseException:
            self.__exit__(*__import__('sys').exc_info())
            raise

    def write(self, chunk: bytes) -> None:
        if self.size + len(chunk) > MAX_FILE_BYTES:
            raise LibraryError('file_limit', 'The upload exceeds 64 MiB; nothing was retained.', 413)
        self.size += len(chunk)
        self.prefix = (self.prefix + chunk[:5])[:5]
        self.digest.update(chunk)
        if self.decoder:
            try:
                if '\x00' in self.decoder.decode(chunk):
                    raise UnicodeError()
            except UnicodeError:
                raise LibraryError('invalid_text', 'TXT/MD must be strict UTF-8 without NUL bytes.', 415) from None
        view = memoryview(chunk)
        while view:
            count = os.write(self.temp, view)
            view = view[count:]

    def finish(self) -> dict:
        if self.size == 0:
            raise LibraryError('empty_file', 'Empty files are not imported.', 400)
        if self.decoder:
            try:
                self.decoder.decode(b'', final=True)
            except UnicodeError:
                raise LibraryError('invalid_text', 'The final UTF-8 sequence is incomplete.', 415) from None
        elif self.prefix != b'%PDF-':
            raise LibraryError('invalid_pdf', 'The PDF envelope is missing its %PDF- header.', 415)
        os.fsync(self.temp)
        digest = self.digest.hexdigest()
        duplicate = self.conn.execute('SELECT * FROM library_files WHERE vault_id=? AND sha256=?', (self.expected, digest)).fetchone()
        if duplicate:
            row = dict(duplicate)
            with retained(self.conn, self.expected, row['file_id'], row['version_id']) as (_, fd, _):
                os.lseek(self.temp, 0, os.SEEK_SET)
                while True:
                    left, right = os.read(fd, 65536), os.read(self.temp, 65536)
                    if left != right:
                        raise LibraryError('digest_collision', 'Matching hash but different bytes; duplicate reuse refused.')
                    if not left:
                        break
            if row['media_type'] != self.media:
                raise LibraryError('media_conflict', 'Identical bytes already have another media interpretation.')
        else:
            disk = os.statvfs(self.root)
            if disk.f_bavail * disk.f_frsize < FREE_SPACE_FLOOR:
                raise LibraryError('disk_full', 'Keeping this file would leave less than 512 MB free on the Library '
                                   "folder's disk; nothing was kept.", 507)
            file_id, version_id = str(uuid.uuid4()), str(uuid.uuid4())
            self.files = _open_dir('files', self.root)
            os.mkdir(file_id, 0o700, dir_fd=self.files)
            self.new_file_id = file_id
            self.folder = _open_dir(file_id, self.files)
            self.dest_name = f'{version_id}.{self.extension}'
            # link is exclusive, unlike rename/replace. Remove our staging link
            # before any ready row becomes visible; retained files have nlink=1.
            os.link(self.temp_name, self.dest_name, src_dir_fd=self.root, dst_dir_fd=self.folder, follow_symlinks=False)
            self.published = True
            os.unlink(self.temp_name, dir_fd=self.root)
            os.fsync(self.folder)
            os.fsync(self.files)
            os.fsync(self.root)
            self.conn.execute('''INSERT INTO library_files
                (file_id,version_id,vault_id,sha256,byte_size,media_type,original_name,relative_path,created_at_utc)
                VALUES (?,?,?,?,?,?,?,?,?)''', (file_id, version_id, self.expected, digest, self.size, self.media,
                                              self.filename, f'files/{file_id}/{self.dest_name}', utc_now()))
            row = file_row(self.conn, file_id)
        if self.document_id is not None:
            self.conn.execute('INSERT OR IGNORE INTO library_file_documents VALUES (?,?,?)', (row['file_id'], self.document_id, utc_now()))
        # Build the receipt before commit; a later projection failure must not
        # turn a durable publication into an attempted cleanup.
        result = {'version': 1, 'vault_id': self.expected, 'file': projection(self.conn, row),
                  'created': duplicate is None, 'duplicate': duplicate is not None,
                  'linked_document_ids': [x['document_id'] for x in links(self.conn, row['file_id'])]}
        self.conn.commit()
        self.committed = True
        return result

    def __exit__(self, exc_type, exc, tb) -> None:
        try:
            if not self.committed:
                self.conn.rollback()
                if self.published:
                    os.unlink(self.dest_name, dir_fd=self.folder)
                if self.new_file_id:
                    os.rmdir(self.new_file_id, dir_fd=self.files)
            if self.temp is not None:
                os.close(self.temp)
                if self.temp_name in os.listdir(self.root):
                    os.unlink(self.temp_name, dir_fd=self.root)
            if self.lock is not None:
                os.close(self.lock)
                os.unlink('.import.lock', dir_fd=self.root)
        finally:
            if self.folder is not None:
                os.close(self.folder)
            if self.files is not None:
                os.close(self.files)
            self.vault_context.__exit__(exc_type, exc, tb)
