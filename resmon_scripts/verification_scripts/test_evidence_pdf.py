"""Authored synthetic PDF fixtures and real fixed-child boundary tests."""
from __future__ import annotations

import io
import zlib

MIB = 1024 * 1024
ALPHA = "Alpha evidence — exact version."
BETA = "Beta evidence stays separate."
CANARY_ORIGIN = "https://pdf-action-canary.invalid"


def _integer(value: int, minimum: int, maximum: int, name: str) -> int:
    if type(value) is not int or not minimum <= value <= maximum:
        raise ValueError(f"{name} must be an exact int in [{minimum}, {maximum}]")
    return value


def _literal(raw: bytes) -> bytes:
    """PDF literal string; high/control octets use three-digit octal escapes."""
    parts = [b"("]
    for byte in raw:
        if byte in (ord("("), ord(")"), ord("\\")):
            parts.append(b"\\" + bytes((byte,)))
        elif 32 <= byte <= 126:
            parts.append(bytes((byte,)))
        else:
            parts.append(f"\\{byte:03o}".encode("ascii"))
    parts.append(b")")
    return b"".join(parts)


def _ref(object_id: int) -> bytes:
    return f"{object_id} 0 R".encode("ascii")


def _stream(data: bytes, dictionary: bytes = b"", *, declared_length: int | None = None) -> bytes:
    length = len(data) if declared_length is None else declared_length
    return (
        b"<< /Length " + str(length).encode("ascii") + b" " + dictionary
        + b" >>\nstream\n" + data + b"\nendstream"
    )


class _Pdf:
    """Small PDF 1.7 writer with exact offsets and conventional xref table."""

    def __init__(self) -> None:
        self.objects: list[bytes | None] = []

    def reserve(self) -> int:
        self.objects.append(None)
        return len(self.objects)

    def set(self, number: int, data: bytes) -> None:
        if not 1 <= number <= len(self.objects) or self.objects[number - 1] is not None:
            raise ValueError("Object is absent or already assigned")
        self.objects[number - 1] = data

    def add(self, data: bytes) -> int:
        number = self.reserve()
        self.set(number, data)
        return number

    def render(self, root: int) -> bytes:
        if any(value is None for value in self.objects):
            raise ValueError("Unassigned PDF object")
        body = bytearray(b"%PDF-1.7\n%\xe2\xe3\xcf\xd3\n")
        offsets = [0]
        for number, value in enumerate(self.objects, 1):
            assert value is not None
            offsets.append(len(body))
            body.extend(f"{number} 0 obj\n".encode("ascii"))
            body.extend(value)
            body.extend(b"\nendobj\n")
        xref = len(body)
        body.extend(f"xref\n0 {len(offsets)}\n".encode("ascii"))
        body.extend(b"0000000000 65535 f \n")
        for offset in offsets[1:]:
            body.extend(f"{offset:010d} 00000 n \n".encode("ascii"))
        body.extend(
            b"trailer\n<< /Size " + str(len(offsets)).encode("ascii")
            + b" /Root " + _ref(root) + b" >>\nstartxref\n"
            + str(xref).encode("ascii") + b"\n%%EOF\n"
        )
        return bytes(body)


