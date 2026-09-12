"""One SQL snapshot and explicitly selected verified files in a portable ZIP.

The temporary archive is completely built before advertising a download. Only
the operation's own spool is cleaned; membership/originals are never modified.
"""
from __future__ import annotations

import hashlib
import html
import json
import os
from pathlib import Path
import re
import sqlite3
import tempfile
import threading
import uuid
import zipfile
from typing import Iterator

from . import evidence, library

MAX_FILES = 20
MAX_RETAINED_BYTES = 256 * 1024 * 1024
MAX_MANIFEST_BYTES = 4 * 1024 * 1024
MAX_NOTES_BYTES = 4 * 1024 * 1024


class Bundle:
    def __init__(self) -> None:
        self.directory = tempfile.TemporaryDirectory(prefix='resmon-evidence-bundle-')
        self.path = Path(self.directory.name) / 'bundle.zip'
        self.manifest: dict = {}
        self.size = 0
        self.closed = False

    def chunks(self) -> Iterator[bytes]:
        try:
            with self.path.open('rb') as stream:
                while True:
                    chunk = stream.read(65536)
                    if not chunk:
                        break
                    yield chunk
        finally:
            self.close()

    def close(self) -> None:
        if not self.closed:
            self.directory.cleanup()
            self.closed = True


def cancelled(cancel: threading.Event | None) -> None:
    if cancel is not None and cancel.is_set():
        evidence.refuse('cancelled', 'The selected bundle was cancelled.')


def _escaped(value: str) -> str:
    return re.sub(r'([\\`*_{}\[\]()#+.!|>~-])', r'\\\1', html.escape(value, quote=True))


def _fence(value: str) -> str:
    longest = max((len(x) for x in re.findall(r'`+', value)), default=0)
    fence = '`' * max(3, longest + 1)
    return fence + 'text\n' + value + '\n' + fence


def notes_markdown(manifest: dict) -> bytes:
    pieces = ['# Selected evidence', '', _escaped(manifest['project']['name']), '',
              'Mode: ' + manifest['mode'] + '.', manifest['verification'], '']
    for file in manifest['files']:
        pieces += ['## ' + _escaped(file['original_name']), '',
                   'File: ' + file['file_id'] + ' / version: ' + file['version_id'], '']
        for note in file['notes']:
            pieces += ['### ' + note['kind'] + ' ' + note['note_id'], '']
            if note['kind'] == 'passage':
                pieces += [f"Page {note['page_number']} · {_escaped(note['extraction_contract'])} · saved text SHA256 {note['page_text_sha256']}",
                           '', _fence(note['quote']), '']
            if note['body']:
                pieces += [_fence(note['body']), '']
    data = '\n'.join(pieces).encode('utf-8')
    if len(data) > MAX_NOTES_BYTES:
        evidence.refuse('notes_limit', 'Selected notes exceed the 4 MiB portable text limit.', 413)
    return data


