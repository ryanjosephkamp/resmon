"""Bounded page projections from reverified retained descriptors, never source paths."""
from __future__ import annotations

import hashlib
import os
import sqlite3
import threading

from . import evidence, evidence_pdf, library, library_text


def pdf_bytes(conn: sqlite3.Connection, expected: str, project_id: str, file_id: str, version_id: str) -> tuple[dict, bytes]:
    file = evidence.reader_access(conn, expected, project_id, file_id, version_id)
    if file['media_type'] != 'application/pdf':
        evidence.refuse('unsupported', 'The visual reader accepts PDF files only.', 415)
    with library.retained(conn, expected, file_id, version_id, evidence_pdf.MAX_INPUT) as (row, fd, _):
        data = bytearray()
        while len(data) <= evidence_pdf.MAX_INPUT:
            chunk = os.read(fd, min(65536, evidence_pdf.MAX_INPUT + 1 - len(data)))
            if not chunk:
                break
            data.extend(chunk)
        if len(data) > evidence_pdf.MAX_INPUT:
            evidence.refuse('pdf_limit', 'This PDF exceeds 16 MiB; nothing was truncated.', 413)
        if len(data) != row['byte_size'] or hashlib.sha256(data).hexdigest() != row['sha256']:
            evidence.refuse('changed_content', 'Retained bytes changed during the read.')
        return file, bytes(data)


def read_text(conn: sqlite3.Connection, expected: str, project_id: str, file_id: str,
              version_id: str, page: int, *, cancel: threading.Event | None = None) -> dict:
    if cancel is not None and cancel.is_set():
        evidence.refuse('cancelled', 'The selected page read was cancelled.')
    evidence.integer(page, 1, 200)
    file = evidence.reader_access(conn, expected, project_id, file_id, version_id)
    if file['media_type'] == 'application/pdf':
        _, raw = pdf_bytes(conn, expected, project_id, file_id, version_id)
        result = evidence_pdf.extract(raw, page, cancel=cancel)
        contract = evidence.PDF_CONTRACT
    else:
        if page != 1:
            evidence.refuse('invalid_page', 'TXT and MD have one bounded logical page.', 422)
        projection = library_text.read_text(conn, expected, file_id, version_id)
        result = {'status': 'extracted' if projection['text'] else 'no_text', 'page_number': 1,
                  'page_count': 1, 'text': projection['text']}
        contract = evidence.TEXT_CONTRACT
    if cancel is not None and cancel.is_set():
        evidence.refuse('cancelled', 'The selected page read was cancelled.')
    text = result['text']
    return evidence.envelope(expected, project_id, file_id=file_id, version_id=version_id,
                             sha256=file['sha256'], media_type=file['media_type'], **result,
                             extraction_contract=contract,
                             page_text_sha256=hashlib.sha256(text.encode('utf-8')).hexdigest() if result['status'] == 'extracted' else None,
                             examined_pages=[page] if result['status'] in ('extracted', 'no_text') else [],
                             remaining_pages='not_examined',
                             coverage='Canonical text may omit or reshape tables, equations, columns and images. No OCR.')
