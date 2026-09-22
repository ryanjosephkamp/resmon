# resmon_scripts/implementation_scripts/api_contract.py
"""The HTTP surface, described from the app itself rather than from memory.

``docs/api-contract/`` already held the MCP contract and five per-feature
contracts, each frozen for the duration of the work that needed both harnesses
at once. Nothing described the *whole* HTTP surface, and nothing went red when
one of its 184 routes changed shape. A renderer rebuild measured against a
surface nobody had written down would have had to rediscover it a screen at a
time, and would have had no way to tell a deliberate change from a slip.

This module is the generator. It reads the running FastAPI application — the
real one, imported in-process — and writes two committed files:

``docs/api-contract/openapi.json``
    ``app.openapi()``, normalised. Keys sorted so a diff is readable, and
    ``info.version`` removed because the app version bumps at every release
    while the contract does not.

``docs/api-contract/http.md``
    The index: one table per parity-register row, listing the routes that serve
    it, with the auth class, whether it streams, and a one-line purpose.

``verification_scripts/test_api_contract.py`` regenerates both in-process and
fails when they differ from what is committed, naming the routes rather than
printing one enormous assertion. A contract change therefore takes its own pull
request, which is the whole point: the seam moves visibly or not at all.

**What this module does not do.** It invents nothing. Not one of the 184 routes
declares a ``response_model``, so ``app.openapi()`` describes a 200 body as the
empty schema ``{}`` and this file leaves it that way. A route here is described
by its method, path, parameters and request body; what it *answers* with is
documented in prose in ``README.md`` and in the five feature contracts, and a
schema written here would be a guess dressed as a contract.
"""

from __future__ import annotations

import ast
import inspect
import json
import re
from pathlib import Path
from typing import Iterable, Optional

# ---------------------------------------------------------------------------
# Where the committed files live
# ---------------------------------------------------------------------------

#: ``resmon_scripts/implementation_scripts`` -> the repository root.
REPO_ROOT = Path(__file__).resolve().parents[2]
CONTRACT_DIR = REPO_ROOT / "docs" / "api-contract"
OPENAPI_PATH = CONTRACT_DIR / "openapi.json"
HTTP_INDEX_PATH = CONTRACT_DIR / "http.md"

#: The command a failing guard tells you to run.
REGENERATE_COMMAND = "python -m implementation_scripts.api_contract --write"


# ---------------------------------------------------------------------------
# The parity register
# ---------------------------------------------------------------------------
#
# The register itself is a planning document and does not live in this
# repository; what lives here is its identifier list, so the mapping below can
# be checked against something rather than against nobody. ``J27`` and ``J43``
# and their neighbours are as real as ``J01`` — a row with no route is listed
# as having none, which is information, not an omission.

REGISTER: tuple[tuple[str, str], ...] = (
    ("J01", "Deep Dive"),
    ("J02", "Deep Sweep"),
    ("J03", "Routines"),
    ("J04", "Background daemon"),
    ("J05", "Analytics"),
    ("J06", "Watchdog"),
    ("J07", "Watch profiles"),
    ("J08", "Author identity and entity search"),
    ("J09", "Semantic search"),
    ("J10", "Near-duplicate links"),
    ("J11", "Coverage audit"),
    ("J12", "Explorer"),
    ("J13", "The assistant (CLI lane)"),
    ("J14", "The assistant on a key"),
    ("J15", "First-run card"),
    ("J16", "Weekly live-network job"),
    ("J17", "AI summarization lanes"),
    ("J18", "Reports and exports"),
    ("J19", "Live monitoring"),
    ("J20", "Calendar"),
    ("J21", "Saved configurations"),
    ("J22", "Repositories and keys"),
    ("J23", "Notifications and email"),
    ("J24", "Google Drive backup"),
    ("J25", "In-app documentation"),
    ("J26", "Danger Zone"),
    ("J27", "Citation graph"),
    ("J28", "Reading queue"),
    ("J29", "Recorded-source coverage"),
    ("J30", "Runtime identity"),
    ("J31", "Readable Ask"),
    ("J32", "Chats and export"),
    ("J33", "Composer choices"),
    ("J34", "Owned Library"),
    ("J35", "Evidence workspace"),
    ("J36", "Selected-evidence answers"),
    ("J37", "Portable saved-answer HTML"),
    ("J38", "Interrupted runs and Restart"),
    ("J39", "One run per routine, one per submission, missed fires"),
    ("J40", "Delivery: where a report goes, and whether it got there"),
    ("J41", "Backup and restore"),
    ("J42", "Local API locked to this app"),
    ("J43", "Upgrade in place"),
    ("J44", "Driving resmon from an external harness (MCP)"),
)

#: ``J01`` -> ``Deep Dive``.
REGISTER_TITLES = dict(REGISTER)

#: The rows that are not carried by an HTTP route at all, with the reason a
#: reader deserves. Written out rather than inferred from an empty table: "no
#: route" and "nobody got round to mapping it" look identical otherwise.
ROWLESS_REASONS: dict[str, str] = {
    "J08": (
        "No route of its own. The capability is in the normaliser, the catalog's "
        "`entity_search` syntax and `api_base.search_entity`; it reaches a user "
        "through the routes of J01, J02 and J07."
    ),
    "J16": (
        "No route. A GitHub Actions workflow over `verification_scripts/live_suite.py` "
        "and `live_quarantine.json`."
    ),
    "J25": (
        "No route. The tutorials and every `PageHelp` entry are renderer assets, "
        "shipped inside the app rather than fetched."
    ),
    "J27": "No route. Recorded in the register as not carried forward.",
    "J43": (
        "No route. Migrations run inside `database.init_db` at start; the journey is "
        "exercised by `test_cumulative_upgrade.py` against a released fixture."
    ),
}


