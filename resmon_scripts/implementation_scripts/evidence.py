"""Exact Library versions, collection membership and literal saved evidence.

These records are owner selections, not inferred paper identity or scientific
findings. Removing membership never removes a saved record or retained object.
"""
from __future__ import annotations

from contextlib import contextmanager
from datetime import datetime, timezone
import re
import sqlite3
import uuid
from typing import Iterator

from . import library

MAX_PROJECTS = 100
MAX_MEMBERS = 1000
MAX_NOTES = 5000
MAX_BODY = 20000
FILE_FIELDS = ('file_id', 'version_id', 'vault_id', 'sha256', 'byte_size',
               'media_type', 'original_name', 'created_at_utc')
ANCHOR_FIELDS = ('page_number', 'extraction_contract', 'page_text_sha256',
                 'start_codepoint', 'end_codepoint', 'quote')
TEXT_CONTRACT = 'library-text-lf/v1'
PDF_CONTRACT = 'pypdf-6.18.1/plain-lf/v1'


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec='microseconds')


class EvidenceError(library.LibraryError):
    pass


def refuse(reason: str, message: str, status: int = 409) -> None:
    raise EvidenceError(reason, message, status)


def identity(value: str) -> str:
    try:
        return library.identity(value)
    except library.LibraryError:
        refuse('invalid_identity', 'An exact canonical UUID is required.', 422)


def integer(value: int, minimum: int = 1, maximum: int = 2**53 - 1) -> int:
    if type(value) is not int or not minimum <= value <= maximum:
        refuse('invalid_integer', 'An integer within the stated bounds is required.', 422)
    return value


def literal(value: str, minimum: int, maximum: int) -> str:
    if (not isinstance(value, str) or not minimum <= len(value) <= maximum
            or '\x00' in value or any(0xD800 <= ord(c) <= 0xDFFF for c in value)):
        refuse('invalid_text', 'Literal text exceeds its bounds or contains invalid characters.', 422)
    return value


def timestamp(value: str) -> str:
    # Evidence timestamps are generated here at six-digit UTC precision. A
    # damaged stored record must not become apparently valid portable evidence.
    try:
        if (not isinstance(value, str)
                or not re.fullmatch(r'\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{6}\+00:00', value)):
            raise ValueError
        datetime.fromisoformat(value)
    except ValueError:
        refuse('corrupt_record', 'A stored Evidence timestamp is invalid.')
    return value


def name(value: str) -> str:
    if not isinstance(value, str):
        refuse('invalid_name', 'A project name is required.', 422)
    return literal(value.strip(), 1, 120)


def vault(conn: sqlite3.Connection, expected: str) -> str:
    identity(expected)
    row = conn.execute('SELECT vault_id FROM library_vault WHERE singleton=1').fetchone()
    if row is None:
        refuse('no_vault', 'Configure Library before creating a collection.')
    if row[0] != expected:
        refuse('wrong_vault', 'The configured Library identity changed. Refresh explicitly.')
    return expected


def envelope(vault_id: str, project_id: str | None = None, **fields: object) -> dict:
    return {'contract_version': 1, 'vault_id': vault_id, **({'project_id': project_id} if project_id else {}), **fields}


def project(conn: sqlite3.Connection, expected: str, project_id: str) -> dict:
    vault(conn, expected)
    identity(project_id)
    row = conn.execute('SELECT * FROM evidence_projects WHERE project_id=?', (project_id,)).fetchone()
    if row is None:
        refuse('unknown_project', 'This project is not present.', 404)
    row = dict(row)
    if row['vault_id'] != expected:
        refuse('wrong_vault', 'This project belongs to a different vault.')
    integer(row['id']); integer(row['revision']); literal(row['name'], 1, 120)
    timestamp(row['created_at_utc']); timestamp(row['updated_at_utc'])
    return row


def project_view(conn: sqlite3.Connection, row: dict) -> dict:
    counts = {key: conn.execute(f'SELECT count(*) FROM {table} WHERE project_id=?', (row['project_id'],)).fetchone()[0]
              for key, table in [('file_count', 'evidence_project_files'), ('note_count', 'evidence_notes')]}
    return {**row, **counts}


def detail(conn: sqlite3.Connection, expected: str, project_id: str) -> dict:
    row = project(conn, expected, project_id)
    return envelope(expected, project_id, project=project_view(conn, row))


