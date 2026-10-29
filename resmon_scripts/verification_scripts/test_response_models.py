"""The response models do not change a single byte of a response body.

``response_model`` is the only thing in FastAPI that can take a field out of a
reply without anybody writing code to do so. A key the handler returned and the
model did not declare is dropped, with a 200 and no log line, and on a surface
of 185 routes whose bodies are dicts assembled across several modules that is a
functionality decrease waiting for one forgetful afternoon.

So the models arrive with a mechanism rather than on trust. This file is it.

What is asserted here
---------------------

1. **Equality, per route, on the same request.** Each modeled route is driven
   over HTTP while its endpoint is wrapped so the raw value it returned is
   captured — the same call, not a second one, so nothing has to be stable
   across two requests for the comparison to mean anything. The body a client
   received is then compared with ``jsonable_encoder`` of that raw value, which
   is precisely what FastAPI sends when there is no ``response_model``.
   Differences are reported as JSON paths, not as one enormous assertion.

2. **The comparison can fail.** ``test_a_model_that_drops_a_field_is_caught``
   builds a lossy twin of every real model — the same fields minus one, with
   pydantic's default ``extra="ignore"`` — serves the captured payload through
   it, and requires the comparison to notice. A check that has never been seen
   to go red is not evidence that anything is right.

3. **Losslessness by construction, enforced on models nobody has written yet.**
   Every model reachable from a route must carry ``extra="allow"``, and every
   route carrying a model must set ``response_model_exclude_unset=True``. The
   two together are what make the serialized body the handler's own key set:
   the first stops a key being dropped, the second stops one being invented at
   its default. Both are read off the application, so a twelfth model added
   next month is held to this standard without its author reading anything.

4. **Coverage of the registry.** Every route on the app that declares a
   response model must be exercised by the scenario below, and the set of
   modeled routes must be exactly ``THE_MODELED_SURFACE`` below. A model added
   without a case is a red test rather than an untested claim, and a route
   modeled without being declared is a red test rather than a quiet widening.

What is deliberately not asserted
---------------------------------

That the models are *complete* — that every key a handler can ever produce is
declared. They cannot be: a branch this scenario does not reach can return a
key no model names, and ``extra="allow"`` is what makes that survive rather
than something that would catch it. The schema is a lower bound on the body and
``additionalProperties: true`` in ``openapi.json`` says so.
"""

from __future__ import annotations

import contextlib
import functools
import json
import os
import socket
import sys
import tempfile
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from unittest import mock
from typing import Any, Iterator, Optional

import pytest

PROJECT_ROOT = Path(__file__).resolve().parent.parent.parent
sys.path.insert(0, str(PROJECT_ROOT / "resmon_scripts"))

from fastapi import FastAPI                    # noqa: E402
from fastapi.encoders import jsonable_encoder  # noqa: E402
from fastapi.routing import APIRoute           # noqa: E402
from fastapi.testclient import TestClient      # noqa: E402
from pydantic import BaseModel, ConfigDict, create_model  # noqa: E402

import resmon as resmon_mod                                    # noqa: E402
from implementation_scripts import response_models             # noqa: E402
from implementation_scripts import watch_profiles as wp        # noqa: E402
from implementation_scripts import collection_map              # noqa: E402


# ---------------------------------------------------------------------------
# The contract: which routes are modeled, declared slice by slice
# ---------------------------------------------------------------------------
#
# This replaces the pilot's fence. That fence said "every modeled route starts
# with /api/profiles", which kept the pilot honest and would have had to be
# deleted the first time anybody modeled anything else -- leaving nothing in
# its place. What is worth holding is not *which* slice is modeled but that the
# modeled set is exactly the declared one: a route that grows a response_model
# without a line here is a quiet widening of a surface whose whole point is
# that it cannot change quietly, and it reddens
# ``test_the_modeled_surface_is_exactly_what_is_declared`` below.
#
# Each route here is also driven by the scenario, and the two properties are
# separate tests on purpose: a declaration with no drive is an untested claim,
# and a drive with no declaration is a change nobody wrote down.

THE_MODELED_SURFACE: dict[str, tuple[tuple[str, str], ...]] = {
    "watch profiles": (
        ("GET", "/api/profiles"),
        ("POST", "/api/profiles"),
        ("GET", "/api/profiles/starter"),
        ("GET", "/api/profiles/{profile_id}"),
        ("PUT", "/api/profiles/{profile_id}"),
        ("DELETE", "/api/profiles/{profile_id}"),
        ("GET", "/api/profiles/{profile_id}/export"),
        ("GET", "/api/profiles/{profile_id}/lifecycle"),
        ("GET", "/api/profiles/{profile_id}/matches"),
        ("POST", "/api/profiles/import"),
        ("POST", "/api/profiles/matches/for-documents"),
    ),
    "settings": (
        ("GET", "/api/settings/ai"),
        ("PUT", "/api/settings/ai"),
        ("GET", "/api/settings/ai/cli-status"),
        ("GET", "/api/settings/assistant"),
        ("PUT", "/api/settings/assistant"),
        ("GET", "/api/settings/cloud"),
        ("PUT", "/api/settings/cloud"),
        ("GET", "/api/settings/email"),
        ("PUT", "/api/settings/email"),
        ("POST", "/api/settings/email/test"),
        ("GET", "/api/settings/embeddings"),
        ("PUT", "/api/settings/embeddings"),
        ("GET", "/api/settings/execution"),
        ("PUT", "/api/settings/execution"),
        ("GET", "/api/settings/notifications"),
        ("PUT", "/api/settings/notifications"),
        ("GET", "/api/settings/storage"),
        ("PUT", "/api/settings/storage"),
    ),
    "appearance": (
        ("GET", "/api/appearance"),
        ("PUT", "/api/appearance"),
    ),
    "collection map": (
        ("GET", "/api/map"),
    ),
    "today": (
        ("GET", "/api/today"),
        ("POST", "/api/today/looked"),
    ),
    "document briefs": (
        ("POST", "/api/documents/briefs"),
    ),
    "reading queue": (
        ("GET", "/api/reading-queue"),
        ("POST", "/api/reading-queue"),
        ("PUT", "/api/reading-queue/{document_id}"),
        ("DELETE", "/api/reading-queue/{document_id}"),
    ),
    "watchdog": (
        ("GET", "/api/watchdog"),
        ("POST", "/api/watchdog/mute"),
        ("POST", "/api/watchdog/unmute"),
    ),
    "first run": (
        ("GET", "/api/onboarding"),
        ("POST", "/api/onboarding/dismiss"),
    ),
    "process identity and the catalogs": (
        ("GET", "/api/health"),
        ("GET", "/api/credentials"),
        ("GET", "/api/repositories/catalog"),
        ("GET", "/api/search/repositories"),
        ("POST", "/api/renderer/heartbeat"),
    ),
    "saved configurations": (
        ("GET", "/api/configurations"),
        ("POST", "/api/configurations"),
        ("PUT", "/api/configurations/{config_id}"),
        ("DELETE", "/api/configurations/{config_id}"),
        ("POST", "/api/configurations/export"),
        ("POST", "/api/configurations/import"),
    ),
    "starting a run": (
        ("POST", "/api/search/dive"),
        ("POST", "/api/search/sweep"),
    ),
    "runs": (
        ("GET", "/api/executions"),
        ("GET", "/api/executions/active"),
        ("GET", "/api/executions/{exec_id}"),
        ("GET", "/api/executions/{exec_id}/report"),
        ("GET", "/api/executions/{exec_id}/log"),
        ("POST", "/api/executions/{exec_id}/cancel"),
        ("POST", "/api/executions/{exec_id}/restart"),
        ("GET", "/api/executions/{exec_id}/documents"),
    ),
    "the Explorer": (
        ("POST", "/api/explorer/search"),
    ),
    "a paper's account": (
        ("GET", "/api/documents/{doc_id}"),
        ("GET", "/api/documents/{doc_id}/why"),
    ),
    "the same work twice": (
        ("POST", "/api/links/for-documents"),
        ("POST", "/api/links/collapse-preview"),
    ),
    "the embedding index": (
        ("GET", "/api/embeddings/status"),
    ),
    "the scheduler": (
        ("GET", "/api/scheduler/status"),
    ),
    "watches": (
        ("GET", "/api/routines"),
        ("POST", "/api/routines"),
        ("GET", "/api/routines/{routine_id}"),
        ("PUT", "/api/routines/{routine_id}"),
        ("POST", "/api/routines/{routine_id}/activate"),
        ("POST", "/api/routines/{routine_id}/deactivate"),
        ("POST", "/api/routines/{routine_id}/run"),
        ("GET", "/api/routines/{routine_id}/documents"),
        ("GET", "/api/routines/{routine_id}/delivery-targets"),
        ("POST", "/api/routines/{routine_id}/delivery-targets"),
        ("GET", "/api/routines/{routine_id}/deliveries"),
        ("GET", "/api/routines/{routine_id}/coverage"),
    ),
    "where a watch's reports go": (
        ("POST", "/api/deliveries/{delivery_id}/deliver"),
        ("POST", "/api/deliveries/{delivery_id}/skip"),
        ("POST", "/api/deliveries/{delivery_id}/retry"),
    ),
    "the calendar": (
        ("GET", "/api/calendar/events"),
    ),
    "the background service": (
        ("GET", "/api/service/status"),
        ("GET", "/api/service/daemon-status"),
        ("POST", "/api/service/install"),
        ("POST", "/api/service/uninstall"),
    ),
    "a credential stored or removed": (
        ("PUT", "/api/credentials/{key_name}"),
        ("DELETE", "/api/credentials/{key_name}"),
    ),
    "the source wall": (
        ("GET", "/api/coverage/source-wall"),
    ),
    "analytics": (
        ("GET", "/api/analytics/overview"),
        ("GET", "/api/analytics/summary"),
        ("GET", "/api/analytics/source-contribution"),
        ("GET", "/api/analytics/discovery-lag"),
        ("GET", "/api/analytics/routine-health"),
        ("GET", "/api/analytics/publication-volume"),
        ("GET", "/api/analytics/keyword-contribution"),
    ),
}

#: Routes whose body is a list of **strings**, so there is no object anywhere
#: in it and no pydantic model to walk. The structural guards below say nothing
#: at all about these -- there is no key for a model to drop -- so they are
#: named here and their annotation is pinned instead. Adding a route to this
#: set is how you say "this one answers scalars"; it is not a way out of the
#: guards for a route that answers objects, because the pin below fails on any
#: annotation that is not exactly ``list[str]``.
SCALAR_LIST_ROUTES: frozenset[tuple[str, str]] = frozenset({
    ("GET", "/api/search/repositories"),
})


