"""One PDF fetched over https, every hop checked, streamed to a file.

This is the only code in resmon that fetches a file a source pointed at, so it
holds the rules a fetch from an address someone else chose needs:

* **https only**, on the first address and on every redirect.
* **Every hop's host is resolved here and every address it resolves to is
  checked**: a private, loopback, link-local, multicast, reserved or otherwise
  non-public address is refused before any connection is made, and so is an
  IPv6 address that carries one inside it (IPv4-mapped, 6to4, NAT64). The
  connection is then made to the address that was checked, with the
  certificate verified against the host's name, so a name that resolves
  differently a moment later cannot send the request somewhere else.
* **Refused providers stay refused through a redirect**: a hop onto NASA ADS's,
  Springer's, CORE's, BMC's, or nature.com's site ends the fetch
  (``open_access.REFUSED_HOSTS``).
* **A size limit**, from ``Content-Length`` before reading and from the bytes
  as they arrive, and **a type check**: the reply must say it is a PDF (or an
  undifferentiated binary) and its first bytes must be ``%PDF-``.
* **Streamed to disk**: the body is read a chunk at a time into a new file, and
  never held whole in memory. A fetch that fails leaves no file.

What this module does not decide: whether a copy may be downloaded at all (its
license, ``open_access``), how often a host is asked and how many fetches run
at once (``full_text``), and where the file is kept (the Library's own import).
Nothing here opens or parses a PDF; it reads five bytes to check the header.
"""
from __future__ import annotations

import hashlib
import http.client
import ipaddress
import os
import socket
import ssl
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Callable
from urllib.parse import urljoin, urlsplit

from . import config, open_access

#: The most a PDF may be: the Library's own limit, so every file fetched is one
#: the Library keeps and every reader of it opens.
MAX_BYTES = 64 * 1024 * 1024
MAX_REDIRECTS = 5
CONNECT_TIMEOUT_SECONDS = 15.0
#: How long one read may wait for the next bytes.
READ_TIMEOUT_SECONDS = 30.0
#: How long one fetch may take in all, redirects included.
FETCH_DEADLINE_SECONDS = 180.0
CHUNK_BYTES = 64 * 1024
#: The types a reply may say a PDF is. An undifferentiated binary is accepted
#: because some repositories serve their PDFs that way; the ``%PDF-`` check
#: decides either way.
PDF_TYPES = frozenset({"application/pdf", "application/x-pdf",
                       "application/octet-stream", "binary/octet-stream"})
_REDIRECTS = frozenset({301, 302, 303, 307, 308})

#: Test-only settings. Product code never sets them. A test that stands up an
#: https server on loopback points ``_CA_BUNDLE`` at its own certificate
#: authority, names its server's host in ``_LOOPBACK_TEST_HOSTS`` (that exact
#: name, and only it, may resolve to loopback), and replaces ``_RESOLVE`` to
#: answer that name. Verification is never turned off: the test's certificate
#: is checked against the test's authority, as a real one is against certifi's.
_CA_BUNDLE: str | None = None
_LOOPBACK_TEST_HOSTS: frozenset[str] = frozenset()
_RESOLVE: Callable[..., list] = socket.getaddrinfo


class DownloadRefused(Exception):
    """A fetch that did not produce a PDF, with the reason as a word and a sentence."""

    def __init__(self, reason: str, detail: str):
        super().__init__(detail)
        self.reason = reason
        self.detail = detail


@dataclass(frozen=True)
class Fetched:
    final_url: str
    content_type: str
    byte_size: int
    sha256: str
    redirects: int


def _ssl_context() -> ssl.SSLContext:
    if _CA_BUNDLE:
        context = ssl.create_default_context(cafile=_CA_BUNDLE)
    else:
        import certifi  # noqa: PLC0415 - httpx's own bundle, already installed

        context = ssl.create_default_context(cafile=certifi.where())
    context.minimum_version = ssl.TLSVersion.TLSv1_2
    return context


_NAT64 = ipaddress.ip_network("64:ff9b::/96")