# ---------------------------------------------------------------------------
# The mapping
# ---------------------------------------------------------------------------
#
# ``(method, path)`` -> the register rows this route serves, most specific
# first. A route may serve several: ``GET /api/executions/{exec_id}`` is how
# Reports reads a run (J18), how the recorded-source coverage is read (J29) and
# how an interrupted run reports what stopped it (J38), and pretending it
# belongs to one of those would lose the other two.
#
# ``J44`` is deliberately absent here: the routes an external harness drives are
# read out of ``mcp_server.py`` by ``mcp_driven_routes()`` below rather than
# transcribed, so that table cannot go stale while the MCP server changes. The
# guard requires every route in ``app.routes`` to appear in this mapping, so a
# new route is a red test until somebody says which journey it serves.

ROUTE_JOURNEYS: dict[tuple[str, str], tuple[str, ...]] = {
    # --- Danger Zone -------------------------------------------------------
    ("POST", "/api/admin/erase-ai-keys"): ("J26",),
    ("POST", "/api/admin/erase-app-data"): ("J26",),
    ("POST", "/api/admin/erase-configs"): ("J26",),
    ("POST", "/api/admin/erase-corpus"): ("J26",),
    ("POST", "/api/admin/erase-execution-data"): ("J26",),
    ("POST", "/api/admin/erase-executions"): ("J26",),
    ("POST", "/api/admin/erase-repo-keys"): ("J26",),
    ("POST", "/api/admin/factory-reset"): ("J26",),
    ("POST", "/api/admin/reset-settings"): ("J26",),
    # --- AI lanes ----------------------------------------------------------
    ("POST", "/api/ai/models"): ("J17", "J14"),
    ("GET", "/api/settings/ai"): ("J17",),
    ("PUT", "/api/settings/ai"): ("J17",),
    ("GET", "/api/settings/ai/cli-status"): ("J13",),
    # --- Analytics ---------------------------------------------------------
    ("GET", "/api/analytics/discovery-lag"): ("J05",),
    ("GET", "/api/analytics/keyword-contribution"): ("J05",),
    ("GET", "/api/analytics/overview"): ("J05",),
    ("GET", "/api/analytics/publication-volume"): ("J05",),
    ("GET", "/api/analytics/routine-health"): ("J05",),
    ("GET", "/api/analytics/source-contribution"): ("J05",),
    ("GET", "/api/analytics/summary"): ("J05",),
    # --- The assistant -----------------------------------------------------
    ("POST", "/api/assistant/permissions"): ("J13",),
    ("POST", "/api/assistant/permissions/{request_id}"): ("J13",),
    ("GET", "/api/assistant/sessions"): ("J13", "J32"),
    ("POST", "/api/assistant/sessions"): ("J13",),
    ("GET", "/api/assistant/sessions/browse"): ("J32",),
    ("DELETE", "/api/assistant/sessions/{session_id}"): ("J32",),
    ("GET", "/api/assistant/sessions/{session_id}"): ("J13", "J32"),
    ("POST", "/api/assistant/sessions/{session_id}/cancel"): ("J13",),
    ("GET", "/api/assistant/sessions/{session_id}/export"): ("J32",),
    ("POST", "/api/assistant/sessions/{session_id}/messages"): ("J13", "J31", "J33"),
    ("GET", "/api/assistant/status"): ("J13", "J14"),
    ("GET", "/api/settings/assistant"): ("J13",),
    ("PUT", "/api/settings/assistant"): ("J13",),
    # --- The guard ---------------------------------------------------------
    ("POST", "/api/auth/renderer-origin"): ("J42",),
    # --- Backup and restore ------------------------------------------------
    ("POST", "/api/backup"): ("J41",),
    ("GET", "/api/backup/last"): ("J41",),
    ("POST", "/api/backup/verify"): ("J41",),
    ("POST", "/api/restore"): ("J41",),
    ("POST", "/api/restore/acknowledge"): ("J41",),
    ("POST", "/api/restore/cancel"): ("J41",),
    ("POST", "/api/restore/undo-copy/delete"): ("J41",),
    ("GET", "/api/settings/storage"): ("J41",),
    ("PUT", "/api/settings/storage"): ("J41",),
    # --- Calendar ----------------------------------------------------------
    ("GET", "/api/calendar/events"): ("J20",),
    # --- Google Drive backup ----------------------------------------------
    ("POST", "/api/cloud/backup"): ("J24",),
    ("POST", "/api/cloud/link"): ("J24",),
    ("GET", "/api/cloud/status"): ("J24",),
    ("POST", "/api/cloud/unlink"): ("J24",),
    ("GET", "/api/settings/cloud"): ("J24",),
    ("PUT", "/api/settings/cloud"): ("J24",),
    # --- Saved configurations ---------------------------------------------
    ("GET", "/api/configurations"): ("J21",),
    ("POST", "/api/configurations"): ("J21",),
    ("POST", "/api/configurations/export"): ("J21",),
    ("POST", "/api/configurations/import"): ("J21",),
    ("DELETE", "/api/configurations/{config_id}"): ("J21",),
    ("PUT", "/api/configurations/{config_id}"): ("J21",),
    # --- Repositories and keys --------------------------------------------
    ("GET", "/api/credentials"): ("J22",),
    ("POST", "/api/credentials/validate"): ("J22",),
    ("DELETE", "/api/credentials/{key_name}"): ("J22",),
    ("PUT", "/api/credentials/{key_name}"): ("J22",),
    ("GET", "/api/repositories/catalog"): ("J22",),
    ("GET", "/api/search/repositories"): ("J22", "J01", "J02"),
    # --- Delivery ----------------------------------------------------------
    ("GET", "/api/deliveries/{delivery_id}/bundle"): ("J40", "J42"),
    ("POST", "/api/deliveries/{delivery_id}/deliver"): ("J40",),
    ("POST", "/api/deliveries/{delivery_id}/retry"): ("J40",),
    ("POST", "/api/deliveries/{delivery_id}/skip"): ("J40",),
    ("GET", "/api/executions/{exec_id}/deliveries"): ("J40",),
    ("GET", "/api/routines/{routine_id}/deliveries"): ("J40",),
    ("GET", "/api/routines/{routine_id}/delivery-targets"): ("J40",),
    ("POST", "/api/routines/{routine_id}/delivery-targets"): ("J40",),
    ("DELETE", "/api/routines/{routine_id}/delivery-targets/{target_id}"): ("J40",),
    ("PUT", "/api/routines/{routine_id}/delivery-targets/{target_id}"): ("J40",),
    # --- One paper, three questions ---------------------------------------
    ("GET", "/api/documents/{doc_id}/lifecycle"): ("J06",),
    ("GET", "/api/documents/{doc_id}/why"): ("J12",),
    ("GET", "/api/documents/{document_id}/links"): ("J10",),
    ("GET", "/api/documents/{document_id}/similar"): ("J09",),
    # --- Semantic search ---------------------------------------------------
    ("POST", "/api/embeddings/backfill"): ("J09",),
    ("POST", "/api/embeddings/backfill/cancel"): ("J09",),
    ("GET", "/api/embeddings/estimate"): ("J09",),
    ("POST", "/api/embeddings/probe"): ("J09",),
    ("POST", "/api/embeddings/rebuild"): ("J09",),
    ("GET", "/api/embeddings/status"): ("J09",),
    ("GET", "/api/settings/embeddings"): ("J09",),
    ("PUT", "/api/settings/embeddings"): ("J09",),
    # --- Evidence workspace ------------------------------------------------
    ("GET", "/api/evidence/projects"): ("J35",),
    ("POST", "/api/evidence/projects"): ("J35",),
    ("GET", "/api/evidence/projects/{project_id}"): ("J35",),
    ("PATCH", "/api/evidence/projects/{project_id}"): ("J35",),
    ("POST", "/api/evidence/projects/{project_id}/bundle"): ("J35",),
    ("GET", "/api/evidence/projects/{project_id}/files"): ("J35",),
    ("POST", "/api/evidence/projects/{project_id}/files"): ("J35",),
    ("DELETE", "/api/evidence/projects/{project_id}/files/{file_id}"): ("J35",),
    ("GET", "/api/evidence/projects/{project_id}/notes"): ("J35",),
    ("POST", "/api/evidence/projects/{project_id}/notes"): ("J35",),
    ("PATCH", "/api/evidence/projects/{project_id}/notes/{note_id}"): ("J35",),
    ("GET", "/api/evidence/projects/{project_id}/reader/{file_id}"): ("J35",),
    # --- Selected-evidence answers, and the file one becomes ---------------
    ("POST", "/api/evidence/projects/{project_id}/answer-previews"): ("J36",),
    ("GET", "/api/evidence/projects/{project_id}/answers"): ("J36",),
    ("POST", "/api/evidence/projects/{project_id}/answers"): ("J36",),
    ("GET", "/api/evidence/projects/{project_id}/answers/{answer_id}"): ("J36",),
    ("POST", "/api/evidence/projects/{project_id}/answers/{answer_id}/cancel"): ("J36",),
    ("GET", "/api/evidence/projects/{project_id}/answers/{answer_id}/events"): ("J36",),
    ("GET", "/api/evidence/projects/{project_id}/answers/{answer_id}/export"): ("J37", "J36"),
    # --- Executions: history, reports, exports -----------------------------
    ("GET", "/api/executions"): ("J18",),
    ("POST", "/api/executions/export"): ("J18",),
    ("DELETE", "/api/executions/{exec_id}"): ("J18",),
    ("GET", "/api/executions/{exec_id}"): ("J18", "J29", "J38"),
    ("GET", "/api/executions/{exec_id}/documents"): ("J18",),
    ("GET", "/api/executions/{exec_id}/log"): ("J18",),
    ("GET", "/api/executions/{exec_id}/references"): ("J18",),
    ("GET", "/api/executions/{exec_id}/report"): ("J18",),
    ("GET", "/api/executions/{exec_id}/search-record"): ("J18", "J29"),
    ("POST", "/api/export/references"): ("J18",),
    # --- Live monitoring and restart ---------------------------------------
    ("GET", "/api/executions/active"): ("J19",),
    ("POST", "/api/executions/{exec_id}/cancel"): ("J19",),
    ("GET", "/api/executions/{exec_id}/progress/events"): ("J19", "J01", "J02"),
    ("GET", "/api/executions/{exec_id}/progress/stream"): ("J19", "J01", "J02"),
    ("POST", "/api/executions/{exec_id}/restart"): ("J38",),
    ("POST", "/api/renderer/heartbeat"): ("J38", "J30"),
    # --- Explorer ----------------------------------------------------------
    ("POST", "/api/explorer/export"): ("J12",),
    ("POST", "/api/explorer/facets"): ("J12",),
    ("POST", "/api/explorer/search"): ("J12", "J09"),
    # --- Runtime identity --------------------------------------------------
    ("GET", "/api/health"): ("J30",),
    # --- Owned Library -----------------------------------------------------
    ("GET", "/api/library"): ("J34",),
    ("GET", "/api/library/export"): ("J34",),
    ("GET", "/api/library/files"): ("J34",),
    ("POST", "/api/library/files"): ("J34",),
    ("GET", "/api/library/files/{file_id}"): ("J34",),
    ("POST", "/api/library/files/{file_id}/open"): ("J34",),
    ("POST", "/api/library/files/{file_id}/paper-links"): ("J34",),
    ("GET", "/api/library/files/{file_id}/text"): ("J34",),
    ("POST", "/api/library/vault"): ("J34",),
    # --- Watchdog and lifecycle -------------------------------------------
    ("GET", "/api/lifecycle"): ("J06",),
    ("POST", "/api/lifecycle/check"): ("J06",),
    ("POST", "/api/lifecycle/for-documents"): ("J06",),
    ("POST", "/api/lifecycle/stop"): ("J06",),
    ("GET", "/api/watchdog"): ("J06",),
    ("POST", "/api/watchdog/mute"): ("J06",),
    ("POST", "/api/watchdog/unmute"): ("J06",),
    # --- Near-duplicate links ----------------------------------------------
    ("POST", "/api/links/collapse-preview"): ("J10",),
    ("POST", "/api/links/for-documents"): ("J10",),
    ("POST", "/api/links/scan"): ("J10",),
    ("POST", "/api/links/scan/cancel"): ("J10",),
    ("GET", "/api/links/status"): ("J10",),
    # --- First-run card ----------------------------------------------------
    ("GET", "/api/onboarding"): ("J15",),
    ("POST", "/api/onboarding/dismiss"): ("J15",),
    # --- Watch profiles ----------------------------------------------------
    ("GET", "/api/profiles"): ("J07",),
    ("POST", "/api/profiles"): ("J07",),
    ("POST", "/api/profiles/import"): ("J07",),
    ("POST", "/api/profiles/matches/for-documents"): ("J07",),
    ("GET", "/api/profiles/starter"): ("J07",),
    ("DELETE", "/api/profiles/{profile_id}"): ("J07",),
    ("GET", "/api/profiles/{profile_id}"): ("J07",),
    ("PUT", "/api/profiles/{profile_id}"): ("J07",),
    ("GET", "/api/profiles/{profile_id}/export"): ("J07",),
    ("GET", "/api/profiles/{profile_id}/lifecycle"): ("J07", "J06"),
    ("GET", "/api/profiles/{profile_id}/matches"): ("J07",),
    # --- Reading queue -----------------------------------------------------
    ("GET", "/api/reading-queue"): ("J28",),
    ("POST", "/api/reading-queue"): ("J28",),
    ("DELETE", "/api/reading-queue/{document_id}"): ("J28",),
    ("PUT", "/api/reading-queue/{document_id}"): ("J28",),
    # --- Routines ----------------------------------------------------------
    ("GET", "/api/routines"): ("J03",),
    ("POST", "/api/routines"): ("J03",),
    ("DELETE", "/api/routines/{routine_id}"): ("J03",),
    ("GET", "/api/routines/{routine_id}"): ("J03", "J39"),
    ("PUT", "/api/routines/{routine_id}"): ("J03",),
    ("POST", "/api/routines/{routine_id}/activate"): ("J03",),
    ("POST", "/api/routines/{routine_id}/deactivate"): ("J03",),
    ("POST", "/api/routines/{routine_id}/run"): ("J03", "J39"),
    ("GET", "/api/routines/{routine_id}/coverage"): ("J11",),
    ("GET", "/api/scheduler/jobs"): ("J03",),
    # --- Manual runs -------------------------------------------------------
    ("POST", "/api/search/dive"): ("J01", "J39"),
    ("POST", "/api/search/sweep"): ("J02", "J39"),
    ("GET", "/api/settings/execution"): ("J39",),
    ("PUT", "/api/settings/execution"): ("J39",),
    # --- Background daemon -------------------------------------------------
    ("GET", "/api/service/daemon-status"): ("J04",),
    ("POST", "/api/service/install"): ("J04",),
    ("GET", "/api/service/status"): ("J04",),
    ("POST", "/api/service/uninstall"): ("J04",),
    # --- Notifications and email ------------------------------------------
    ("GET", "/api/settings/email"): ("J23",),
    ("PUT", "/api/settings/email"): ("J23",),
    ("POST", "/api/settings/email/test"): ("J23",),
    ("GET", "/api/settings/notifications"): ("J23",),
    ("PUT", "/api/settings/notifications"): ("J23",),
}


