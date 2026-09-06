# resmon_scripts/mcp_server.py
"""resmon as an MCP server — contract v1.

Exposes resmon's capabilities as MCP tools over stdio, so a harness the user
already works in (Claude Code, Codex, anything speaking MCP) can read and drive
resmon without leaving it. The same surface is what phase 2.0's embedded
assistant consumes: built once, consumed twice.

The tool surface is frozen at ``docs/api-contract/mcp.md``. This module is built
against that document rather than the other way round, and every deviation
would be a contract change with its own pull request.

**It never opens the database.** It is an HTTP client of the running backend on
127.0.0.1. Two reasons, both concrete: the backend owns its connections, the
scheduler and admission control, and a second process writing that SQLite file
is the BUG-020 failure class over again; and going through the API means the
tool surface cannot drift from what the app itself does.

The cost is accepted and stated: **the backend must be running.** When it is
not, every tool returns one structured error rather than an empty result — a
harness told "you have no papers" because the app is closed would repeat that
to the user as fact, which is the one thing this surface must not make possible.

**No MCP SDK.** The protocol needed here is JSON-RPC 2.0 over stdin/stdout with
four methods, and resmon ships a bundled interpreter where every dependency
costs real megabytes in a ~900 MB build. ``httpx`` is already a dependency and
does the only hard part. Implemented directly, and small enough to read.
"""

from __future__ import annotations

import json
import os
import sys
from pathlib import Path
from typing import Any, Callable, Optional

import httpx

# The contract this server implements: docs/api-contract/mcp.md.
#
# v2.0 is a **major** bump, and the reason is the confirmation model rather
# than a broken return shape: three tools arrive that can reconfigure the app
# or put a routine on a schedule, and every write tool now carries
# ``requires_confirmation``. A caller that ignored that flag would be running
# writes the contract says a person approves first, so callers are not
# unaffected and the major version says so.
CONTRACT_VERSION = "2.1"
PROTOCOL_VERSION = "2025-06-18"
SERVER_NAME = "resmon"

DEFAULT_PORT = 8742
_TIMEOUT = httpx.Timeout(30.0, connect=3.0)

# The oldest backend whose API this server was built against.
#
# Not defensive tidiness. resmon writes a port file, but only while it is
# running -- so with the app closed, nothing names a port and the default
# applies, and on a machine where an older resmon holds that port, it answers.
# That happened: a v1.2.1 launchd daemon from April answered every tool
# truthfully about a completely different corpus. Checking the version closes
# the one path the "a named port is never widened" rule does not cover.
MIN_BACKEND_VERSION = "1.8.0"

# Every list tool defaults small. Token efficiency is a contract term rather
# than an aspiration: a harness asking "what did my arXiv routine find this
# week" must not cost a five-hour usage window.
DEFAULT_LIMIT = 25
MAX_LIMIT = 100

# The settings groups ``update_settings`` may touch. An allowlist rather than a
# denylist: a group added to the app later is *not* reachable through this tool
# until someone puts it here and thinks about it.
#
# **``assistant`` is here because the app grew it and nobody noticed** —
# contract v2.1. The group landed in ``resmon.py`` in 2.0a (PR #88) after this
# list was frozen (PR #86), so v2.0 shipped with a settings group that was
# neither reachable nor deliberately excluded. The test that exists to force
# that decision, ``test_no_settings_group_the_app_has_is_silently_reachable``,
# is ``live_network``, and nothing ran the live suite on a schedule — which is
# the same gap the weekly job in ``.github/workflows/live-network.yml`` was
# added to close, and this was its first finding.
#
# Reachable rather than excluded, deliberately: "use opus for the assistant" is
# among the likeliest things a person will ask the assistant itself, it is
# confirm-gated like every other write, and a runtime change takes effect on the
# next turn because the runtime is built per turn. The credential-shaped guard
# below still applies, and none of the group's three keys is one.
#
# There is no credential group to exclude, because credentials are not settings
# -- they live behind ``/api/credentials`` and the keychain, and the contract
# excludes those routes entirely. What is guarded here is the other direction:
# a settings *key* that carries a secret. See ``_CREDENTIAL_SHAPED``.
SETTINGS_GROUPS: tuple[str, ...] = (
    "ai", "email", "embeddings", "cloud", "storage", "notifications",
)

# A key whose name contains any of these is refused before the request is
# built. No key in any group above matches one today --
# ``test_the_credential_denylist_excludes_nothing_that_exists`` asserts that
# against a real backend, so this is a standing guard on future keys rather
# than a filter that is quietly doing nothing. The point is that
# ``update_settings`` cannot *name* a credential, whatever a caller asks for.
_CREDENTIAL_SHAPED: tuple[str, ...] = (
    "key", "token", "secret", "password", "passphrase", "credential", "auth",
)


# ---------------------------------------------------------------------------
# Errors
# ---------------------------------------------------------------------------

class ToolError(Exception):
    """A failure with the machine code and human sentence the contract fixes."""

    def __init__(self, code: str, message: str, detail: Optional[dict] = None) -> None:
        super().__init__(message)
        self.code = code
        self.message = message
        self.detail = detail or {}

    def payload(self) -> dict:
        return {"error": self.code, "message": self.message, "detail": self.detail}


# ---------------------------------------------------------------------------
# Finding the backend
# ---------------------------------------------------------------------------