def public_address(address: str) -> bool:
    """Whether *address* is one a fetch may connect to: globally routable, and nothing inside it is not."""
    try:
        ip = ipaddress.ip_address(address.split("%", 1)[0])
    except ValueError:
        return False
    if isinstance(ip, ipaddress.IPv6Address):
        if ip.ipv4_mapped is not None:
            return public_address(str(ip.ipv4_mapped))
        if ip.sixtofour is not None:
            return public_address(str(ip.sixtofour))
        if ip.teredo is not None:
            return False
        if ip in _NAT64:
            return public_address(str(ipaddress.IPv4Address(int(ip) & 0xFFFFFFFF)))
    return (ip.is_global and not ip.is_multicast and not ip.is_reserved
            and not ip.is_loopback and not ip.is_link_local and not ip.is_private
            and not ip.is_unspecified)


def _checked_target(url: str) -> tuple[str, int, str, str]:
    """``(host, port, address, path)`` for *url*, or refused with the reason."""
    try:
        parts = urlsplit(url)
        port = parts.port or 443
    except ValueError:
        raise DownloadRefused("bad_address", f"The address {url[:200]} could not be read.") from None
    if parts.scheme.lower() != "https":
        raise DownloadRefused("not_https", f"resmon fetches over https only, and {url[:200]} is not.")
    host = (parts.hostname or "").lower()
    if not host or parts.username is not None or parts.password is not None:
        raise DownloadRefused("bad_address", f"The address {url[:200]} has no usable host.")
    provider = open_access.refused_by_host(url)
    if provider:
        raise DownloadRefused("refused_source", open_access.refused_why(provider))
    try:
        resolved = _RESOLVE(host, port, type=socket.SOCK_STREAM)
    except (OSError, UnicodeError):
        raise DownloadRefused("unresolvable", f"{host} could not be found.") from None
    addresses = []
    for family, _type, _proto, _name, sockaddr in resolved:
        if family in (socket.AF_INET, socket.AF_INET6):
            addresses.append(str(sockaddr[0]))
    if not addresses:
        raise DownloadRefused("unresolvable", f"{host} could not be found.")
    for address in addresses:
        if public_address(address):
            continue
        loopback = False
        try:
            loopback = ipaddress.ip_address(address.split("%", 1)[0]).is_loopback
        except ValueError:
            pass
        if not (loopback and host in _LOOPBACK_TEST_HOSTS):
            raise DownloadRefused(
                "private_address",
                f"{host} resolves to {address}, which is not a public address, so resmon did not "
                "connect to it.")
    path = parts.path or "/"
    if parts.query:
        path += "?" + parts.query
    return host, port, addresses[0], path


class _PinnedHTTPSConnection(http.client.HTTPSConnection):
    """An https connection made to the address that was checked, verified against the host's name."""

    def __init__(self, host: str, port: int, address: str, context: ssl.SSLContext):
        super().__init__(host, port, context=context, timeout=CONNECT_TIMEOUT_SECONDS)
        self._address = address
        self._pinned_context = context

    def connect(self) -> None:
        sock = socket.create_connection((self._address, self.port), CONNECT_TIMEOUT_SECONDS)
        sock.settimeout(READ_TIMEOUT_SECONDS)
        self.sock = self._pinned_context.wrap_socket(sock, server_hostname=self.host)


def _headers() -> dict[str, str]:
    return {
        "User-Agent": f"resmon/1.0 (+{config.REPOSITORY_URL})",
        "Accept": "application/pdf",
        "Accept-Encoding": "identity",
        "Connection": "close",
    }