# ---------------------------------------------------------------------------
# Reading the running application
# ---------------------------------------------------------------------------

def _app():
    """The real FastAPI application, imported late.

    Late because ``resmon`` imports most of ``implementation_scripts`` and this
    module is part of that package: importing it at module scope would make the
    package's import graph depend on the app it describes.
    """
    import resmon  # noqa: PLC0415 — deliberate, see the docstring

    return resmon.app


def api_routes() -> list:
    """Every ``APIRoute`` on the app, in declaration order.

    The four non-``APIRoute`` entries FastAPI adds for its own docs
    (``/openapi.json``, ``/docs``, ``/docs/oauth2-redirect``, ``/redoc``) are
    not part of the surface any client uses and are left out.
    """
    from fastapi.routing import APIRoute  # noqa: PLC0415

    return [r for r in _app().routes if isinstance(r, APIRoute)]


def route_keys() -> list[tuple[str, str]]:
    """``(method, path)`` for every route, ``HEAD`` and ``OPTIONS`` excluded.

    FastAPI adds ``HEAD`` alongside ``GET`` on nothing here and Starlette
    answers ``OPTIONS`` from the CORS middleware, so neither is a declared part
    of the surface; excluding them keeps the count equal to the route count.
    """
    keys: list[tuple[str, str]] = []
    for route in api_routes():
        for method in sorted(route.methods or ()):
            if method in ("HEAD", "OPTIONS"):
                continue
            keys.append((method, route.path))
    return sorted(set(keys), key=lambda k: (k[1], k[0]))


