"""The Library files a person attaches to an Ask conversation, and the one way Ask reads them.

A file is attached when the conversation is created, at the exact version it has then
(Ask About This Paper attaches the paper's file). After that, Ask's ``read_attached_file``
tool reads that version's text, a page and a part of a page at a time, through the same
page reader Evidence uses, so a page is the same text, by the same codepoints, in both.

Nothing else in the Library is reachable from Ask: a file that is not attached to the
conversation is refused before anything is read, and a file whose version changed since
it was attached is refused rather than read as something the person did not choose.
"""
from __future__ import annotations

import hashlib
import sqlite3
import threading

from . import assistant_store, evidence, evidence_reader, library

#: How many files one conversation can have attached.
MAX_FILES = 3
#: The most text one read returns. A longer page is read in parts: ``next_offset`` says
#: where the next part starts, and nothing is cut without saying so.
MAX_PART = 12_000
#: How long a read waits for the one PDF page reader another read is using.
BUSY_WAIT_SECONDS = 5.0


def _refuse(reason: str, message: str, status: int = 409) -> None:
    raise library.LibraryError(reason, message, status)


def attachable(conn: sqlite3.Connection, refs: list[dict]) -> tuple[dict, ...]:
    """Verified records for the files a new conversation attaches.

    Each reference names a ``file_id`` and, optionally, the ``version_id`` the person saw;
    without one, the file's current version is the one attached. Every file must be in the
    Library's current folder, in a type the reader reads.
    """
    if len(refs) > MAX_FILES:
        _refuse('too_many_files', f'A conversation can have at most {MAX_FILES} files attached.', 422)
    ids = [ref['file_id'] for ref in refs]
    if len(set(ids)) != len(ids):
        _refuse('duplicate_file', 'Each file is attached once.', 422)
    if not refs:
        return ()
    vault = library.vault_row(conn)['vault_id']
    records = []
    for ref in refs:
        row = library.file_row(conn, ref['file_id'], ref.get('version_id'))
        if row['vault_id'] != vault:
            _refuse('wrong_vault', 'This file belongs to a different Library folder.')
        if row['media_type'] not in library.MEDIA.values():
            _refuse('unsupported', 'Ask reads PDF, text, Markdown, and TeX files.', 415)
        records.append({k: row[k] for k in ('file_id', 'version_id', 'original_name', 'media_type')})
    return tuple(records)


def _public(file: dict) -> dict:
    return {k: file[k] for k in ('file_id', 'version_id', 'original_name', 'media_type')}


def read(conn: sqlite3.Connection, session_id: int, file_id: str | None, page: int, offset: int,
         *, cancel: threading.Event | None = None) -> dict:
    """One part of one page of a file attached to conversation *session_id*.

    With no *file_id*, the conversation's only attached file is read; with several, the
    answer lists them (``status`` ``choose_file``) and reads nothing.
    """
    if assistant_store.get_session(conn, session_id) is None:
        _refuse('unknown_conversation', 'That conversation does not exist.', 404)
    evidence.integer(page, 1, 200)
    if type(offset) is not int or offset < 0:
        _refuse('invalid_offset', 'offset is a whole number from 0.', 422)
    attached = assistant_store.session_files(conn, session_id)
    listed = [_public(f) for f in attached]
    if file_id is None:
        if len(attached) != 1:
            return {'session_id': session_id, 'attached': listed, 'status': 'choose_file' if attached else 'no_file',
                    'text': ''}
        chosen = attached[0]
    else:
        chosen = next((f for f in attached if f['file_id'] == file_id), None)
        if chosen is None:
            _refuse('not_attached', 'That file is not attached to this conversation, so Ask cannot read it.', 404)
    vault = library.vault_row(conn)['vault_id']
    try:
        file = evidence.file_record(conn, vault, chosen['file_id'], chosen['version_id'])
    except library.LibraryError as exc:
        if exc.reason == 'wrong_version':
            _refuse('changed_file', f'“{chosen["original_name"]}” has a different version in the Library now '
                    'than when it was attached, so it was not read.')
        if exc.reason == 'unknown_file':
            _refuse('removed_file', f'“{chosen["original_name"]}” is no longer in the Library, so it was not read.', 404)
        raise
    result, contract = evidence_reader.page_text(conn, vault, file, file['file_id'], file['version_id'],
                                                 page, cancel=cancel, busy_wait=BUSY_WAIT_SECONDS)
    text = result['text'] if result['status'] == 'extracted' else ''
    # Only text that was read can be past its end. A page the reader could not read this time
    # says so in ``status``, with no text, whatever the offset.
    if result['status'] == 'extracted' and offset and offset >= len(text):
        _refuse('invalid_offset', f'This page has {len(text)} characters; offset {offset} is past its end.', 422)
    part = text[offset:offset + MAX_PART]
    end = offset + len(part)
    return {
        'session_id': session_id, 'attached': listed, 'status': result['status'], 'text': part,
        'file': {**_public(file), 'sha256': file['sha256']},
        'page_number': result['page_number'], 'page_count': result['page_count'],
        'offset': offset, 'next_offset': end if end < len(text) else None,
        'page_characters': len(text), 'extraction_contract': contract,
        'page_text_sha256': hashlib.sha256(text.encode('utf-8')).hexdigest() if result['status'] == 'extracted' else None,
        'coverage': evidence_reader.COVERAGE,
    }
