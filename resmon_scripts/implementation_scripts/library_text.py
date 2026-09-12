"""Bounded literal display projection; the retained original is never normalized."""
from __future__ import annotations

import hashlib
import json
import os
import sqlite3
from . import library

MAX_TEXT_BYTES = 256 * 1024
MAX_LINES = 5000
MAX_RESPONSE_BYTES = 2 * 1024 * 1024


def read_text(conn: sqlite3.Connection, vault_id: str, file_id: str, version_id: str) -> dict:
    # Validate the pairing even for an unsupported format; never return content
    # for a guessed item/version. Open and text use the same retained resolver.
    with library.checked_vault(conn, vault_id):
        row = library.file_row(conn, file_id, version_id)
        if row['media_type'] not in ('text/plain', 'text/markdown'):
            raise library.LibraryError('unsupported_text', 'PDF is retained but cannot be read here. Use verified external Open.', 415)
    with library.retained(conn, vault_id, file_id, version_id, MAX_TEXT_BYTES) as (row, fd, _):
        raw = bytearray()
        while len(raw) <= MAX_TEXT_BYTES:
            chunk = os.read(fd, min(65536, MAX_TEXT_BYTES + 1 - len(raw)))
            if not chunk:
                break
            raw.extend(chunk)
        if len(raw) > MAX_TEXT_BYTES:
            raise library.LibraryError('too_large', 'Text exceeds 256 KiB. Use verified external Open.', 413)
        if len(raw) != row['byte_size'] or hashlib.sha256(raw).hexdigest() != row['sha256']:
            raise library.LibraryError('changed_content', 'The retained bytes changed during the read.')
        try:
            text = raw.decode('utf-8', errors='strict')
            if '\x00' in text:
                raise UnicodeError()
        except UnicodeError:
            raise library.LibraryError('invalid_text', 'Text must be strict UTF-8 without NUL bytes.', 415) from None
        text = text.replace('\r\n', '\n').replace('\r', '\n')
        lines = text.count('\n') + 1
        if lines > MAX_LINES:
            raise library.LibraryError('too_many_lines', 'Text exceeds 5,000 logical lines. Use verified external Open.', 413)
        result = {'version': 1, 'kind': 'resmon-library-text', 'vault_id': vault_id,
                  'file_id': file_id, 'version_id': version_id, 'sha256': row['sha256'],
                  'media_type': row['media_type'], 'encoding': 'utf-8',
                  'normalization': 'crlf-cr-to-lf-v1', 'byte_size': row['byte_size'],
                  'line_count': lines, 'text': text}
        if len(json.dumps(result, ensure_ascii=False).encode('utf-8')) > MAX_RESPONSE_BYTES:
            raise library.LibraryError('response_limit', 'The serialized text exceeds 2 MiB; nothing was truncated.', 413)
        return result