def _candidate_ports() -> list[int]:
    """Ports to try, in the contract's order: env, port file, default.

    **The default is a last resort, not a fallback.** If ``RESMON_PORT`` or the
    port file names a port, that is the backend the caller means, and the
    default is not tried at all.

    This is not defensive tidiness. Driving the real server during development
    found that when a named port had stopped answering, falling through to 8742
    connected the MCP server to the *launchd daemon* -- a different process,
    running a different version, over a different database. Every tool then
    answered truthfully about the wrong corpus, which is worse than failing: a
    harness asking "what did my routine find this week" would report another
    installation's papers as the user's own.

    So a named port that does not answer means the backend is unavailable. The
    default only applies when nothing named a port, which is the case for an
    older backend that predates the port file.
    """
    named: list[int] = []

    env_port = os.environ.get("RESMON_PORT")
    if env_port:
        try:
            named.append(int(env_port))
        except ValueError:
            pass

    try:
        from implementation_scripts.config import PORT_FILE

        text = Path(PORT_FILE).read_text(encoding="utf-8").strip()
        if text:
            named.append(int(text))
    except (OSError, ValueError, ImportError):
        pass

    candidates = named or [DEFAULT_PORT]

    seen: set[int] = set()
    ordered: list[int] = []
    for port in candidates:
        if port not in seen:
            seen.add(port)
            ordered.append(port)
    return ordered


class Backend:
    """A thin HTTP client for the running resmon backend."""

    def __init__(self) -> None:
        self._base: Optional[str] = None
        self._tried: list[str] = []

    def base_url(self) -> str:
        """Resolve, confirm and cache the backend's address."""
        if self._base:
            return self._base

        self._tried = []
        rejected: list[str] = []
        for port in _candidate_ports():
            base = f"http://127.0.0.1:{port}"
            self._tried.append(base)
            try:
                resp = httpx.get(f"{base}/api/health", timeout=httpx.Timeout(3.0))
            except httpx.HTTPError:
                continue
            if resp.status_code != 200:
                continue

            version = _reported_version(resp)
            if not _version_is_supported(version):
                # Something answered, and it is not a resmon this server can
                # speak for. Refusing is the whole point: a user ran the app,
                # asked "what did my routine find this week", and was answered
                # truthfully by a *different* installation over a different
                # database. Being wrong quietly is worse than being unavailable.
                rejected.append(f"{base} (v{version or 'unknown'})")
                continue

            self._base = base
            return base

        if rejected:
            raise ToolError(
                "backend_unavailable",
                "Found a resmon backend, but it is version "
                f"{rejected[0].split('(v')[-1].rstrip(')')}, which this MCP server "
                f"cannot speak for (it needs {MIN_BACKEND_VERSION} or later). That is "
                "usually an older resmon still running in the background. Start the "
                "current app and try again.",
                {"tried": list(self._tried), "rejected": rejected},
            )

        raise ToolError(
            "backend_unavailable",
            "resmon is not running. Start the resmon app and try again.",
            {"tried": list(self._tried)},
        )

    def request(self, method: str, path: str, **kwargs: Any) -> Any:
        base = self.base_url()
        try:
            resp = httpx.request(method, f"{base}{path}", timeout=_TIMEOUT, **kwargs)
        except httpx.HTTPError as exc:
            # The address answered /api/health a moment ago, so treat a failure
            # now as the backend having gone away rather than as a tool bug.
            self._base = None
            raise ToolError(
                "backend_unavailable",
                "resmon stopped responding part-way through the request.",
                {"tried": list(self._tried), "reason": type(exc).__name__},
            ) from None

        if resp.status_code == 404:
            raise ToolError("not_found", _detail_of(resp, "That item does not exist."))
        if resp.status_code in (400, 422):
            raise ToolError("invalid_argument", _detail_of(resp, "The request was rejected."))
        if resp.status_code == 409:
            raise ToolError("conflict", _detail_of(resp, "resmon could not accept that right now."))
        if resp.status_code == 429:
            raise ToolError("conflict", _detail_of(resp, "resmon is already at its execution limit."))
        if resp.status_code >= 500:
            raise ToolError("upstream_error", _detail_of(resp, "resmon reported an internal error."))
        if resp.status_code >= 400:
            raise ToolError("internal_error", _detail_of(resp, "Unexpected response from resmon."))

        if not resp.content:
            return None
        try:
            return resp.json()
        except ValueError:
            return resp.text


def _reported_version(resp: httpx.Response) -> Optional[str]:
    """The version string from a /api/health response, if it has one."""
    try:
        body = resp.json()
    except ValueError:
        return None
    if isinstance(body, dict):
        version = body.get("version")
        if isinstance(version, str) and version.strip():
            return version.strip()
    return None


def _version_is_supported(version: Optional[str]) -> bool:
    """True when *version* is at least MIN_BACKEND_VERSION.

    An unparseable or absent version is refused rather than assumed good: a
    backend that cannot say what it is, is exactly the case this guard exists
    for. Compared numerically part by part so "1.10.0" sorts above "1.9.0",
    which a string comparison gets wrong.
    """
    if not version:
        return False

    def parts(value: str) -> Optional[tuple[int, ...]]:
        chunks = value.split(".")
        try:
            return tuple(int(chunk) for chunk in chunks[:3])
        except ValueError:
            return None

    found, minimum = parts(version), parts(MIN_BACKEND_VERSION)
    if found is None or minimum is None:
        return False
    return found >= minimum


def _detail_of(resp: httpx.Response, fallback: str) -> str:
    """FastAPI's error envelope, unwrapped, or a plain sentence.

    Never assembles a message from anything but what the backend said, so a
    tool cannot claim more than the backend actually reported.
    """
    try:
        body = resp.json()
    except ValueError:
        return fallback
    if isinstance(body, dict):
        detail = body.get("detail")
        if isinstance(detail, str) and detail.strip():
            return detail
    return fallback


backend = Backend()


# ---------------------------------------------------------------------------
# Shaping
# ---------------------------------------------------------------------------