# ---------------------------------------------------------------------------
# Reading the application, rather than a list somebody keeps up to date
# ---------------------------------------------------------------------------

def api_routes() -> list[APIRoute]:
    """Every ``APIRoute`` on the real app.

    The same selection ``api_contract.api_routes`` makes, for the same reason:
    FastAPI's own four documentation routes are not part of the surface and
    would make every denominator wrong by four.
    """
    return [r for r in resmon_mod.app.routes if isinstance(r, APIRoute)]


def api_contract_route_keys() -> list[tuple[str, str]]:
    """``(method, path)`` for the whole surface, from the contract generator.

    The same selection the generated ``docs/api-contract/`` files are built
    from, borrowed rather than reimplemented so a route this file thinks exists
    and the contract does not is impossible.
    """
    from implementation_scripts import api_contract  # noqa: PLC0415

    return api_contract.route_keys()


def modeled_routes() -> dict[tuple[str, str], APIRoute]:
    """``(method, path)`` -> route, for every route declaring a response model."""
    out: dict[tuple[str, str], APIRoute] = {}
    for route in api_routes():
        if route.response_model is None:
            continue
        for method in sorted(route.methods or ()):
            if method in ("HEAD", "OPTIONS"):
                continue
            out[(method, route.path)] = route
    return out


# ---------------------------------------------------------------------------
# Capturing what the handler returned, on the request that returned it
# ---------------------------------------------------------------------------
#
# ``route.dependant.call`` is read at request time -- ``run_endpoint_function``
# dereferences it per call -- so replacing it for the duration of a test puts a
# recorder between FastAPI and the handler without touching a line of shipped
# code. ``is_coroutine`` is decided once when the route is built, so a sync
# handler must keep a sync wrapper; both shapes are handled below.
#
# The recorder is a plain list rather than a ``ContextVar`` on purpose. FastAPI
# runs a sync endpoint in a worker thread through ``run_in_threadpool``, which
# gives that thread a *copy* of the context, so a value set inside the handler
# never comes back. The suite runs one request at a time, and each drive
# asserts it captured exactly one call, which is what makes a list safe here.

@contextlib.contextmanager
def recording(routes: list[APIRoute]) -> Iterator[list]:
    """Record ``(route, raw return value)`` for every call to these routes."""
    captured: list[tuple[APIRoute, Any]] = []
    originals: list[tuple[APIRoute, Any]] = []

    for route in routes:
        original = route.dependant.call
        originals.append((route, original))

        def make(route=route, original=original):
            if route.dependant.is_coroutine_callable:
                @functools.wraps(original)
                async def recorder(*args, **kwargs):
                    value = await original(*args, **kwargs)
                    captured.append((route, value))
                    return value
            else:
                @functools.wraps(original)
                def recorder(*args, **kwargs):
                    value = original(*args, **kwargs)
                    captured.append((route, value))
                    return value
            return recorder

        route.dependant.call = make()

    try:
        yield captured
    finally:
        for route, original in originals:
            route.dependant.call = original


def differences(expected: Any, actual: Any, path: str = "$") -> list[str]:
    """Every place two JSON values differ, named by its path.

    ``expected`` is the body with no response model; ``actual`` is the body
    with one. A single ``assert expected == actual`` on a watch profile prints
    two hundred lines of near-identical dict and leaves the reader to find the
    one key that moved, which is how a real difference gets waved through.
    """
    out: list[str] = []
    if isinstance(expected, dict) and isinstance(actual, dict):
        for key in sorted(set(expected) - set(actual)):
            out.append(f"{path}.{key}: dropped by the response model "
                       f"(was {json.dumps(expected[key], default=str)[:120]})")
        for key in sorted(set(actual) - set(expected)):
            out.append(f"{path}.{key}: added by the response model "
                       f"(now {json.dumps(actual[key], default=str)[:120]})")
        for key in sorted(set(expected) & set(actual)):
            out.extend(differences(expected[key], actual[key], f"{path}.{key}"))
        return out
    if isinstance(expected, list) and isinstance(actual, list):
        if len(expected) != len(actual):
            out.append(f"{path}: {len(expected)} items became {len(actual)}")
            return out
        for index, (left, right) in enumerate(zip(expected, actual)):
            out.extend(differences(left, right, f"{path}[{index}]"))
        return out
    if expected != actual or type(expected) is not type(actual):
        out.append(f"{path}: {expected!r} ({type(expected).__name__}) "
                   f"became {actual!r} ({type(actual).__name__})")
    return out


# ---------------------------------------------------------------------------
# One scenario, driving every modeled route against a seeded corpus
# ---------------------------------------------------------------------------

class Drive:
    """A client that records what each handler returned beside what it sent."""

    def __init__(self, client: TestClient, captured: list) -> None:
        self.client = client
        self.captured = captured
        #: ``(method, path)`` -> list of ``(raw return, response body)``.
        self.calls: dict[tuple[str, str], list[tuple[Any, Any]]] = {}
        #: ``(method, path)`` -> list of the exact bytes that went over the wire.
        self.wire: dict[tuple[str, str], list[str]] = {}

    def __call__(self, method: str, url: str, expect: int = 200, **kwargs) -> Any:
        before = len(self.captured)
        response = self.client.request(method, url, **kwargs)
        assert response.status_code == expect, f"{method} {url}: {response.text}"
        new = self.captured[before:]
        assert len(new) == 1, (
            f"{method} {url} ran {len(new)} recorded handlers; the comparison "
            f"needs exactly one so the raw value belongs to this body")
        route, raw = new[0]
        body = response.json()
        self.calls.setdefault((method, route.path), []).append((raw, body))
        self.wire.setdefault((method, route.path), []).append(response.text)
        return body


@pytest.fixture(scope="module")
def driven() -> Drive:
    """Drive every modeled route against a corpus this scenario builds.

    Module-scoped because the scenario is a *sequence* and the order carries
    meaning: the first-run card is read before anything exists, the embeddings
    page before and after a lane is configured, the watchdog after six runs
    have been recorded against it. Re-running each slice from a clean database
    would be cheaper to read and would lose exactly the bodies worth comparing.

    The slices are functions below, each taking ``drive`` and returning what
    the next one needs. They run in one transaction-free sequence against one
    ``:memory:`` corpus, which is also what the lossy-twin test replays.
    """
    resmon_mod._db_path = ":memory:"
    resmon_mod._shared_conn = None
    resmon_mod._db_initialized = False
    client = TestClient(resmon_mod.app)

    # ``APIRoute`` is unhashable, and one route object serves several
    # ``(method, path)`` keys only when it declares several methods — none here
    # does, but deduplicating by identity costs nothing and keeps a second
    # recorder off a route if one ever does.
    unique = list({id(r): r for r in modeled_routes().values()}.values())
    with recording(unique) as captured:
        drive = Drive(client, captured)

        # Before anything exists, so the card's ``show`` is true on this call
        # and false on the one at the end of the watchdog slice.
        drive("GET", "/api/onboarding")
        _drive_process_identity(drive)
        _drive_settings(drive)
        _drive_appearance(drive)

        # A profile with no identifier, so ``basis_warning`` is a sentence and
        # not ``None``: the field most easily lost is the one carrying a value.
        watched = drive(
            "POST", "/api/profiles", expect=201,
            json={"kind": "person", "display_name": "Jane Doe",
                  "names": ["Jane Doe", "J. Doe"], "affiliations": ["Somewhere"],
                  "field_hints": ["astronomy"], "notes": "A note."})
        profile_id = watched["id"]

        # Two papers matched to it, with lifecycle findings on the first, so the
        # matches page, the lifecycle join and the per-document map all have
        # rows rather than empty lists to compare.
        conn = resmon_mod._get_db()
        try:
            doc_ids = []
            for index in range(2):
                conn.execute(
                    "INSERT INTO documents (source_repository, external_id, title, "
                    "doi, url, publication_date, metadata_hash) "
                    "VALUES ('arxiv', ?, ?, ?, ?, ?, ?)",
                    (f"E{index}", f"Paper {index}",
                     f"10.1000/{index}" if index == 0 else None,
                     f"https://example.org/{index}" if index == 0 else None,
                     "2026-01-01" if index == 0 else None, f"h{index}"))
                doc_ids.append(conn.execute(
                    "SELECT id FROM documents WHERE external_id = ?",
                    (f"E{index}",)).fetchone()["id"])
            for doc_id, basis in zip(doc_ids, ("name_only", "name+affiliation")):
                conn.execute(
                    "INSERT INTO watch_profile_matches (document_id, profile_id, "
                    "basis, matched_author, evidence) VALUES (?, ?, ?, ?, ?)",
                    (doc_id, profile_id, basis, "Jane Doe",
                     "the name on the paper" if basis == "name_only" else None))
            conn.execute(
                "INSERT INTO document_lifecycle (document_id, kind, severity, "
                "notice_key, label, notice_doi, notice_url, notice_date, "
                "provider, provider_source) "
                "VALUES (?, 'retraction', 'critical', 'k1', 'Retracted', "
                "'10.1000/notice', 'https://example.org/notice', '2026-02-02', "
                "'crossref', 'api')", (doc_ids[0],))
            conn.execute(
                "INSERT INTO document_lifecycle_checks (document_id, status) "
                "VALUES (?, 'ok')", (doc_ids[0],))
            conn.commit()
        finally:
            resmon_mod._close_db(conn)

        drive("GET", "/api/profiles")
        drive("GET", "/api/profiles/starter")
        drive("GET", f"/api/profiles/{profile_id}")
        drive("PUT", f"/api/profiles/{profile_id}",
              json={"kind": "person", "display_name": "Jane Doe",
                    "names": ["Jane Doe"], "notes": "Edited."})
        exported = drive("GET", f"/api/profiles/{profile_id}/export")
        drive("GET", f"/api/profiles/{profile_id}/matches")
        drive("GET", f"/api/profiles/{profile_id}/lifecycle")
        drive("POST", "/api/profiles/matches/for-documents",
              json={"document_ids": doc_ids})
        # One importable profile and one that cannot be read, so both lists in
        # the result have a row.
        drive("POST", "/api/profiles/import",
              json={"profiles": [exported, {"schema": 1, "kind": "person",
                                            "names": []}]})

        # The conditional body, both ways round. A routine pointing at a profile
        # adds ``detail`` to the delete response; nothing pointing at it leaves
        # the key out altogether, and a model that serialized its default would
        # have turned the second case into the first.
        unwatched = drive("POST", "/api/profiles", expect=201,
                          json={"kind": "person", "display_name": "Nobody Watches"})
        watched_by_routine = drive(
            "POST", "/api/profiles", expect=201,
            json={"kind": "person", "display_name": "Somebody Watches"})
        conn = resmon_mod._get_db()
        try:
            conn.execute(
                "INSERT INTO routines (name, schedule_cron, parameters) "
                "VALUES ('watcher', '0 9 * * *', ?)",
                (json.dumps({"entity": {"profile_id": watched_by_routine["id"],
                                        "mode": "new_work"}}),))
            conn.commit()
        finally:
            resmon_mod._close_db(conn)
        drive("DELETE", f"/api/profiles/{unwatched['id']}")
        drive("DELETE", f"/api/profiles/{watched_by_routine['id']}")

        _drive_reading_queue(drive, doc_ids[0])
        _drive_watchdog_and_first_run(drive)
        _drive_configurations(drive)
        _drive_scheduler(drive)
        _drive_collection_map(drive)
        _drive_today(drive)
        _drive_runs(drive)
        _drive_collection(drive)
        _drive_watches(drive, doc_ids)
        _drive_background_service(drive)
        _drive_credentials_and_the_test_send(drive)
        _drive_source_wall_and_analytics(drive)

        yield drive