def normalised_openapi() -> dict:
    """``app.openapi()`` with the version removed.

    ``info.version`` is ``config.APP_VERSION``, which moves at every release.
    A contract that changed on every release would say nothing about whether
    the *surface* changed, so it goes. ``info.title`` stays: it is stable and
    it names the document.
    """
    app = _app()
    # FastAPI caches the document on the app object. Clear it so a regeneration
    # inside a process that has already served ``/openapi.json`` reflects the
    # routes as they are now rather than as they were the first time.
    app.openapi_schema = None
    document = app.openapi()
    app.openapi_schema = None
    document = json.loads(json.dumps(document))  # a copy we may edit
    document.get("info", {}).pop("version", None)
    return document


def contract_json() -> str:
    """The bytes that belong in ``openapi.json``.

    ``sort_keys`` is the whole normalisation: pydantic and FastAPI emit keys in
    definition order, which is stable for a given version of both but reorders
    the moment a model's fields are rearranged for readability. Sorted, a diff
    shows what changed rather than where it moved to.
    """
    return json.dumps(
        normalised_openapi(), sort_keys=True, indent=2, ensure_ascii=False
    ) + "\n"


# ---------------------------------------------------------------------------
# Auth class, streaming, purpose — each read from the thing that decides it
# ---------------------------------------------------------------------------