def _limit(args: dict, key: str = "limit") -> int:
    """Clamp a caller's page size. Oversized pages are the token-cost failure."""
    try:
        value = int(args.get(key, DEFAULT_LIMIT))
    except (TypeError, ValueError):
        return DEFAULT_LIMIT
    return max(1, min(value, MAX_LIMIT))


def _offset(args: dict) -> int:
    try:
        return max(0, int(args.get("offset", 0)))
    except (TypeError, ValueError):
        return 0


def _page(rows: list, args: dict) -> list:
    start = _offset(args)
    return rows[start:start + _limit(args)]


def _paper(row: dict) -> dict:
    """The compact paper shape. Never the full record, never a report dump."""
    return {
        "id": row.get("id"),
        "title": row.get("title"),
        "authors": row.get("authors"),
        "date": row.get("publication_date"),
        "source": row.get("source_repository"),
        "doi": row.get("doi"),
        "url": row.get("url"),
    }


def _require(args: dict, key: str) -> Any:
    if key not in args or args[key] in (None, ""):
        raise ToolError("invalid_argument", f"'{key}' is required.")
    return args[key]


def _require_int(args: dict, key: str) -> int:
    try:
        return int(_require(args, key))
    except (TypeError, ValueError):
        raise ToolError("invalid_argument", f"'{key}' must be a whole number.") from None


# ---------------------------------------------------------------------------
# Tools
# ---------------------------------------------------------------------------

def t_health(args: dict) -> Any:
    return backend.request("GET", "/api/health")


def t_search_corpus(args: dict) -> Any:
    """Search the stored corpus, by keyword or by meaning.

    Paginated by **cursor**, not offset. The contract specifies `offset`, but
    the endpoint behind it seeks on ``(publication_date DESC, id DESC)`` using
    an opaque cursor so the index does a logarithmic descent instead of walking
    the table. Emulating an offset would mean re-walking every prior page on
    each call and charging the caller for it. An explicit `offset` is refused
    rather than silently ignored -- a harness that thinks it is paging and is
    not would report the first page repeatedly as though it were the corpus.

    ``mode="semantic"`` (contract v1.2) ranks the corpus by distance from the
    query, **within the structured filters** — sources and dates still narrow it
    and are unchanged by the mode. The `query` itself is the difference: in
    keyword mode it is a text filter, in semantic mode it is what the ranking is
    measured against. So **the two modes can return different sets**, and a
    harness that needs the keyword set asks for `keyword`.

    That is not a loosening. The text filter is an AND over every word, so a
    plain-English question matches no paper and a ranking restricted to it has
    nothing to order: measured on a real 15,707-paper corpus, eleven of twenty
    natural queries came back empty. `ranked_count` and `unranked_count` say how
    much of what did come back is actually ordered.

    Semantic mode can decline. When it does -- no embedding model configured,
    the model refused, the extension will not load -- the answer carries
    ``mode: "keyword"`` and a ``mode_unavailable`` sentence rather than silently
    serving a date order under a semantic label. A harness told it received a
    ranking it did not receive would report a relevance order that is a date
    order, which is exactly the class of claim this project refuses to make.
    """
    if args.get("offset"):
        raise ToolError(
            "invalid_argument",
            "The corpus paginates by cursor, not offset. Pass the 'next_cursor' "
            "from the previous call as 'cursor'.",
        )
    mode = str(args.get("mode") or "keyword").strip().lower()
    if mode not in ("keyword", "semantic"):
        raise ToolError(
            "invalid_argument",
            f"Unknown mode {mode!r}. Use 'keyword' or 'semantic'.",
        )
    body: dict[str, Any] = {
        "query": _require(args, "query"),
        "limit": _limit(args),
        "sort": "similarity" if mode == "semantic" else "newest",
    }
    if args.get("cursor"):
        body["cursor"] = args["cursor"]
    for key in ("sources", "date_from", "date_to"):
        if args.get(key):
            body[key] = args[key]
    data = backend.request("POST", "/api/explorer/search", json=body) or {}
    rows = data.get("results") if isinstance(data, dict) else None
    rows = rows if isinstance(rows, list) else []
    served = "semantic" if data.get("sort") == "similarity" else "keyword"
    out: dict[str, Any] = {
        "papers": [
            # The distance travels with the paper in semantic mode. A harness
            # ranking papers for a person should be able to say how close they
            # actually were, not merely what order they came in.
            {**_paper(r), "distance": r.get("distance")} if served == "semantic"
            else _paper(r)
            for r in rows
        ],
        "count": len(rows),
        "next_cursor": data.get("next_cursor"),
        "has_more": data.get("has_more"),
        # The backend caps its own count; passing the cap through means a
        # harness cannot mistake "at least this many" for an exact total.
        "total": data.get("total"),
        "total_is_capped": data.get("total_is_capped"),
        "mode": served,
    }
    if served == "semantic":
        # How much of the answer is actually ranked. Papers with no vector are
        # appended rather than dropped, so a harness that assumed the whole list
        # was ordered by relevance would be wrong about the tail.
        out["ranked_count"] = data.get("ranked_count")
        out["unranked_count"] = data.get("unranked_count")
        out["model"] = data.get("model")
    if mode == "semantic" and served != "semantic":
        out["mode_unavailable"] = data.get("similarity_unavailable") or (
            "This resmon cannot rank by meaning; the results are newest first."
        )
    return out


def t_find_similar(args: dict) -> Any:
    """The papers nearest a given one, with distances and their sources.

    Costs nothing at any embedding provider: the paper's vector is already
    stored, so this is one index query.

    An empty list always carries a reason. "This paper is not embedded",
    "nothing else is" and "this build cannot load the vector extension" are
    three different situations, and a bare empty list would let a harness report
    "resmon found nothing similar" for any of them -- a claim about the corpus
    made from a fact about the configuration.
    """
    doc_id = _require_int(args, "doc_id")
    limit = _limit(args, "limit")
    data = backend.request(
        "GET", f"/api/documents/{doc_id}/similar", params={"k": limit}
    ) or {}
    neighbours = data.get("neighbours") if isinstance(data, dict) else None
    neighbours = neighbours if isinstance(neighbours, list) else []
    return {
        "document_id": data.get("document_id", doc_id),
        "model": data.get("model"),
        "papers": [{**_paper(n), "distance": n.get("distance")} for n in neighbours],
        "count": len(neighbours),
        "reason": data.get("reason"),
    }


