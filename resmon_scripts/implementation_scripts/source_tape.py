"""Opt-in, private recordings of source HTTP exchanges, below source parsers."""

from __future__ import annotations

import base64
import hashlib
import json
import os
import re
import tempfile
import threading
import uuid
from datetime import date, datetime, timezone
from pathlib import Path
from typing import Callable
from urllib.parse import parse_qsl, quote, quote_plus, urlencode, urlsplit, urlunsplit

import httpx

REDACTED = "[redacted]"
_ROOT = Path(__file__).resolve().parents[2]
_EMAIL = re.compile(r"[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}")
_REPLY_HEADERS = {"content-type", "retry-after", "date"}
_RUN_KEYS = ("query", "keywords", "repositories", "max_results", "entity", "entity_profile", "find", "date_window")


def _private(name: str) -> bool:
    name = re.sub(r"[^a-z0-9]", "", name.lower())
    return (name in {"auth", "signature", "sig", "password", "pwd"}
            or name.endswith(("key", "token", "secret", "password", "credential", "email", "mailto",
                              "contact", "cookie", "authorization")))


def _without_credentials(value: object) -> object:
    if isinstance(value, dict):
        return {k: _without_credentials(v) for k, v in value.items() if not _private(k)}
    if isinstance(value, list):
        return [_without_credentials(v) for v in value]
    return value


class TapeMiss(httpx.TransportError):
    """The recording cannot answer this request; live transport is forbidden."""


def _json(value: object) -> bytes:
    return json.dumps(value, sort_keys=True, ensure_ascii=True, separators=(",", ":"), default=str).encode()


def _digest(value: object) -> str:
    return hashlib.sha256(_json(value)).hexdigest()


class _Redactor:
    def __init__(self) -> None:
        self.values: set[str] = set()

    def secret(self, value: object) -> str:
        if isinstance(value, dict):
            for part in value.values():
                self.secret(part)
        elif isinstance(value, (list, tuple)):
            for part in value:
                self.secret(part)
        if value is not None and str(value):
            self.values.add(str(value))
            # Header schemes are part of the header value, but a provider may
            # echo just the credential. Scrub both forms before encoding bytes.
            scheme, _, credential = str(value).partition(" ")
            if scheme.lower() in {"bearer", "basic", "token"} and credential:
                self.values.add(credential)
        return REDACTED

    def text(self, text: str) -> str:
        for value in sorted(self.values, key=len, reverse=True):
            for variant in (value, quote(value, safe=""), quote_plus(value), json.dumps(value)[1:-1]):
                text = text.replace(variant, REDACTED)
        return _EMAIL.sub(REDACTED, text)

    def tree(self, value: object) -> object:
        if isinstance(value, dict):
            return {str(k): self.secret(v) if _private(str(k)) else self.tree(v)
                    for k, v in value.items()}
        if isinstance(value, (list, tuple)):
            return [self.tree(v) for v in value]
        return self.text(value) if isinstance(value, str) else value

    def url(self, url: str) -> str:
        parts = urlsplit(url)
        host = parts.netloc
        if "@" in host:
            for credential in host.rsplit("@", 1)[0].split(":"):
                self.secret(credential)
            host = REDACTED + "@" + host.rsplit("@", 1)[1]
        pairs = [(k, self.secret(v) if _private(k) else v)
                 for k, v in parse_qsl(parts.query, keep_blank_values=True)]
        return self.text(urlunsplit((parts.scheme, host, parts.path, urlencode(pairs), "")))

    def body(self, body: bytes) -> bytes:
        # HTTPX has already decoded content encodings. Keep the bytes its
        # parsers see, except credentials a provider echoed into its reply.
        for value in sorted(self.values, key=len, reverse=True):
            for variant in (value, quote(value, safe=""), quote_plus(value), json.dumps(value)[1:-1]):
                body = body.replace(variant.encode(), REDACTED.encode())
        return body