_PARAM = re.compile(r"\{[^}]+\}")


def _concrete(path: str) -> str:
    """A path with its parameters filled in, for asking the guard about it.

    ``api_auth.AUTH_SIGNED_PATHS`` holds regexes matched against the *request*
    path, which carries real ids, not against FastAPI's ``{delivery_id}``
    template. ``1`` satisfies both the numeric patterns and the string ones, so
    substituting it lets the committed auth class be derived from the guard's
    own constants instead of transcribed from the prose.
    """
    return _PARAM.sub("1", path)


def auth_class(path: str) -> str:
    """Which credential opens this route, according to ``api_auth``."""
    from implementation_scripts import api_auth  # noqa: PLC0415

    concrete = _concrete(path)
    if concrete in api_auth.AUTH_EXEMPT_PATHS or path in api_auth.AUTH_EXEMPT_PATHS:
        return "exempt"
    if any(pattern.match(concrete) for pattern in api_auth.AUTH_SIGNED_PATHS):
        return "signed link"
    return "token"


def streams_sse(route) -> bool:
    """Does this endpoint answer with a Server-Sent Events stream?

    Read out of the endpoint's own source: whether a handler streams is decided
    by the ``media_type`` it passes to ``StreamingResponse``, and there is no
    declared response type to ask. A handler that starts streaming without the
    literal in its own body — by delegating to a helper — would be missed here,
    which is why the committed file is regenerated and diffed rather than
    trusted: the test is what notices.
    """
    try:
        source = inspect.getsource(route.endpoint)
    except (OSError, TypeError):  # pragma: no cover — every endpoint has source
        return False
    return "text/event-stream" in source


def purpose(route, operation: Optional[dict]) -> tuple[str, bool]:
    """A one-line purpose, and whether it came from a docstring.

    The first line of the endpoint's docstring where there is one. Where there
    is not, FastAPI's generated summary — the function name with underscores
    turned into spaces — which says less but says it honestly. The caller
    reports how many of each there are rather than letting the two look alike.
    """
    doc = inspect.getdoc(route.endpoint) or ""
    first = doc.strip().splitlines()[0].strip() if doc.strip() else ""
    if first:
        return first, True
    return ((operation or {}).get("summary") or route.name or "").strip(), False


# ---------------------------------------------------------------------------
# What an external harness drives
# ---------------------------------------------------------------------------

def _joined(node: ast.AST) -> Optional[str]:
    """A string literal or f-string, with ``{}`` where an expression went.

    ``f"/api/routines/{rid}/run"`` becomes ``/api/routines/{}/run``, which is
    the shape a FastAPI path template has once its parameter names are taken
    out — so the two can be compared without knowing what the MCP server calls
    its local variables.
    """
    if isinstance(node, ast.Constant) and isinstance(node.value, str):
        return node.value
    if isinstance(node, ast.JoinedStr):
        parts: list[str] = []
        for value in node.values:
            if isinstance(value, ast.Constant) and isinstance(value.value, str):
                parts.append(value.value)
            else:
                parts.append("{}")
        return "".join(parts)
    return None


def _path_tables(tree: ast.Module) -> dict[str, list[str]]:
    """Module-level dicts whose values are all ``/api/...`` strings.

    ``mcp_server._ANALYTICS_VIEWS`` maps the six public view names onto the six
    analytics routes, because three of the tool's names do not match the
    endpoint that serves them. A tool that looks a path up in such a table
    drives every route in it, and reading the table is the only way to say so
    without transcribing the list into this file.
    """
    tables: dict[str, list[str]] = {}
    for node in tree.body:
        if not isinstance(node, ast.Assign) or not isinstance(node.value, ast.Dict):
            continue
        values = [_joined(v) for v in node.value.values]
        if not values or not all(v and v.startswith("/api/") for v in values):
            continue
        for target in node.targets:
            if isinstance(target, ast.Name):
                tables[target.id] = [v for v in values if v]
    return tables


