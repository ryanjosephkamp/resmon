"""The downloader against a real https server on loopback, with a test authority's certificate.

Nothing here reaches the internet. The server's names (``pdf.resmon.test`` and
two more) resolve to loopback through the test-only resolver, and only those
names may: every other private address is refused exactly as in the product.
The certificate is verified against a test authority made for this file,
trusted through the test-only ``_CA_BUNDLE``, never by turning verification off.
"""
from __future__ import annotations

import socket
import time
import tracemalloc

import pytest

from implementation_scripts import fulltext_download as fd
from implementation_scripts import open_access
from verification_scripts.tls_loopback import TEST_HOSTS, LoopbackHTTPS, pdf_body

#: Names the test resolver answers, and with what. ``private.resmon.test`` is
#: a name that resolves to a private address, as a hostile redirect would.
_NAMES = {**{h: "127.0.0.1" for h in TEST_HOSTS}, "private.resmon.test": "10.0.0.7",
          "linklocal.resmon.test": "169.254.169.254", "mapped.resmon.test": "::ffff:127.0.0.1",
          "unlisted.resmon.test": "127.0.0.1"}


def _resolve(host, port, *args, **kwargs):
    address = _NAMES.get(host)
    if address is None:
        raise socket.gaierror(f"{host} is not a test name")
    family = socket.AF_INET6 if ":" in address else socket.AF_INET
    return [(family, socket.SOCK_STREAM, 6, "", (address, port))]


@pytest.fixture(scope="module")
def server(tmp_path_factory):
    srv = LoopbackHTTPS(tmp_path_factory.mktemp("tls"))
    srv.start()
    yield srv
    srv.stop()


@pytest.fixture(autouse=True)
def test_settings(server, monkeypatch):
    monkeypatch.setattr(fd, "_CA_BUNDLE", str(server.ca_path))
    monkeypatch.setattr(fd, "_LOOPBACK_TEST_HOSTS", frozenset(TEST_HOSTS))
    monkeypatch.setattr(fd, "_RESOLVE", _resolve)
    server.routes.clear()
    server.requests.clear()


def _pdf(size=4096, content_type="application/pdf"):
    body = pdf_body(size)
    return lambda _h: (200, {"Content-Type": content_type}, body)


def _redirect(location):
    return lambda _h: (302, {"Location": location, "Content-Length": "0"}, b"")


def _refused(server, url, tmp_path, **kwargs) -> fd.DownloadRefused:
    target = tmp_path / "out.pdf"
    with pytest.raises(fd.DownloadRefused) as caught:
        fd.fetch_pdf(url, target, **kwargs)
    assert not target.exists(), "a refused download left a file"
    return caught.value


def test_a_pdf_is_fetched_verified_and_written(server, tmp_path):
    server.routes["/paper.pdf"] = _pdf(10_000)
    target = tmp_path / "out.pdf"
    fetched = fd.fetch_pdf(server.url("/paper.pdf"), target)
    assert target.read_bytes() == pdf_body(10_000)
    assert (fetched.byte_size, fetched.content_type, fetched.redirects) == (10_000, "application/pdf", 0)
    assert server.requests[0]["user_agent"].startswith("resmon/1.0")
    assert server.requests[0]["host"] == f"pdf.resmon.test:{server.port}"


def test_a_redirect_to_another_public_host_is_followed_and_each_hop_is_paced(server, tmp_path):
    server.routes["/start"] = _redirect(server.url("/paper.pdf", "mirror.resmon.test"))
    server.routes["/paper.pdf"] = _pdf()
    hosts = []
    fetched = fd.fetch_pdf(server.url("/start"), tmp_path / "out.pdf", before_request=hosts.append)
    assert hosts == ["pdf.resmon.test", "mirror.resmon.test"]
    assert fetched.final_url == server.url("/paper.pdf", "mirror.resmon.test")
    assert fetched.redirects == 1


@pytest.mark.parametrize("name", ["private.resmon.test", "linklocal.resmon.test", "mapped.resmon.test",
                                  "unlisted.resmon.test"])
def test_a_redirect_to_a_private_address_is_refused_before_connecting(server, tmp_path, name):
    server.routes["/start"] = _redirect(f"https://{name}:{server.port}/paper.pdf")
    server.routes["/paper.pdf"] = _pdf()
    refused = _refused(server, server.url("/start"), tmp_path)
    assert refused.reason == "private_address"
    # The first hop was asked; the private one never was.
    assert [r["path"] for r in server.requests] == ["/start"]