# ---------------------------------------------------------------------------
# The slices
# ---------------------------------------------------------------------------

def _drive_process_identity(drive: Drive) -> None:
    """Five reads that belong to no feature and that every client makes first.

    ``/api/health`` and ``/api/credentials`` answer objects; the two catalogs
    answer **bare lists**, one of objects and one of plain strings, which is
    the shape the structural guards cannot speak about. Both are driven here
    so the equality sweep does speak about them.
    """
    drive("GET", "/api/health")
    sources = drive("GET", "/api/search/repositories")
    assert sources and all(isinstance(s, str) for s in sources), (
        "the bare-list-of-strings case needs a non-empty list to be evidence")
    catalog = drive("GET", "/api/repositories/catalog")
    assert catalog, "the catalog must have rows for its model to be exercised"
    drive("GET", "/api/credentials")
    drive("POST", "/api/renderer/heartbeat")


class _HealthAnswering:
    """A loopback server that answers ``/api/health`` as this process would.

    Real rather than a patched ``httpx.Client``, so the daemon probe opens a
    connection and reads a body exactly as it does against a running service.
    It answers with this process's pid, which is the one body of the probe that
    carries ``is_self``.
    """

    def __enter__(self) -> "_HealthAnswering":
        pid = os.getpid()

        class Handler(BaseHTTPRequestHandler):
            def do_GET(self) -> None:  # noqa: N802 - the stdlib's name
                body = json.dumps({"status": "ok", "pid": pid, "version": "0.0.0-scenario",
                                   "started_at": "2026-10-28T12:00:00+00:00"}).encode()
                self.send_response(200 if self.path == "/api/health" else 404)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)

            def log_message(self, *_args: Any) -> None:
                pass

        self.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.port = int(self.server.server_address[1])
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        return self

    def __exit__(self, *_exc: Any) -> None:
        self.server.shutdown()
        self.server.server_close()
        self.thread.join()


def _drive_background_service(drive: Drive) -> None:
    """The service panel's four routes, over a unit directory and a lock file
    this scenario owns.

    ``RESMON_SERVICE_UNIT_DIR`` points the unit at a temporary directory and
    every install and uninstall asks ``register: false``, so nothing is written
    outside it and the machine's own service manager is never called. The
    daemon probe is driven through its three bodies: no lock, a lock naming a
    port nothing listens on, and a lock naming a server that answers health as
    this process, the only body that carries ``is_self``.
    """
    from implementation_scripts import daemon as daemon_mod

    units = Path(tempfile.mkdtemp(prefix="resmon-scenario-units-"))
    lock = Path(tempfile.mkdtemp(prefix="resmon-scenario-lock-")) / "daemon.lock"
    with mock.patch.dict(os.environ, {"RESMON_SERVICE_UNIT_DIR": str(units)}), \
            mock.patch.object(daemon_mod, "lock_path", lambda: lock):
        assert drive("GET", "/api/service/status")["installed"] is False
        # Removing what was never installed is an answer, not an error.
        nothing = drive("POST", "/api/service/uninstall", json={"register": False})
        assert nothing["removed"] is False, nothing
        made = drive("POST", "/api/service/install", json={"register": False})
        assert Path(made["unit_path"]).parent == units, made
        assert drive("GET", "/api/service/status")["installed"] is True
        assert drive("POST", "/api/service/uninstall", json={"register": False})["removed"] is True

        assert drive("GET", "/api/service/daemon-status")["lock_present"] is False
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as reserved:
            reserved.bind(("127.0.0.1", 0))
            closed = int(reserved.getsockname()[1])
        lock.write_text(json.dumps({"pid": 99999, "port": closed, "version": "0.0.0"}), encoding="utf-8")
        stale = drive("GET", "/api/service/daemon-status")
        assert stale["lock_present"] and not stale["running"] and stale["error"], stale
        with _HealthAnswering() as health:
            lock.write_text(json.dumps({"pid": os.getpid(), "port": health.port, "version": "0.0.0"}),
                            encoding="utf-8")
            alive = drive("GET", "/api/service/daemon-status")
        assert alive["running"] is True and alive["is_self"] is True, alive


def _drive_credentials_and_the_test_send(drive: Drive) -> None:
    """The SMTP password stored, a test send the server accepted, and the
    password removed.

    The settings slice stored an SMTP destination, so the password is all the
    test send lacks. ``send_test_email`` is replaced by one that accepts: the
    body under test is the route's, and no socket opens. The keyring is
    conftest's in-memory one, so nothing reaches the machine's own.
    """
    from implementation_scripts import email_notifier

    drive("PUT", "/api/credentials/smtp_password", json={"value": "a-password-for-the-scenario"})
    with mock.patch.object(email_notifier, "send_test_email", return_value=True):
        sent = drive("POST", "/api/settings/email/test")
    assert sent == {"success": True, "recipient": "someone@example.org"}, sent
    drive("DELETE", "/api/credentials/smtp_password")


def _drive_source_wall_and_analytics(drive: Drive) -> None:
    """The Source wall over every run the scenario recorded, and the analytics views.

    Last in the scenario, so the wall has the watchdog slice's failures, the
    runs slice's ``missing_key`` non-answers and its cancelled run to classify,
    and every view has the slices' papers and watches to count.

    Two of the views are only interesting past a threshold, so this adds what
    crosses it: six dated papers from a second source, so overlap and the lag
    median are drawn rather than refused, and three completed runs of one
    watch, so its health is judged. The views below the threshold answer with
    ``insufficient_reason`` and ``None`` shares, which is the half of each
    model a well-stocked corpus would never exercise; the first reads, before
    the rows are added, are those.
    """
    first = drive("GET", "/api/analytics/overview")
    assert first["discovery_lag"]["sufficient"] is False, (
        "the lag view must be read below its threshold once, so its None medians "
        "are compared")
    wall = drive("GET", "/api/coverage/source-wall")
    states = {cell["state"] for source in wall["sources"] for cell in source["cells"]}
    assert {"failed", "could_not_be_asked"} <= states, (
        f"the wall must classify a failure and a non-answer to be worth comparing: {states}")
    narrow = drive("GET", "/api/coverage/source-wall?limit=1")
    assert narrow["window"]["returned"] == 1

    conn = resmon_mod._get_db()
    try:
        for index in range(6):
            conn.execute(
                "INSERT INTO documents (source_repository, external_id, title, "
                "publication_date, first_seen_at, metadata_hash, categories) "
                "VALUES ('crossref', ?, ?, ?, ?, ?, ?)",
                (f"C{index}", f"Crossref paper {index}", f"2026-0{index + 1}-01",
                 f"2026-0{index + 1}-0{index + 2}T00:00:00Z", f"c{index}",
                 "astro-ph.CO, cs.LG" if index % 2 else None))
        routine_id = conn.execute(
            "SELECT id FROM routines ORDER BY id LIMIT 1").fetchone()["id"]
        for index, new in enumerate((4, 0, 0)):
            conn.execute(
                "INSERT INTO executions (execution_type, parameters, start_time, "
                "end_time, status, routine_id, result_count, new_result_count) "
                "VALUES ('automated_sweep', ?, ?, ?, 'completed', ?, ?, ?)",
                ('{"keywords": ["perovskite"], "repositories": ["crossref"]}',
                 f"2026-07-0{index + 1}T08:00:00Z", f"2026-07-0{index + 1}T08:01:00Z",
                 routine_id, 6, new))
        conn.commit()
    finally:
        resmon_mod._close_db(conn)

    drive("GET", "/api/analytics/summary")
    drive("GET", "/api/analytics/source-contribution")
    lag = drive("GET", "/api/analytics/discovery-lag")
    assert lag["sufficient"] is True, "six dated crossref papers cross the lag threshold"
    health = drive("GET", "/api/analytics/routine-health")
    assert any(row["sufficient"] for row in health["routines"]), (
        "three completed runs of one watch cross the health threshold")
    drive("GET", "/api/analytics/publication-volume")
    drive("GET", "/api/analytics/publication-volume?group_by=category&months=6")
    drive("GET", "/api/analytics/overview")
    corpus = drive("GET", "/api/analytics/keyword-contribution")
    assert corpus["scope"] == {"type": "corpus"}, (
        "the corpus scope carries no execution_id, and the model must not invent one")
    run_id = wall["runs"][-1]["execution_id"]
    one = drive("GET", f"/api/analytics/keyword-contribution?execution_id={run_id}")
    assert one["scope"] == {"type": "execution", "execution_id": run_id}


def _drive_today(drive: Drive) -> None:
    """Both windows: the first look (seven days, nothing recorded) with the
    scenario's papers, routines and runs in it, then the window after a look,
    which is empty."""
    first = drive("GET", "/api/today")
    drive("POST", "/api/today/looked")
    drive("GET", "/api/today")
    # Briefs for the papers Today listed, and for an id that is not there.
    ids = [paper["id"] for paper in first["papers"]][:3] + [987654]
    briefs = drive("POST", "/api/documents/briefs", json={"ids": ids})
    assert [b["id"] for b in briefs] == ids[:-1]