def file_record(conn: sqlite3.Connection, expected: str, file_id: str, version_id: str) -> dict:
    identity(file_id); identity(version_id)
    row = library.file_row(conn, file_id, version_id)
    if row['vault_id'] != expected:
        refuse('wrong_vault', 'The file and project vault do not match.')
    if not isinstance(row['sha256'], str) or not re.fullmatch('[0-9a-f]{64}', row['sha256']):
        refuse('corrupt_record', 'The recorded digest is invalid.')
    integer(row['byte_size'], 1, library.MAX_FILE_BYTES)
    if row['media_type'] not in library.MEDIA.values():
        refuse('corrupt_record', 'The recorded file type is invalid.')
    literal(row['original_name'], 1, 255)
    return {k: row[k] for k in FILE_FIELDS}


def member(conn: sqlite3.Connection, expected: str, project_id: str, file_id: str, version_id: str,
           *, required: bool = True) -> dict | None:
    file_record(conn, expected, file_id, version_id)
    row = conn.execute('SELECT * FROM evidence_project_files WHERE project_id=? AND file_id=?', (project_id, file_id)).fetchone()
    if row is None:
        if required:
            refuse('not_member', 'Select a current member of this collection.')
        return None
    if row['version_id'] != version_id:
        refuse('wrong_version', 'Collection membership and file version do not match.')
    integer(row['id']); timestamp(row['added_at_utc'])
    return dict(row)


@contextmanager
def write(conn: sqlite3.Connection, expected: str, project_id: str,
          expected_revision: int) -> Iterator[dict]:
    integer(expected_revision)
    conn.execute('BEGIN IMMEDIATE')
    try:
        row = project(conn, expected, project_id)
        if row['revision'] != expected_revision:
            refuse('stale_revision', 'This project changed. Refresh; your unsaved text is preserved.')
        yield row
        conn.commit()
    except BaseException:
        conn.rollback()
        raise


def changed(conn: sqlite3.Connection, project_id: str) -> None:
    conn.execute('UPDATE evidence_projects SET revision=revision+1,updated_at_utc=? WHERE project_id=?',
                 (utc_now(), project_id))


def create_project(conn: sqlite3.Connection, expected: str, title: str) -> dict:
    title = name(title)
    conn.execute('BEGIN IMMEDIATE')
    try:
        vault(conn, expected)
        if conn.execute('SELECT count(*) FROM evidence_projects').fetchone()[0] >= MAX_PROJECTS:
            refuse('project_limit', 'The 100-project limit is reached.', 413)
        project_id, now = str(uuid.uuid4()), utc_now()
        conn.execute('INSERT INTO evidence_projects(project_id,vault_id,name,revision,created_at_utc,updated_at_utc) VALUES (?,?,?,1,?,?)',
                     (project_id, expected, title, now, now))
        result = detail(conn, expected, project_id)
        conn.commit()
        return result
    except BaseException:
        conn.rollback()
        raise


def rename_project(conn: sqlite3.Connection, expected: str, project_id: str, revision: int, title: str) -> dict:
    title = name(title)
    with write(conn, expected, project_id, revision):
        conn.execute('UPDATE evidence_projects SET name=? WHERE project_id=?', (title, project_id))
        changed(conn, project_id)
        return detail(conn, expected, project_id)


def pagination(conn: sqlite3.Connection, table: str, where: str, args: tuple,
               after_id: int = 0, through_id: int | None = None, limit: int = 50) -> tuple[list, dict]:
    integer(after_id, 0); integer(limit, 1, 50)
    if through_id is not None:
        integer(through_id, 0)
    ceiling = through_id if through_id is not None else conn.execute(f'SELECT coalesce(max(id),0) FROM {table} WHERE {where}', args).fetchone()[0]
    rows = conn.execute(f'SELECT * FROM {table} WHERE {where} AND id>? AND id<=? ORDER BY id LIMIT ?', (*args, after_id, ceiling, limit + 1)).fetchall()
    more = len(rows) > limit
    items = [dict(row) for row in rows[:limit]]
    total = conn.execute(f'SELECT count(*) FROM {table} WHERE {where} AND id<=?', (*args, ceiling)).fetchone()[0]
    return items, {'through_id': ceiling, 'next_after_id': items[-1]['id'] if more else None,
                   'has_more': more, 'total': total, 'count_basis': 'current rows at the selected ID ceiling; removals may change counts'}


def list_projects(conn: sqlite3.Connection, expected: str, **page: int) -> dict:
    vault(conn, expected)
    rows, bounds = pagination(conn, 'evidence_projects', 'vault_id=?', (expected,), **page)
    items = [project_view(conn, project(conn, expected, r['project_id'])) for r in rows]
    return envelope(expected, projects=items, **bounds)