def fetch_pdf(url: str, destination: Path, *, max_bytes: int = MAX_BYTES,
              before_request: Callable[[str], None] | None = None,
              deadline_seconds: float = FETCH_DEADLINE_SECONDS) -> Fetched:
    """Fetch the PDF at *url* into the new file *destination*, or raise ``DownloadRefused``.

    *before_request* is called with each hop's host before its request goes
    out, so the caller can hold every host to its pace. *destination* must not
    exist; on any failure it does not exist afterwards either.
    """
    deadline = time.monotonic() + deadline_seconds
    context = _ssl_context()
    current = url
    for hop in range(MAX_REDIRECTS + 1):
        host, port, address, path = _checked_target(current)
        if before_request is not None:
            before_request(host)
        if time.monotonic() > deadline:
            raise DownloadRefused("timed_out", "The download took longer than resmon allows.")
        connection = _PinnedHTTPSConnection(host, port, address, context)
        try:
            try:
                connection.request("GET", path, headers=_headers())
                response = connection.getresponse()
            except ssl.SSLCertVerificationError as exc:
                raise DownloadRefused(
                    "tls_failed", f"{host}'s certificate could not be verified ({exc.verify_message}).") from None
            except ssl.SSLError:
                raise DownloadRefused("tls_failed", f"A secure connection to {host} could not be made.") from None
            except (socket.timeout, TimeoutError):
                raise DownloadRefused("timed_out", f"{host} did not answer in time.") from None
            except (OSError, http.client.HTTPException):
                raise DownloadRefused("connection_failed", f"{host} could not be reached.") from None
            status = response.status
            if status in _REDIRECTS:
                location = response.getheader("Location")
                if not location:
                    raise DownloadRefused("http_status", f"{host} answered {status} without saying where to.")
                current = urljoin(current, location.strip())
                continue
            if status != 200:
                raise DownloadRefused("http_status", f"{host} answered HTTP {status}.")
            return _stream(response, current, destination, max_bytes, deadline, hop)
        finally:
            connection.close()
    raise DownloadRefused("too_many_redirects",
                          f"The address redirected more than {MAX_REDIRECTS} times.")


def _stream(response: http.client.HTTPResponse, final_url: str, destination: Path,
            max_bytes: int, deadline: float, redirects: int) -> Fetched:
    host = open_access.host_of(final_url) or "the host"
    content_type = (response.getheader("Content-Type") or "").split(";", 1)[0].strip().lower()
    if content_type not in PDF_TYPES:
        raise DownloadRefused(
            "wrong_type", f"{host} sent {content_type or 'a reply with no type'}, not a PDF.")
    encoding = (response.getheader("Content-Encoding") or "identity").strip().lower()
    if encoding not in ("", "identity"):
        raise DownloadRefused("wrong_type", f"{host} sent the PDF {encoding}-encoded.")
    declared = response.getheader("Content-Length")
    if declared is not None and declared.strip().isdigit() and int(declared) > max_bytes:
        raise DownloadRefused("too_large", _too_large(host, max_bytes))
    digest = hashlib.sha256()
    size = 0
    head = b""
    fd = os.open(destination, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    kept = False
    try:
        while True:
            if time.monotonic() > deadline:
                raise DownloadRefused("timed_out", "The download took longer than resmon allows.")
            try:
                chunk = response.read(CHUNK_BYTES)
            except (socket.timeout, TimeoutError):
                raise DownloadRefused("timed_out", f"{host} stopped sending.") from None
            except (OSError, http.client.HTTPException):
                raise DownloadRefused("connection_failed", f"The connection to {host} broke.") from None
            if not chunk:
                break
            size += len(chunk)
            if size > max_bytes:
                raise DownloadRefused("too_large", _too_large(host, max_bytes))
            if len(head) < 5:
                head = (head + chunk)[:5]
                if len(head) == 5 and head != b"%PDF-":
                    raise DownloadRefused("not_pdf", f"What {host} sent is not a PDF.")
            digest.update(chunk)
            view = memoryview(chunk)
            while view:
                written = os.write(fd, view)
                view = view[written:]
        if size == 0:
            raise DownloadRefused("empty", f"{host} sent nothing.")
        if head != b"%PDF-":
            raise DownloadRefused("not_pdf", f"What {host} sent is not a PDF.")
        os.fsync(fd)
        kept = True
        return Fetched(final_url=final_url, content_type=content_type, byte_size=size,
                       sha256=digest.hexdigest(), redirects=redirects)
    finally:
        os.close(fd)
        if not kept:
            try:
                os.unlink(destination)
            except FileNotFoundError:
                pass


def _too_large(host: str, max_bytes: int) -> str:
    return f"The PDF from {host} is larger than the {max_bytes // (1024 * 1024)} MB the Library keeps."
