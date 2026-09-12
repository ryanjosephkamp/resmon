"""Own one fixed parser process and bounded pipes until it is conclusively reaped."""
from __future__ import annotations

from datetime import datetime, timezone
import json
import os
from pathlib import Path
import struct
import subprocess
import sys
import tempfile
import threading
import time
from typing import BinaryIO

from . import evidence

MAX_INPUT = 16 * 1024 * 1024
MAX_OUTPUT = 1024 * 1024
MAX_STDERR = 4096
TIMEOUT_SECONDS = 20
_LEASE = threading.Lock()
_WORKER = Path(__file__).with_name('evidence_pdf_worker.py').resolve()
_STATUSES = {'extracted', 'no_text', 'unsupported', 'malformed', 'limit_exceeded', 'unavailable'}
# Bounded diagnostics, without document text. Tests inspect exact owned lifecycle.
LAST_RUN: dict = {}


def _unique_json(pairs: list[tuple]) -> dict:
    result = {}
    for key, value in pairs:
        if key in result:
            raise ValueError('duplicate parser field')
        result[key] = value
    return result


def validate_output(raw: bytes, page: int) -> dict:
    data = json.loads(raw.decode('utf-8', errors='strict'), object_pairs_hook=_unique_json)
    if (not isinstance(data, dict) or set(data) != {'status', 'page_number', 'page_count', 'text'}
            or data['status'] not in _STATUSES or type(data['page_number']) is not int
            or data['page_number'] != page or not isinstance(data['text'], str)
            or '\x00' in data['text'] or any(0xD800 <= ord(c) <= 0xDFFF for c in data['text'])
            or len(data['text']) > 200000
            or (data['page_count'] is not None and (type(data['page_count']) is not int or data['page_count'] < 0))):
        raise ValueError('invalid parser result')
    if data['status'] in ('extracted', 'no_text'):
        if (data['page_count'] is None or not page <= data['page_count'] <= 200
                or (data['status'] == 'extracted') != bool(data['text'])):
            raise ValueError('invalid extracted page')
    elif data['text']:
        raise ValueError('failed page contains text')
    return data


def extract(raw: bytes, page: int, *, cancel: threading.Event | None = None) -> dict:
    evidence.integer(page, 1, 200)
    if not isinstance(raw, bytes) or not 1 <= len(raw) <= MAX_INPUT:
        evidence.refuse('pdf_limit', 'PDF reading is limited to 16 MiB.', 413)
    if cancel is not None and cancel.is_set():
        evidence.refuse('cancelled', 'The selected PDF page was cancelled.')
    if not _LEASE.acquire(blocking=False):
        evidence.refuse('reader_busy', 'Another bounded PDF page is being read. Try again when it finishes.', 409)
    start = time.monotonic()
    proc = None
    threads: list[threading.Thread] = []
    overflow = threading.Event()
    stdout, stderr = bytearray(), bytearray()
    result = {'status': 'unavailable', 'page_number': page, 'page_count': None, 'text': ''}
    record = {'started_at': datetime.now(timezone.utc).isoformat(), 'pid': None, 'page_number': page,
              'status': 'starting', 'returncode': None, 'reaped': False, 'scratch_removed': False}
    scratch = None

    def drain(pipe: BinaryIO, target: bytearray, maximum: int) -> None:
        try:
            while True:
                chunk = pipe.read(min(65536, maximum + 1 - len(target)))
                if not chunk:
                    break
                target.extend(chunk)
                if len(target) > maximum:
                    overflow.set()
                    break
        except (OSError, ValueError):
            pass

    def feed(pipe: BinaryIO, payload: bytes) -> None:
        try:
            pipe.write(payload)
            pipe.close()
        except (BrokenPipeError, OSError, ValueError):
            pass

    try:
        scratch = tempfile.TemporaryDirectory(prefix='resmon-pdf-')
        record['scratch'] = scratch.name
        # No inherited PATH, PYTHONPATH, app state, DB, plugin or credential env.
        env = {'PYTHONDONTWRITEBYTECODE': '1', 'PYTHONNOUSERSITE': '1',
               'LANG': 'C.UTF-8', 'LC_ALL': 'C.UTF-8'}
        if os.name == 'nt' and 'SYSTEMROOT' in os.environ:
            env['SYSTEMROOT'] = os.environ['SYSTEMROOT']
        try:
            proc = subprocess.Popen([sys.executable, '-I', str(_WORKER)], cwd=scratch.name, env=env,
                                    stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                    shell=False, close_fds=True)
            record.update(pid=proc.pid, launched_at=datetime.now(timezone.utc).isoformat())
            for target, args in [(drain, (proc.stdout, stdout, MAX_OUTPUT)),
                                 (drain, (proc.stderr, stderr, MAX_STDERR)),
                                 (feed, (proc.stdin, struct.pack('!II', page, len(raw)) + raw))]:
                thread = threading.Thread(target=target, args=args, daemon=True)
                thread.start(); threads.append(thread)
        except (OSError, RuntimeError):
            # Process/thread capacity is an unavailable parser, never a partial
            # page. The outer finally still owns a partially launched child.
            record['status'] = 'unavailable'
            return result
        while proc.poll() is None:
            if cancel is not None and cancel.is_set():
                record['status'] = 'cancelled'
                break
            if overflow.is_set():
                result['status'] = 'limit_exceeded'
                break
            if time.monotonic() - start >= TIMEOUT_SECONDS:
                result['status'] = 'timeout'
                break
            time.sleep(0.01)
        if proc.poll() is None:
            proc.terminate()
            try:
                proc.wait(timeout=0.2)
            except subprocess.TimeoutExpired:
                proc.kill()
        proc.wait(timeout=1)
        for thread in threads:
            thread.join(timeout=1)
        if cancel is not None and cancel.is_set():
            record['status'] = 'cancelled'
        if overflow.is_set():
            result['status'] = 'limit_exceeded'
        elif record['status'] != 'cancelled' and result['status'] != 'timeout' and proc.returncode == 0:
            try:
                result = validate_output(bytes(stdout), page)
            except (ValueError, TypeError, UnicodeError, RecursionError):
                result['status'] = 'malformed'
        if record['status'] != 'cancelled':
            record['status'] = result['status']
        return result
    finally:
        try:
            if proc is not None:
                if proc.poll() is None:
                    proc.kill()
                proc.wait()
                for pipe in (proc.stdin, proc.stdout, proc.stderr):
                    if pipe is not None:
                        pipe.close()
                for thread in threads:
                    thread.join(timeout=1)
                record.update(returncode=proc.returncode, reaped=proc.poll() is not None,
                              pipe_threads_stopped=all(not t.is_alive() for t in threads))
            if scratch is not None:
                scratch.cleanup()
                record['scratch_removed'] = not os.path.exists(scratch.name)
        finally:
            record.update(elapsed_seconds=time.monotonic() - start, stdout_bytes=len(stdout), stderr_bytes=len(stderr))
            LAST_RUN.clear(); LAST_RUN.update(record)
            # Never strand the single-child lease after an owned cleanup error.
            # An unreaped child is a material error, rather than another launch.
            if proc is None or proc.poll() is not None:
                _LEASE.release()