def _font(pdf: _Pdf) -> int:
    return pdf.add(b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>")


def _text_operators(text: str) -> bytes:
    # U+2014 encodes as WinAnsi/Windows-1252 byte 0x97, written as PDF \227.
    return b"BT /F1 12 Tf 72 720 Td " + _literal(text.encode("cp1252")) + b" Tj ET\n"


def _page_dictionary(parent: int, content: int, resources: bytes, extra: bytes = b"") -> bytes:
    return (
        b"<< /Type /Page /Parent " + _ref(parent)
        + b" /MediaBox [0 0 612 792] /Resources << " + resources
        + b" >> /Contents " + _ref(content) + b" " + extra + b" >>"
    )


def _pages(pdf: _Pdf, root: int, children: list[int], count: int | None = None) -> None:
    physical = len(children) if count is None else count
    pdf.set(root, b"<< /Type /Pages /Count " + str(physical).encode("ascii")
            + b" /Kids [" + b" ".join(map(_ref, children)) + b"] >>")


def text_pages(texts: list[str]) -> bytes:
    _integer(len(texts), 1, 2100, "page count")
    pdf = _Pdf()
    catalog, pages = pdf.reserve(), pdf.reserve()
    font = _font(pdf)
    leaves = []
    for text in texts:
        content = pdf.add(_stream(_text_operators(text)))
        leaves.append(pdf.add(_page_dictionary(pages, content, b"/Font << /F1 " + _ref(font) + b" >>")))
    _pages(pdf, pages, leaves)
    pdf.set(catalog, b"<< /Type /Catalog /Pages " + _ref(pages) + b" >>")
    return pdf.render(catalog)


def two_pages() -> bytes:
    """E06: expected exact canonical strings ALPHA and BETA, one per page."""
    return text_pages([ALPHA, BETA])


def blank_page() -> bytes:
    """E07: no text operators and no visual content; no content absence claim."""
    pdf = _Pdf()
    catalog, pages = pdf.reserve(), pdf.reserve()
    content = pdf.add(_stream(b"q Q\n"))
    leaf = pdf.add(_page_dictionary(pages, content, b""))
    _pages(pdf, pages, [leaf])
    pdf.set(catalog, b"<< /Type /Catalog /Pages " + _ref(pages) + b" >>")
    return pdf.render(catalog)


def drawn_chart() -> bytes:
    """E07: a vector chart with visible pixels but no text operators."""
    pdf = _Pdf()
    catalog, pages = pdf.reserve(), pdf.reserve()
    operations = (
        b"q\n0.15 0.25 0.35 RG 2 w 72 100 m 72 400 l S 72 100 m 500 100 l S\n"
        b"0.2 0.55 0.75 rg 110 100 60 120 re f 230 100 60 220 re f 350 100 60 160 re f\nQ\n"
    )
    content = pdf.add(_stream(operations))
    leaf = pdf.add(_page_dictionary(pages, content, b""))
    _pages(pdf, pages, [leaf])
    pdf.set(catalog, b"<< /Type /Catalog /Pages " + _ref(pages) + b" >>")
    return pdf.render(catalog)


def image_only_chart() -> bytes:
    """E07 distinct arm: authored 24x16 RGB raster bars, no image dependency."""
    width, height = 24, 16
    pixels = bytearray()
    for y in range(height):
        for x in range(width):
            axis = x == 1 or y == height - 2
            bar = ((4 <= x <= 7 and 8 <= y < 14)
                   or (11 <= x <= 14 and 3 <= y < 14)
                   or (18 <= x <= 21 and 6 <= y < 14))
            pixels.extend((35, 50, 60) if axis else (40, 135, 185) if bar else (255, 255, 255))
    pdf = _Pdf()
    catalog, pages = pdf.reserve(), pdf.reserve()
    image = pdf.add(_stream(bytes(pixels), b"/Type /XObject /Subtype /Image /Width 24 /Height 16 /ColorSpace /DeviceRGB /BitsPerComponent 8"))
    content = pdf.add(_stream(b"q 384 0 0 256 72 200 cm /Im0 Do Q\n"))
    leaf = pdf.add(_page_dictionary(pages, content, b"/XObject << /Im0 " + _ref(image) + b" >>"))
    _pages(pdf, pages, [leaf])
    pdf.set(catalog, b"<< /Type /Catalog /Pages " + _ref(pages) + b" >>")
    return pdf.render(catalog)


def malformed_xref() -> bytes:
    """E08: invalid noninteger startxref token; preserve actual refusal reason."""
    good = two_pages()
    prefix, _ = good.rsplit(b"startxref\n", 1)
    return prefix + b"startxref\nnot-an-offset\n%%EOF\n"


def malformed_stream() -> bytes:
    """E08: a content object declares a Flate filter over invalid zlib bytes."""
    pdf = _Pdf()
    catalog, pages = pdf.reserve(), pdf.reserve()
    font = _font(pdf)
    content = pdf.add(_stream(b"this-is-not-a-zlib-stream", b"/Filter /FlateDecode"))
    leaf = pdf.add(_page_dictionary(pages, content, b"/Font << /F1 " + _ref(font) + b" >>"))
    _pages(pdf, pages, [leaf])
    pdf.set(catalog, b"<< /Type /Catalog /Pages " + _ref(pages) + b" >>")
    return pdf.render(catalog)


def over_page_limit(count: int = 201) -> bytes:
    _integer(count, 201, 2100, "count")
    return text_pages(["Synthetic page count fixture."] * count)


def deep_page_tree(depth: int = 34) -> bytes:
    """E09: depth is number of edges from Pages root to the one leaf page."""
    _integer(depth, 1, 64, "depth")
    pdf = _Pdf()
    catalog = pdf.reserve()
    branches = [pdf.reserve() for _ in range(depth)]
    font = _font(pdf)
    content = pdf.add(_stream(_text_operators("Deep tree fixture.")))
    leaf = pdf.add(_page_dictionary(branches[-1], content, b"/Font << /F1 " + _ref(font) + b" >>"))
    for index, branch in enumerate(branches):
        child = branches[index + 1] if index + 1 < len(branches) else leaf
        parent = b"" if index == 0 else b" /Parent " + _ref(branches[index - 1])
        pdf.set(branch, b"<< /Type /Pages /Count 1 /Kids [" + _ref(child) + b"]" + parent + b" >>")
    pdf.set(catalog, b"<< /Type /Catalog /Pages " + _ref(branches[0]) + b" >>")
    return pdf.render(catalog)


def cyclic_page_tree() -> bytes:
    """E09: Pages root directly names itself as its own child."""
    pdf = _Pdf()
    catalog, pages = pdf.reserve(), pdf.reserve()
    pdf.set(pages, b"<< /Type /Pages /Count 1 /Kids [" + _ref(pages) + b"] >>")
    pdf.set(catalog, b"<< /Type /Catalog /Pages " + _ref(pages) + b" >>")
    return pdf.render(catalog)


def page_tree_entry_limit(empty_branches: int = 2000) -> bytes:
    """E09: empty Pages branches + one real page; distinguishes entry/page caps.

    Default has 2,001 child entries (root excluded) but only one physical page.
    Empty branches are synthetically authored; confirm actual pinned parser path.
    """
    _integer(empty_branches, 1, 2100, "empty_branches")
    pdf = _Pdf()
    catalog, pages = pdf.reserve(), pdf.reserve()
    children = [pdf.add(b"<< /Type /Pages /Parent " + _ref(pages) + b" /Count 0 /Kids [] >>")
                for _ in range(empty_branches)]
    font = _font(pdf)
    content = pdf.add(_stream(_text_operators("Entry limit fixture.")))
    children.append(pdf.add(_page_dictionary(pages, content, b"/Font << /F1 " + _ref(font) + b" >>")))
    _pages(pdf, pages, children, count=1)
    pdf.set(catalog, b"<< /Type /Catalog /Pages " + _ref(pages) + b" >>")
    return pdf.render(catalog)


def _compressed_spaces(decoded_bytes: int) -> bytes:
    _integer(decoded_bytes, 1, 16 * MIB + 1, "decoded_bytes")
    compressor = zlib.compressobj(level=9)
    chunks = []
    remaining = decoded_bytes
    while remaining:
        size = min(remaining, 65536)
        chunks.append(compressor.compress(b" " * size))
        remaining -= size
    chunks.append(compressor.flush())
    return b"".join(chunks)


def expansion_pdf(decoded_bytes: int = 8 * MIB + 1, *, nested_form: bool = False) -> bytes:
    """E09: compressed whitespace expands over the frozen stream cap.

    nested_form=True exercises pypdf's catch-and-warn XForm path; app must reject
    degraded output rather than return the root page's otherwise valid text.
    """
    data = _compressed_spaces(decoded_bytes)
    pdf = _Pdf()
    catalog, pages = pdf.reserve(), pdf.reserve()
    font = _font(pdf)
    resources = b"/Font << /F1 " + _ref(font) + b" >>"
    if nested_form:
        form = pdf.add(_stream(data, b"/Type /XObject /Subtype /Form /BBox [0 0 612 792] /Resources << "
                               + resources + b" >> /Filter /FlateDecode"))
        resources += b" /XObject << /Fm0 " + _ref(form) + b" >>"
        content = pdf.add(_stream(_text_operators("Root text must not become an accepted partial result.") + b"/Fm0 Do\n"))
    else:
        content = pdf.add(_stream(data, b"/Filter /FlateDecode"))
    leaf = pdf.add(_page_dictionary(pages, content, resources))
    _pages(pdf, pages, [leaf])
    pdf.set(catalog, b"<< /Type /Catalog /Pages " + _ref(pages) + b" >>")
    return pdf.render(catalog)


def form_invocations(count: int = 101, *, cycle: bool = False) -> bytes:
    """E09: repeated single form counts invocations, not unique form objects."""
    _integer(count, 1, 200, "count")
    pdf = _Pdf()
    catalog, pages, form = pdf.reserve(), pdf.reserve(), pdf.reserve()
    font = _font(pdf)
    font_resources = b"/Font << /F1 " + _ref(font) + b" >>"
    form_resources = font_resources + (b" /XObject << /Fm0 " + _ref(form) + b" >>" if cycle else b"")
    form_operations = _text_operators("Synthetic form evidence.") + (b"/Fm0 Do\n" if cycle else b"")
    pdf.set(form, _stream(form_operations, b"/Type /XObject /Subtype /Form /BBox [0 0 612 792] /Resources << "
                          + form_resources + b" >>"))
    resources = font_resources + b" /XObject << /Fm0 " + _ref(form) + b" >>"
    content = pdf.add(_stream(_text_operators("Root evidence.") + b"/Fm0 Do\n" * count))
    leaf = pdf.add(_page_dictionary(pages, content, resources))
    _pages(pdf, pages, [leaf])
    pdf.set(catalog, b"<< /Type /Catalog /Pages " + _ref(pages) + b" >>")
    return pdf.render(catalog)


def overlong_text(codepoints: int = 200001) -> bytes:
    _integer(codepoints, 200001, 300000, "codepoints")
    return text_pages(["X" * codepoints])


def oversized_input(payload_bytes: int = 16 * MIB + 1) -> bytes:
    """E08: valid envelope with a large unreferenced stream; input guard first."""
    _integer(payload_bytes, 16 * MIB + 1, 17 * MIB, "payload_bytes")
    pdf = _Pdf()
    catalog, pages = pdf.reserve(), pdf.reserve()
    font = _font(pdf)
    content = pdf.add(_stream(_text_operators("Input size fixture.")))
    leaf = pdf.add(_page_dictionary(pages, content, b"/Font << /F1 " + _ref(font) + b" >>"))
    pdf.add(_stream(b"x" * payload_bytes))
    _pages(pdf, pages, [leaf])
    pdf.set(catalog, b"<< /Type /Catalog /Pages " + _ref(pages) + b" >>")
    return pdf.render(catalog)


def action_canaries() -> bytes:
    """E20: static canaries only; run with pretransport navigation cancellation.

    Includes link URI, catalog OpenAction JS, field additional-action URI,
    AcroForm/XFA packets, and an inert embedded text attachment. No real host,
    user path, credentials, live document, executable attachment or launch action.
    """
    pdf = _Pdf()
    catalog, pages, leaf = pdf.reserve(), pdf.reserve(), pdf.reserve()
    font = _font(pdf)
    resources = b"/Font << /F1 " + _ref(font) + b" >>"
    content = pdf.add(_stream(_text_operators("Synthetic action canaries. Canvas and canonical text only.")))
    uri = pdf.add(b"<< /Type /Action /S /URI /URI " + _literal((CANARY_ORIGIN + "/link").encode("ascii")) + b" >>")
    javascript = pdf.add(b"<< /Type /Action /S /JavaScript /JS "
                         + _literal(("app.alert('EVIDENCE_JS_CANARY');").encode("ascii")) + b" >>")
    link = pdf.add(b"<< /Type /Annot /Subtype /Link /Rect [72 690 460 735] /Border [0 0 1] /A " + _ref(uri) + b" >>")
    widget = pdf.add(b"<< /Type /Annot /Subtype /Widget /FT /Tx /T (EVIDENCE_FORM_CANARY) /V (literal fixture value)"
                     b" /Rect [72 620 380 650] /P " + _ref(leaf)
                     + b" /DA (/F1 12 Tf 0 g) /AA << /Fo " + _ref(uri) + b" >> >>")
    template_xml = (
        b'<?xml version="1.0"?><template xmlns="http://www.xfa.org/schema/xfa-template/3.3/">'
        b'<subform name="EVIDENCE_XFA_CANARY"><field name="value"><value><text>literal XFA canary</text>'
        b'</value></field></subform></template>'
    )
    datasets_xml = (b'<?xml version="1.0"?><xfa:datasets xmlns:xfa="http://www.xfa.org/schema/xfa-data/1.0/">'
                    b'<xfa:data><value>EVIDENCE_XFA_DATA_CANARY</value></xfa:data></xfa:datasets>')
    template = pdf.add(_stream(template_xml))
    datasets = pdf.add(_stream(datasets_xml))
    acroform = pdf.add(b"<< /Fields [" + _ref(widget) + b"] /NeedAppearances true /DR << " + resources
                       + b" >> /DA (/F1 12 Tf 0 g) /XFA [(template) " + _ref(template)
                       + b" (datasets) " + _ref(datasets) + b"] >>")
    attachment = pdf.add(_stream(b"EVIDENCE_ATTACHMENT_CANARY\n", b"/Type /EmbeddedFile /Subtype /text#2Fplain"))
    filespec = pdf.add(b"<< /Type /Filespec /F (canary.txt) /UF (canary.txt) /Desc (Synthetic inert text attachment)"
                      b" /EF << /F " + _ref(attachment) + b" >> >>")
    file_annotation = pdf.add(b"<< /Type /Annot /Subtype /FileAttachment /Rect [480 700 500 720]"
                             b" /Contents (EVIDENCE_ATTACHMENT_CANARY) /FS " + _ref(filespec) + b" >>")
    pdf.set(leaf, _page_dictionary(pages, content, resources,
                                  b"/Annots [" + b" ".join(map(_ref, [link, widget, file_annotation])) + b"]"))
    _pages(pdf, pages, [leaf])
    pdf.set(catalog, b"<< /Type /Catalog /Pages " + _ref(pages)
            + b" /OpenAction " + _ref(javascript) + b" /AcroForm " + _ref(acroform)
            + b" /Names << /EmbeddedFiles << /Names [(canary.txt) " + _ref(filespec) + b"] >> >> >>")
    return pdf.render(catalog)


def encrypted_pdf(*, empty_user_password: bool = False) -> bytes:
    """DRAFT ONLY: run later inside the approved disposable pypdf environment.

    RC4-40 is solely an encryption-refusal fixture, not a protection recommendation.
    The literal passwords are synthetic fixture constants, never user credentials.
    There is no encryption/dependency operation until this function is called.
    """
    from pypdf import PdfReader, PdfWriter

    reader = PdfReader(io.BytesIO(two_pages()), strict=True)
    writer = PdfWriter()
    try:
        for page in reader.pages:
            writer.add_page(page)
        writer.encrypt(
            user_password="" if empty_user_password else "synthetic-user-password",
            owner_password="synthetic-owner-password",
            algorithm="RC4-40",
        )
        output = io.BytesIO()
        writer.write(output)
        return output.getvalue()
    finally:
        reader.close()
        writer.close()

# Actual parent/child tests. Synthetic hang/crash arms do not stand for parser bugs.
import json
import os
from pathlib import Path
import threading
import time

import pytest

from implementation_scripts import evidence_pdf as supervisor, evidence


def assert_reaped() -> None:
    run = dict(supervisor.LAST_RUN)
    assert run['pid'] > 0 and run['launched_at']
    assert run['reaped'] and run['pipe_threads_stopped'] and run['scratch_removed']
    assert not Path(run['scratch']).exists()
    with pytest.raises(ProcessLookupError):
        os.kill(run['pid'], 0)


def test_real_two_page_text_and_parser_identity() -> None:
    for page, expected in [(1, ALPHA), (2, BETA)]:
        result = supervisor.extract(two_pages(), page)
        assert result == {'status':'extracted', 'page_number':page, 'page_count':2, 'text':expected}
        assert_reaped()
    from implementation_scripts import evidence_pdf_worker as worker
    assert worker.CONFIGURATION['page_tree_maximum_entries'] == 1999
    assert worker.CONFIGURATION['xform_maximum_invocations_per_extraction'] == 100
    assert worker.CONFIGURATION['zlib_maximum_output_length'] == 8 * MIB
    assert worker.CONFIGURATION['jbig2dec_binary'] is None
    assert supervisor.TIMEOUT_SECONDS == 20 and supervisor.MAX_OUTPUT == MIB


@pytest.mark.parametrize('constructor', [blank_page, drawn_chart, image_only_chart])
def test_actual_pages_without_text_are_not_claimed_empty(constructor) -> None:
    result = supervisor.extract(constructor(), 1)
    assert result == {'status':'no_text', 'page_number':1, 'page_count':1, 'text':''}
    assert_reaped()


@pytest.mark.parametrize('empty_password', [False, True])
def test_encrypted_documents_refuse_without_password_collection(empty_password: bool) -> None:
    result = supervisor.extract(encrypted_pdf(empty_user_password=empty_password), 1)
    assert result['status'] == 'unsupported' and result['text'] == ''
    assert_reaped()


@pytest.mark.parametrize('constructor,allowed', [
    (malformed_xref, {'malformed'}), (malformed_stream, {'malformed'}),
    (over_page_limit, {'limit_exceeded'}), (deep_page_tree, {'limit_exceeded'}),
    (cyclic_page_tree, {'malformed', 'limit_exceeded'}),
    (page_tree_entry_limit, {'limit_exceeded'}),
    (expansion_pdf, {'limit_exceeded'}),
    (lambda: expansion_pdf(nested_form=True), {'limit_exceeded', 'malformed'}),
    (form_invocations, {'limit_exceeded'}),
    (lambda: form_invocations(1, cycle=True), {'malformed'}),
    (overlong_text, {'limit_exceeded'}),
])
def test_real_parser_rejects_malformed_expansion_tree_form_and_text_limits(constructor, allowed) -> None:
    result = supervisor.extract(constructor(), 1)
    assert result['status'] in allowed and result['text'] == ''
    assert_reaped()


def test_same_fixture_small_arms_parse_before_resource_rejections() -> None:
    for data, status in [(deep_page_tree(4),'extracted'),(page_tree_entry_limit(3),'extracted'),
                         (expansion_pdf(1024),'no_text'),(form_invocations(1),'extracted')]:
        assert supervisor.extract(data,1)['status'] == status
        assert_reaped()


@pytest.mark.parametrize('page', [True, 1.0, '1', 0, -1, 201])
def test_invalid_pages_never_start_a_child(page) -> None:
    before = dict(supervisor.LAST_RUN)
    with pytest.raises(evidence.EvidenceError):
        supervisor.extract(two_pages(),page)
    assert supervisor.LAST_RUN == before


def test_input_limit_refuses_before_spawn() -> None:
    before = dict(supervisor.LAST_RUN)
    with pytest.raises(evidence.EvidenceError) as error:
        supervisor.extract(oversized_input(),1)
    assert error.value.status == 413 and supervisor.LAST_RUN == before


@pytest.mark.parametrize('arm', ['hang','crash','stdout','stderr','bad_json','duplicate_json','deep_json'])
def test_owned_fixed_worker_failure_is_bounded_and_reaped(tmp_path,monkeypatch,arm: str) -> None:
    worker = tmp_path/'authored-worker.py'
    scripts = {
        'hang':'import time\ntime.sleep(60)\n',
        'crash':'raise SystemExit(7)\n',
        'stdout':'import sys\nsys.stdout.write("x"*1048580)\nsys.stdout.flush()\n',
        'stderr':'import sys\nsys.stderr.write("x"*4100)\nsys.stderr.flush()\n',
        'bad_json':'print("not-json")\n',
        'duplicate_json':'print(\'{"status":"no_text","status":"extracted"}\')\n',
        'deep_json':'print("["*2000+"0"+"]"*2000)\n',
    }
    worker.write_text(scripts[arm])
    with monkeypatch.context() as patch:
        patch.setattr(supervisor,'_WORKER',worker)
        if arm == 'hang':patch.setattr(supervisor,'TIMEOUT_SECONDS',0.25)
        start=time.monotonic();result=supervisor.extract(two_pages(),1)
        assert time.monotonic()-start < 4
        assert result['status'] == ('timeout' if arm=='hang' else 'limit_exceeded' if arm in ('stdout','stderr') else 'unavailable' if arm=='crash' else 'malformed')
        assert_reaped()
        assert supervisor.LAST_RUN['stdout_bytes']<=supervisor.MAX_OUTPUT+1
        assert supervisor.LAST_RUN['stderr_bytes']<=supervisor.MAX_STDERR+1
    assert supervisor.extract(two_pages(),1)['text']==ALPHA
    assert_reaped()


def test_cancel_terminates_only_the_owned_child_and_releases_lease(tmp_path,monkeypatch) -> None:
    worker=tmp_path/'hang.py';worker.write_text('import time\ntime.sleep(60)\n');cancel=threading.Event()
    timer=threading.Timer(.2,cancel.set)
    with monkeypatch.context() as patch:
        patch.setattr(supervisor,'_WORKER',worker);timer.start()
        try:result=supervisor.extract(two_pages(),1,cancel=cancel)
        finally:timer.join()
        assert result['status']=='unavailable'
        assert supervisor.LAST_RUN['status']=='cancelled';assert_reaped()
    assert supervisor.extract(two_pages(),2)['text']==BETA


def test_second_request_is_busy_without_another_process() -> None:
    assert supervisor._LEASE.acquire(blocking=False)
    try:
        with pytest.raises(evidence.EvidenceError,match='Another bounded PDF'):
            supervisor.extract(two_pages(),1)
    finally:supervisor._LEASE.release()


@pytest.mark.parametrize('arm', ['spawn', 'first_thread', 'third_thread'])
def test_startup_resource_failure_refuses_and_restores_owned_runtime(monkeypatch, arm) -> None:
    with monkeypatch.context() as patch:
        if arm == 'spawn':
            def fail_spawn(*args, **kwargs):
                raise BlockingIOError(35, 'Resource temporarily unavailable')
            patch.setattr(supervisor.subprocess, 'Popen', fail_spawn)
        else:
            original_start = threading.Thread.start
            starts = 0
            def fail_thread_start(thread):
                nonlocal starts
                starts += 1
                if starts == (1 if arm == 'first_thread' else 3):
                    raise RuntimeError("can't start new thread")
                return original_start(thread)
            patch.setattr(threading.Thread, 'start', fail_thread_start)
        assert supervisor.extract(two_pages(), 1) == {
            'status': 'unavailable', 'page_number': 1, 'page_count': None, 'text': ''}
        assert supervisor.LAST_RUN['status'] == 'unavailable'
        assert supervisor.LAST_RUN['scratch_removed']
        if arm == 'spawn':
            assert supervisor.LAST_RUN['pid'] is None
        else:
            assert_reaped()
    assert supervisor.extract(two_pages(), 2)['text'] == BETA
    assert_reaped()


@pytest.mark.parametrize('bad', [
    {'status':'extracted','page_number':True,'page_count':2,'text':'x'},
    {'status':'extracted','page_number':2,'page_count':2,'text':'x'},
    {'status':'no_text','page_number':1,'page_count':None,'text':''},
    {'status':'extracted','page_number':1,'page_count':2,'text':''},
    {'status':'malformed','page_number':1,'page_count':2,'text':'unsafe partial'},
])
def test_parent_checks_child_semantics(bad) -> None:
    with pytest.raises(ValueError):supervisor.validate_output(json.dumps(bad).encode(),1)


def test_action_fixture_contains_canaries_but_text_extraction_runs_no_actions() -> None:
    raw=action_canaries()
    for token in (b'/URI',b'/JavaScript',b'/OpenAction',b'/AcroForm',b'/XFA',b'/EmbeddedFiles',b'/FileAttachment'):
        assert token in raw
    result=supervisor.extract(raw,1)
    assert result['status']=='extracted' and result['text']=='Synthetic action canaries. Canvas and canonical text only.'
    assert_reaped()