class SourceTape:
    """One recording directory. Each search replays its own ordered attempts.

    One file per exchange makes an interrupted recording readable without a
    closing index. Atomic replacement never exposes half a JSON document.
    A directory has one writer engine; replay engines only read it.
    """

    def __init__(self, setting: str) -> None:
        mode, separator, directory = setting.partition(":")
        if mode not in {"record", "replay"} or not separator or not directory:
            raise ValueError("RESMON_SOURCE_TAPE must be record:<absolute directory> or replay:<absolute directory>")
        root = Path(directory).expanduser()
        if not root.is_absolute() or root.resolve().is_relative_to(_ROOT):
            raise ValueError("Source tapes need an absolute directory outside the repository")
        self.mode = mode
        self.root = root.resolve()
        self._lock = threading.Lock()
        manifest = self.root / "tape.json"
        if mode == "record":
            self.root.mkdir(parents=True, exist_ok=True)
            if manifest.exists():
                raise ValueError("Record into a new source tape directory for each manual test pass")
            self.recorded_at = datetime.now(timezone.utc).isoformat()
            self.local_day = datetime.now().date().isoformat()
            self._write(manifest, {"version": 1, "recorded_at": self.recorded_at, "local_day": self.local_day})
        else:
            metadata = json.loads(manifest.read_text())
            if metadata.get("version") != 1:
                raise ValueError("Unsupported source tape version")
            self.recorded_at = metadata["recorded_at"]
            self.local_day = metadata["local_day"]
        day = datetime.fromisoformat(self.recorded_at).date()
        self.message = (f"Source replay uses a recording made on {day:%B} {day.day}, {day.year}. "
                        "No live source requests are sent; a request not on the tape is a non-answer.")

    def today(self, *, utc: bool) -> date:
        """The recording's calendar day for an implicit source date bound."""
        return datetime.fromisoformat(self.recorded_at).date() if utc else date.fromisoformat(self.local_day)

    def _write(self, path: Path, value: object) -> None:
        temporary: str | None = None
        try:
            with tempfile.NamedTemporaryFile(dir=self.root, prefix=".exchange-", delete=False) as stream:
                temporary = stream.name
                stream.write(_json(value))
                stream.flush()
                os.fsync(stream.fileno())
            os.replace(temporary, path)
        finally:
            if temporary is not None and os.path.exists(temporary):
                os.unlink(temporary)

    def _save_exchange(self, path: Path, value: dict) -> None:
        with self._lock:
            if path.exists():
                # A second run can repeat an attempt with another answer. Keep
                # every exchange, but leave the first replay sequence stable.
                path = path.with_name(f"{path.stem}-repeat-{uuid.uuid4().hex}.json")
            self._write(path, value)

    def prepare_run(self, params: dict) -> None:
        """Keep explicit dates exact; reuse a moving watch's recorded bounds.

        Matching the watch's intent before dispatch also gives local date
        filters the recorded window. Ignoring dates in HTTP keys would instead
        parse an old reply through today's different filter and lose papers.
        """
        params.pop("source_tape", None)
        intent = {key: params[key] for key in _RUN_KEYS if key in params}
        moving = params.get("date_window") is not None
        if not moving:
            intent.update({key: params.get(key) for key in ("date_from", "date_to")})
        scope = _digest(_Redactor().tree(intent))
        path = self.root / f"run-{scope}.json"
        if self.mode == "record":
            window = {key: params.get(key) for key in ("date_from", "date_to")}
            with self._lock:
                if path.exists():
                    if json.loads(path.read_text())["window"] != window:
                        raise ValueError("Use a new source tape directory for a different watch window")
                else:
                    self._write(path, {"window": window})
        elif moving and path.exists():
            params.update(json.loads(path.read_text())["window"])
            # An earlier run id belongs to the recording's database. Do not
            # present it as a previous run in the database replay is using.
            first = params.get("date_from")
            params["date_window_computed"] = {
                "mode": "recording", "basis": "recording", "date_from": first,
                "date_to": params.get("date_to"),
                "sentence": f"Publication dates reused from the source recording: from {first}, with no end date.",
            }
        params["source_tape"] = {"mode": self.mode, "recorded_at": self.recorded_at, "scope": scope}
        if self.mode == "replay":
            params["source_tape"]["message"] = self.message

    def exchange(
        self, method: str, url: str, headers: dict, kwargs: dict,
        positions: dict[str, int], scope: str, send: Callable[[], httpx.Response],
        deadline_error: type[httpx.TimeoutException],
    ) -> httpx.Response:
        # The source clients use query parameters, JSON, and form mappings.
        # Refuse an unrepresented body or credential channel rather than
        # recording a misleading key, or writing an unrecognized credential.
        if any(kwargs.get(key) is not None for key in ("content", "files", "auth", "cookies")):
            raise ValueError("Source tapes support query parameters, JSON, headers, and form mappings")
        if kwargs.get("data") is not None and not isinstance(kwargs["data"], dict):
            raise ValueError("Source tapes require a mapping for form data")
        redactor = _Redactor()
        # Discover every credential before scrubbing any other field, including
        # reflected values in a URL, a body, or a harmlessly named header.
        clean_headers = redactor.tree(dict(headers))
        params = list(httpx.QueryParams(kwargs.get("params")).multi_items())
        clean_params = [(k, redactor.secret(v) if _private(k) else v) for k, v in params]
        body = redactor.tree(kwargs.get("json"))
        data = redactor.tree(kwargs.get("data"))
        redactor.url(str(url))
        # HTTPX replaces the URL's query when params is supplied, including
        # an empty mapping. A merged key could equate different wire requests.
        effective_url = (httpx.URL(url, params=kwargs["params"])
                         if kwargs.get("params") is not None else httpx.URL(url))
        clean_url = redactor.url(str(effective_url))
        request = json.loads(redactor.text(_json({
            "method": method.upper(), "url": clean_url, "params": clean_params,
            "headers": clean_headers, "json": body, "data": data,
        }).decode()))
        # Keys ignore credentials, including their absence. Preserve every
        # other query value, body field, and response-negotiating header.
        parts = urlsplit(request["url"])
        query = parse_qsl(parts.query, keep_blank_values=True)
        identity = {**request, "url": urlunsplit((parts.scheme, parts.netloc.rsplit("@", 1)[-1], parts.path, "", "")),
                    "params": sorted((k, v) for k, v in query if not _private(k)),
                    "headers": {k.lower(): v for k, v in request["headers"].items()
                                if not _private(k) and k.lower() != "user-agent"}}
        # Secret JSON/form fields also do not distinguish otherwise identical
        # requests made with another key, or without a key.
        for name in ("json", "data"):
            identity[name] = _without_credentials(identity[name])
        key = _digest([scope, identity])
        ordinal = positions.get(key, 0)
        positions[key] = ordinal + 1
        path = self.root / f"exchange-{key}-{ordinal:06d}.json"
        if self.mode == "replay":
            try:
                saved = json.loads(path.read_text())
                failure = saved.get("failure")
                if failure:
                    cls = deadline_error if failure == "RequestDeadlineExceeded" else getattr(httpx, failure, httpx.TransportError)
                    if not isinstance(cls, type) or not issubclass(cls, httpx.RequestError):
                        cls = httpx.TransportError
                    raise cls(f"Recorded source transport failure ({failure})")
                reply = saved["response"]
                instant = datetime.fromisoformat(saved["recorded_at"])
                if instant.tzinfo is None:
                    raise ValueError("The recorded exchange has no time zone")
                response = httpx.Response(reply["status"], headers=reply["headers"],
                                          content=base64.b64decode(reply["body"], validate=True),
                                          request=httpx.Request(method, request["url"]))
                # An HTTP-date Retry-After must be evaluated at the time of
                # the exchange, rather than appearing expired a day later.
                response.extensions["source_tape_recorded_at"] = saved["recorded_at"]
                return response
            except (OSError, ValueError, KeyError, TypeError) as exc:
                raise TapeMiss("The source request was not on the tape, or its recording could not be read; no live request was sent") from exc
        try:
            response = send()
        except httpx.RequestError as exc:
            self._save_exchange(path, {"request": request, "recorded_at": datetime.now(timezone.utc).isoformat(),
                                       "failure": type(exc).__name__})
            raise
        reply_headers = {k: redactor.text(v) for k, v in response.headers.items() if k.lower() in _REPLY_HEADERS}
        saved = {"request": request, "recorded_at": datetime.now(timezone.utc).isoformat(),
                 "response": {"status": response.status_code, "headers": reply_headers,
                              "body": base64.b64encode(redactor.body(response.content)).decode()}}
        self._save_exchange(path, saved)
        return response