def _mcp_calls() -> tuple[list[tuple[str, str]], list[str]]:
    """Every ``(method, path)`` ``mcp_server.py`` asks the backend for.

    Parsed rather than transcribed, so the J44 table cannot drift while the MCP
    server changes. Every backend call in that module goes through one helper,
    ``backend.request(method, path, ...)``, with the method as a literal first
    argument — which is what makes the method knowable here. Matching on the
    path alone would have put ``DELETE /api/executions/{exec_id}`` in the table
    because ``GET`` on the same path is driven, and claiming an external harness
    drives a delete it does not is exactly the kind of overclaim this file
    exists to prevent.

    Returns ``(calls, unresolved)``. A path that is neither a literal, an
    f-string, nor a lookup into one of the module's path tables cannot be read
    statically; it is reported by the function it appears in rather than
    dropped, so the index can say what it did not see.
    """
    source = (REPO_ROOT / "resmon_scripts" / "mcp_server.py").read_text(encoding="utf-8")
    tree = ast.parse(source)
    tables = _path_tables(tree)

    calls: list[tuple[str, str]] = []
    unresolved: list[str] = []

    def scan(scope: ast.AST, where: str) -> None:
        # Local names that hold a path, in this scope only: one written out as a
        # literal or an f-string, or one looked up in a module path table. Both
        # shapes are in ``mcp_server.py`` today — ``t_get_execution`` builds its
        # path into a local because it sends it twice, and ``t_get_analytics``
        # looks one up by view name.
        bound: dict[str, list[str]] = {}
        for node in ast.walk(scope):
            if not isinstance(node, ast.Assign):
                continue
            names = [t.id for t in node.targets if isinstance(t, ast.Name)]
            if not names:
                continue
            value = node.value
            paths: list[str] = []
            literal = _joined(value)
            if literal and literal.startswith("/api/"):
                paths = [literal]
            elif (isinstance(value, ast.Call)
                    and isinstance(value.func, ast.Attribute)
                    and value.func.attr == "get"
                    and isinstance(value.func.value, ast.Name)
                    and value.func.value.id in tables):
                paths = tables[value.func.value.id]
            elif (isinstance(value, ast.Subscript)
                    and isinstance(value.value, ast.Name)
                    and value.value.id in tables):
                paths = tables[value.value.id]
            if paths:
                for name in names:
                    bound[name] = paths

        for node in ast.walk(scope):
            if not isinstance(node, ast.Call):
                continue
            func = node.func
            name = func.attr if isinstance(func, ast.Attribute) else (
                func.id if isinstance(func, ast.Name) else ""
            )
            if name != "request" or len(node.args) < 2:
                continue
            method = (_joined(node.args[0]) or "").upper()
            if not method:
                continue
            literal = _joined(node.args[1])
            if literal and literal.startswith("/api/"):
                calls.append((method, literal))
                continue
            arg = node.args[1]
            if isinstance(arg, ast.Name) and arg.id in bound:
                for path in bound[arg.id]:
                    calls.append((method, path))
                continue
            if isinstance(arg, ast.Name) and arg.id in tables:  # pragma: no cover
                for path in tables[arg.id]:
                    calls.append((method, path))
                continue
            unresolved.append(f"{method} in {where}")

    for node in tree.body:
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
            scan(node, f"`{node.name}`")
    # Calls outside any function body — none today, but a module-level probe
    # added later must not vanish from this account.
    module_level = ast.Module(
        body=[n for n in tree.body
              if not isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef))],
        type_ignores=[],
    )
    scan(module_level, "module scope")

    return sorted(set(calls)), sorted(set(unresolved))


def _template(path: str) -> str:
    """``/api/routines/{routine_id}/run`` -> ``/api/routines/{}/run``."""
    return _PARAM.sub("{}", path)


def mcp_driven_routes() -> tuple[set[tuple[str, str]], list[str]]:
    """The routes the MCP server drives, and the calls this cannot resolve.

    Returns ``(keys, uncertain)``. ``uncertain`` is not a failure: the MCP
    server builds its settings path from a tool argument, which is a real call
    against real routes and matches none of them as a template. It is named in
    the index rather than silently dropped.
    """
    by_template: dict[tuple[str, str], list[tuple[str, str]]] = {}
    for method, path in route_keys():
        by_template.setdefault((method, _template(path)), []).append((method, path))

    calls, unresolved = _mcp_calls()
    matched: set[tuple[str, str]] = set()
    uncertain: list[str] = [
        f"a `{note}` whose path this could not read statically" for note in unresolved
    ]
    for method, path in calls:
        hits = by_template.get((method, _template(path)))
        if hits:
            matched.update(hits)
        else:
            uncertain.append(f"`{method} {path}`")
    return matched, sorted(set(uncertain))


# ---------------------------------------------------------------------------
# Vocabularies
# ---------------------------------------------------------------------------

def _execution_statuses() -> tuple[str, ...]:
    """The ``executions.status`` CHECK values, parsed from the DDL that creates it.

    There is no Python tuple to import: the one authoritative spelling is the
    CHECK inside ``database._EXECUTIONS_V19_DDL``, which is also what the
    renderer's ``ExecutionStatusVocabulary.test.ts`` parses. Parsing the same
    string here means this document and that test agree by construction, and a
    status added to the schema turns both red rather than neither.
    """
    from implementation_scripts import database  # noqa: PLC0415

    match = re.search(
        r"status TEXT NOT NULL DEFAULT '[a-z_]+' CHECK\(status IN \(([^)]*)\)\)",
        database._EXECUTIONS_V19_DDL,
    )
    if match is None:  # pragma: no cover — the guard test asserts the parse
        raise RuntimeError(
            "the executions status CHECK is no longer where api_contract looks for it"
        )
    return tuple(
        value.strip().strip("'")
        for value in match.group(1).split(",")
        if value.strip()
    )


def _guard_refusals() -> tuple[tuple[int, str], ...]:
    """Every ``(status, reason)`` the guard can refuse with, from its own source.

    ``api_auth.check`` spells its four refusals as literal arguments to
    ``_refusal``; there is no constant to import. Walking the AST is the nearest
    thing to reading the list the code actually uses, and a fifth refusal added
    to ``check`` appears here without anybody remembering to add it.

    ``403 signature_invalid`` is deliberately not here: it is raised by the
    bundle route, which checks a different credential, not by the guard.
    """
    from implementation_scripts import api_auth  # noqa: PLC0415

    source = Path(inspect.getfile(api_auth)).read_text(encoding="utf-8")
    refusals: list[tuple[int, str]] = []
    for node in ast.walk(ast.parse(source)):
        if not isinstance(node, ast.Call):
            continue
        if not (isinstance(node.func, ast.Name) and node.func.id == "_refusal"):
            continue
        if len(node.args) < 2:
            continue
        status, reason = node.args[0], node.args[1]
        if isinstance(status, ast.Constant) and isinstance(reason, ast.Constant):
            refusals.append((int(status.value), str(reason.value)))
    return tuple(sorted(set(refusals), key=lambda r: (r[0], r[1])))