def build(conn: sqlite3.Connection, expected: str, project_id: str, revision: int,
          selected: list[dict], include_files: bool, *, cancel: threading.Event | None = None) -> Bundle:
    evidence.integer(revision)
    if type(include_files) is not bool or not isinstance(selected, list):
        evidence.refuse('invalid_selection', 'Choose an explicit file selection and inclusion mode.', 422)
    if not 1 <= len(selected) <= MAX_FILES:
        evidence.refuse('selection_limit', 'Select 1–20 distinct current files.', 413)
    identities = []
    for item in selected:
        if not isinstance(item, dict) or set(item) != {'file_id', 'version_id'}:
            evidence.refuse('invalid_selection', 'Each selection needs exact file and version UUIDs only.', 422)
        identities.append((evidence.identity(item['file_id']), evidence.identity(item['version_id'])))
    if len(set(identities)) != len(identities) or len({x[0] for x in identities}) != len(identities):
        evidence.refuse('duplicate_selection', 'A selected file may appear only once.', 422)
    bundle = Bundle()
    try:
        conn.execute('BEGIN')
        project = evidence.project(conn, expected, project_id)
        if project['revision'] != revision:
            evidence.refuse('stale_revision', 'The project changed. Refresh before selecting a bundle.')
        manifest = {'format': 'evidence-bundle', 'version': 1, 'bundle_id': str(uuid.uuid4()),
                    'captured_at': library.utc_now(), 'mode': 'include_retained_files' if include_files else 'metadata_only',
                    'project': {k: project[k] for k in ('project_id', 'name', 'revision')},
                    'vault_id': expected, 'files': [],
                    'verification': ('Included retained bytes were rehashed against exact saved identities; saved quotations were not re-extracted.'
                                     if include_files else 'Retained bytes were not checked. Notes and passages are saved records, not newly verified quotations.')}
        total = 0
        note_budget = 0
        for file_id, version_id in identities:
            cancelled(cancel)
            evidence.member(conn, expected, project_id, file_id, version_id)
            file = evidence.file_record(conn, expected, file_id, version_id)
            notes = conn.execute('SELECT * FROM evidence_notes WHERE project_id=? AND file_id=? ORDER BY id', (project_id, file_id))
            saved = []
            for note in notes:
                cancelled(cancel)
                row = evidence.note_view(conn, expected, dict(note))
                if row['version_id'] != version_id:
                    evidence.refuse('wrong_version', 'A saved note has a mismatched version.')
                portable = {k: row[k] for k in ('note_id', 'project_id', 'file_id', 'version_id', 'kind', 'body',
                                               *evidence.ANCHOR_FIELDS, 'revision', 'created_at_utc', 'updated_at_utc')}
                note_budget += len(json.dumps(portable, ensure_ascii=False).encode('utf-8'))
                if note_budget > MAX_MANIFEST_BYTES:
                    evidence.refuse('manifest_limit', 'Selected metadata exceeds 4 MiB.', 413)
                saved.append(portable)
            file['notes'] = saved
            if include_files:
                extension = next(k for k, v in library.MEDIA.items() if v == file['media_type'])
                file['content_path'] = f'files/{file_id}/{version_id}.{extension}'
            total += file['byte_size']
            manifest['files'].append(file)
        if include_files and total > MAX_RETAINED_BYTES:
            evidence.refuse('bundle_limit', 'Selected retained files exceed 256 MiB.', 413)
        metadata = json.dumps(manifest, ensure_ascii=False, indent=2).encode('utf-8')
        if len(metadata) > MAX_MANIFEST_BYTES:
            evidence.refuse('manifest_limit', 'Selected metadata exceeds 4 MiB.', 413)
        notes = notes_markdown(manifest)
        actual_total = 0
        with zipfile.ZipFile(bundle.path, 'x', compression=zipfile.ZIP_STORED, allowZip64=False) as archive:
            archive.writestr('manifest.json', metadata)
            archive.writestr('notes.md', notes)
            if include_files:
                for file in manifest['files']:
                    cancelled(cancel)
                    with library.retained(conn, expected, file['file_id'], file['version_id']) as (row, fd, _):
                        digest, size = hashlib.sha256(), 0
                        with archive.open(file['content_path'], 'w') as target:
                            while True:
                                cancelled(cancel)
                                data = os.read(fd, 65536)
                                if not data:
                                    break
                                size += len(data); actual_total += len(data)
                                if actual_total > MAX_RETAINED_BYTES or size > file['byte_size']:
                                    evidence.refuse('bundle_limit', 'Actual streamed bytes exceed the selected bundle bounds.', 413)
                                digest.update(data); target.write(data)
                        if (size != file['byte_size'] or digest.hexdigest() != file['sha256']
                                or row['sha256'] != file['sha256']):
                            evidence.refuse('changed_content', 'A selected retained file changed during export.')
        cancelled(cancel)
        conn.rollback()  # End the read snapshot: this operation has no writes.
        bundle.manifest = manifest
        bundle.size = bundle.path.stat().st_size
        return bundle
    except BaseException:
        conn.rollback()
        bundle.close()
        raise
