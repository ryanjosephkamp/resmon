"""An https server on loopback, with a certificate from a test authority made on the spot.

For the tests of resmon's downloader and the e2e journey of Get the PDF: the
downloader fetches over https only and verifies every certificate, so a test
needs a server whose certificate a test-only authority signed, trusted through
``fulltext_download._CA_BUNDLE`` and nothing else. The authority and the
certificate are made fresh in a temporary folder each time and never leave it.

Run as a script, it serves until stdin closes and prints one JSON line with its
port and the authority's path, which is how the Electron journey starts it.
"""
from __future__ import annotations

import datetime as _dt
import http.server
import json
import ssl
import sys
import threading
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Callable

from cryptography import x509
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import ec
from cryptography.x509.oid import NameOID

#: The names the test certificate answers for.
TEST_HOSTS = ("pdf.resmon.test", "mirror.resmon.test", "slow.resmon.test")


def make_authority(folder: Path, hosts: tuple[str, ...] = TEST_HOSTS) -> tuple[Path, Path, Path]:
    """A test authority and a server certificate it signed, for *hosts*; returns their paths."""
    folder.mkdir(parents=True, exist_ok=True)
    now = _dt.datetime.now(_dt.timezone.utc)
    ca_key = ec.generate_private_key(ec.SECP256R1())
    ca_name = x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, "resmon test authority")])
    ca_cert = (x509.CertificateBuilder().subject_name(ca_name).issuer_name(ca_name)
               .public_key(ca_key.public_key()).serial_number(x509.random_serial_number())
               .not_valid_before(now - _dt.timedelta(minutes=5))
               .not_valid_after(now + _dt.timedelta(days=1))
               .add_extension(x509.BasicConstraints(ca=True, path_length=0), critical=True)
               .add_extension(x509.KeyUsage(digital_signature=True, key_cert_sign=True, crl_sign=True,
                                            content_commitment=False, key_encipherment=False,
                                            data_encipherment=False, key_agreement=False,
                                            encipher_only=False, decipher_only=False), critical=True)
               .sign(ca_key, hashes.SHA256()))
    key = ec.generate_private_key(ec.SECP256R1())
    cert = (x509.CertificateBuilder()
            .subject_name(x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, hosts[0])]))
            .issuer_name(ca_name).public_key(key.public_key())
            .serial_number(x509.random_serial_number())
            .not_valid_before(now - _dt.timedelta(minutes=5))
            .not_valid_after(now + _dt.timedelta(days=1))
            .add_extension(x509.SubjectAlternativeName([x509.DNSName(h) for h in hosts]), critical=False)
            .add_extension(x509.ExtendedKeyUsage([x509.oid.ExtendedKeyUsageOID.SERVER_AUTH]), critical=False)
            .sign(ca_key, hashes.SHA256()))
    ca_path, cert_path, key_path = folder / "ca.pem", folder / "server.pem", folder / "server.key"
    ca_path.write_bytes(ca_cert.public_bytes(serialization.Encoding.PEM))
    cert_path.write_bytes(cert.public_bytes(serialization.Encoding.PEM))
    key_path.write_bytes(key.private_bytes(serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8,
                                           serialization.NoEncryption()))
    return ca_path, cert_path, key_path


#: A route answers with ``(status, headers, body)``; a body may be bytes or an
#: iterable of byte chunks, which is sent as it is produced.
Route = Callable[[http.server.BaseHTTPRequestHandler], tuple]


@dataclass
class LoopbackHTTPS:
    """The server, its routes, and every request it was sent."""

    folder: Path
    routes: dict[str, Route] = field(default_factory=dict)
    requests: list[dict] = field(default_factory=list)
    port: int = 0
    ca_path: Path | None = None
    hosts: tuple[str, ...] = TEST_HOSTS

    def start(self) -> "LoopbackHTTPS":
        self.ca_path, cert, key = make_authority(self.folder, self.hosts)
        context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        context.load_cert_chain(cert, key)
        owner = self

        class Handler(http.server.BaseHTTPRequestHandler):
            protocol_version = "HTTP/1.1"

            def log_message(self, *args) -> None:  # noqa: D401 - quiet
                return

            def do_GET(self) -> None:  # noqa: N802
                path = self.path.split("?", 1)[0]
                entry = {"path": self.path, "host": self.headers.get("Host"),
                         "user_agent": self.headers.get("User-Agent"), "at": time.monotonic()}
                owner.requests.append(entry)
                route = owner.routes.get(path)
                if route is None:
                    status, headers, body = 404, {"Content-Type": "text/plain"}, b"not here"
                else:
                    status, headers, body = route(self)
                self.send_response(status)
                chunks = [body] if isinstance(body, (bytes, bytearray)) else body
                headers = dict(headers)
                if isinstance(body, (bytes, bytearray)) and "Content-Length" not in headers:
                    headers["Content-Length"] = str(len(body))
                streamed = "Content-Length" not in headers
                if streamed:
                    headers["Transfer-Encoding"] = "chunked"
                headers.setdefault("Connection", "close")
                for name, value in headers.items():
                    self.send_header(name, value)
                self.end_headers()
                try:
                    for chunk in chunks:
                        if not chunk:
                            continue
                        if streamed:
                            self.wfile.write(f"{len(chunk):x}\r\n".encode() + chunk + b"\r\n")
                        else:
                            self.wfile.write(chunk)
                    if streamed:
                        self.wfile.write(b"0\r\n\r\n")
                except (BrokenPipeError, ConnectionResetError, ssl.SSLError):
                    pass
                finally:
                    entry["done"] = time.monotonic()

        self._server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self._server.daemon_threads = True
        self._server.socket = context.wrap_socket(self._server.socket, server_side=True)
        self.port = self._server.server_address[1]
        self._thread = threading.Thread(target=self._server.serve_forever, daemon=True,
                                        name="tls-loopback")
        self._thread.start()
        return self

    def url(self, path: str, host: str = TEST_HOSTS[0]) -> str:
        return f"https://{host}:{self.port}{path}"

    def stop(self) -> None:
        self._server.shutdown()
        self._server.server_close()
        self._thread.join(timeout=5)


def pdf_body(size: int = 2048) -> bytes:
    head = b"%PDF-1.7\n% authored test file, not a paper\n"
    return head + b"0" * max(0, size - len(head) - 6) + b"\n%%EOF"


def _serve_forever_from_stdin() -> None:
    """The journey's server: a PDF at ``/paper.pdf`` and ``/second.pdf``, until stdin closes."""
    folder = Path(sys.argv[1])
    server = LoopbackHTTPS(folder)
    body = pdf_body(40_000)
    server.routes["/paper.pdf"] = lambda _h: (200, {"Content-Type": "application/pdf"}, body)
    server.routes["/second.pdf"] = lambda _h: (200, {"Content-Type": "application/pdf"}, pdf_body(30_000))
    server.start()
    print(json.dumps({"port": server.port, "ca": str(server.ca_path)}), flush=True)
    try:
        sys.stdin.read()
    finally:
        log = folder / "requests.json"
        log.write_text(json.dumps(server.requests))
        server.stop()


if __name__ == "__main__":
    _serve_forever_from_stdin()
