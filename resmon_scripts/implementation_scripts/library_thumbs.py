"""The first-page pictures the Library's gallery shows, kept beside the database.

The renderer draws a PDF's first page with the PDF.js the reader already uses,
once, and hands the picture here; every later gallery reads it back instead of
opening the PDF again. The window may not keep it itself: Atlas keeps nothing in
browser storage, and its content policy shows images from its own origin and
``data:`` only, so a picture reaches it as bytes it turns into a ``data:`` URL.

A picture is keyed by the file's version id and the drawing revision
(``fonts-1``), so a picture from an earlier revision is never served and the
cover is drawn again. It is checked against the catalog on every read and write,
so no picture is served for a version the Library does not record.
The folder is ``<database>-library-pictures/`` beside the database, as the map's
fit is beside it: derived data, cheap to draw again, and never inside the
person's Library folder. Only the three image formats a canvas encodes are
taken, by their signatures, and nothing here decodes one.
"""
from __future__ import annotations

import os
from pathlib import Path
import sqlite3
import tempfile
import uuid

from . import library
from .library import LibraryError

MAX_PICTURE_BYTES = 512 * 1024
_SIGNATURES = {
    'image/webp': lambda b: b[:4] == b'RIFF' and b[8:12] == b'WEBP',
    'image/png': lambda b: b[:8] == b'\x89PNG\r\n\x1a\n',
    'image/jpeg': lambda b: b[:3] == b'\xff\xd8\xff',
}
_EXTENSION = {'image/webp': 'webp', 'image/png': 'png', 'image/jpeg': 'jpg'}


def folder(conn: sqlite3.Connection) -> Path | None:
    """Where pictures are kept for this database, or ``None`` for one with no file of its own."""
    row = conn.execute('PRAGMA database_list').fetchone()
    path = row[2] if row else ''
    if not path:
        return None
    return Path(path).with_name(Path(path).name + '-library-pictures')


def _paired(conn: sqlite3.Connection, expected: str, file_id: str, version_id: str) -> dict:
    library.vault_row(conn, expected)
    row = library.file_row(conn, file_id, version_id)
    if row['vault_id'] != expected:
        raise LibraryError('wrong_vault', 'This file belongs to another vault.')
    return row


def _named(version_id: str) -> str:
    return str(uuid.UUID(version_id)) + '.fonts-1'


def read(conn: sqlite3.Connection, expected: str, file_id: str, version_id: str) -> tuple[str, bytes]:
    """The kept picture of this exact version, or ``no_picture``."""
    _paired(conn, expected, file_id, version_id)
    where = folder(conn)
    if where is not None:
        for media, extension in _EXTENSION.items():
            path = where / f'{_named(version_id)}.{extension}'
            try:
                with open(path, 'rb') as handle:
                    data = handle.read(MAX_PICTURE_BYTES + 1)
            except FileNotFoundError:
                continue
            if len(data) <= MAX_PICTURE_BYTES and _SIGNATURES[media](data):
                return media, data
    raise LibraryError('no_picture', 'No picture is kept for this file yet.', 404)


def write(conn: sqlite3.Connection, expected: str, file_id: str, version_id: str, media: str, data: bytes) -> dict:
    """Keep the picture the renderer drew of this version, replacing any earlier one."""
    row = _paired(conn, expected, file_id, version_id)
    if row['media_type'] != 'application/pdf':
        raise LibraryError('unsupported', 'Pictures are kept for PDF files only.', 415)
    if media not in _SIGNATURES:
        raise LibraryError('invalid_picture', 'Send a WebP, PNG or JPEG picture.', 415)
    if not 1 <= len(data) <= MAX_PICTURE_BYTES:
        raise LibraryError('picture_limit', 'A picture is limited to 512 KiB.', 413)
    if not _SIGNATURES[media](data):
        raise LibraryError('invalid_picture', 'The bytes are not the picture format they were sent as.', 415)
    where = folder(conn)
    if where is None:
        raise LibraryError('no_picture_folder', 'This database has no folder beside it to keep pictures in.')
    where.mkdir(mode=0o700, exist_ok=True)
    name = _named(version_id)
    with tempfile.NamedTemporaryFile(dir=where, prefix='.picture-', delete=False) as handle:
        handle.write(data)
        handle.flush()
        os.fsync(handle.fileno())
        staged = handle.name
    try:
        # A picture of this version from an earlier drawing revision is
        # derived data; it is removed rather than kept beside the new one.
        for extension in _EXTENSION.values():
            (where / f'{uuid.UUID(version_id)}.{extension}').unlink(missing_ok=True)
        for other in _EXTENSION.values():
            if other != _EXTENSION[media]:
                try:
                    (where / f'{name}.{other}').unlink()
                except FileNotFoundError:
                    pass
        os.replace(staged, where / f'{name}.{_EXTENSION[media]}')
    except BaseException:
        try:
            os.unlink(staged)
        except FileNotFoundError:
            pass
        raise
    return {'version': 1, 'vault_id': expected, 'file_id': file_id, 'version_id': version_id,
            'media_type': media, 'byte_size': len(data)}


def forget(conn: sqlite3.Connection, version_id: str) -> None:
    """Drop a version's picture once nothing can show it again."""
    where = folder(conn)
    if where is None:
        return
    for extension in _EXTENSION.values():
        for name in (_named(version_id), str(uuid.UUID(version_id))):
            (where / f'{name}.{extension}').unlink(missing_ok=True)