def t_list_sources(args: dict) -> Any:
    catalog = backend.request("GET", "/api/repositories/catalog") or []
    try:
        creds = (backend.request("GET", "/api/credentials") or {}).get("credentials", {})
    except ToolError:
        # Presence is a nicety here; the catalog is the answer. Reporting the
        # sources without key status beats failing the whole call.
        creds = {}

    out = []
    for entry in catalog:
        name = entry.get("credential_name")
        # Presence only, never a value. The alias is named; the key is not read.
        status = (creds.get(name) or {}).get("status") if name else None
        out.append({
            "slug": entry.get("slug"),
            "name": entry.get("name"),
            "coverage": entry.get("subject_coverage"),
            "key_required": entry.get("api_key_requirement") == "required",
            "credential_alias": name,
            "credential_status": status,
            "attribution": entry.get("attribution") or None,
            "attribution_requirement": entry.get("attribution_requirement"),
        })
    return {"sources": out, "count": len(out)}


def t_list_routines(args: dict) -> Any:
    rows = backend.request("GET", "/api/routines") or []
    if args.get("active_only"):
        rows = [r for r in rows if r.get("is_active")]
    return {
        "routines": [{
            "id": r.get("id"),
            "name": r.get("name"),
            "schedule": r.get("schedule_cron"),
            "active": bool(r.get("is_active")),
            "last_run": r.get("last_executed_at"),
        } for r in rows],
        "count": len(rows),
    }


def t_get_routine(args: dict) -> Any:
    """One routine's configuration, and how well it is doing its job.

    The coverage summary rides along rather than living behind a second tool: an
    assistant asked "how is my arXiv routine doing" should not have to know to
    ask twice, and the summary is one sentence.

    It is a *summary*, never the lists. The two lists are long, and a harness
    that pasted them would present distances as verdicts — the audit's whole
    caveat is that a distance is not relevance. ``coverage.cannot_see`` travels
    with it for the same reason ``explain_match`` carries its refusals: stripping
    them would make an honest product dishonest through an integration.
    """
    routine_id = _require_int(args, "routine_id")
    routine = backend.request("GET", f"/api/routines/{routine_id}")
    if not isinstance(routine, dict):
        return routine
    try:
        audit = backend.request("GET", f"/api/routines/{routine_id}/coverage") or {}
    except ToolError:
        # A backend that cannot audit still has a routine to return. The
        # configuration is the answer to the question that was asked.
        return routine
    routine["coverage"] = {
        "summary": audit.get("summary"),
        "intent": audit.get("intent"),
        "intent_source": audit.get("intent_source"),
        "results": audit.get("results"),
        "results_embedded": audit.get("results_embedded"),
        # The totals, not the pages. Both lists are capped at 25 in the payload
        # and a harness reading `len(off_target)` as "how many" would report 25
        # for a routine with 312. The lists themselves are still not returned.
        "off_target_count": audit.get("off_target_total"),
        "missed_in_corpus_count": audit.get("missed_in_corpus_total"),
        "missed_in_corpus_count_is_lower_bound": bool(
            audit.get("missed_in_corpus_total_is_lower_bound")
        ),
        "reason": audit.get("reason"),
        "cannot_see": audit.get("cannot_see"),
    }
    return routine


def t_list_executions(args: dict) -> Any:
    rows = backend.request("GET", "/api/executions") or []
    if args.get("routine_id") is not None:
        rid = _require_int(args, "routine_id")
        rows = [r for r in rows if r.get("routine_id") == rid]
    if args.get("status"):
        rows = [r for r in rows if r.get("status") == args["status"]]
    page = _page(rows, args)
    return {
        "executions": [{
            "id": r.get("id"),
            "type": r.get("execution_type"),
            "status": r.get("status"),
            "started": r.get("start_time"),
            "finished": r.get("end_time"),
            "result_count": r.get("result_count"),
        } for r in page],
        "count": len(page),
        "total": len(rows),
    }


def t_get_execution(args: dict) -> Any:
    return backend.request("GET", f"/api/executions/{_require_int(args, 'exec_id')}")


def t_get_execution_results(args: dict) -> Any:
    """The papers one execution found.

    The contract names ``GET /api/executions/{id}/report`` for this, and that
    endpoint returns ``{"report_text": ...}`` -- the entire rendered Markdown
    report. Returning it would break the contract's own token-efficiency
    guarantee in the same document that states it, so this uses the structured
    reference export instead. Recorded as a contract amendment rather than a
    silent deviation.
    """
    exec_id = _require_int(args, "exec_id")
    raw = backend.request(
        "GET", f"/api/executions/{exec_id}/references", params={"format": "json"},
    )
    if isinstance(raw, str):
        try:
            rows = json.loads(raw)
        except ValueError:
            raise ToolError(
                "upstream_error",
                "resmon returned a reference export that could not be read.",
            ) from None
    else:
        rows = raw
    rows = rows if isinstance(rows, list) else []
    page = _page(rows, args)
    return {"papers": [_paper(r) for r in page], "count": len(page),
            "total": len(rows)}


def t_get_search_record(args: dict) -> Any:
    exec_id = _require_int(args, "exec_id")
    return backend.request("GET", f"/api/executions/{exec_id}/search-record")