def _drive_collection(drive: Drive) -> None:
    """The collection: searched, a run's papers, one paper's account, the same
    work twice, and a ranking by meaning.

    Three papers on one topic, two of them the same work from two sources
    (they share a DOI), so the link routes answer a link and a fold rather
    than empty maps. One is saved to read, so the run's papers carry a queue
    status beside a ``None``. The ranking uses the suite's real loopback
    embedding server (``embedding_server.py``) as the lane, with vectors stored
    for two of the three papers, so a ranked page has distances, a paper
    listed last with none, and the counts and model the similarity sort adds;
    an empty phrase is refused, which is the one body carrying
    ``similarity_unavailable``. The lane is turned off again at the end, so no
    slice embeds unless it sets up its own.
    """
    from embedding_server import EmbeddingServer, deterministic_vector  # noqa: PLC0415
    from implementation_scripts import vector_index  # noqa: PLC0415
    from implementation_scripts.database import (  # noqa: PLC0415
        insert_execution, link_execution_document, record_execution_source, update_execution_status,
    )

    conn = resmon_mod._get_db()
    try:
        ids = []
        for n, (source, title, doi) in enumerate((
            ("arxiv", "Perovskite solar cells that keep their efficiency", "10.5555/same-work"),
            ("crossref", "Perovskite solar cells that keep their efficiency", "10.5555/same-work"),
            ("arxiv", "Perovskite light-emitting diodes", None),
        )):
            ids.append(conn.execute(
                "INSERT INTO documents (source_repository, external_id, title, abstract, authors, doi, "
                "publication_date, metadata_hash) VALUES (?, ?, ?, ?, 'A. Author', ?, '2026-10-01', ?)",
                (source, f"collection-{n}", title, f"{title}. A perovskite film is studied.", doi,
                 f"collection-{n}")).lastrowid)
        run = insert_execution(conn, {
            "execution_type": "deep_dive", "start_time": "2026-10-28T00:00:00Z",
            "parameters": json.dumps({"repository": "arxiv", "query": "perovskite", "keywords": ["perovskite"]}),
        })
        for doc in ids:
            link_execution_document(conn, run, doc)
        record_execution_source(conn, run, "arxiv", "ok", result_count=len(ids), zero_reason=None)
        update_execution_status(conn, run, "completed", end_time="2026-10-28T00:00:09Z",
                                result_count=len(ids), new_result_count=len(ids))
        conn.execute(
            "INSERT INTO document_links (document_a, document_b, kind, score, method) "
            "VALUES (?, ?, 'near_duplicate', NULL, 'shared_doi')", (ids[0], ids[1]))
        conn.commit()
    finally:
        resmon_mod._close_db(conn)
    saved = drive.client.post("/api/reading-queue", json={"document_id": ids[0]})
    assert saved.status_code == 201, saved.text

    page = drive("GET", f"/api/executions/{run}/documents")
    assert {p["queue_status"] for p in page["papers"]} == {"to_read", None}
    drive("POST", "/api/explorer/search", json={"query": "perovskite", "limit": 50})
    drive("GET", f"/api/documents/{ids[0]}")
    drive("GET", f"/api/documents/{ids[2]}")
    drive("GET", f"/api/documents/{ids[0]}/why")
    drive("GET", f"/api/documents/{ids[2]}/why", params={"execution_id": run})
    links = drive("POST", "/api/links/for-documents", json={"document_ids": ids})
    assert links["links"], "the link model needs a link to be compared"
    folded = drive("POST", "/api/links/collapse-preview", json={"document_ids": ids})
    assert folded["folded"], "the fold model needs a fold to be compared"

    drive("GET", "/api/embeddings/status")
    with EmbeddingServer() as server:
        model = "scenario-model"
        made = drive.client.put("/api/settings/embeddings", json={"settings": {
            "embedding_enabled": "true", "embedding_provider": "local",
            "embedding_model": model, "embedding_endpoint": server.base_url}})
        assert made.status_code == 200, made.text
        conn = resmon_mod._get_db()
        try:
            for doc, title in ((ids[0], "Perovskite solar cells"), (ids[2], "Perovskite diodes")):
                vector = deterministic_vector(title, server.dims)
                conn.execute(
                    "INSERT INTO document_embeddings (document_id, model, dims, vector, fields) "
                    "VALUES (?, ?, ?, ?, 'title+abstract')",
                    (doc, model, len(vector), vector_index.pack_vector(vector)))
            conn.commit()
        finally:
            resmon_mod._close_db(conn)
        drive("GET", "/api/embeddings/status")
        ranked = drive("POST", "/api/explorer/search",
                       json={"query": "perovskite solar", "sort": "similarity", "limit": 50})
        assert ranked["sort"] == "similarity" and ranked["unranked_count"] >= 1, ranked
        refused = drive("POST", "/api/explorer/search", json={"query": "", "sort": "similarity", "limit": 50})
        assert "similarity_unavailable" in refused, refused
        drive.client.put("/api/settings/embeddings", json={"settings": {"embedding_enabled": "false"}})


def _wait_until_settled(drive: Drive, exec_id: int, timeout: float = 30.0) -> dict:
    """Poll a run, unrecorded, until it is no longer running."""
    import time  # noqa: PLC0415 — only the runs slice waits on a thread

    deadline = time.monotonic() + timeout
    while True:
        row = drive.client.get(f"/api/executions/{exec_id}").json()
        if row["status"] != "running":
            return row
        assert time.monotonic() < deadline, f"run {exec_id} still running after {timeout} s"
        time.sleep(0.05)


def _drive_runs(drive: Drive) -> None:
    """Runs started over the API, read back, restarted and cancelled.

    Real runs, not seeded rows, over sources that require an API key: the
    suite's keyring is empty, so each is skipped at once and records a
    non-answer (``missing_key``), and the coverage on the rows below has
    recorded sources to compare. A keyless source would also record one, but
    only after ``safe_request``'s retries against the suite's refused
    connections, which took this file from 2 seconds to 52. Last in the
    scenario, so its runs reach no slice above.

    The same ``request_id`` twice is what makes ``duplicate`` appear: absent
    on the first answer and present on the second, the conditional key
    ``response_model_exclude_unset`` exists for. Cancel needs a run that is
    running when it is asked; one is registered by hand and never started, so
    the answer cannot race a thread that finishes first.
    """
    from implementation_scripts.progress import progress_store  # noqa: PLC0415

    dive = drive("POST", "/api/search/dive",
                 json={"repository": "springer", "query": "x", "keywords": ["x"],
                       "max_results": 5, "request_id": "runs-slice-1"})
    again = drive("POST", "/api/search/dive",
                  json={"repository": "springer", "query": "x", "keywords": ["x"],
                        "max_results": 5, "request_id": "runs-slice-1"})
    assert "duplicate" not in dive and again == {"execution_id": dive["execution_id"], "duplicate": True}
    sweep = drive("POST", "/api/search/sweep",
                  json={"repositories": ["springer", "core"], "query": "y",
                        "keywords": ["y"], "max_results": 5})
    for run in (dive, sweep):
        _wait_until_settled(drive, run["execution_id"])

    rows = drive("GET", "/api/executions", params={"limit": 10})
    assert rows and any(row["coverage"]["sources"] for row in rows), (
        "the coverage model needs a recorded source to be compared")
    drive("GET", "/api/executions/active")
    first = drive("GET", f"/api/executions/{dive['execution_id']}")
    if first.get("result_path") and Path(first["result_path"]).exists():
        drive("GET", f"/api/executions/{dive['execution_id']}/report")
    if first.get("log_path") and Path(first["log_path"]).exists():
        drive("GET", f"/api/executions/{dive['execution_id']}/log")

    assert first["status"] in ("failed", "completed", "cancelled"), first["status"]
    if first["status"] == "completed":
        # Restart takes a run that did not finish; this one did, so it is
        # marked as having stopped before it is restarted.
        conn = resmon_mod._get_db()
        try:
            conn.execute("UPDATE executions SET status = 'interrupted', "
                         "interrupted_reason = 'owner_dead' WHERE id = ?",
                         (dive["execution_id"],))
            conn.commit()
        finally:
            resmon_mod._close_db(conn)
    restarted = drive("POST", f"/api/executions/{dive['execution_id']}/restart", expect=202)
    assert restarted["restarted_from"] == dive["execution_id"] and "duplicate" not in restarted
    _wait_until_settled(drive, restarted["execution_id"])
    linked = drive("GET", f"/api/executions/{dive['execution_id']}")
    assert linked["restarted_into"] == [restarted["execution_id"]]

    conn = resmon_mod._get_db()
    try:
        held = conn.execute(
            "INSERT INTO executions (execution_type, parameters, start_time, status) "
            "VALUES ('deep_dive', ?, '2026-10-28T00:00:00Z', 'running')",
            (json.dumps({"repository": "arxiv", "query": "z"}),)).lastrowid
        conn.commit()
    finally:
        resmon_mod._close_db(conn)
    progress_store.register(held)
    try:
        drive("POST", f"/api/executions/{held}/cancel")
    finally:
        progress_store.cleanup(held)
        conn = resmon_mod._get_db()
        try:
            conn.execute("UPDATE executions SET status = 'cancelled' WHERE id = ?", (held,))
            conn.commit()
        finally:
            resmon_mod._close_db(conn)


def _drive_collection_map(drive: Drive) -> None:
    """Both shapes the map has: ``fitting`` with empty columns, then ``ready``.

    Last in the scenario, because it adds papers with text: the papers above
    have titles only, and a map of papers it cannot place would never show the
    region and point shapes that are the reason to model this route.
    """
    conn = resmon_mod._get_db()
    topics = ("protein folding residue", "traffic congestion road", "quantum circuit qubit")
    for index in range(12):
        words = topics[index % 3]
        conn.execute(
            "INSERT INTO documents (source_repository, external_id, title, abstract, metadata_hash) "
            "VALUES ('arxiv', ?, ?, ?, ?)",
            (f"map-{index}", f"{words} study {index}", f"We examine {words} with a {words} benchmark.",
             f"map-{index}"))
    conn.commit()
    drive("GET", "/api/map")
    collection_map.wait(conn)
    ready = drive("GET", "/api/map")
    assert ready["state"] == "ready" and ready["points"]["id"], ready
    collection_map.forget(conn)


def _drive_appearance(drive: Drive) -> None:
    """An enum and a nullable color, and a PUT that answers what it stored.

    Read before a choice, where ``accent`` is null, and after one, where it is
    the lowercased string the PUT reported: the null and the string are the two
    shapes the field has.
    """
    drive("GET", "/api/appearance")
    drive("PUT", "/api/appearance", json={"theme": "dark", "accent": "#3D8AFF"})
    drive("GET", "/api/appearance")


