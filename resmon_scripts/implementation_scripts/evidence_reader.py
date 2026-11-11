"""Bounded page projections from reverified retained descriptors, never source paths."""
from __future__ import annotations

import hashlib
import os
import sqlite3
import threading
import time

from . import evidence, evidence_pdf, library, library_text


def pdf_bytes(conn: sqlite3.Connection, expected: str, project_id: str, file_id: str, version_id: str) -> tuple[dict, bytes]:
    file = evidence.reader_access(conn, expected, project_id, file_id, version_id)
    if file['media_type'] != 'application/pdf':
        evidence.refuse('unsupported', 'The visual reader accepts PDF files only.', 415)
    return file, retained_pdf(conn, expected, file_id, version_id)


def retained_pdf(conn: sqlite3.Connection, expected: str, file_id: str, version_id: str) -> bytes:
    """A retained PDF's bytes, verified whole against its recorded size and digest.

    Whoever calls this has already decided the reader may see the file.
    """
    with library.retained(conn, expected, file_id, version_id, evidence_pdf.MAX_INPUT) as (row, fd, _):
        data = bytearray()
        while len(data) <= evidence_pdf.MAX_INPUT:
            chunk = os.read(fd, min(65536, evidence_pdf.MAX_INPUT + 1 - len(data)))
            if not chunk:
                break
            data.extend(chunk)
        if len(data) > evidence_pdf.MAX_INPUT:
            evidence.refuse('pdf_limit', 'This PDF exceeds 64 MiB; nothing was truncated.', 413)
        if len(data) != row['byte_size'] or hashlib.sha256(data).hexdigest() != row['sha256']:
            evidence.refuse('changed_content', 'Retained bytes changed during the read.')
        return bytes(data)


def page_text(conn: sqlite3.Connection, expected: str, file: dict, file_id: str, version_id: str,
              page: int, *, cancel: threading.Event | None = None,
              busy_wait: float = 0.0) -> tuple[dict, str]:
    """One page of a file the caller may read: the extractor's result and its contract.

    ``file`` is the verified record (``evidence.file_record``). A PDF is read page by
    page; TXT, MD, and TeX have one bounded logical page. Evidence and Ask's attached
    files both read through here, so a page means the same text, by the same
    codepoints, in either. ``busy_wait`` is how long, in seconds, to keep asking
    the one PDF page reader while another read holds it; the file is read and
    verified once, before the first ask.
    """
    if file['media_type'] == 'application/pdf':
        raw = retained_pdf(conn, expected, file_id, version_id)
        deadline = time.monotonic() + busy_wait
        while True:
            try:
                return evidence_pdf.extract(raw, page, cancel=cancel), evidence.PDF_CONTRACT
            except library.LibraryError as exc:
                if exc.reason != 'reader_busy' or time.monotonic() >= deadline:
                    raise
                time.sleep(0.2)
    if page != 1:
        evidence.refuse('invalid_page', 'TXT and MD have one bounded logical page.', 422)
    projection = library_text.read_text(conn, expected, file_id, version_id)
    return ({'status': 'extracted' if projection['text'] else 'no_text', 'page_number': 1,
             'page_count': 1, 'text': projection['text']}, evidence.TEXT_CONTRACT)


def read_text(conn: sqlite3.Connection, expected: str, project_id: str, file_id: str,
              version_id: str, page: int, *, cancel: threading.Event | None = None) -> dict:
    if cancel is not None and cancel.is_set():
        evidence.refuse('cancelled', 'The selected page read was canceled.')
    evidence.integer(page, 1, 200)
    file = evidence.reader_access(conn, expected, project_id, file_id, version_id)
    result, contract = page_text(conn, expected, file, file_id, version_id, page, cancel=cancel)
    if cancel is not None and cancel.is_set():
        evidence.refuse('cancelled', 'The selected page read was canceled.')
    text = result['text']
    return evidence.envelope(expected, project_id, file_id=file_id, version_id=version_id,
                             sha256=file['sha256'], media_type=file['media_type'], **result,
                             extraction_contract=contract,
                             page_text_sha256=hashlib.sha256(text.encode('utf-8')).hexdigest() if result['status'] == 'extracted' else None,
                             examined_pages=[page] if result['status'] in ('extracted', 'no_text') else [],
                             remaining_pages='not_examined',
                             coverage=COVERAGE)


#: What canonical page text can and cannot hold, said with every page that is read.
COVERAGE = 'Canonical text may omit or reshape tables, equations, columns, and images. No OCR.'
