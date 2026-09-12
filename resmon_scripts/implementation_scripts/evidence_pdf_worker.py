"""Fixed one-page parser entry: stdin bytes only, no app or database imports.

This process has bounded parser settings and a parent deadline. Python audit
denials are defense in depth, not a portable OS sandbox or hard RSS guarantee.
"""
from __future__ import annotations

import io
import json
import logging
import struct
import sys

from pypdf import PdfReader, apply_configuration
from pypdf.errors import DependencyError, LimitReachedError, PdfReadError

MAX_INPUT = 16 * 1024 * 1024
MAX_OUTPUT = 1024 * 1024
MAX_CODEPOINTS = 200000
CONFIGURATION = {
    'maximum_declared_stream_length': 8 * 1024 * 1024,
    'array_based_stream_maximum_output_length': 8 * 1024 * 1024,
    'jbig2_maximum_output_length': 8 * 1024 * 1024,
    'lzw_maximum_output_length': 8 * 1024 * 1024,
    'run_length_maximum_output_length': 8 * 1024 * 1024,
    'zlib_maximum_output_length': 8 * 1024 * 1024,
    'image_maximum_buffer_size': 8 * 1024 * 1024,
    'zlib_maximum_recovery_input_length': 1024 * 1024,
    'flate_maximum_columns': 16384,
    'flate_maximum_row_length': 1024 * 1024,
    'xmp_maximum_input_length': 1024 * 1024,
    'xmp_maximum_element_count': 10000,
    'outline_maximum_entries': 1000,
    'outline_maximum_depth': 32,
    # The upstream counter excludes the root; 1999 children bounds total nodes.
    'page_tree_maximum_entries': 1999,
    'page_tree_maximum_depth': 32,
    'xform_maximum_invocations_per_extraction': 100,
    'jbig2dec_binary': None,
}


class ParserWarnings(logging.Handler):
    """Never format a document-controlled logging argument or emit its content."""
    def __init__(self) -> None:
        super().__init__(logging.WARNING)
        self.status: str | None = None

    def emit(self, record: logging.LogRecord) -> None:
        template = record.msg if isinstance(record.msg, str) else ''
        if any(word in template.lower() for word in ('maximum', 'limit', 'invocation')):
            self.status = 'limit_exceeded'
        elif self.status is None:
            self.status = 'malformed'


def parse(raw: bytes, page: int) -> dict:
    result = {'status': 'malformed', 'page_number': page, 'page_count': None, 'text': ''}
    if type(page) is not int or page < 1 or not raw.startswith(b'%PDF-'):
        return result
    if len(raw) > MAX_INPUT:
        return {**result, 'status': 'limit_exceeded'}
    warnings = ParserWarnings()
    logger = logging.getLogger('pypdf')
    logger.handlers = [warnings]
    logger.propagate = False
    try:
        with apply_configuration(**CONFIGURATION):
            reader = PdfReader(io.BytesIO(raw), strict=True)
            if reader.is_encrypted:
                return {**result, 'status': 'unsupported'}
            count = len(reader.pages)
            if count > 200:
                return {**result, 'status': 'limit_exceeded', 'page_count': count}
            if count < 1 or page > count:
                return {**result, 'status': 'unavailable', 'page_count': count}
            result['page_count'] = count
            text = reader.pages[page - 1].extract_text().replace('\r\n', '\n').replace('\r', '\n')
            if warnings.status:
                return {**result, 'status': warnings.status}
            if '\x00' in text or any(0xD800 <= ord(c) <= 0xDFFF for c in text):
                return result
            if len(text) > MAX_CODEPOINTS:
                return {**result, 'status': 'limit_exceeded'}
            result.update(status='extracted' if text else 'no_text', text=text)
            if len(json.dumps(result, ensure_ascii=False).encode('utf-8')) > MAX_OUTPUT:
                return {**result, 'status': 'limit_exceeded', 'text': ''}
            return result
    except LimitReachedError:
        return {**result, 'status': 'limit_exceeded', 'text': ''}
    except (DependencyError, NotImplementedError):
        return {**result, 'status': 'unsupported', 'text': ''}
    except (Exception, MemoryError):
        # Exception text may contain untrusted PDF values or private paths.
        return {**result, 'status': 'malformed', 'text': ''}


def _deny_capabilities(event: str, args: tuple) -> None:
    if (event == 'open' or event.startswith(('socket.', 'subprocess.', 'ctypes.'))
            or event in ('os.system', 'os.exec', 'os.posix_spawn', 'os.fork', 'os.forkpty',
                         'os.spawn', 'os.chdir', 'os.remove', 'os.rename', 'os.mkdir',
                         'os.rmdir', 'os.link', 'os.symlink', 'os.listdir', 'os.scandir')):
        raise PermissionError('The fixed PDF parser does not expose this capability.')


def main() -> None:
    header = sys.stdin.buffer.read(8)
    if len(header) != 8:
        raise SystemExit(2)
    page, length = struct.unpack('!II', header)
    if not 1 <= page <= 200 or not 1 <= length <= MAX_INPUT:
        raise SystemExit(2)
    raw = sys.stdin.buffer.read(length + 1)
    if len(raw) != length:
        raise SystemExit(2)
    # Dependencies are imported before restricting capabilities. No document
    # supplied path, module, command, environment or credential is accepted.
    sys.addaudithook(_deny_capabilities)
    result = parse(raw, page)
    encoded = json.dumps(result, ensure_ascii=False, separators=(',', ':')).encode('utf-8')
    if len(encoded) > MAX_OUTPUT:
        raise SystemExit(3)
    sys.stdout.buffer.write(encoded)
    sys.stdout.buffer.flush()


if __name__ == '__main__':
    main()