def list_files(conn: sqlite3.Connection, expected: str, project_id: str, **page: int) -> dict:
    p = project(conn, expected, project_id)
    rows, bounds = pagination(conn, 'evidence_project_files', 'project_id=?', (project_id,), **page)
    for r in rows:
        integer(r['id']); timestamp(r['added_at_utc'])
    items = [{**r, 'file': file_record(conn, expected, r['file_id'], r['version_id']), 'availability': 'not_checked'} for r in rows]
    return envelope(expected, project_id, revision=p['revision'], files=items, **bounds)


def add_file(conn: sqlite3.Connection, expected: str, project_id: str, revision: int, file_id: str, version_id: str) -> dict:
    with write(conn, expected, project_id, revision):
        current = member(conn, expected, project_id, file_id, version_id, required=False)
        if current is None:
            if conn.execute('SELECT count(*) FROM evidence_project_files WHERE project_id=?', (project_id,)).fetchone()[0] >= MAX_MEMBERS:
                refuse('member_limit', 'This project has reached 1,000 files.', 413)
            conn.execute('INSERT INTO evidence_project_files(project_id,file_id,version_id,added_at_utc) VALUES (?,?,?,?)',
                         (project_id, file_id, version_id, utc_now()))
            changed(conn, project_id)
        return envelope(expected, project_id, project=project_view(conn, project(conn, expected, project_id)),
                        membership=member(conn, expected, project_id, file_id, version_id), added=current is None)


def remove_file(conn: sqlite3.Connection, expected: str, project_id: str, revision: int, file_id: str, version_id: str) -> dict:
    with write(conn, expected, project_id, revision):
        current = member(conn, expected, project_id, file_id, version_id, required=False)
        if current is not None:
            conn.execute('DELETE FROM evidence_project_files WHERE project_id=? AND file_id=?', (project_id, file_id))
            changed(conn, project_id)
        return envelope(expected, project_id, project=project_view(conn, project(conn, expected, project_id)), removed=current is not None)


def validate_note(row: dict) -> None:
    if 'id' in row:
        integer(row['id'])
    timestamp(row['created_at_utc']); timestamp(row['updated_at_utc'])
    for key in ('note_id', 'project_id', 'file_id', 'version_id'):
        identity(row[key])
    integer(row['revision']); literal(row['body'], 0 if row['kind'] == 'passage' else 1, MAX_BODY)
    if row['kind'] == 'note':
        if any(row[k] is not None for k in ANCHOR_FIELDS):
            refuse('corrupt_record', 'A plain note has an invalid anchor.')
    elif row['kind'] == 'passage':
        integer(row['page_number'], 1, 200); integer(row['start_codepoint'], 0); integer(row['end_codepoint'])
        literal(row['extraction_contract'], 1, 100)
        literal(row['quote'], 1, MAX_BODY)
        if (row['end_codepoint'] - row['start_codepoint'] != len(row['quote'])
                or not isinstance(row['extraction_contract'], str)
                or not isinstance(row['page_text_sha256'], str)
                or not re.fullmatch('[0-9a-f]{64}', row['page_text_sha256'])):
            refuse('corrupt_record', 'The saved passage basis is invalid.')
    else:
        refuse('corrupt_record', 'The saved note kind is invalid.')


def note_view(conn: sqlite3.Connection, expected: str, row: dict) -> dict:
    validate_note(row)
    f = file_record(conn, expected, row['file_id'], row['version_id'])
    m = member(conn, expected, row['project_id'], row['file_id'], row['version_id'], required=False)
    return {**row, 'file': f, 'membership_state': 'member' if m else 'removed', 'resolution': 'not_checked'}


def list_notes(conn: sqlite3.Connection, expected: str, project_id: str, file_id: str | None = None,
               version_id: str | None = None, **page: int) -> dict:
    p = project(conn, expected, project_id)
    where, args = 'project_id=?', (project_id,)
    if file_id is not None or version_id is not None:
        file_record(conn, expected, file_id, version_id)
        where += ' AND file_id=? AND version_id=?'; args += (file_id, version_id)
    rows, bounds = pagination(conn, 'evidence_notes', where, args, **page)
    return envelope(expected, project_id, revision=p['revision'], notes=[note_view(conn, expected, r) for r in rows], **bounds)


