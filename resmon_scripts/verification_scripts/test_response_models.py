"""The response models do not change a single byte of a response body.

``response_model`` is the only thing in FastAPI that can take a field out of a
reply without anybody writing code to do so. A key the handler returned and the
model did not declare is dropped, with a 200 and no log line, and on a surface
of 184 routes whose bodies are dicts assembled across several modules that is a
functionality decrease waiting for one forgetful afternoon.

So the models arrive with a mechanism rather than on trust. This file is it.

What is asserted here
---------------------

1. **Equality, per route, on the same request.** Each modelled route is driven
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
   two together are what make the serialised body the handler's own key set:
   the first stops a key being dropped, the second stops one being invented at
   its default. Both are read off the application, so a twelfth model added
   next month is held to this standard without its author reading anything.

4. **Coverage of the registry.** Every route on the app that declares a
   response model must be exercised by the scenario below. A model added
   without a case is a red test rather than an untested claim.

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
import sys
from pathlib import Path
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


def modelled_routes() -> dict[tuple[str, str], APIRoute]:
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
# One scenario, driving every modelled route against a seeded corpus
# ---------------------------------------------------------------------------

class Drive:
    """A client that records what each handler returned beside what it sent."""

    def __init__(self, client: TestClient, captured: list) -> None:
        self.client = client
        self.captured = captured
        #: ``(method, path)`` -> list of ``(raw return, response body)``.
        self.calls: dict[tuple[str, str], list[tuple[Any, Any]]] = {}

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
        return body


@pytest.fixture(scope="module")
def driven() -> Drive:
    """Drive all eleven J07 routes once, recording raw returns beside bodies.

    Module-scoped because the scenario is a sequence — a profile is created,
    matched, read, exported, imported, and finally deleted twice over, once
    with a routine watching it and once without — and because the lossy-twin
    test needs the same real payloads this one compares.
    """
    resmon_mod._db_path = ":memory:"
    resmon_mod._shared_conn = None
    resmon_mod._db_initialized = False
    client = TestClient(resmon_mod.app)

    # ``APIRoute`` is unhashable, and one route object serves several
    # ``(method, path)`` keys only when it declares several methods — none here
    # does, but deduplicating by identity costs nothing and keeps a second
    # recorder off a route if one ever does.
    unique = list({id(r): r for r in modelled_routes().values()}.values())
    with recording(unique) as captured:
        drive = Drive(client, captured)

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
        # the key out altogether, and a model that serialised its default would
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

        yield drive


# ---------------------------------------------------------------------------
# 1 — the bodies are identical
# ---------------------------------------------------------------------------

def test_every_modelled_route_answers_exactly_what_its_handler_returned(driven):
    """The mechanism. Body with the model == body without one, key for key.

    ``jsonable_encoder(raw)`` is not an approximation of the old behaviour: it
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

    For every modelled route, for every declared field of its model: take the
    payload that route really answered with, serve it through the same model
    with that one field taken out and ``extra="ignore"`` restored, and assert
    ``differences`` reports the loss and names the field. Nine routes' worth of
    this is what makes the green in the test above mean something.

    A field the handler did not actually return on this payload is skipped: its
    removal cannot be observed in a body that never carried it, and asserting
    otherwise would be the test lying about its own reach.
    """
    checked = 0
    for (method, path), calls in sorted(driven.calls.items()):
        route = modelled_routes()[(method, path)]
        model = route.response_model
        raw, _body = calls[0]
        encoded = jsonable_encoder(raw)
        for name, field in model.model_fields.items():
            key = field.alias or name
            if not isinstance(encoded, dict) or key not in encoded:
                continue
            probe = FastAPI()
            twin = _lossy_twin(model, name)
            probe.add_api_route(
                "/probe", lambda raw=raw: raw, methods=["GET"],
                response_model=twin, response_model_exclude_unset=True)
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
    assert checked >= 40, (
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
    for (method, path), route in sorted(modelled_routes().items()):
        for model in _reachable_models(route.response_model):
            if model.model_config.get("extra") != "allow":
                offenders.append(
                    f"{method} {path}: {model.__name__} has extra="
                    f"{model.model_config.get('extra', 'ignore')!r}, so a field "
                    f"it does not declare is dropped from the body")
    assert not offenders, "\n".join(sorted(set(offenders)))


def test_every_modelled_route_excludes_unset_fields():
    """The other half: a field the handler did not return is not invented.

    Without it, ``detail: Optional[str] = None`` puts ``"detail": null`` into
    every delete response, and a client that told the two cases apart by key
    presence stops being able to.
    """
    offenders = [
        f"{method} {path}"
        for (method, path), route in sorted(modelled_routes().items())
        if not route.response_model_exclude_unset
    ]
    assert not offenders, (
        "these routes declare a response model without "
        "response_model_exclude_unset=True, so an undeclared-but-defaulted "
        "field is serialised into a body the handler never produced: "
        + ", ".join(offenders))


def test_every_response_model_inherits_the_lossless_base():
    """Config by inheritance, not by copy-paste.

    ``extra="allow"`` spelled out on each model would pass the test above and
    still leave the next author to remember it. The base class is the thing
    that carries the reason, and this is what keeps models attached to it.
    """
    strays = sorted({
        model.__name__
        for route in modelled_routes().values()
        for model in _reachable_models(route.response_model)
        if not issubclass(model, response_models.LosslessModel)
    })
    assert not strays, (
        "these response models do not inherit LosslessModel: " + ", ".join(strays))


# ---------------------------------------------------------------------------
# 4 — the registry and its denominator
# ---------------------------------------------------------------------------

def test_every_modelled_route_is_driven_by_this_file(driven):
    """A model added without a case here is a red test, not an untested claim."""
    missing = sorted(set(modelled_routes()) - set(driven.calls))
    assert not missing, (
        "these routes declare a response model that nothing in this file "
        "compares against its handler's own output: "
        + ", ".join(f"{m} {p}" for m, p in missing))


def test_the_modelled_slice_is_the_watch_profiles_row_and_says_so():
    """The denominator, read from the app rather than counted by hand.

    Eleven of the 184 routes are modelled and they are all of J07. The number
    on the right is ``len(api_routes())``, so this test moves when the surface
    does; the number on the left is the count of routes declaring a model, so
    it moves when somebody models one. Neither is written down twice.
    """
    modelled = modelled_routes()
    assert len(api_routes()) == 184, (
        f"the surface is now {len(api_routes())} routes; every count in "
        f"docs/api-contract/ and in this file's docstring needs regenerating")
    assert len(modelled) == 11
    off_slice = sorted(p for _m, p in modelled if not p.startswith("/api/profiles"))
    assert not off_slice, (
        "the pilot slice is J07 alone; these modelled routes are outside it: "
        + ", ".join(off_slice))


def test_the_contract_reports_the_same_count_this_file_does():
    """``http.md``'s response-schema paragraph is generated, not asserted.

    It used to say "not one of the 184 routes declares a response_model",
    which was true when it was written and is the kind of sentence that stays
    on the page long after it stops being true. The generator now counts.
    """
    from implementation_scripts import api_contract  # noqa: PLC0415

    assert api_contract.modelled_route_count() == len(modelled_routes())


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