def _drive_settings(drive: Drive) -> None:
    """Every stored group read, written and read again.

    Read first so the empty state is compared, written with values a real tab
    would send, and read again so the stored state is compared too. The second
    read is where a coercion shows up, and it is the half that matters here:
    six of these groups answer stored **strings**, ``execution`` answers
    **ints** and ``notifications`` answers a **bool**, and pydantic will take a
    string into an int or a bool without a word. An empty corpus answers ``""``
    and ``0`` for most of them, where a coercion is invisible; a stored ``"4"``
    behind ``max_concurrent_executions`` is where it is not.

    The embeddings page is driven across a lane being configured, because
    ``lane`` is ``null`` until one is and a scenario that only saw the null
    would never exercise ``EmbeddingLaneView`` at all. Same reasoning for the
    agent-CLI probe: the second read has an ``ai_cli_path`` stored, so the
    explicit-path branch of ``discover_cli`` is the one being described.
    """
    for group, body in (
        ("email", {"settings": {"smtp_server": "smtp.example.org",
                                "smtp_port": "587",
                                "smtp_username": "someone",
                                "smtp_from": "someone@example.org",
                                "smtp_to": "someone@example.org"}}),
        ("cloud", {"settings": {"cloud_provider": "gdrive",
                                "cloud_auto_backup": "1"}}),
        ("storage", {"settings": {"pdf_policy": "keep", "txt_policy": "keep",
                                  "archive_after_days": "30",
                                  "export_directory": ""}}),
        ("assistant", {"settings": {"assistant_runtime": "claude_cli",
                                    "assistant_provider": "claude_code",
                                    "assistant_model": "a-model",
                                    "assistant_effort": "medium"}}),
    ):
        drive("GET", f"/api/settings/{group}")
        drive("PUT", f"/api/settings/{group}", json=body)
        drive("GET", f"/api/settings/{group}")

    # notifications: the group whose read is a bool and an enum rather than
    # the stored strings its siblings answer.
    drive("GET", "/api/settings/notifications")
    drive("PUT", "/api/settings/notifications",
          json={"settings": {"notify_manual": False,
                             "notify_automatic_mode": "selected"}})
    drive("GET", "/api/settings/notifications")

    # execution: integers, and a PUT that echoes what it stored.
    drive("GET", "/api/settings/execution")
    drive("PUT", "/api/settings/execution",
          json={"max_concurrent_executions": 4, "routine_fire_queue_limit": 8})
    drive("GET", "/api/settings/execution")

    # ai, and the CLI probe either side of a configured path.
    drive("GET", "/api/settings/ai")
    drive("GET", "/api/settings/ai/cli-status")
    drive("PUT", "/api/settings/ai",
          json={"settings": {"ai_provider": "claude_code",
                             "ai_model": "a-model",
                             "ai_cli_path": "/nonexistent/claude",
                             "ai_effort": "medium",
                             "ai_chain": json.dumps([{"provider": "claude_code"}]),
                             "ai_default_models": json.dumps({"openai": "m"})}})
    drive("GET", "/api/settings/ai")
    drive("GET", "/api/settings/ai/cli-status")

    # embeddings: a page before a lane exists and a page after one does.
    before = drive("GET", "/api/settings/embeddings")
    assert before["lane"] is None, "the null-lane branch must be the first read"
    drive("PUT", "/api/settings/embeddings",
          json={"settings": {"embedding_enabled": "1",
                             "embedding_provider": "openai",
                             "embedding_model": "text-embedding-3-small",
                             "embedding_batch_size": "16"}})
    after = drive("GET", "/api/settings/embeddings")
    assert after["lane"], (
        "EmbeddingLaneView is only exercised when a lane is configured; this "
        "read must be the one that has one")


def _drive_reading_queue(drive: Drive, document_id: int) -> None:
    """Save a paper, list it, mark it read, take it out again.

    The page is read twice, once unfiltered and once with ``?status=``, so
    ``ReadingQueuePage.status`` is compared as ``null`` and as a string — the
    field that tells "everything" from "everything that happens to be unread".
    """
    drive("POST", "/api/reading-queue", expect=201,
          json={"document_id": document_id})
    page = drive("GET", "/api/reading-queue")
    assert page["entries"], "the page must have a row for its entry model to run"
    assert page["status"] is None
    filtered = drive("GET", "/api/reading-queue?status=to_read")
    assert filtered["status"] == "to_read"
    drive("PUT", f"/api/reading-queue/{document_id}", json={"status": "read"})
    drive("DELETE", f"/api/reading-queue/{document_id}")


def _drive_watchdog_and_first_run(drive: Drive) -> None:
    """Give the watchdog something to find, then mute it and let it go.

    Six recorded runs of one routine, the last three of them failures against
    one source and a second source that has only been seen twice: that is a
    ``broken`` finding and a row in ``not_enough_data`` at the same time, which
    is the pair of lists this report exists to keep apart. An empty
    ``findings`` would have let a model that dropped the whole list pass.

    The runs are stamped months back so the routine reads as overdue, which
    is the second finding and the one whose ``scope.id`` is an **integer**
    where the source finding's is a **string** — the reason both scopes are
    declared ``dict`` rather than modeled.
    """
    conn = resmon_mod._get_db()
    try:
        conn.execute(
            "INSERT INTO routines (name, schedule_cron, parameters, is_active) "
            "VALUES ('Nightly', '0 9 * * *', ?, 1)",
            (json.dumps({"keywords": ["x"], "repositories": ["arxiv", "pubmed"]}),))
        routine_id = conn.execute(
            "SELECT id FROM routines WHERE name = 'Nightly'").fetchone()["id"]
        for index in range(6):
            stamp = f"2026-0{index + 1}-01 00:00:00"
            conn.execute(
                "INSERT INTO executions (execution_type, status, parameters, "
                "start_time, end_time, result_count, new_result_count, routine_id) "
                "VALUES ('automated_sweep', 'completed', ?, ?, ?, 0, 0, ?)",
                (json.dumps({"keywords": ["x"]}), stamp,
                 f"2026-0{index + 1}-01 00:05:00", routine_id))
            exec_id = conn.execute(
                "SELECT MAX(id) AS m FROM executions").fetchone()["m"]
            conn.execute(
                "INSERT INTO execution_sources (execution_id, source, status, "
                "result_count, error_message, recorded_at) VALUES (?,?,?,?,?,?)",
                (exec_id, "arxiv", "error" if index > 2 else "ok", 0,
                 "upstream refused the connection" if index > 2 else None, stamp))
            if index < 2:
                conn.execute(
                    "INSERT INTO execution_sources (execution_id, source, status, "
                    "result_count, error_message, recorded_at) VALUES (?,?,?,?,?,?)",
                    (exec_id, "pubmed", "ok", 3, None, stamp))
        conn.commit()
    finally:
        resmon_mod._close_db(conn)

    report = drive("GET", "/api/watchdog")
    assert report["findings"], "the watchdog must have found something to report"
    assert report["not_enough_data"], (
        "the unjudged list must have a row; it is the half of this report that "
        "says silence has not been measured rather than that nothing is wrong")
    assert {f["severity"] for f in report["findings"]} >= {"broken"}

    key = report["findings"][0]["key"]
    drive("POST", "/api/watchdog/mute", json={"finding_key": key, "note": "known"})
    muted = drive("GET", "/api/watchdog")
    assert any(f["key"] == key and f["muted"] and f["muted_at"]
               for f in muted["findings"]), (
        "a muted finding must come back carrying both its mute flag and its "
        "timestamp; those are the two fields the mute round-trip adds")
    drive("POST", "/api/watchdog/unmute", json={"finding_key": key})

    # The first-run card again, now that the corpus has rows: ``show`` is false
    # where the call at the top of the scenario had it true.
    second_look = drive("GET", "/api/onboarding")
    assert second_look["show"] is False

    # And once more with the keyring refusing to answer, because a step's
    # ``done`` is three-valued and ``None`` is the state a model is most likely
    # to get wrong. ``done: bool`` was in fact what this file declared first,
    # and it turned this body into a 500 rather than mis-describing it — so the
    # case is driven here and not only in ``test_onboarding.py``.
    #
    # Patched by hand rather than with ``monkeypatch``: this is a module-scoped
    # fixture and the function-scoped one is not available in it.
    #
    # ``probe_credential`` is patched as well as ``keyring_is_responsive``, and
    # that is not belt and braces. ``_credential_present`` answers ``None``
    # only when *no* name in the set is present, so leaving the real probe in
    # place makes this assertion depend on whether some earlier test in the
    # session stored a key in the shared in-memory keyring. It passed alone and
    # failed in CI on all three Python versions for exactly that reason: by the
    # time the full suite reached this file, ``ai_key`` was present and only
    # ``repository_key`` came back undecided. The scenario now controls both
    # halves of the condition it is asserting about.
    original_responsive = resmon_mod.keyring_is_responsive
    original_probe = resmon_mod.probe_credential
    resmon_mod.keyring_is_responsive = lambda: False
    resmon_mod.probe_credential = lambda _name: "unreadable"
    try:
        unreadable = drive("GET", "/api/onboarding")
    finally:
        resmon_mod.keyring_is_responsive = original_responsive
        resmon_mod.probe_credential = original_probe
    undecided = [s["id"] for s in unreadable["steps"] if s["done"] is None]
    assert undecided == ["ai_key", "repository_key"], (
        "an unreadable keyring must leave both credential steps undecided; "
        f"this read left {undecided}")

    drive("POST", "/api/onboarding/dismiss")