@pytest.mark.parametrize("literal", ["127.0.0.1", "10.1.2.3", "[::1]", "169.254.169.254", "0.0.0.0"])
def test_an_address_written_as_a_number_is_checked_too(server, tmp_path, literal, monkeypatch):
    monkeypatch.setattr(fd, "_RESOLVE", socket.getaddrinfo)
    refused = _refused(server, f"https://{literal}:{server.port}/paper.pdf", tmp_path)
    assert refused.reason == "private_address"


def test_a_redirect_to_http_is_refused(server, tmp_path):
    server.routes["/start"] = _redirect(f"http://pdf.resmon.test:{server.port}/paper.pdf")
    assert _refused(server, server.url("/start"), tmp_path).reason == "not_https"
    assert _refused(server, f"http://pdf.resmon.test:{server.port}/paper.pdf", tmp_path).reason == "not_https"


@pytest.mark.parametrize("url", [
    "https://link.springer.com/content/pdf/10.1007/x.pdf",
    "https://bmcbioinformatics.biomedcentral.com/counter/pdf/10.1186/s12859-020-03566-9.pdf",
    "https://www.nature.com/articles/s41586-020-2649-2.pdf",
])
def test_a_redirect_onto_a_refused_providers_site_ends_the_fetch(server, tmp_path, url):
    server.routes["/start"] = _redirect(url)
    refused = _refused(server, server.url("/start"), tmp_path)
    assert refused.reason == "refused_source"
    assert refused.detail == open_access.refusal({"pdf_url": url})
    # The first hop was asked; the refused site never was.
    assert [r["path"] for r in server.requests] == ["/start"]


@pytest.mark.parametrize("url", [
    "https://bmcbioinformatics.biomedcentral.com/counter/pdf/10.1186/s12859-020-03566-9.pdf",
    "https://www.nature.com/articles/s41586-020-2649-2.pdf",
])
def test_a_refused_providers_address_is_refused_before_any_lookup(tmp_path, url, monkeypatch):
    def resolve(*_args, **_kwargs):
        raise AssertionError("a refused site's name was looked up")

    monkeypatch.setattr(fd, "_RESOLVE", resolve)
    with pytest.raises(fd.DownloadRefused) as refused:
        fd.fetch_pdf(url, tmp_path / "paper.pdf")
    assert refused.value.reason == "refused_source"
    assert "Springer Nature" in refused.value.detail
    assert not (tmp_path / "paper.pdf").exists()


def test_too_many_redirects(server, tmp_path):
    server.routes["/loop"] = _redirect("/loop")
    refused = _refused(server, server.url("/loop"), tmp_path)
    assert refused.reason == "too_many_redirects"
    assert len(server.requests) == fd.MAX_REDIRECTS + 1


def test_the_size_cap_from_content_length_before_reading(server, tmp_path):
    server.routes["/big.pdf"] = _pdf(300_000)
    refused = _refused(server, server.url("/big.pdf"), tmp_path, max_bytes=200_000)
    assert refused.reason == "too_large"


def test_the_size_cap_from_the_bytes_when_no_length_is_sent(server, tmp_path):
    def chunks(_h):
        def body():
            yield b"%PDF-1.7\n"
            for _ in range(10):
                yield b"0" * 65536
        return 200, {"Content-Type": "application/pdf"}, body()
    server.routes["/big.pdf"] = chunks
    refused = _refused(server, server.url("/big.pdf"), tmp_path, max_bytes=200_000)
    assert refused.reason == "too_large"


@pytest.mark.parametrize("content_type", ["text/html", "application/json", "image/png", ""])
def test_a_wrong_content_type_is_refused(server, tmp_path, content_type):
    server.routes["/page"] = lambda _h: (200, {"Content-Type": content_type} if content_type else {},
                                         pdf_body(1000))
    assert _refused(server, server.url("/page"), tmp_path).reason == "wrong_type"


def test_a_body_that_is_not_a_pdf_is_refused(server, tmp_path):
    server.routes["/fake.pdf"] = lambda _h: (200, {"Content-Type": "application/pdf"},
                                             b"<!doctype html><title>Sign in</title>")
    assert _refused(server, server.url("/fake.pdf"), tmp_path).reason == "not_pdf"