def vocabularies() -> list[tuple[str, str, tuple[str, ...]]]:
    """``(heading, where it comes from, values)`` for each closed vocabulary.

    Every list here is read from the object that defines it, so the committed
    document cannot disagree with the code: a value added by hand to
    ``http.md`` fails the guard, and a value added to the code turns the guard
    red until the document is regenerated.
    """
    from implementation_scripts import database  # noqa: PLC0415
    from implementation_scripts import delivery, zero_reason  # noqa: PLC0415

    return [
        (
            "Execution status",
            "the `executions.status` CHECK in `database._EXECUTIONS_V19_DDL`",
            _execution_statuses(),
        ),
        (
            "Interrupted reason",
            "`database.INTERRUPTED_REASONS`",
            tuple(database.INTERRUPTED_REASONS),
        ),
        (
            "Zero reason",
            "`zero_reason.ZERO_REASONS`",
            tuple(zero_reason.ZERO_REASONS),
        ),
        (
            "Zero reasons that mean the source did not answer",
            "`zero_reason.DID_NOT_ANSWER`",
            tuple(sorted(zero_reason.DID_NOT_ANSWER)),
        ),
        (
            "Delivery state",
            "`database.DELIVERY_STATES`",
            tuple(database.DELIVERY_STATES),
        ),
        (
            "Delivery channel",
            "`database.DELIVERY_CHANNELS`",
            tuple(database.DELIVERY_CHANNELS),
        ),
        (
            "Delivery channels with an adapter behind them",
            "`delivery.SHIPPED_CHANNELS`",
            tuple(delivery.SHIPPED_CHANNELS),
        ),
        (
            "Delivery target mode",
            "`database.DELIVERY_TARGET_MODES`",
            tuple(database.DELIVERY_TARGET_MODES),
        ),
        (
            "Guard refusal",
            "the `_refusal(...)` calls in `api_auth.check`",
            tuple(f"{status} {reason}" for status, reason in _guard_refusals()),
        ),
    ]


# ---------------------------------------------------------------------------
# Rendering the index
# ---------------------------------------------------------------------------

def _escape(text: str) -> str:
    """Make a docstring line safe inside a Markdown table cell.

    The backend's docstrings are written in reStructuredText, where a literal
    is ``double-backticked``. Left alone that renders in Markdown as an empty
    code span either side of the word, so the doubles are folded to singles
    here; the pipe is escaped because it would otherwise start a new cell.
    """
    return (
        text.replace("``", "`").replace("|", "\\|").replace("\n", " ").strip()
    )


def route_rows() -> list[dict]:
    """One row per ``(method, path)``, with everything the index prints."""
    document = normalised_openapi()
    paths = document.get("paths", {})
    by_key = {}
    for route in api_routes():
        for method in sorted(route.methods or ()):
            if method in ("HEAD", "OPTIONS"):
                continue
            by_key[(method, route.path)] = route

    mcp_keys, _unmatched = mcp_driven_routes()

    rows: list[dict] = []
    for method, path in route_keys():
        route = by_key[(method, path)]
        operation = (paths.get(path) or {}).get(method.lower())
        text, from_docstring = purpose(route, operation)
        journeys = list(ROUTE_JOURNEYS.get((method, path), ()))
        if (method, path) in mcp_keys and "J44" not in journeys:
            journeys.append("J44")
        rows.append({
            "method": method,
            "path": path,
            "auth": auth_class(path),
            "sse": streams_sse(route),
            "purpose": text,
            "from_docstring": from_docstring,
            "journeys": tuple(journeys),
        })
    return rows


def _table(rows: Iterable[dict]) -> list[str]:
    lines = [
        "| Method | Path | Auth | SSE | Purpose |",
        "| --- | --- | --- | --- | --- |",
    ]
    for row in rows:
        text = _escape(row["purpose"])
        if not row["from_docstring"]:
            text = f"*{text}*"
        lines.append(
            "| `{method}` | `{path}` | {auth} | {sse} | {purpose} |".format(
                method=row["method"],
                path=row["path"],
                auth=row["auth"],
                sse="yes" if row["sse"] else "—",
                purpose=text,
            )
        )
    return lines