def _drive_watches(drive: Drive, doc_ids: list[int]) -> None:
    """A watch: made, read, changed, paused and resumed, run now, its papers,
    where its report went, its coverage audit both ways, and its fires.

    The routine asks a source that needs a key, so its run is skipped at once
    and settles without the network, as the runs slice explains. Two papers
    the scenario already holds are then linked to that run, so the papers route
    answers ids rather than an empty list. Three destinations: a folder that
    exists, and two webhooks in review mode, so the record has two deliveries
    waiting for a person: one is skipped and retried, the other released. No
    drain runs in this suite, so nothing is sent anywhere.

    The coverage audit is read twice: with no intent and no embedding model,
    which is the reason sentence, and with an intent through the suite's
    loopback embedder and fourteen indexed results, which is the measured audit
    with its distribution and lists where this Python can load the vector index,
    and the sentence saying it cannot where it cannot. Last,
    the routine is resumed so the calendar promises its fires beside its run,
    and paused again.
    """
    import tempfile  # noqa: PLC0415
    from embedding_server import EmbeddingServer, deterministic_vector  # noqa: PLC0415
    from implementation_scripts import vector_index  # noqa: PLC0415

    profile = drive.client.post("/api/profiles", json={"kind": "person", "display_name": "Ada Watched"})
    assert profile.status_code == 201, profile.text
    # bioRxiv cannot be asked about an author, so a routine watching a person
    # through it alone is created with the sentence saying it will find nothing.
    person = drive("POST", "/api/routines", expect=201, json={
        "name": "a person, through a source that cannot ask", "schedule_cron": "0 7 * * 1",
        "parameters": {"repositories": ["biorxiv"],
                       "entity": {"profile_id": profile.json()["id"], "mode": "new_papers"}}})
    assert person.get("entity_warning"), person
    made = drive("POST", "/api/routines", expect=201, json={
        "name": "Perovskite films", "schedule_cron": "0 9 * * *",
        "parameters": {"repositories": ["springer"], "keywords": ["perovskite"],
                       "query": "perovskite", "max_results": 5},
        "is_active": False})
    assert "entity" not in made, made
    rid = made["id"]
    drive("GET", "/api/routines")
    drive("GET", f"/api/routines/{rid}")
    drive("PUT", f"/api/routines/{rid}", json={"intent": "Stable perovskite films.", "notify_on_complete": True})
    cleared = drive("PUT", f"/api/routines/{rid}", json={"intent": ""})
    assert "intent" in cleared and cleared["intent"] is None, cleared
    drive("POST", f"/api/routines/{rid}/activate")
    drive("POST", f"/api/routines/{rid}/deactivate")

    with tempfile.TemporaryDirectory() as folder:
        drive("POST", f"/api/routines/{rid}/delivery-targets",
              json={"channel": "folder", "target": folder, "mode": "automatic", "enabled": True})
        for n in range(2):
            drive("POST", f"/api/routines/{rid}/delivery-targets",
                  json={"channel": "webhook", "target": f"https://watch-{n}.invalid/hook",
                        "mode": "review", "enabled": True})
        drive("GET", f"/api/routines/{rid}/delivery-targets")

        started = drive("POST", f"/api/routines/{rid}/run")
        assert started["was_inactive"] is True, started
        _wait_until_settled(drive, started["execution_id"])
        conn = resmon_mod._get_db()
        try:
            for doc in doc_ids:
                conn.execute("INSERT OR IGNORE INTO execution_documents (execution_id, document_id) "
                             "VALUES (?, ?)", (started["execution_id"], doc))
            conn.commit()
        finally:
            resmon_mod._close_db(conn)
        papers = drive("GET", f"/api/routines/{rid}/documents")
        assert sorted(papers["document_ids"]) == sorted(doc_ids) and papers["total"] == len(doc_ids), papers
        nights = drive("GET", "/api/executions", params={"routine_id": rid})
        assert [row["id"] for row in nights] == [started["execution_id"]], nights

        record = drive("GET", f"/api/routines/{rid}/deliveries")
        held = [d["id"] for d in record["deliveries"] if d["state"] == "awaiting_review"]
        assert len(held) == 2, record
        drive("POST", f"/api/deliveries/{held[0]}/skip")
        drive("POST", f"/api/deliveries/{held[0]}/retry")
        drive("POST", f"/api/deliveries/{held[1]}/deliver")
        drive("GET", f"/api/routines/{rid}/deliveries")

    unmeasured = drive("GET", f"/api/routines/{rid}/coverage")
    assert unmeasured["intent_source"] == "keywords" and unmeasured["reason"], unmeasured
    with EmbeddingServer() as server:
        model = "scenario-model"
        made_lane = drive.client.put("/api/settings/embeddings", json={"settings": {
            "embedding_enabled": "true", "embedding_provider": "local",
            "embedding_model": model, "embedding_endpoint": server.base_url}})
        assert made_lane.status_code == 200, made_lane.text
        # Fourteen more of the run's papers, every one embedded and indexed: the
        # audit draws a distribution only from twelve or more, and the papers
        # the collection slice embedded are outside this routine, so they are
        # what the missed list can name.
        conn = resmon_mod._get_db()
        try:
            measurable = vector_index.load_extension(conn) is not None
            for n in range(14):
                doc = conn.execute(
                    "INSERT INTO documents (source_repository, external_id, title, metadata_hash) "
                    "VALUES ('springer', ?, ?, ?)",
                    (f"watch-{n}", f"Perovskite film {n}", f"watch-{n}")).lastrowid
                conn.execute("INSERT INTO execution_documents (execution_id, document_id) VALUES (?, ?)",
                             (started["execution_id"], doc))
                vector = deterministic_vector(f"perovskite film {n}", server.dims)
                conn.execute(
                    "INSERT INTO document_embeddings (document_id, model, dims, vector, fields) "
                    "VALUES (?, ?, ?, ?, 'title+abstract')",
                    (doc, model, len(vector), vector_index.pack_vector(vector)))
            if measurable:
                rebuilt = vector_index.rebuild(conn, model)
                assert rebuilt["ok"], rebuilt
            conn.commit()
        finally:
            resmon_mod._close_db(conn)
        drive.client.put(f"/api/routines/{rid}", json={"intent": "Stable perovskite films."})
        measured = drive("GET", f"/api/routines/{rid}/coverage")
        if measurable:
            assert measured["distribution"] and measured["off_target"], measured
        else:
            assert "cannot load" in measured["reason"], measured
        drive.client.put("/api/settings/embeddings", json={"settings": {"embedding_enabled": "false"}})

    drive("POST", f"/api/routines/{rid}/activate")
    events = drive("GET", "/api/calendar/events")
    kinds = {event["status"] for event in events if event.get("routine_id") == rid}
    assert {"scheduled"} < kinds, kinds
    drive("POST", f"/api/routines/{rid}/deactivate")


def _drive_scheduler(drive: Drive) -> None:
    """Whether routines will fire, asked with one active routine to answer for.

    This module's backend starts no scheduler, so the routine's verdict is a
    ``False`` with a reason rather than an empty list: the model is compared
    against a body that carries every field. The routine is made with a bare
    request because ``POST /api/routines`` declares no model and ``drive``
    records only routes that do.
    """
    made = drive.client.post("/api/routines", json={
        "name": "Fires or not",
        "schedule_cron": "0 8 * * *",
        "parameters": {"query": "x", "repositories": ["arxiv"]},
        "is_active": True,
    })
    assert made.status_code == 201, made.text
    status = drive("GET", "/api/scheduler/status")
    assert status["routines"], "the verdict list needs a routine to be evidence"


def _drive_configurations(drive: Drive) -> None:
    """Create one, rename it, rewrite it, export it, delete it, import it back.

    The two PUTs are the point. One sends a name alone and the other sends a
    name and parameters, so the same route answers two and three keys on the
    same corpus — which is what ``response_model_exclude_unset=True`` is for,
    and what a model serializing its defaults would have flattened into three
    keys both times.

    The round trip through the zip is a real one: the file the export wrote is
    the file the import reads, so the two routes are checked against each other
    rather than against a fixture.
    """
    import zipfile  # noqa: PLC0415 — only this slice needs it

    drive("GET", "/api/configurations")
    made = drive("POST", "/api/configurations", expect=201,
                 json={"name": "Nightly sweep", "config_type": "manual_sweep",
                       "parameters": {"keywords": ["x"], "repositories": ["arxiv"]}})
    config_id = made["id"]
    listed = drive("GET", "/api/configurations")
    assert listed and isinstance(listed[0]["parameters"], dict), (
        "the list route parses the parameters column; that is the half of the "
        "asymmetry with the PUT below that has to be real for either model to "
        "be right")

    renamed = drive("PUT", f"/api/configurations/{config_id}",
                    json={"name": "Nightly sweep, renamed"})
    assert set(renamed) == {"id", "name"}, (
        "a rename must answer two keys; a third means a default was invented")
    rewritten = drive("PUT", f"/api/configurations/{config_id}",
                      json={"name": "Nightly sweep",
                            "parameters": {"keywords": ["y"],
                                           "repositories": ["arxiv"]}})
    assert set(rewritten) == {"id", "name", "parameters"}
    assert isinstance(rewritten["parameters"], str), (
        "the write route echoes the stored text, not the parsed object")

    exported = drive("POST", "/api/configurations/export", json={"ids": [config_id]})
    archive = Path(exported["path"])
    assert archive.exists(), "the export must have written the file it names"
    with zipfile.ZipFile(archive) as bundle:
        members = [(name, bundle.read(name)) for name in bundle.namelist()]
    assert members, "the exported archive must carry the configuration"

    drive("DELETE", f"/api/configurations/{config_id}")
    result = drive(
        "POST", "/api/configurations/import",
        files=[("files", (name, data, "application/json")) for name, data in members])
    assert result["imported"] == 1, (
        "the import must have taken the exported file back in; a zero here "
        "means the two routes were never checked against each other")


# ---------------------------------------------------------------------------
# 1 — the bodies are identical
# ---------------------------------------------------------------------------

def test_every_modeled_route_answers_exactly_what_its_handler_returned(driven):
    """The mechanism. Body with the model == body without one, key for key.

    ``jsonable_encoder(raw)`` is not an approximation of the old behavior: it
    is the function FastAPI calls when ``response_model`` is ``None``, so the
    left-hand side of this comparison is literally what the route answered
    before this change.
    """
    problems: list[str] = []
    for (method, path), calls in sorted(driven.calls.items()):
        for index, (raw, body) in enumerate(calls):
            for line in differences(jsonable_encoder(raw), body):
                problems.append(f"{method} {path} (call {index + 1}) {line}")
    assert not problems, (
        f"{len(problems)} field(s) changed between the handler and the wire:\n"
        + "\n".join(problems))


def test_the_bytes_are_identical_too_and_not_only_the_fields(driven):
    """The stronger claim: the same keys, in the same order, as the same text.

    The sweep above compares parsed JSON, which is the property that matters —
    object key order carries no meaning and no sane client depends on it. But
    the models were written in each handler's own field order, and while that
    holds the reply is the same *bytes* it was before, so a client diffing two
    recorded responses sees nothing at all. This pins it.

    ``separators`` and ``ensure_ascii`` are Starlette's own, from
    ``JSONResponse.render``; the right-hand side is therefore exactly the text
    a route with no ``response_model`` would have produced. If reordering a
    model's fields turns this red and the order was deliberate, this is a test
    to relax rather than a change to revert — it is the weaker property that is
    load-bearing.
    """
    problems: list[str] = []
    for (method, path), texts in sorted(driven.wire.items()):
        for index, text in enumerate(texts):
            raw, _body = driven.calls[(method, path)][index]
            expected = json.dumps(
                jsonable_encoder(raw), separators=(",", ":"), ensure_ascii=False)
            if text == expected:
                continue
            # Key order is only one way these two can differ, and printing the
            # two key lists for any other cause prints two identical lines and
            # tells the reader nothing. Ask ``differences`` first: when it has
            # something to say, it is the real answer and the ordering is a
            # red herring.
            semantic = differences(json.loads(expected), json.loads(text))
            if semantic:
                problems.append(
                    f"{method} {path} (call {index + 1}): the bodies differ in "
                    f"content, not merely in key order — "
                    + "; ".join(semantic))
            else:
                # Same content, so the difference is ordering — and it may be
                # ordering deep inside a nested object, where the top-level key
                # lists are identical and printing them says nothing. Point at
                # the first character that differs instead.
                at = next((i for i, (x, y) in enumerate(zip(expected, text))
                           if x != y), min(len(expected), len(text)))
                start = max(0, at - 40)
                problems.append(
                    f"{method} {path} (call {index + 1}): same content, "
                    f"different key order, first differing at character {at}.\n"
                    f"    handler : ...{expected[start:at + 60]}\n"
                    f"    wire    : ...{text[start:at + 60]}")
    assert not problems, "\n".join(problems)