def create_note(conn: sqlite3.Connection, expected: str, project_id: str, revision: int,
                file_id: str, version_id: str, kind: str, body: str, anchor: dict | None = None,
                *, cancel: object = None) -> dict:
    project(conn, expected, project_id)
    member(conn, expected, project_id, file_id, version_id)
    literal(body, 1 if kind == 'note' else 0, MAX_BODY)
    values = {k: None for k in ANCHOR_FIELDS}
    if kind == 'passage':
        if not isinstance(anchor, dict) or set(anchor) != set(ANCHOR_FIELDS):
            refuse('invalid_anchor', 'A complete exact passage basis is required.', 422)
        values.update(anchor)
    elif kind != 'note' or anchor is not None:
        refuse('invalid_note', 'Choose a plain note or an exact passage.', 422)
    now = utc_now()
    row = {'note_id': str(uuid.uuid4()), 'project_id': project_id, 'file_id': file_id,
           'version_id': version_id, 'kind': kind, 'body': body, **values,
           'revision': 1, 'created_at_utc': now, 'updated_at_utc': now}
    validate_note(row)
    if kind == 'passage':
        from . import evidence_reader
        basis = evidence_reader.read_text(conn, expected, project_id, file_id, version_id, row['page_number'], cancel=cancel)
        if (basis['status'] != 'extracted' or basis['extraction_contract'] != row['extraction_contract']
                or basis['page_text_sha256'] != row['page_text_sha256']
                or row['end_codepoint'] > len(basis['text'])
                or basis['text'][row['start_codepoint']:row['end_codepoint']] != row['quote']):
            refuse('quote_mismatch', 'The exact page, text hash, offsets and quote must match the retained version.')
    if cancel is not None and cancel.is_set():
        refuse('cancelled', 'Saving the selected evidence was cancelled.')
    with write(conn, expected, project_id, revision):
        if cancel is not None and cancel.is_set():
            refuse('cancelled', 'Saving the selected evidence was cancelled.')
        member(conn, expected, project_id, file_id, version_id)
        if conn.execute('SELECT count(*) FROM evidence_notes WHERE project_id=?', (project_id,)).fetchone()[0] >= MAX_NOTES:
            refuse('note_limit', 'This project has reached 5,000 saved notes.', 413)
        keys = tuple(row)
        conn.execute(f'INSERT INTO evidence_notes({",".join(keys)}) VALUES ({",".join("?" for _ in keys)})', tuple(row[k] for k in keys))
        changed(conn, project_id)
        saved = dict(conn.execute('SELECT * FROM evidence_notes WHERE note_id=?', (row['note_id'],)).fetchone())
        return envelope(expected, project_id, project=project_view(conn, project(conn, expected, project_id)), note=note_view(conn, expected, saved))


def edit_note(conn: sqlite3.Connection, expected: str, project_id: str, revision: int,
              note_id: str, note_revision: int, body: str) -> dict:
    identity(note_id); integer(note_revision)
    with write(conn, expected, project_id, revision):
        row = conn.execute('SELECT * FROM evidence_notes WHERE project_id=? AND note_id=?', (project_id, note_id)).fetchone()
        if row is None:
            refuse('unknown_note', 'This saved note is not present.', 404)
        row = dict(row); note_view(conn, expected, row)
        if row['revision'] != note_revision:
            refuse('stale_note', 'This note changed. Refresh; your unsaved text is preserved.')
        literal(body, 1 if row['kind'] == 'note' else 0, MAX_BODY)
        conn.execute('UPDATE evidence_notes SET body=?,revision=revision+1,updated_at_utc=? WHERE note_id=?',
                     (body, utc_now(), note_id))
        changed(conn, project_id)
        saved = dict(conn.execute('SELECT * FROM evidence_notes WHERE note_id=?', (note_id,)).fetchone())
        return envelope(expected, project_id, project=project_view(conn, project(conn, expected, project_id)), note=note_view(conn, expected, saved))


def reader_access(conn: sqlite3.Connection, expected: str, project_id: str, file_id: str, version_id: str) -> dict:
    project(conn, expected, project_id)
    f = file_record(conn, expected, file_id, version_id)
    if member(conn, expected, project_id, file_id, version_id, required=False) is None:
        notes = conn.execute('SELECT * FROM evidence_notes WHERE project_id=? AND file_id=?', (project_id, file_id)).fetchall()
        if not notes:
            refuse('not_member', 'This file has neither membership nor a saved note in this project.')
        for note in notes:
            note_view(conn, expected, dict(note))
    return f