def t_explain_match(args: dict) -> Any:
    doc_id = _require_int(args, "doc_id")
    return backend.request("GET", f"/api/documents/{doc_id}/why")


def t_get_paper_lifecycle(args: dict) -> Any:
    doc_id = _require_int(args, "doc_id")
    return backend.request("GET", f"/api/documents/{doc_id}/lifecycle")


# The contract's view names are the tool's public vocabulary; three of them do
# not match the endpoint that serves them. Checking each route rather than
# trusting the contract found that `volume`, `sources` and `keywords` are
# served by `publication-volume`, `source-contribution` and
# `keyword-contribution`. Keeping the contract's names and mapping them here
# means the tool surface stays as specified while actually working.
_ANALYTICS_VIEWS = {
    "overview": "/api/analytics/overview",
    "volume": "/api/analytics/publication-volume",
    "sources": "/api/analytics/source-contribution",
    "keywords": "/api/analytics/keyword-contribution",
    "routine-health": "/api/analytics/routine-health",
    "discovery-lag": "/api/analytics/discovery-lag",
}


def t_get_analytics(args: dict) -> Any:
    view = str(_require(args, "view"))
    path = _ANALYTICS_VIEWS.get(view)
    if not path:
        raise ToolError(
            "invalid_argument",
            f"Unknown view '{view}'. Expected one of: "
            f"{', '.join(sorted(_ANALYTICS_VIEWS))}.",
        )
    params = {"window": args["window"]} if args.get("window") else None
    return backend.request("GET", path, params=params)


def t_get_watchdog_findings(args: dict) -> Any:
    params = {"include_muted": "true"} if args.get("include_muted") else None
    return backend.request("GET", "/api/watchdog", params=params)


def t_export_references(args: dict) -> Any:
    """Export references for an execution, or for an explicit set of papers.

    Two different endpoints, because the backend already has one for each and
    neither should be widened for this client's convenience. An execution has
    its own route with the id in the path; ``POST /api/export/references``
    takes ``document_ids`` and *only* ``document_ids`` -- passing it an
    ``execution_id`` was a guaranteed HTTP 422, which is exactly what shipped
    in v1.8.2 and what a caller hit the first time they tried it.
    """
    fmt = args.get("format") or "bibtex"
    if args.get("exec_id") is not None:
        exec_id = _require_int(args, "exec_id")
        return backend.request(
            "GET", f"/api/executions/{exec_id}/references", params={"format": fmt},
        )
    if args.get("doc_ids"):
        return backend.request(
            "POST", "/api/export/references",
            json={"document_ids": list(args["doc_ids"]), "format": fmt},
        )
    raise ToolError("invalid_argument", "Pass either 'exec_id' or 'doc_ids'.")


def t_run_sweep(args: dict) -> Any:
    body = {
        "query": _require(args, "query"),
        "repositories": list(_require(args, "sources")),
        "max_results": args.get("max_results") or 50,
    }
    for key in ("date_from", "date_to"):
        if args.get(key):
            body[key] = args[key]
    if args.get("ai_enabled") is not None:
        body["ai_enabled"] = bool(args["ai_enabled"])
    data = backend.request("POST", "/api/search/sweep", json=body) or {}
    return {"execution_id": data.get("execution_id"),
            "detail": "Started. Poll get_execution for progress."}


def t_create_routine(args: dict) -> Any:
    """Creates the routine INACTIVE, as the contract requires.

    Scheduling something to run repeatedly on someone's machine is not a side
    effect a tool call gets to have. The user activates it in the app.
    """
    parameters = {
        "query": " ".join(args["keywords"]) if isinstance(args.get("keywords"), list)
        else _require(args, "keywords"),
        "repositories": list(_require(args, "sources")),
    }
    # `parameters` is a dict on the wire, not a JSON string. The database column
    # stores JSON text, which makes the string form the obvious guess and the
    # wrong one -- RoutineCreate declares `parameters: dict` and rejects a
    # string with a 422. Found by driving a real backend; the stubbed unit test
    # could not have caught it.
    body = {
        "name": _require(args, "name"),
        "schedule_cron": _require(args, "schedule"),
        "parameters": parameters,
        "is_active": False,
        "ai_enabled": bool(args.get("ai_enabled", False)),
    }
    # Optional, and never defaulted from the keywords. `get_routine`'s coverage
    # summary reports which of the two it compared against, and a routine whose
    # intent is its own keywords is being measured against itself -- filling this
    # in from `keywords` would erase that distinction at the point it is created.
    intent = str(args.get("intent") or "").strip()
    if intent:
        body["intent"] = intent
    created = backend.request("POST", "/api/routines", json=body) or {}

    # ``POST /api/routines`` answers with ``{id, name}`` -- everything the
    # endpoint's own caller (the routine form, which already has the rest)
    # needs, and less than this contract promised. Reading the record back
    # makes "the created routine" true, and it makes ``is_active: 0`` a fact
    # the caller can see rather than a sentence resmon asserts about itself.
    # One localhost GET, which is the cheapest way to stop a tool overclaiming.
    routine = created
    rid = created.get("id")
    if rid is not None:
        try:
            routine = backend.request("GET", f"/api/routines/{rid}") or created
        except ToolError:
            routine = created

    return {"routine": routine,
            "detail": "Created inactive. Activate it — in resmon, or by asking "
                      "to turn it on — to put it on its schedule."}


def t_run_routine(args: dict) -> Any:
    rid = _require_int(args, "routine_id")
    return backend.request("POST", f"/api/routines/{rid}/run")