def render_http_md() -> str:
    """The bytes that belong in ``http.md``."""
    rows = route_rows()
    total = len(rows)
    documented = sum(1 for row in rows if row["from_docstring"])
    mcp_keys, uncertain = mcp_driven_routes()
    by_journey: dict[str, list[dict]] = {}
    for row in rows:
        for journey in row["journeys"]:
            by_journey.setdefault(journey, []).append(row)
    carried = sum(1 for jid, _ in REGISTER if by_journey.get(jid))

    out: list[str] = []
    out.append("# The HTTP surface, by parity-register row")
    out.append("")
    out.append(
        "**Generated. Do not edit by hand.** `implementation_scripts/api_contract.py` "
        "writes this file from the running FastAPI application; "
        f"`verification_scripts/test_api_contract.py` regenerates it and fails on any "
        f"difference. Regenerate with `{REGENERATE_COMMAND}`."
    )
    out.append("")
    out.append(
        f"{total} routes, over {len(REGISTER)} register rows: {carried} rows are "
        f"carried by at least one route and {len(REGISTER) - carried} are not. Every "
        "route appears in at least one table — the guard fails when one does not."
    )
    out.append("")
    out.append("## How to read a row")
    out.append("")
    out.append(
        "**Auth.** `token` means the request must carry `Authorization: Bearer "
        "<this backend's token>`, a loopback `Host` on this backend's own port, and — "
        "when it is a browser request, which is to say when it carries an `Origin` — "
        "this app's renderer origin. The MCP server and Electron's main process send "
        "no `Origin` and are judged on the token alone. `signed link` means the guard "
        "lets the request past the token check and the route checks a per-destination "
        "HMAC instead. The full model, including what it does not defend, is "
        "[local-api-security.md](../local-api-security.md); the classes here are "
        "computed from `api_auth.AUTH_EXEMPT_PATHS` and `api_auth.AUTH_SIGNED_PATHS` "
        "rather than transcribed from that page."
    )
    out.append("")
    out.append(
        "**SSE.** `yes` means the handler answers with `text/event-stream`. The "
        "response is a sequence of events, not a JSON body, and a client that reads it "
        "with an ordinary fetch-and-parse will hang."
    )
    out.append("")
    out.append(
        f"**Purpose.** The first line of the endpoint's docstring, for the "
        f"{documented} of {total} routes that have one. The remaining "
        f"{total - documented} show FastAPI's generated summary instead, *in italics*: "
        "it is the function's own name with the underscores taken out, and it is here "
        "because an invented sentence would read like documentation without being any."
    )
    out.append("")
    out.append(
        "**No response schemas.** Not one of the "
        f"{total} routes declares a `response_model`, so `openapi.json` describes every "
        "200 body as the empty schema `{}`. What a route accepts — its path and query "
        "parameters and its request body — is fully described there; what it answers "
        "with is described in prose in [README.md](../../README.md) and in the five "
        "feature contracts beside this file. Nothing here guesses at a response shape."
    )
    out.append("")

    for jid, title in REGISTER:
        out.append(f"## {jid} — {title}")
        out.append("")
        journey_rows = by_journey.get(jid, [])
        if journey_rows:
            out.extend(_table(journey_rows))
        else:
            reason = ROWLESS_REASONS.get(jid)
            out.append(reason if reason else "No route serves this row.")
        if jid == "J42":
            out.append("")
            out.append(
                f"The guard is in front of all {total} routes, not only the two listed "
                "here: `AUTH_EXEMPT_PATHS` is an explicitly empty constant and a test "
                "fails if it grows. The two rows above are the routes that are *about* "
                "the guard — the one that registers a renderer origin (and refuses to "
                "do so for a request carrying an `Origin`, because a browser must not "
                "be able to widen the allowlist), and the one route that proves itself "
                "with a signature instead of the token."
            )
        if jid == "J44":
            out.append("")
            out.append(
                "Read out of `resmon_scripts/mcp_server.py` rather than transcribed: "
                "`api_contract.mcp_driven_routes()` parses every "
                "`backend.request(method, path)` call in that module — method "
                "included, so a path the harness only reads does not appear here as a "
                "path it also deletes — and matches each against the route table."
            )
            if uncertain:
                out.append("")
                out.append(
                    "Calls in `mcp_server.py` that resolve to no single route, and so "
                    "are not in the table above: "
                    + ", ".join(uncertain)
                    + ". The settings path is built from a tool argument and reaches "
                    "the `GET`/`PUT /api/settings/*` routes; it is named here rather "
                    "than dropped, because a table that quietly omits what it could "
                    "not read is worse than one that says so."
                )
        out.append("")

    out.append("## Closed vocabularies")
    out.append("")
    out.append(
        "Every list below is generated from the object named beside it and tested "
        "equal to it. A value added to the code and not to this file, or to this file "
        "and not to the code, is a failing test."
    )
    out.append("")
    for heading, origin, values in vocabularies():
        out.append(f"**{heading}** — from {origin}. {len(values)} values:")
        out.append("")
        out.append("".join(f"`{value}` · " for value in values).rstrip(" ·") or "(none)")
        out.append("")
    out.append(
        "`NULL` is a fourth value `interrupted_reason` may hold, and means the row was "
        "never interrupted rather than that the reason was lost. `not_recorded` is the "
        "tenth zero reason and means resmon did not observe why the source returned "
        "nothing; it is not a reason, and it is never rendered as one."
    )
    out.append("")
    out.append("## Admission, and the one 429")
    out.append("")
    out.append(
        "`POST /api/search/dive` and `POST /api/search/sweep` are refused `429` when "
        "the admission controller has no free slot for a manual run. The body is "
        "FastAPI's ordinary `{\"detail\": \"<sentence>\"}` — a sentence naming the "
        "current cap, not a code — and the answer carries `Retry-After: 5`. A "
        "resubmission of a run that is already going is answered with that run "
        "instead, before the cap is consulted: it is not new demand on capacity. "
        "Routine fires are not refused; they queue. The controller is "
        "`implementation_scripts/admission.py`, and the cap is "
        "`GET`/`PUT /api/settings/execution`."
    )
    out.append("")
    return "\n".join(out)


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------

def write() -> list[Path]:
    """Write both files. Returns the paths written."""
    CONTRACT_DIR.mkdir(parents=True, exist_ok=True)
    OPENAPI_PATH.write_text(contract_json(), encoding="utf-8")
    HTTP_INDEX_PATH.write_text(render_http_md(), encoding="utf-8")
    return [OPENAPI_PATH, HTTP_INDEX_PATH]


def main(argv: Optional[list[str]] = None) -> int:  # pragma: no cover — CLI
    import argparse  # noqa: PLC0415

    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument(
        "--write", action="store_true",
        help="regenerate docs/api-contract/openapi.json and http.md",
    )
    args = parser.parse_args(argv)
    if args.write:
        for path in write():
            print(f"wrote {path.relative_to(REPO_ROOT)}")
        return 0
    stale = [
        path.relative_to(REPO_ROOT)
        for path, expected in (
            (OPENAPI_PATH, contract_json()),
            (HTTP_INDEX_PATH, render_http_md()),
        )
        if not path.exists() or path.read_text(encoding="utf-8") != expected
    ]
    if stale:
        print("out of date: " + ", ".join(str(p) for p in stale))
        print(f"regenerate with: {REGENERATE_COMMAND}")
        return 1
    print("docs/api-contract/ matches the running application")
    return 0


if __name__ == "__main__":  # pragma: no cover — CLI
    import sys as _sys

    _sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
    raise SystemExit(main())