def test_the_delete_route_carries_its_detail_only_when_there_is_one(driven):
    """The conditional body, which is where a default would have been invented.

    Named separately from the equality sweep because the sweep would still pass
    if both deletes happened to carry a detail — the property worth holding is
    that the two bodies differ in exactly this key.
    """
    calls = driven.calls[("DELETE", "/api/profiles/{profile_id}")]
    assert len(calls) == 2, "both branches of the delete body must be driven"
    unwatched, watched = (body for _raw, body in calls)
    assert "detail" not in unwatched, (
        "a profile nothing was watching must not grow a null detail")
    assert unwatched["routines_watching"] == []
    assert watched["detail"] and watched["routines_watching"]


# ---------------------------------------------------------------------------
# 2 — the comparison can fail
# ---------------------------------------------------------------------------

def _lossy_twin(model: type[BaseModel], drop: str) -> type[BaseModel]:
    """``model`` with one field removed and pydantic's own default config.

    Derived from the real model rather than written out, so this stays a twin
    of whatever the model becomes. ``extra="ignore"`` is not a strawman: it is
    what a ``BaseModel`` does when nobody says otherwise, and it is exactly the
    mistake ``LosslessModel`` exists to prevent.
    """
    fields: dict[str, Any] = {}
    for name, field in model.model_fields.items():
        if name == drop:
            continue
        annotation = field.annotation if field.annotation is not None else Any
        fields[name] = (Optional[annotation], None)
    return create_model(
        f"Lossy{model.__name__}", __config__=ConfigDict(extra="ignore"), **fields)


def test_a_model_that_drops_a_field_is_caught(driven):
    """Serve a real payload through a lossy twin and require the check to notice.

    For every modeled route, for every declared field of its model: take the
    payload that route really answered with, serve it through the same model
    with that one field taken out and ``extra="ignore"`` restored, and assert
    ``differences`` reports the loss and names the field, once per declared
    field of every modeled route. That volume is what makes the green in the
    test above mean something.

    A field the handler did not actually return on this payload is skipped: its
    removal cannot be observed in a body that never carried it, and asserting
    otherwise would be the test lying about its own reach. A route whose body
    is a bare list is probed through ``list[twin]`` on the same payload, so the
    three list-shaped routes are held to the same standard as the rest: that is
    where a dropped field is least visible, because the loss repeats in every
    row and the body still reads like a list of the right things.

    ``SCALAR_LIST_ROUTES`` is skipped, and that is not a loophole: a list of
    strings has no key, so there is nothing a response model could drop from
    it. ``test_every_modeled_route_resolves_to_the_lossless_base`` pins those
    routes to ``list[str]`` so one cannot grow keys here without being noticed.
    """
    checked = 0
    for (method, path), calls in sorted(driven.calls.items()):
        if (method, path) in SCALAR_LIST_ROUTES:
            continue
        route = modeled_routes()[(method, path)]
        declared = route.response_model
        models = _annotation_models(declared)
        assert len(models) == 1, (
            f"{method} {path}: this check probes one model per route and "
            f"{declared!r} resolves to {len(models)}")
        model = models[0]
        #: True when the route answers ``list[model]`` rather than ``model``.
        is_list = model is not declared
        raw, _body = calls[0]
        encoded = jsonable_encoder(raw)
        # The row a field has to be present in for its removal to be visible.
        sample = (encoded[0] if is_list and encoded else encoded)
        for name, field in model.model_fields.items():
            key = field.alias or name
            if not isinstance(sample, dict) or key not in sample:
                continue
            probe = FastAPI()
            twin = _lossy_twin(model, name)
            probe.add_api_route(
                "/probe", lambda raw=raw: raw, methods=["GET"],
                response_model=list[twin] if is_list else twin,
                response_model_exclude_unset=True)
            lossy = TestClient(probe).get("/probe").json()
            found = differences(encoded, lossy)
            assert found, (
                f"{method} {path}: dropping {key!r} from {model.__name__} "
                f"changed nothing the comparison could see, so the comparison "
                f"would not have caught it")
            assert any(f".{key}:" in line and "dropped" in line for line in found), (
                f"{method} {path}: dropping {key!r} was noticed but not named; "
                f"the report said {found}")
            checked += 1
    assert checked >= 170, (
        f"only {checked} field removals were observable; the scenario's payloads "
        f"are too thin to be evidence that the comparison works")


# ---------------------------------------------------------------------------
# 3 — losslessness by construction, on models nobody has written yet
# ---------------------------------------------------------------------------

def _reachable_models(model: Any, seen: Optional[set] = None) -> set:
    """Every ``BaseModel`` reachable from a response model, itself included.

    Walks annotations rather than only the top level, because ``extra="allow"``
    on an outer model does nothing for a field inside a list of inner ones —
    and the inner model is where a field is most easily forgotten.
    """
    seen = set() if seen is None else seen
    for candidate in _annotation_models(model):
        if candidate in seen:
            continue
        seen.add(candidate)
        for field in candidate.model_fields.values():
            _reachable_models(field.annotation, seen)
    return seen


def _annotation_models(annotation: Any) -> list[type[BaseModel]]:
    """The ``BaseModel`` subclasses inside an annotation, however nested."""
    import typing  # noqa: PLC0415 — only this helper needs it

    if isinstance(annotation, type) and issubclass(annotation, BaseModel):
        return [annotation]
    out: list[type[BaseModel]] = []
    for arg in typing.get_args(annotation):
        out.extend(_annotation_models(arg))
    return out


def test_every_response_model_on_the_app_cannot_drop_a_field():
    """``extra="allow"`` on every model a route can reach, nested ones included."""
    offenders: list[str] = []
    for (method, path), route in sorted(modeled_routes().items()):
        for model in _reachable_models(route.response_model):
            if model.model_config.get("extra") != "allow":
                offenders.append(
                    f"{method} {path}: {model.__name__} has extra="
                    f"{model.model_config.get('extra', 'ignore')!r}, so a field "
                    f"it does not declare is dropped from the body")
    assert not offenders, "\n".join(sorted(set(offenders)))


def test_every_modeled_route_excludes_unset_fields():
    """The other half: a field the handler did not return is not invented.

    Without it, ``detail: Optional[str] = None`` puts ``"detail": null`` into
    every delete response, and a client that told the two cases apart by key
    presence stops being able to.
    """
    offenders = [
        f"{method} {path}"
        for (method, path), route in sorted(modeled_routes().items())
        if not route.response_model_exclude_unset
    ]
    assert not offenders, (
        "these routes declare a response model without "
        "response_model_exclude_unset=True, so an undeclared-but-defaulted "
        "field is serialized into a body the handler never produced: "
        + ", ".join(offenders))


def test_every_modeled_route_resolves_to_the_lossless_base():
    """The two guards above iterate a set. This is what stops it being empty.

    ``_reachable_models`` walks ``BaseModel`` subclasses, and returns nothing
    at all for a response type that is not one — a pydantic *dataclass*, a
    ``TypedDict``, a bare ``dict[str, int]``. Both guards then pass over an
    empty set and report green while the route quietly filters its body. A
    review of this file found that, and planting a pydantic dataclass on
    ``GET /api/profiles/{profile_id}`` reproduces it: both guards stay green
    and the route answers 200 carrying 2 of a watch profile's 11 keys, having
    dropped ``basis_warning`` among the nine. The equality sweep above did
    catch it, which is the argument for having four of these rather than one —
    and not an argument for leaving three of them asleep.

    So: a modeled route's response type must resolve to at least one model,
    and every model it resolves to must be a ``LosslessModel``. A response type
    that resolves to none of them has not been thought about, and the two
    guards above cannot say anything true about it.
    """
    unresolved: list[str] = []
    strays: list[str] = []
    mispinned: list[str] = []
    for (method, path), route in sorted(modeled_routes().items()):
        if (method, path) in SCALAR_LIST_ROUTES:
            # A list of strings has no key for a model to drop, so the guards
            # in this section genuinely have nothing to check. Pin the shape
            # instead: a route that quietly starts answering objects stops
            # being ``list[str]`` and reddens here rather than slipping past
            # every structural guard in the file.
            if route.response_model != list[str]:
                mispinned.append(f"{method} {path} -> {route.response_model!r}")
            continue
        top = _annotation_models(route.response_model)
        if not top:
            unresolved.append(f"{method} {path} -> {route.response_model!r}")
            continue
        for model in top:
            if not issubclass(model, response_models.LosslessModel):
                strays.append(f"{method} {path} -> {model.__name__}")
    assert not unresolved, (
        "these routes declare a response type that resolves to no pydantic "
        "model, so every structural guard in this file passes over them "
        "without checking anything: " + ", ".join(unresolved))
    assert not strays, (
        "these routes resolve to a model that is not a LosslessModel: "
        + ", ".join(strays))
    assert not mispinned, (
        "these routes are listed in SCALAR_LIST_ROUTES, which claims they "
        "answer a bare list of strings, and they do not: " + ", ".join(mispinned))


def test_every_response_model_inherits_the_lossless_base():
    """Config by inheritance, not by copy-paste.

    ``extra="allow"`` spelled out on each model would pass the test above and
    still leave the next author to remember it. The base class is the thing
    that carries the reason, and this is what keeps models attached to it.
    """
    strays = sorted({
        model.__name__
        for route in modeled_routes().values()
        for model in _reachable_models(route.response_model)
        if not issubclass(model, response_models.LosslessModel)
    })
    assert not strays, (
        "these response models do not inherit LosslessModel: " + ", ".join(strays))


# ---------------------------------------------------------------------------
# 4 — the registry and its denominator
# ---------------------------------------------------------------------------

def test_every_modeled_route_is_driven_by_this_file(driven):
    """A model added without a case here is a red test, not an untested claim."""
    missing = sorted(set(modeled_routes()) - set(driven.calls))
    assert not missing, (
        "these routes declare a response model that nothing in this file "
        "compares against its handler's own output: "
        + ", ".join(f"{m} {p}" for m, p in missing))