def t_activate_routine(args: dict) -> Any:
    """Put a saved routine on its schedule.

    ``create_routine`` deliberately creates a routine inactive, and until v2.0
    the only way to turn one on was to open the app. That was the right default
    and the wrong dead end: the contract's own note said an explicit
    ``activate_routine`` was what a later version should add. It is here now
    because 2.0's assistant has a person in the conversation to confirm with --
    which is what ``requires_confirmation`` on this tool records.
    """
    rid = _require_int(args, "routine_id")
    return backend.request("POST", f"/api/routines/{rid}/activate")


def t_deactivate_routine(args: dict) -> Any:
    """Take a saved routine off its schedule. The routine itself is kept."""
    rid = _require_int(args, "routine_id")
    return backend.request("POST", f"/api/routines/{rid}/deactivate")


def t_update_settings(args: dict) -> Any:
    """Change named settings in one group, and report exactly what moved.

    ``PUT /api/settings/*`` was excluded from v1 with a reason the contract
    wrote down: "reconfiguring the app underneath a user is a 2.0 assistant
    concern, where there is a person in the conversation to confirm with."
    That person now exists, so the exclusion lifts -- and everything that made
    it dangerous is answered structurally rather than by asking the model
    nicely.

    Four guards, in order:

    1. **The group is an allowlist.** A group the app grows later is
       unreachable here until someone adds it deliberately.
    2. **No key may be credential-shaped.** Refused on the name, before a
       request is built, so the tool cannot be *asked* for a secret.
    3. **The legal key list comes from the backend**, not from a copy in this
       file. ``GET /api/settings/<group>`` returns the group's keys, so a key
       renamed in the app cannot silently become a no-op here -- and an
       unknown key is refused rather than dropped. The backend's own PUT
       ignores keys outside the group, which is the right behaviour for a
       form and the wrong one for a tool: a caller told "success" for a key
       that was discarded has been lied to.
    4. **The answer is a before/after diff.** Not "success": the exact keys
       that changed, from what to what, and the count of keys in the group
       this call left alone. A confirmation card can render the diff, and a
       write that touched more than it named is visible in the answer rather
       than only in a test.
    """
    group = str(_require(args, "group")).strip()
    if group not in SETTINGS_GROUPS:
        raise ToolError(
            "invalid_argument",
            f"'{group}' is not a settings group this tool can change. "
            f"Allowed: {', '.join(SETTINGS_GROUPS)}.",
        )

    settings = args.get("settings")
    if not isinstance(settings, dict) or not settings:
        raise ToolError("invalid_argument", "'settings' must be a non-empty object.")

    named = [str(k) for k in settings]
    forbidden = sorted(
        k for k in named
        if any(word in k.lower() for word in _CREDENTIAL_SHAPED)
    )
    if forbidden:
        raise ToolError(
            "invalid_argument",
            "This tool cannot change a setting whose name looks like a "
            f"credential ({', '.join(forbidden)}). resmon's API keys and "
            "passwords are not settings; they are stored in the system "
            "keychain and are changed in the app, never through a tool.",
            {"refused_keys": forbidden},
        )

    before = backend.request("GET", f"/api/settings/{group}")
    if not isinstance(before, dict):
        raise ToolError(
            "internal_error",
            f"resmon did not return the '{group}' settings group.",
        )

    unknown = sorted(k for k in named if k not in before)
    if unknown:
        raise ToolError(
            "invalid_argument",
            f"The '{group}' group has no setting called "
            f"{', '.join(repr(k) for k in unknown)}. Its keys are: "
            f"{', '.join(sorted(before))}.",
            {"unknown_keys": unknown, "group_keys": sorted(before)},
        )

    payload = {k: ("" if v is None else str(v)) for k, v in settings.items()}
    backend.request("PUT", f"/api/settings/{group}", json={"settings": payload})

    after = backend.request("GET", f"/api/settings/{group}")
    if not isinstance(after, dict):
        raise ToolError(
            "internal_error",
            f"resmon did not return the '{group}' settings group after the change.",
        )

    changed = {
        key: {"from": before.get(key), "to": after.get(key)}
        for key in sorted(set(before) | set(after))
        if before.get(key) != after.get(key)
    }
    return {
        "group": group,
        "changed": changed,
        "requested": sorted(named),
        "unchanged_key_count": len([k for k in after if k not in changed]),
        "detail": (
            f"{len(changed)} setting(s) changed in '{group}'."
            if changed else
            f"Nothing changed in '{group}' — the values were already those."
        ),
    }


