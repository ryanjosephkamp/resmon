#!/usr/bin/env python3
"""One derived denominator for "how many routes does this app have".

Four places in this tree held that number by hand, and only one of them — the
API-contract guard — was the one anybody knew about. The other three were found
separately, by three different people, each time as a red that looked like a
real regression and each time turning out to be a counter nobody had been told
to move: ``test_selected_evidence_boundary.py``,
``frontend/e2e/watch-profiles.spec.ts`` (since retired) and
``test_response_models.py``.

Three derivations of the same number exist and none of them is a literal:

* ``app_total()`` — ``(method, path)`` off the running FastAPI app, which is
  what ``implementation_scripts/api_contract.py`` already computes for the
  generated documents;
* ``contract_total()`` — the committed ``docs/api-contract/openapi.json``,
  which ``test_api_contract.py`` regenerates and diffs on every run;
* ``declared_total()`` — the ``@app.<method>("...")`` decorators in the source
  of ``resmon.py``, read with ``ast``.

They are kept separate rather than collapsed because they can disagree, and
each disagreement means something different. The app against the contract is a
stale generated document. The app against the source is a route registered
somewhere other than a decorator. ``test_route_census.py`` requires all three
to match, so any test that needs the number can take whichever is cheapest for
it and be comparing against something real.

A test that wants to assert "exactly N routes" should call one of these instead
of typing N. A test that wants to assert a *change* — "seven routes were added
by this feature" — should say that as a subset of the keys, not as an
arithmetic fact about the total, because the total moves for reasons that have
nothing to do with the feature.
"""

from __future__ import annotations

import ast
import json
import sys
from functools import lru_cache
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parent.parent.parent
RESMON_SOURCE = PROJECT_ROOT / "resmon_scripts" / "resmon.py"
OPENAPI_PATH = PROJECT_ROOT / "docs" / "api-contract" / "openapi.json"

# The HTTP methods a route can be declared with as a decorator on the app.
# ``api_contract.route_keys`` drops HEAD and OPTIONS from its own count for the
# reason given there — nothing declares HEAD, and OPTIONS is answered by the
# CORS middleware — so neither appears here either.
_DECORATOR_METHODS = {"get", "post", "put", "patch", "delete"}


@lru_cache(maxsize=1)
def declared_routes() -> tuple[tuple[str, str], ...]:
    """``(method, path)`` for every ``@app.<method>("…")`` in ``resmon.py``.

    Parsed rather than imported, so a caller that only wants the number does
    not have to start the application to get it.
    """
    return declared_in(RESMON_SOURCE.read_text(encoding="utf-8"))


def declared_in(source: str) -> tuple[tuple[str, str], ...]:
    """The same parse over arbitrary source text.

    Separate from ``declared_routes`` so a test can drive it over the real
    ``resmon.py`` with one decorator taken out: a census that has never been
    seen to notice a missing route is somebody's word.
    """
    tree = ast.parse(source)
    found: list[tuple[str, str]] = []
    for node in ast.walk(tree):
        if not isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
            continue
        for decorator in node.decorator_list:
            if (
                isinstance(decorator, ast.Call)
                and isinstance(decorator.func, ast.Attribute)
                and isinstance(decorator.func.value, ast.Name)
                and decorator.func.value.id == "app"
                and decorator.func.attr in _DECORATOR_METHODS
                and decorator.args
                and isinstance(decorator.args[0], ast.Constant)
                and isinstance(decorator.args[0].value, str)
            ):
                found.append((decorator.func.attr.upper(), decorator.args[0].value))
    return tuple(sorted(set(found)))


@lru_cache(maxsize=1)
def contract_routes() -> tuple[tuple[str, str], ...]:
    """``(METHOD, path)`` for every operation in the committed contract.

    ``docs/api-contract/openapi.json`` is generated from the real application
    and ``test_api_contract.py`` fails when the committed copy is not a fresh
    generation, so reading it is reading the app one step removed — and it
    costs an import of ``json`` rather than an import of the whole backend.
    """
    document = json.loads(OPENAPI_PATH.read_text(encoding="utf-8"))
    return tuple(sorted(
        (method.upper(), path)
        for path, operations in document["paths"].items()
        for method in operations
        if method.lower() in _DECORATOR_METHODS
    ))


def app_routes() -> tuple[tuple[str, str], ...]:
    """``(METHOD, path)`` off the real FastAPI app, through the generator.

    Imported inside the function: it starts the backend, which is far more than
    a test asking only for a count should have to pay.
    """
    sys.path.insert(0, str(PROJECT_ROOT / "resmon_scripts"))
    from implementation_scripts import api_contract  # noqa: PLC0415

    return tuple(sorted(api_contract.route_keys()))


def declared_total() -> int:
    return len(declared_routes())


def contract_total() -> int:
    return len(contract_routes())


def app_total() -> int:
    return len(app_routes())


def main() -> int:                                   # pragma: no cover - entrypoint
    print(f"declared in resmon.py : {declared_total()}")
    print(f"committed contract    : {contract_total()}")
    print(f"the running app       : {app_total()}")
    return 0


if __name__ == "__main__":                           # pragma: no cover
    sys.exit(main())