def test_the_modeled_surface_is_exactly_what_is_declared():
    """The fence, widened without being removed.

    The pilot asserted that every modeled route began with ``/api/profiles``.
    That had teeth exactly once: the first time a second slice landed, the
    assertion had to go, and an assertion that is deleted to make a change pass
    protects nothing afterwards. What replaces it is the same shape of claim
    made about a list that moves with the rollout — the modeled set is
    ``THE_MODELED_SURFACE``, slice for slice, route for route.

    So a route that grows a ``response_model`` without a line in that table
    fails here, and a line in that table whose route lost its model fails here
    too. Both directions matter: the first is a surface widening nobody wrote
    down, the second is a model that was removed while the contract still
    promised it.

    No number is written out. The denominator is ``len(api_routes())`` and the
    numerator is read off the application, so neither needs a human to
    maintain it and neither can be right about a version of the app that no
    longer exists.
    """
    declared = {route for routes in THE_MODELED_SURFACE.values() for route in routes}
    # A route named in two slices would make the count disagree with the table
    # while every route still matched, which is the one way this could pass
    # while the table was wrong about itself.
    flat = [route for routes in THE_MODELED_SURFACE.values() for route in routes]
    assert len(flat) == len(declared), (
        "a route appears in more than one slice of THE_MODELED_SURFACE: "
        + ", ".join(sorted(f"{m} {p}" for m, p in
                           {r for r in flat if flat.count(r) > 1})))

    actual = set(modeled_routes())
    undeclared = sorted(actual - declared)
    unfulfilled = sorted(declared - actual)
    assert not undeclared, (
        "these routes declare a response model and no slice of "
        "THE_MODELED_SURFACE claims them, so the modeled surface grew without "
        "anybody saying so: "
        + ", ".join(f"{m} {p}" for m, p in undeclared))
    assert not unfulfilled, (
        "THE_MODELED_SURFACE claims these routes are modeled and they are not: "
        + ", ".join(f"{m} {p}" for m, p in unfulfilled))

    # Every declared route must exist. A typo in the table would otherwise show
    # up only as the two sets differing, which reads as a missing model.
    surface = set(api_contract_route_keys())
    unknown = sorted(declared - surface)
    assert not unknown, (
        "THE_MODELED_SURFACE names routes that are not on the app: "
        + ", ".join(f"{m} {p}" for m, p in unknown))


def test_the_slices_are_coherent_rather_than_a_scatter_of_routes():
    """A slice is a feature area, and the paths in it say which one.

    The rollout's unit is a slice with a scenario behind it, not a route
    somebody found easy. This holds the table to that: every route in a slice
    shares a path prefix with the rest of its slice, so a route modeled on its
    own has to be filed somewhere it does not belong before this passes.

    ``process identity and the catalogs`` is the exception and is named here
    rather than silently excused: five single-route reads that belong to no
    one feature and are the first thing every client calls.
    """
    scattered: list[str] = []
    for slice_name, routes in THE_MODELED_SURFACE.items():
        if slice_name == "process identity and the catalogs":
            continue
        prefixes = {"/".join(path.split("/")[:3]) for _m, path in routes}
        if len(prefixes) != 1:
            scattered.append(f"{slice_name}: {sorted(prefixes)}")
    assert not scattered, (
        "these slices span more than one path prefix, so they are not one "
        "feature area: " + "; ".join(scattered))


def test_the_contract_reports_the_same_count_this_file_does():
    """``http.md``'s response-schema paragraph is generated, not asserted.

    It used to say "not one of the 184 routes declares a response_model",
    which was true when it was written and is the kind of sentence that stays
    on the page long after it stops being true. The generator now counts.
    """
    from implementation_scripts import api_contract  # noqa: PLC0415

    assert api_contract.modeled_route_count() == len(modeled_routes())


# ---------------------------------------------------------------------------
# The one field this whole journey exists to carry
# ---------------------------------------------------------------------------

def test_the_basis_warning_survives_every_route_that_returns_a_profile(driven):
    """A regression guard aimed at the field, not at the mechanism.

    ``basis_warning`` is computed on every read and stored nowhere. It is the
    sentence that says every match for this profile will be name-only, and it
    is the exact shape of field — derived, not a column — that a model written
    from the database schema would have left out.
    """
    for route_key in (("GET", "/api/profiles"),
                      ("GET", "/api/profiles/starter")):
        for _raw, body in driven.calls[route_key]:
            assert body["profiles"], f"{route_key} returned nothing to check"
            for profile in body["profiles"]:
                assert "basis_warning" in profile, route_key
    for route_key in (("POST", "/api/profiles"),
                      ("GET", "/api/profiles/{profile_id}"),
                      ("PUT", "/api/profiles/{profile_id}")):
        for _raw, body in driven.calls[route_key]:
            assert "basis_warning" in body, route_key
    created = driven.calls[("POST", "/api/profiles")][0][1]
    assert "ORCID" in (created["basis_warning"] or ""), (
        "a profile with no identifier must still say what its matches can be")
    unwarned = driven.calls[("DELETE", "/api/profiles/{profile_id}")]
    assert unwarned, "the delete scenario must have run"


def test_what_an_undeclared_value_does_and_does_not_survive():
    """``extra="allow"`` guarantees the key. It does not guarantee the bytes.

    An extra is written by pydantic's inference serializer; an unmodeled
    route's body is written by FastAPI's ``jsonable_encoder``. They agree on
    everything the backend actually puts in a response — ``datetime``, ``date``,
    ``UUID``, ``set``, ``bytes``, ``Path`` — and disagree on three things. This
    pins all of it, so the table in ``response_models.py`` is checked rather
    than remembered, and so the next person to model a route meets the
    exception instead of only the rule.

    None of the three divergent cases is reachable today: there is no
    ``Decimal`` and no ``PurePath`` anywhere in the backend, and ``math.inf``
    appears only in ``api_base``'s rate-limiter arithmetic, never in a response
    dict. That is why this is a note to a future author and not a defect.
    """
    import math  # noqa: PLC0415 — only this test needs these
    from datetime import date, datetime  # noqa: PLC0415
    from decimal import Decimal  # noqa: PLC0415
    from pathlib import Path as ConcretePath, PurePosixPath  # noqa: PLC0415
    from uuid import UUID  # noqa: PLC0415

    from pydantic_core import PydanticSerializationError  # noqa: PLC0415

    class Shell(response_models.LosslessModel):
        declared: int

    def through_a_model(value):
        """The body a client gets when ``value`` rides along as an extra."""
        probe = FastAPI()
        probe.add_api_route(
            "/probe", lambda: {"declared": 1, "x": value}, methods=["GET"],
            response_model=Shell, response_model_exclude_unset=True)
        return TestClient(probe).get("/probe").json()["x"]

    def unmodeled(value):
        """The body the same handler gives with no response model at all."""
        probe = FastAPI()
        probe.add_api_route(
            "/probe", lambda: {"declared": 1, "x": value}, methods=["GET"])
        return TestClient(probe).get("/probe").json()["x"]

    # Agreement, on every type the backend actually returns.
    for value in (datetime(2026, 1, 2, 3, 4, 5), date(2026, 1, 2),
                  UUID("12345678-1234-5678-1234-567812345678"),
                  {1, 2}, b"ab", ConcretePath("/a/b"), None, "", 0, False):
        assert through_a_model(value) == unmodeled(value), value

    # 1. A Decimal keeps its trailing zero and stops being a number.
    assert unmodeled(Decimal("1.50")) == 1.5
    assert through_a_model(Decimal("1.50")) == "1.50"

    # 2. A *pure* path raises where the concrete Path two lines above is fine.
    #    The two look alike in a diff, which is what makes this worth pinning.
    with pytest.raises(PydanticSerializationError):
        through_a_model(PurePosixPath("/a/b"))
    assert unmodeled(PurePosixPath("/a/b")) == "/a/b"

    # 3. The one that goes the wrong way: a non-finite float is a 500 without
    #    a model, because json.dumps refuses it, and a silent null with one.
    for value in (math.inf, math.nan):
        assert through_a_model(value) is None
        with pytest.raises(ValueError):
            unmodeled(value)


def test_a_stored_row_the_model_cannot_read_is_a_500_and_not_a_wrong_body():
    """The second hazard, recorded rather than left to be found in the field.

    ``response_model`` does not only filter a reply — it *validates* one, and a
    value that fails validation is a ``ResponseValidationError``, which is a
    500. Before the model the same row came back as a 200 with an odd body.
    That is a behavior difference, on a path no resmon code can produce: the
    ``names`` column has held ``[{"value": ..., "script": ...}]`` since the
    table was created, ``watch_profiles._clean_names`` is its only writer, and
    no migration has ever reshaped it. A row in the pre-2.1 shape gets there by
    somebody editing the SQLite file.

    This test is here so that the difference is a decision somebody made and
    can find, not a surprise. If the decision changes — a route that answers
    what it has rather than failing — this is the test to change with it, and
    the error below is what it is trading away: a message naming the exact
    field, at the moment the shape stopped matching.
    """
    from fastapi.exceptions import ResponseValidationError  # noqa: PLC0415

    resmon_mod._db_path = ":memory:"
    resmon_mod._shared_conn = None
    resmon_mod._db_initialized = False
    client = TestClient(resmon_mod.app)
    created = client.post("/api/profiles", json={"display_name": "Jane"})
    assert created.status_code == 201, created.text
    profile_id = created.json()["id"]

    conn = resmon_mod._get_db()
    try:
        conn.execute("UPDATE watch_profiles SET names = ? WHERE id = ?",
                     (json.dumps(["Jane"]), profile_id))
        conn.commit()
    finally:
        resmon_mod._close_db(conn)

    with pytest.raises(ResponseValidationError) as caught:
        client.get(f"/api/profiles/{profile_id}")
    assert "names" in str(caught.value), (
        "the failure must name the field whose shape it could not read; a "
        "500 that does not is worse than the body it replaced")


def test_the_export_body_still_spells_its_version_key_schema(driven):
    """The aliased field. ``schema`` cannot be an attribute name in pydantic.

    The model declares ``schema_`` with ``alias="schema"``; if the alias were
    lost the exported file would gain a key no importer reads and lose the one
    it refuses on.
    """
    _raw, body = driven.calls[("GET", "/api/profiles/{profile_id}/export")][0]
    assert body["schema"] == wp.JSON_SCHEMA_VERSION
    assert "schema_" not in body
    assert "id" not in body, "an exported profile carries no row id"