TOOLS: list[dict] = [
    {"name": "health", "fn": t_health,
     "description": "Whether resmon is running, and which version.",
     "schema": {"type": "object", "properties": {}}},

    {"name": "search_corpus", "fn": t_search_corpus,
     "description": (
         "Search the papers resmon has already collected. mode='semantic' ranks the "
         "corpus by closeness to the query rather than filtering on its words, so it "
         "finds papers that share no wording with it; the answer says which mode was "
         "actually served."
     ),
     "schema": {"type": "object", "required": ["query"], "properties": {
         "query": {"type": "string"},
         "mode": {"type": "string", "enum": ["keyword", "semantic"],
                  "default": "keyword",
                  "description": (
                      "'keyword' filters on the words in 'query'. 'semantic' instead "
                      "ranks the corpus by closeness to 'query', within the other "
                      "filters, so the two modes can return different sets. "
                      "'semantic' needs an embedding model configured in resmon; when "
                      "one is not, the reply is keyword order and says so in "
                      "'mode_unavailable'."
                  )},
         "sources": {"type": "array", "items": {"type": "string"}},
         "date_from": {"type": "string"}, "date_to": {"type": "string"},
         "limit": {"type": "integer", "default": DEFAULT_LIMIT},
         "cursor": {"type": "string",
                    "description": "next_cursor from the previous call"}}}},

    {"name": "find_similar", "fn": t_find_similar,
     "description": (
         "The papers in the corpus nearest a given one, with distances. An empty "
         "answer carries the reason it is empty."
     ),
     "schema": {"type": "object", "required": ["doc_id"], "properties": {
         "doc_id": {"type": "integer"},
         "limit": {"type": "integer", "default": DEFAULT_LIMIT}}}},

    {"name": "list_sources", "fn": t_list_sources,
     "description": "The scholarly sources resmon can query, and whether a key is stored.",
     "schema": {"type": "object", "properties": {}}},

    {"name": "list_routines", "fn": t_list_routines,
     "description": "The user's saved monitoring routines.",
     "schema": {"type": "object", "properties": {
         "active_only": {"type": "boolean"}}}},

    {"name": "get_routine", "fn": t_get_routine,
     "description": (
         "One routine's full configuration, plus a coverage summary: how many of "
         "its results sit furthest from its stated intent and how many papers "
         "already in the corpus it never returned."
     ),
     "schema": {"type": "object", "required": ["routine_id"], "properties": {
         "routine_id": {"type": "integer"}}}},

    {"name": "list_executions", "fn": t_list_executions,
     "description": "Past and running executions, newest first.",
     "schema": {"type": "object", "properties": {
         "routine_id": {"type": "integer"}, "status": {"type": "string"},
         "limit": {"type": "integer", "default": DEFAULT_LIMIT},
         "offset": {"type": "integer", "default": 0}}}},

    {"name": "get_execution", "fn": t_get_execution,
     "description": "One execution: status, per-source counts, timings, the AI lane used.",
     "schema": {"type": "object", "required": ["exec_id"], "properties": {
         "exec_id": {"type": "integer"}}}},

    {"name": "get_execution_results", "fn": t_get_execution_results,
     "description": "The papers one execution found.",
     "schema": {"type": "object", "required": ["exec_id"], "properties": {
         "exec_id": {"type": "integer"},
         "limit": {"type": "integer", "default": DEFAULT_LIMIT},
         "offset": {"type": "integer", "default": 0}}}},

    {"name": "get_search_record", "fn": t_get_search_record,
     "description": ("The PRISMA-shaped reproducible record for an execution. Each "
                     "source that returned nothing carries the recorded reason why, "
                     "or says the reason was not recorded — runs from before resmon "
                     "1.8.6 have none, and an unexplained zero is not evidence that "
                     "there was nothing to find."),
     "schema": {"type": "object", "required": ["exec_id"], "properties": {
         "exec_id": {"type": "integer"}}}},

    {"name": "explain_match", "fn": t_explain_match,
     "description": ("Why a paper matched: which keywords, in which field, and what "
                     "resmon cannot verify. The caveats are part of the answer."),
     "schema": {"type": "object", "required": ["doc_id"], "properties": {
         "doc_id": {"type": "integer"}}}},

    {"name": "get_paper_lifecycle", "fn": t_get_paper_lifecycle,
     "description": "Retractions, preprint-to-published moves and version changes, each with its notice link.",
     "schema": {"type": "object", "required": ["doc_id"], "properties": {
         "doc_id": {"type": "integer"}}}},

    {"name": "get_analytics", "fn": t_get_analytics,
     "description": "A summary view over the corpus and run history.",
     "schema": {"type": "object", "required": ["view"], "properties": {
         "view": {"type": "string", "enum": sorted(_ANALYTICS_VIEWS)},
         "window": {"type": "string"}}}},

    {"name": "get_watchdog_findings", "fn": t_get_watchdog_findings,
     "description": ("Silent-failure findings, each labeled broken (a recorded fact) or "
                     "unusual (an inference), with the thresholds used and what the "
                     "watchdog cannot judge."),
     "schema": {"type": "object", "properties": {
         "include_muted": {"type": "boolean"}}}},

    {"name": "export_references", "fn": t_export_references,
     "description": "Export references as BibTeX, RIS, CSV or JSON.",
     "schema": {"type": "object", "properties": {
         "exec_id": {"type": "integer"},
         "doc_ids": {"type": "array", "items": {"type": "integer"}},
         "format": {"type": "string", "enum": ["bibtex", "ris", "csv", "json"]}}}},

    {"name": "run_sweep", "fn": t_run_sweep, "requires_confirmation": True,
     "description": "Search sources now and store what comes back. Returns immediately.",
     "schema": {"type": "object", "required": ["query", "sources"], "properties": {
         "query": {"type": "string"},
         "sources": {"type": "array", "items": {"type": "string"}},
         "date_from": {"type": "string"}, "date_to": {"type": "string"},
         "max_results": {"type": "integer"},
         "ai_enabled": {"type": "boolean"}}}},

    {"name": "create_routine", "fn": t_create_routine, "requires_confirmation": True,
     "description": "Create a monitoring routine. It is created INACTIVE; the user activates it in resmon.",
     "schema": {"type": "object", "required": ["name", "keywords", "sources", "schedule"],
                "properties": {
                    "name": {"type": "string"},
                    "keywords": {"type": "array", "items": {"type": "string"}},
                    "sources": {"type": "array", "items": {"type": "string"}},
                    "schedule": {"type": "string", "description": "cron expression"},
                    "intent": {"type": "string", "description": (
                        "Optional. What this routine is really looking for, in "
                        "the user's own words. The coverage audit compares "
                        "results against it; without one it falls back to the "
                        "keywords, which measures the query against itself.")},
                    "ai_enabled": {"type": "boolean"}}}},

    {"name": "run_routine", "fn": t_run_routine, "requires_confirmation": True,
     "description": "Run a saved routine now, outside its schedule. Returns immediately.",
     "schema": {"type": "object", "required": ["routine_id"], "properties": {
         "routine_id": {"type": "integer"}}}},

    {"name": "activate_routine", "fn": t_activate_routine, "requires_confirmation": True,
     "description": ("Put a saved routine on its schedule so it runs by itself. "
                     "The user confirms this before it takes effect."),
     "schema": {"type": "object", "required": ["routine_id"], "properties": {
         "routine_id": {"type": "integer"}}}},

    {"name": "deactivate_routine", "fn": t_deactivate_routine, "requires_confirmation": True,
     "description": ("Take a saved routine off its schedule. The routine and "
                     "everything it has found are kept."),
     "schema": {"type": "object", "required": ["routine_id"], "properties": {
         "routine_id": {"type": "integer"}}}},

    {"name": "update_settings", "fn": t_update_settings, "requires_confirmation": True,
     "description": (
         "Change settings in one group. Returns a before/after diff of exactly "
         "what moved. It cannot change an API key, a password or anything else "
         "credential-shaped: those are not settings, and are changed in the app."
     ),
     "schema": {"type": "object", "required": ["group", "settings"], "properties": {
         "group": {"type": "string", "enum": list(SETTINGS_GROUPS)},
         "settings": {
             "type": "object", "additionalProperties": {"type": "string"},
             "description": (
                 "The keys to change and their new values. A key the group does "
                 "not have is refused rather than ignored; call the tool once "
                 "with a wrong key to be told the group's real key list."
             )}}}},
]