def test_an_undifferentiated_binary_is_kept_only_when_it_is_a_pdf(server, tmp_path):
    server.routes["/blob"] = _pdf(2000, "application/octet-stream")
    assert fd.fetch_pdf(server.url("/blob"), tmp_path / "ok.pdf").byte_size == 2000
    server.routes["/blob"] = lambda _h: (200, {"Content-Type": "application/octet-stream"}, b"PK\x03\x04zip")
    assert _refused(server, server.url("/blob"), tmp_path).reason == "not_pdf"


def test_an_error_status_is_refused_with_it(server, tmp_path):
    server.routes["/gone"] = lambda _h: (403, {"Content-Type": "text/html"}, b"forbidden")
    refused = _refused(server, server.url("/gone"), tmp_path)
    assert refused.reason == "site_refused" and "403" in refused.detail


@pytest.mark.parametrize("status", [401, 403, 429])
def test_a_site_refusal_is_plain_and_is_not_retried(server, tmp_path, status):
    server.routes["/refused.pdf"] = lambda _h: (status, {"Content-Type": "text/plain"}, b"refused")
    refused = _refused(server, server.url("/refused.pdf"), tmp_path)
    assert refused.reason == "site_refused"
    assert "refused a download from resmon" in refused.detail
    assert f"HTTP {status}" in refused.detail
    assert len(server.requests) == 1
    assert server.requests[0]["user_agent"].startswith("resmon/")


def test_verification_is_never_off(server, tmp_path, monkeypatch):
    # Without the test authority, the test certificate is not trusted.
    monkeypatch.setattr(fd, "_CA_BUNDLE", None)
    server.routes["/paper.pdf"] = _pdf()
    assert _refused(server, server.url("/paper.pdf"), tmp_path).reason == "tls_failed"


def test_a_name_the_certificate_does_not_carry_is_refused(server, tmp_path, monkeypatch):
    monkeypatch.setattr(fd, "_LOOPBACK_TEST_HOSTS", frozenset({*TEST_HOSTS, "unlisted.resmon.test"}))
    server.routes["/paper.pdf"] = _pdf()
    refused = _refused(server, server.url("/paper.pdf", "unlisted.resmon.test"), tmp_path)
    assert refused.reason == "tls_failed"


def test_an_address_with_credentials_or_no_host_is_refused(server, tmp_path):
    assert _refused(server, f"https://user:pw@pdf.resmon.test:{server.port}/x.pdf", tmp_path).reason == "bad_address"
    assert _refused(server, "https:///x.pdf", tmp_path).reason == "bad_address"


def test_a_server_that_stops_sending_times_out(server, tmp_path, monkeypatch):
    monkeypatch.setattr(fd, "READ_TIMEOUT_SECONDS", 0.5)
    def stalls(_h):
        def body():
            yield b"%PDF-1.7\n"
            time.sleep(2)
            yield b"late"
        return 200, {"Content-Type": "application/pdf"}, body()
    server.routes["/slow.pdf"] = stalls
    assert _refused(server, server.url("/slow.pdf"), tmp_path).reason == "timed_out"


def test_a_large_pdf_streams_to_disk_without_being_held_in_memory(server, tmp_path):
    """The memory and the time a 48 MB download takes, against loopback (B8's rule)."""
    size = 48 * 1024 * 1024
    chunk = b"0" * 65536

    def large(_h):
        def body():
            yield b"%PDF-1.7\n"
            sent = 9
            while sent < size:
                part = chunk[: min(len(chunk), size - sent)]
                sent += len(part)
                yield part
        return 200, {"Content-Type": "application/pdf", "Content-Length": str(size)}, body()

    server.routes["/large.pdf"] = large
    target = tmp_path / "large.pdf"
    tracemalloc.start()
    started = time.perf_counter()
    try:
        fetched = fd.fetch_pdf(server.url("/large.pdf"), target)
        elapsed = time.perf_counter() - started
        _current, peak = tracemalloc.get_traced_memory()
    finally:
        tracemalloc.stop()
    assert fetched.byte_size == size == target.stat().st_size
    print(f"MEASURE download 48 MiB over loopback: {elapsed:.2f} s, "
          f"peak Python allocation {peak / 1024:.0f} KiB")
    # The whole body would be 48 MiB; the chunked read holds a few chunks.
    assert peak < 4 * 1024 * 1024