_BY_NAME: dict[str, Callable[[dict], Any]] = {t["name"]: t["fn"] for t in TOOLS}

# The tools a person confirms before they run, and its complement. Derived from
# ``TOOLS`` rather than written out, so a tool added without a decision about
# confirmation lands in ``READ_TOOLS`` visibly, and
# ``test_every_tool_declares_whether_it_needs_confirmation`` is what makes that
# a decision rather than a default. ``assistant_runtime`` builds the CLI's
# pre-approved ``--allowedTools`` list from ``READ_TOOLS``: one source, so the
# set the model may call without asking cannot drift from the set this file
# calls safe.
WRITE_TOOLS: frozenset[str] = frozenset(
    t["name"] for t in TOOLS if t.get("requires_confirmation")
)
READ_TOOLS: frozenset[str] = frozenset(
    t["name"] for t in TOOLS if not t.get("requires_confirmation")
)


def call_tool(name: str, args: Optional[dict]) -> dict:
    """Run one tool and return its MCP result payload.

    An unhandled exception is reported as ``internal_error`` rather than
    escaping: a crashed stdio server looks to a harness like resmon being
    broken, and the harness cannot tell the two apart.
    """
    fn = _BY_NAME.get(name)
    if fn is None:
        return _result(
            {"error": "invalid_argument", "message": f"Unknown tool '{name}'.",
             "detail": {}}, is_error=True)
    try:
        return _result(fn(args or {}))
    except ToolError as exc:
        return _result(exc.payload(), is_error=True)
    except Exception as exc:  # pragma: no cover - defensive
        return _result(
            {"error": "internal_error",
             "message": f"The resmon MCP server failed handling '{name}'.",
             "detail": {"reason": type(exc).__name__}}, is_error=True)


def _result(payload: Any, is_error: bool = False) -> dict:
    return {
        "content": [{"type": "text", "text": json.dumps(payload, default=str)}],
        "isError": is_error,
    }


# ---------------------------------------------------------------------------
# JSON-RPC over stdio
# ---------------------------------------------------------------------------

def handle_message(msg: dict) -> Optional[dict]:
    """Dispatch one JSON-RPC message. Returns a response, or None for a notification."""
    method = msg.get("method")
    msg_id = msg.get("id")

    if method == "initialize":
        return _ok(msg_id, {
            "protocolVersion": PROTOCOL_VERSION,
            "capabilities": {"tools": {}},
            "serverInfo": {"name": SERVER_NAME, "version": CONTRACT_VERSION},
        })

    if method in ("notifications/initialized", "initialized"):
        return None

    if method == "tools/list":
        # ``requires_confirmation`` is resmon's own field, not part of MCP.
        # It is emitted for every tool -- true *and* false -- because a harness
        # that has to infer "no flag means safe" is one release away from
        # inferring it about a tool that grew teeth. It is the same list the
        # assistant derives its pre-approved set from, so the panel and an
        # external harness cannot disagree about which calls need a person.
        return _ok(msg_id, {"tools": [
            {"name": t["name"], "description": t["description"],
             "inputSchema": t["schema"],
             "requires_confirmation": bool(t.get("requires_confirmation"))}
            for t in TOOLS
        ]})

    if method == "tools/call":
        params = msg.get("params") or {}
        return _ok(msg_id, call_tool(params.get("name"), params.get("arguments")))

    if method == "ping":
        return _ok(msg_id, {})

    if msg_id is None:
        return None
    return {"jsonrpc": "2.0", "id": msg_id,
            "error": {"code": -32601, "message": f"Method not found: {method}"}}


def _ok(msg_id: Any, result: Any) -> dict:
    return {"jsonrpc": "2.0", "id": msg_id, "result": result}


def serve(stdin=None, stdout=None) -> None:
    """Read newline-delimited JSON-RPC from stdin until it closes."""
    stdin = stdin or sys.stdin
    stdout = stdout or sys.stdout

    for line in stdin:
        line = line.strip()
        if not line:
            continue
        try:
            msg = json.loads(line)
        except ValueError:
            # Unparseable input is not addressed to any request id, so there is
            # nothing to answer. Dropping it beats guessing an id.
            continue
        if not isinstance(msg, dict):
            continue

        response = handle_message(msg)
        if response is not None:
            stdout.write(json.dumps(response, default=str) + "\n")
            stdout.flush()


def main() -> None:  # pragma: no cover - process entrypoint
    sys.path.insert(0, str(Path(__file__).resolve().parent))
    serve()


if __name__ == "__main__":  # pragma: no cover
    main()
