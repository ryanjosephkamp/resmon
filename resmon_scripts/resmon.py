"""resmon — Research Monitor backend (FastAPI application)."""

import asyncio
import json
import os
import sqlite3
import shutil
import sys
import tempfile
import threading
from collections import OrderedDict
import time
import zipfile
import logging
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Optional

import httpx

# Ensure the implementation_scripts package is importable
sys.path.insert(0, str(Path(__file__).resolve().parent))

from contextlib import asynccontextmanager
from fastapi import FastAPI, HTTPException, Query, UploadFile, File, Response
from fastapi.middleware.cors import CORSMiddleware
from starlette.requests import Request
from starlette.responses import Response, StreamingResponse
from starlette.types import ASGIApp, Receive, Scope, Send
from pydantic import BaseModel, ConfigDict, Field

from implementation_scripts.config import (
    APP_NAME, APP_VERSION, DEFAULT_DB_PATH, PORT_FILE, REPORTS_DIR,
)
from implementation_scripts.database import (
    get_connection,
    init_db,
    get_routines,
    get_routine_by_id,
    insert_routine,
    update_routine,
    delete_routine,
    get_executions,
    get_execution_by_id,
    get_execution_documents,
    get_documents_by_ids,
    update_execution_status,
    set_execution_saved_configuration,
    get_configurations,
    insert_configuration,
    update_configuration,
    delete_configuration,
    get_setting,
    set_setting,
    save_progress_events,
    get_progress_events,
    get_lifecycle_for_document,
    SCHEMA_VERSION,
    get_schema_version,
)
from implementation_scripts.credential_manager import (
    store_credential,
    get_credential,
    probe_credential,
    keyring_is_responsive,
    PRESENT,
    delete_credential,
    validate_api_key,
    push_ephemeral,
    pop_ephemeral,
    AI_CREDENTIAL_NAMES,
    SMTP_CREDENTIAL_NAMES,
    migrate_legacy_global_ai_key,
)
from implementation_scripts.ai_lanes import SUBSCRIPTION_PROVIDERS, resolve_chain
from implementation_scripts.ai_models import (
    list_available_models as ai_list_available_models,
    list_subscription_catalog,
    ModelListError,
)
from implementation_scripts.cloud_storage import (
    check_connection as cloud_check_connection,
    authorize_google_drive,
    revoke_authorization,
    upload_directory,
    is_token_stored as cloud_is_token_stored,
    probe_api as cloud_probe_api,
)
from implementation_scripts.config_manager import (
    export_configs,
    import_configs,
)
from implementation_scripts.sweep_engine import SweepEngine
from implementation_scripts.api_registry import list_repositories
from implementation_scripts.zero_reason import answered as zero_answered
from implementation_scripts import (
    analytics, coverage_audit, embedding_job, embeddings, explorer, lifecycle,
    match_explain, near_duplicates, reference_export, search_record, vector_index,
    watchdog,
)
from implementation_scripts.progress import progress_store
from implementation_scripts.admission import admission
from implementation_scripts.scheduler import ResmonScheduler, set_dispatcher
from implementation_scripts.repo_catalog import (
    REPOSITORY_CATALOG,
    catalog_as_dicts,
    credential_names as catalog_credential_names,
)

# ---------------------------------------------------------------------------
# App setup
# ---------------------------------------------------------------------------

@asynccontextmanager
async def _lifespan(_app: FastAPI):
    """Startup/shutdown hooks.

    Replaces four deprecated ``@app.on_event`` handlers. Order matters and is
    preserved exactly as the decorators were registered: admission limits are
    hydrated first, then the legacy AI-key migration, then the scheduler (which
    reads routines and therefore needs the database ready). The handlers stay as
    ordinary module-level functions so tests can still call them directly.
    """
    _init_admission_on_startup()
    _migrate_legacy_ai_key_on_startup()
    _init_scheduler_on_startup()
    try:
        yield
    finally:
        _shutdown_scheduler()


app = FastAPI(title=APP_NAME, version=APP_VERSION, lifespan=_lifespan)


class PrivateNetworkMiddleware:
    """Allow Chromium Private Network Access from file:// origins.

    Implemented as a raw ASGI middleware (not BaseHTTPMiddleware) so that
    streaming responses (SSE) are not buffered.
    """

    def __init__(self, app: ASGIApp) -> None:
        self.app = app

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return

        async def _send_with_header(message):
            if message["type"] == "http.response.start":
                headers = list(message.get("headers", []))
                headers.append((b"access-control-allow-private-network", b"true"))
                message = {**message, "headers": headers}
            await send(message)

        await self.app(scope, receive, _send_with_header)


app.add_middleware(PrivateNetworkMiddleware)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

# ---------------------------------------------------------------------------
# Database connections (BUG-020)
# ---------------------------------------------------------------------------
#
# There used to be exactly one module-level ``sqlite3.Connection``, opened with
# ``check_same_thread=False`` and handed to everything: every FastAPI request
# thread, and every execution worker thread spawned by ``_launch_execution``.
# Nothing serialized them.
#
# sqlite3 connections are not safe to use concurrently from multiple threads.
# Python 3.10 and 3.11 mostly got away with it because their sqlite3 module
# holds the GIL across most operations; 3.12 releases it far more aggressively,
# so the race is lost reliably there and only intermittently on 3.10/3.11. It
# surfaced as ``InterfaceError: bad parameter or other API misuse``,
# ``ProgrammingError: Cannot operate on a closed database``, and
# ``OperationalError: cannot start a transaction within a transaction``.
#
# Each thread now gets its own connection. ``_get_db()`` is the single choke
# point every one of the call sites in this module already goes through, so the
# fix lands everywhere at once rather than only on the worker path.
#
# Two details make this work with the existing test suite:
#
#   * ``_shared_conn`` is kept as an *anchor*. An in-memory database lives only
#     as long as a connection to it is open, so the anchor holds it open while
#     per-thread connections come and go. Keeping the name also preserves the
#     ``resmon_mod._shared_conn = None`` reset idiom that a dozen test modules
#     use directly.
#   * ``":memory:"`` is translated to a private temp file. A plain ``:memory:``
#     connection is visible only to itself, so per-thread connections would each
#     get their own empty database. The obvious alternative, a shared-cache
#     ``file:...?mode=memory&cache=shared`` URI, is worse than it looks: shared
#     cache takes *table-level* locks and reports contention as SQLITE_LOCKED,
#     which ``busy_timeout`` does not retry, so a worker writing while a request
#     reads raises "database table is locked". Production is always a file with
#     WAL, where one writer and many readers coexist happily -- so tests get
#     exactly that, and exercise the same locking behavior resmon ships.

_db_path: str | None = None  # overridable for testing
_shared_conn = None  # anchor connection; keeps an in-memory database alive
_db_initialized = False

_db_generation = 0  # bumped on reset to invalidate per-thread connections
_db_local = threading.local()
# Every connection handed out, paired with the thread that owns it.
#
# The owner is recorded because closing a connection from a *different* thread
# while its owner is mid-statement does not raise -- it segfaults. Connections
# are opened with ``check_same_thread=False``, so nothing in sqlite3 serialises
# a close against another thread's in-flight query, and CPython hands the C
# library a connection it is still using. ``close_db`` uses the owner to refuse
# exactly that; see the note there.
_db_conns: list[tuple[sqlite3.Connection, threading.Thread]] = []
_db_lock = threading.Lock()


_memory_dir: tempfile.TemporaryDirectory | None = None


def _ephemeral_db_path(generation: int) -> str:
    """Return the temp-file path standing in for ``":memory:"``."""
    global _memory_dir
    if _memory_dir is None:
        _memory_dir = tempfile.TemporaryDirectory(prefix="resmon-ephemeral-db-")
    return str(Path(_memory_dir.name) / f"resmon_{generation}.db")


def _open_connection():
    """Open one connection to the configured database."""
    path = _db_path or None
    db_str = (
        _ephemeral_db_path(_db_generation) if path == ":memory:"
        else (str(path) if path else str(DEFAULT_DB_PATH))
    )
    conn = sqlite3.connect(db_str, check_same_thread=False, timeout=30)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL;")
    conn.execute("PRAGMA foreign_keys=ON;")
    conn.execute("PRAGMA busy_timeout=5000;")
    with _db_lock:
        _db_conns.append((conn, threading.current_thread()))
    return conn


def _get_db():
    """Return this thread's initialized database connection."""
    global _shared_conn, _db_initialized, _db_generation

    if _shared_conn is None:
        # A reset (or first use): invalidate every per-thread connection by
        # moving the generation forward, then re-anchor.
        _db_generation += 1
        _shared_conn = _open_connection()
        if not _db_initialized:
            init_db(conn=_shared_conn)
            _db_initialized = True

    conn = getattr(_db_local, "conn", None)
    if conn is None or getattr(_db_local, "generation", None) != _db_generation:
        conn = _open_connection()
        _db_local.conn = conn
        _db_local.generation = _db_generation
    return conn


def _close_db(conn):
    """No-op — a thread keeps its connection for its lifetime."""
    pass


# ---------------------------------------------------------------------------
# Pydantic models
# ---------------------------------------------------------------------------

class DiveRequest(BaseModel):
    repository: str
    query: str
    keywords: Optional[list[str]] = None
    date_from: Optional[str] = None
    date_to: Optional[str] = None
    max_results: int = 100
    ai_enabled: bool = False
    ai_settings: Optional[dict] = None
    ephemeral_credentials: Optional[dict[str, str]] = None
    # Update 3 / 4_27_26: when the user launches the dive from a saved
    # configuration via ConfigLoader, the frontend echoes that config's
    # id so the new execution row can be linked back to it.
    saved_configuration_id: Optional[int] = None

class SweepRequest(BaseModel):
    repositories: list[str]
    query: str
    keywords: Optional[list[str]] = None
    date_from: Optional[str] = None
    date_to: Optional[str] = None
    max_results: int = 100
    ai_enabled: bool = False
    ai_settings: Optional[dict] = None
    ephemeral_credentials: Optional[dict[str, str]] = None
    # Update 3 / 4_27_26: see DiveRequest.saved_configuration_id.
    saved_configuration_id: Optional[int] = None

class RoutineCreate(BaseModel):
    name: str
    schedule_cron: str
    parameters: dict
    # What the owner is really looking for, in their own words. Optional, and
    # deliberately not defaulted from the keywords: the coverage audit reports
    # which of the two it compared against, and a silent fallback written into
    # the column would make every routine claim a stated intent it never had.
    intent: Optional[str] = None
    is_active: bool = True
    email_enabled: bool = False
    email_ai_summary_enabled: bool = False
    ai_enabled: bool = False
    ai_settings: Optional[dict] = None
    storage_settings: Optional[dict] = None
    notify_on_complete: bool = False

class RoutineUpdate(BaseModel):
    name: Optional[str] = None
    schedule_cron: Optional[str] = None
    parameters: Optional[dict] = None
    intent: Optional[str] = None
    is_active: Optional[bool] = None
    email_enabled: Optional[bool] = None
    email_ai_summary_enabled: Optional[bool] = None
    ai_enabled: Optional[bool] = None
    ai_settings: Optional[dict] = None
    storage_settings: Optional[dict] = None
    notify_on_complete: Optional[bool] = None

class ConfigCreate(BaseModel):
    name: str
    config_type: str
    parameters: dict
    # Update 3 / 4_27_26: when the SaveConfigButton on Calendar /
    # Dashboard / Results & Logs creates a config from an existing
    # manual execution, the frontend includes the execution id so the
    # backend can stamp ``executions.saved_configuration_id`` in the
    # same request — "last save wins" if the user saves the same
    # execution multiple times.
    link_to_execution_id: Optional[int] = None

class ConfigUpdate(BaseModel):
    name: Optional[str] = None
    parameters: Optional[dict] = None

class SettingsBody(BaseModel):
    settings: dict

class ExecutionSettingsBody(BaseModel):
    max_concurrent_executions: int
    routine_fire_queue_limit: int

class CredentialValidate(BaseModel):
    provider: str
    key: str
    # IMPL-AI12: the Custom provider needs the user-supplied OpenAI-compatible
    # base URL (e.g. ``https://api.together.xyz/v1``) to build the probe.
    base_url: Optional[str] = None

class CredentialStore(BaseModel):
    value: str

class AIModelsRequest(BaseModel):
    provider: str
    # Optional API key. When absent the stored credential for the provider
    # (if any) is used. Never logged or returned to the caller.
    key: Optional[str] = None
    # Required for ``custom``. Ignored for all other providers.
    base_url: Optional[str] = None
    # Custom provider only — auth header prefix (default ``Bearer``).
    header_prefix: Optional[str] = None
    # Required for ``local`` — the ollama endpoint URL.
    endpoint: Optional[str] = None
    # 1.8.5, subscription lanes only — the full path to the agent CLI, when the
    # user has set one. Never a credential: it is a path to a binary.
    binary_path: Optional[str] = None

class CloudBackup(BaseModel):
    execution_ids: Optional[list[int]] = None

class ConfigExport(BaseModel):
    ids: list[int]


class ExecutionExport(BaseModel):
    ids: list[int]


# ---------------------------------------------------------------------------
# Health
# ---------------------------------------------------------------------------

_STARTED_AT = datetime.now(timezone.utc).isoformat()


@app.get("/api/health")
def health():
    """Liveness endpoint. Returns process identity so clients can attach-or-spawn.

    ``embeddings`` reports whether *this* backend can load the vector extension,
    and why not when it cannot. It is here rather than on a route of its own
    because the renderer already reads health on startup to decide what to show,
    and phase 1.9's rule is that a feature whose dependency is missing is
    **absent** rather than present-and-broken: the Explorer's similarity sort and
    the similar-papers panel are not rendered when this says ``null``. A user is
    told the reason in Settings, not by a control that does nothing.

    The load is attempted against a real connection on every call rather than
    read from a cached probe. It is a ``dlopen`` of a 165 KB library, and a
    health endpoint that answered from memory would keep reporting a capability
    the process had lost.
    """
    conn = _get_db()
    try:
        embeddings = vector_index.extension_status(conn)
    except Exception as exc:  # pragma: no cover - defence; the status call catches its own
        embeddings = {"extension": None, "reason": f"{type(exc).__name__}: {exc}"}
    finally:
        _close_db(conn)
    return {
        "status": "ok",
        "pid": os.getpid(),
        "started_at": _STARTED_AT,
        "version": APP_VERSION,
        "embeddings": embeddings,
    }


# ---------------------------------------------------------------------------
# Search (manual dive / sweep)
# ---------------------------------------------------------------------------

@app.get("/api/search/repositories")
def search_repositories():
    return list_repositories()


@app.get("/api/repositories/catalog")
def repositories_catalog():
    """Return the static repository catalog (never returns secrets)."""
    return catalog_as_dicts()


@app.get("/api/credentials")
def credentials_presence():
    """Return per-credential status for every known credential name.

    Never returns the raw credential value.

    Each entry carries ``present`` (kept for compatibility) and ``status``,
    which is ``present``, ``absent`` or ``unreadable``. The last one matters:
    an unsigned macOS build is denied access to keychain items an earlier
    build stored, and reporting that as "absent" tells the user their keys
    are gone when they are simply unreachable. ``keyring_responsive`` is
    False once a read has timed out, so the interface can say so once at the
    top rather than fifteen times over.
    """
    names = sorted(
        catalog_credential_names()
        | AI_CREDENTIAL_NAMES
        | SMTP_CREDENTIAL_NAMES
    )
    statuses = {name: probe_credential(name) for name in names}
    return {
        "keyring_responsive": keyring_is_responsive(),
        "credentials": {
            name: {"present": status == PRESENT, "status": status}
            for name, status in statuses.items()
        },
    }


# ---------------------------------------------------------------------------
# AI summarization wiring (IMPL-AI8)
# ---------------------------------------------------------------------------

# Keys that participate in the LLM-factory settings payload. Persisted
# values live in ``app_settings``; a per-execution override may be passed
# through ``engine.config["ai_settings"]`` (request-body payload) and wins
# on merge.
_AI_SETTING_KEYS: tuple[str, ...] = (
    "ai_chain",
    "ai_provider",
    "ai_model",
    "ai_local_model",
    "ai_local_endpoint",
    "ai_custom_base_url",
    "ai_summary_length",
    "ai_tone",
    "ai_temperature",
    "ai_extraction_goals",
    "ai_show_audit_prefix",
    # 1.8.5 — the three subscription-lane keys. They were reachable through
    # ``PUT /api/settings/ai`` in the renderer's mind only: absent from this
    # tuple, ``_load_ai_settings_from_db`` never read them, so
    # ``resolve_chain`` built every subscription lane without the binary path
    # or the cap the user had set. Absent from ``_SETTINGS_GROUPS["ai"]``
    # below, the PUT dropped them before they were ever stored. A setting is
    # only real when it appears in both.
    "ai_cli_path",
    "ai_subscription_doc_cap",
    "ai_effort",
)

# IMPL-AI13 / Update 2 — Feature 2: per-execution override dicts sent
# through the request body use short keys. Translate them onto the
# canonical ``ai_*`` names before merging so the override actually wins.
# Update 2 — Feature 2 expands parity with Settings → AI by adding
# ``provider``, ``temperature``, ``extraction_goals``, and ``local_model``.
_AI_OVERRIDE_KEY_MAP: dict[str, str] = {
    "provider": "ai_provider",
    "model": "ai_model",
    "local_model": "ai_local_model",
    "length": "ai_summary_length",
    "tone": "ai_tone",
    "temperature": "ai_temperature",
    "extraction_goals": "ai_extraction_goals",
    # 1.8b — a routine can override the whole chain, not just the provider.
    "chain": "ai_chain",
}


def _normalize_ai_override(override: dict | None) -> dict:
    """Translate short-form override keys onto their canonical ``ai_*`` names."""
    if not isinstance(override, dict):
        return {}
    out: dict = {}
    for k, v in override.items():
        if v is None:
            continue
        if isinstance(v, str) and not v.strip():
            continue
        canonical = _AI_OVERRIDE_KEY_MAP.get(k, k)
        out[canonical] = v
    return out


def _load_ai_settings_from_db(conn) -> dict:
    """Return a dict of persisted ``ai_*`` settings (values may be ``""``)."""
    out: dict = {}
    for key in _AI_SETTING_KEYS:
        try:
            value = get_setting(conn, key)
        except Exception:
            value = None
        if value is not None:
            out[key] = value
    return out


def _build_prompt_params(merged: dict) -> dict:
    """Distill prompt knobs from merged AI settings (IMPL-AI8 §F1 / F6).

    IMPL-AI13 additions: carries ``_show_audit_prefix`` + ``_audit_provider``
    + ``_audit_model`` so :class:`SummarizationPipeline` can prepend the
    audit-trail prefix without a direct DB lookup.
    """
    length = str(merged.get("ai_summary_length") or "").strip() or "standard"
    tone = str(merged.get("ai_tone") or "").strip() or "technical"
    goals = merged.get("ai_extraction_goals")
    params: dict = {"length": length, "tone": tone}
    if goals:
        params["extraction_goals"] = str(goals)
    # Update 2 — Feature 2: surface ``ai_temperature`` so it reaches
    # ``RemoteLLMClient.generate`` (which reads ``params['temperature']``).
    # Empty / unparseable values fall back to the client default.
    raw_temp = str(merged.get("ai_temperature") or "").strip()
    if raw_temp:
        try:
            params["temperature"] = float(raw_temp)
        except (TypeError, ValueError):
            pass
    # Audit-prefix controls. Default is enabled; only an explicit "false"
    # (case-insensitive) disables the prefix.
    raw_flag = str(merged.get("ai_show_audit_prefix") or "").strip().lower()
    params["_show_audit_prefix"] = raw_flag != "false"
    provider = str(merged.get("ai_provider") or "").strip().lower()
    if provider == "local":
        model = str(merged.get("ai_local_model") or "").strip()
    else:
        model = str(merged.get("ai_model") or "").strip()
    params["_audit_provider"] = provider
    params["_audit_model"] = model
    return params


def _apply_embedding_settings_to_engine(engine: SweepEngine, exec_id: int, conn) -> None:
    """Attach ``engine.embedding_lane``, or record why there is none.

    Mirrors :func:`_apply_ai_settings_to_engine`. Separate from it on purpose:
    the two lanes are configured independently, and a user who wants semantic
    search without AI summaries — or the reverse — must not have to enable both.

    **The extension is checked here rather than inside the engine**, because
    that is where the honest message differs. Vectors are still written when the
    index will not load; what is unavailable is *ranking*, and telling the user
    that once per run beats a sweep that looks like it did nothing.
    """
    lane = _current_embedding_lane(conn)
    engine.embedding_lane = lane
    if lane is None:
        return
    extension = vector_index.extension_status(conn)
    if extension["extension"] is None:
        progress_store.emit(exec_id, {
            "type": "log_entry",
            "level": "warn",
            "message": (
                "Embedding will run, but this build cannot rank by meaning: "
                f"{extension['reason']} The vectors are stored and will be usable "
                "once the extension loads."
            ),
            "timestamp": datetime.now(timezone.utc).isoformat(),
        })


def _apply_ai_settings_to_engine(
    engine: SweepEngine,
    exec_id: int,
    conn,
    ephemeral_credentials: Optional[dict[str, str]],
) -> None:
    """Attach ``engine.ai_lanes`` and ``engine.config['ai_prompt_params']``.

    Behavior:

    * Always merge persisted ``ai_*`` settings with the per-execution
      override in ``engine.config["ai_settings"]`` (override wins).
    * Resolve the merged settings into lanes. **No client is built here.**
      ``ChainRunner`` builds each lane, lane 0 included, from the lane
      itself — which is the only place that knows what kind of lane it is.
    * Emit one ``log_entry`` warning when nothing at all is configured, i.e.
      when ``resolve_chain`` is empty; never raise.
    * Populate ``engine.config["ai_prompt_params"]`` from the merged
      settings so :class:`SummarizationPipeline` can honor Summary-Length
      / Tone selectors.

    Until 1.8.5 this function also called
    :func:`build_llm_client_from_settings` and handed the result to the
    engine as ``llm_client``. That function has no subscription branch: for a
    subscription-primary configuration it returned ``None`` and this code
    then announced *"AI skipped: API key missing"* on every run — while the
    chain went on to drive the CLI perfectly well. A message that is wrong
    about work the app is doing correctly is the overclaim in reverse, and it
    was reaching users on the exact route 1.8.5 makes primary.

    Building lane 0 here also mislabelled a routine override that carried
    ``provider`` without ``chain``: the override provider did the work while
    lane 0's ``execution_ai`` row named the persisted chain's lane.
    """
    persisted = _load_ai_settings_from_db(conn)
    override = _normalize_ai_override(engine.config.get("ai_settings"))
    merged = {**persisted, **override}

    ai_enabled = bool(engine.config.get("ai_enabled"))
    engine.config["ai_prompt_params"] = _build_prompt_params(merged)

    if not ai_enabled:
        engine.llm_client = None
        engine.ai_lane = None
        return

    # Resolve the configuration into lanes (1.8a). Today the chain is always
    # one lane long -- resolve_chain reads the legacy ai_* keys as a one-lane
    # chain -- so behavior here is unchanged. What is new is that the engine
    # now knows *which* lane it is running, which is what lets it record the
    # attempt in execution_ai. Executing more than one lane is 1.8b.
    chain = resolve_chain(merged)
    engine.ai_lanes = chain
    engine.ai_lane = chain[0] if chain else None
    # The engine builds each lane's client lazily, so it needs the
    # per-execution keys rather than a client built here.
    engine.ai_ephemeral = ephemeral_credentials or None

    # No prebuilt client. ``ChainRunner`` accepts ``primary_client`` and it
    # stays as the seam tests construct an engine through, but the API path
    # leaves it empty so every lane -- including lane 0 -- is built from the
    # lane by ``build_client_for_lane``, which is the only builder that knows
    # what a subscription lane is.
    engine.llm_client = None

    if not chain:
        # Nothing is configured at all. Every other reason a lane cannot run
        # -- no key, no model, CLI not found -- is known per lane rather than
        # globally, so it is reported by the lane after the chain has tried,
        # in ``SweepEngine``. Guessing here is what produced the false
        # "API key missing".
        progress_store.emit(exec_id, {
            "type": "log_entry",
            "level": "warn",
            "message": "AI skipped: provider not configured",
            "timestamp": datetime.now(timezone.utc).isoformat(),
        })


# ---------------------------------------------------------------------------
# Renderer-presence heartbeat (Bug B follow-up — duplicate-notification fix)
# ---------------------------------------------------------------------------
#
# The Electron renderer fires its own ``new Notification(...)`` on
# completion. When the renderer is running, the headless-daemon-side
# ``desktop_notifier.notify`` call (which on macOS goes through
# ``osascript`` and is therefore attributed to Script Editor) duplicates
# that notification under an unfamiliar app name. To avoid the dupe
# while still preserving the headless-daemon path (app fully closed),
# the renderer posts a lightweight heartbeat to the backend; when the
# heartbeat is fresh, the backend suppresses its own dispatch and lets
# the renderer alone show the notification.

_RENDERER_HEARTBEAT_TTL_SEC = 15.0
_renderer_last_heartbeat_ts: float = 0.0


def _renderer_is_attached() -> bool:
    """Return True if the renderer pinged us recently enough to handle
    its own desktop notifications."""
    if _renderer_last_heartbeat_ts <= 0:
        return False
    return (time.time() - _renderer_last_heartbeat_ts) <= _RENDERER_HEARTBEAT_TTL_SEC


def _should_dispatch_desktop_notification(
    *,
    execution_type: str,
    notify_manual: bool,
    notify_automatic_mode: str,
    routine_notify_on_complete: bool,
) -> bool:
    """Decide whether a completed execution warrants a desktop notification.

    Mirrors the in-renderer logic in
    ``ExecutionContext.maybeNotifyCompletion``:

    * Manual runs (``deep_dive`` / ``deep_sweep``) honor ``notify_manual``.
    * Automated runs (``automated_sweep``) honor the per-routine
      ``notify_on_complete`` flag first; otherwise fall back to the
      global ``notify_automatic_mode`` (``all`` fires for every routine,
      ``none`` and ``selected`` suppress when the per-routine flag is
      false).
    """
    if execution_type in ("deep_dive", "deep_sweep"):
        return bool(notify_manual)
    if execution_type == "automated_sweep":
        if routine_notify_on_complete:
            return True
        return notify_automatic_mode == "all"
    return False


def _dispatch_desktop_notification(conn, execution_row: dict) -> None:
    """Best-effort OS-level desktop notification for a completed execution.

    Reads the same settings keys consumed by the in-renderer notifier
    plus the per-routine ``notify_on_complete`` flag, then dispatches via
    :mod:`implementation_scripts.desktop_notifier`. Any failure is
    logged at debug level and never raises.
    """
    try:
        from implementation_scripts import desktop_notifier
    except Exception:
        return

    # If the Electron renderer is attached, it will fire its own
    # ``new Notification(...)``. Suppress the backend dispatch to avoid
    # the duplicate (which on macOS arrives attributed to Script Editor
    # because it's posted via ``osascript``).
    if _renderer_is_attached():
        return

    execution_type = str(execution_row.get("execution_type") or "").strip()
    if execution_type not in ("deep_dive", "deep_sweep", "automated_sweep"):
        return

    raw = _get_settings_group(conn, "notifications")
    manual_raw = str(raw.get("notify_manual", "")).strip().lower()
    if raw.get("notify_manual", "") == "":
        notify_manual = True  # default-on for first-load parity with GET endpoint
    else:
        notify_manual = manual_raw in ("1", "true", "yes", "on")
    mode = str(raw.get("notify_automatic_mode", "")).strip().lower()
    if mode not in ("all", "selected", "none"):
        mode = "none"

    routine_notify_on_complete = False
    routine_id = execution_row.get("routine_id")
    if routine_id:
        try:
            routine = get_routine_by_id(conn, int(routine_id))
            if routine:
                routine_notify_on_complete = bool(routine.get("notify_on_complete"))
        except Exception:
            pass

    if not _should_dispatch_desktop_notification(
        execution_type=execution_type,
        notify_manual=notify_manual,
        notify_automatic_mode=mode,
        routine_notify_on_complete=routine_notify_on_complete,
    ):
        return

    status = str(execution_row.get("status") or "").strip().lower()
    type_label = {
        "deep_dive": "Deep Dive",
        "deep_sweep": "Deep Sweep",
        "automated_sweep": "Automated Sweep",
    }.get(execution_type, "Execution")
    title = (
        "resmon: Execution Completed"
        if status == "completed"
        else f"resmon: Execution {status or 'finished'}"
    )
    if status == "completed":
        total = execution_row.get("total_results") or 0
        new = execution_row.get("new_results") or 0
        body = f"{type_label} finished — {total} results ({new} new)."
    else:
        body = f"{type_label} ended with status: {status or 'unknown'}."

    try:
        desktop_notifier.notify(title, body)
    except Exception:
        logging.getLogger(__name__).debug(
            "desktop_notifier.notify raised", exc_info=True,
        )


def _launch_execution(
    engine: SweepEngine,
    exec_id: int,
    conn,
    ephemeral_credentials: Optional[dict[str, str]] = None,
) -> None:
    """Run the pipeline in a background thread, then persist progress events."""

    def _run() -> None:
        admission.note_admitted(exec_id)
        # Take this thread's own connection rather than reusing the request
        # thread's (BUG-020). The two run concurrently -- the endpoint returns
        # as soon as the thread is started -- and sharing one sqlite3.Connection
        # between them is the race this whole change exists to remove. The
        # engine is rebound too, since it captured the request's connection when
        # it was constructed.
        conn = _get_db()
        engine.db = conn
        try:
            # Register any per-execution credentials BEFORE the engine runs
            # so that client ``get_credential_for`` lookups see them.  Raw
            # values are never logged.
            push_ephemeral(exec_id, ephemeral_credentials or {})
            # IMPL-AI8: attach an LLM client + prompt-parameter bundle to the
            # engine immediately before run_prepared so AI summarization can
            # actually execute. Settings precedence: per-execution override
            # (``engine.config["ai_settings"]``) wins over persisted
            # ``app_settings``. Factory returning ``None`` with
            # ``ai_enabled=True`` results in a single ``log_entry`` progress
            # event and the execution continues without AI.
            _apply_ai_settings_to_engine(
                engine, exec_id, conn, ephemeral_credentials,
            )
            # 1.9 — the embedding lane, resolved the same way and at the same
            # point. It is independent of ``ai_enabled``: semantic search and AI
            # summaries are separate features and a user may want either alone.
            _apply_embedding_settings_to_engine(engine, exec_id, conn)
            try:
                engine.run_prepared(exec_id)
            except Exception:
                pass  # SweepEngine already marks status='failed' and emits error events
        finally:
            pop_ephemeral(exec_id)
            progress_store.mark_complete(exec_id)
            # Routine completion email hook (IMPL-R7). Fires only for
            # routine-backed executions where the routine has email enabled.
            # Any failure is logged but never fails the execution.
            try:
                row = get_execution_by_id(conn, exec_id)
                if (
                    row
                    and row.get("execution_type") == "automated_sweep"
                    and row.get("routine_id")
                ):
                    routine = get_routine_by_id(conn, row["routine_id"])
                    if routine and routine.get("email_enabled"):
                        from implementation_scripts import email_sender
                        # "Results in Email" (previously "AI Summary in
                        # Email") now ships the full execution results
                        # ``.zip`` as an email attachment, reusing the
                        # same bundle helper the Results & Logs export
                        # button produces.
                        attachment_path: Optional[str] = None
                        if routine.get("email_ai_summary_enabled"):
                            try:
                                tmp = tempfile.NamedTemporaryFile(
                                    suffix=".zip", delete=False,
                                    prefix=f"resmon_routine_{exec_id}_",
                                )
                                tmp.close()
                                _build_execution_zip([row], Path(tmp.name))
                                attachment_path = tmp.name
                            except Exception:
                                logging.getLogger(__name__).exception(
                                    "Failed to build results zip for "
                                    "exec_id=%s; sending email without "
                                    "attachment.",
                                    exec_id,
                                )
                                attachment_path = None
                        try:
                            email_sender.send_routine_completion_email(
                                routine=routine,
                                execution=row,
                                include_ai_summary=False,
                                attachment_path=attachment_path,
                            )
                        except Exception:
                            logging.getLogger(__name__).exception(
                                "Failed to send completion email for exec_id=%s",
                                exec_id,
                            )
                        finally:
                            if attachment_path:
                                try:
                                    os.unlink(attachment_path)
                                except OSError:
                                    pass
            except Exception:
                logging.getLogger(__name__).exception(
                    "Routine completion email hook raised for exec_id=%s", exec_id,
                )
            # Bug-B (Update 2 / Batch 2): desktop notification dispatch.
            # Fires from the backend so notifications work even under the
            # headless-daemon path where the renderer is not running.
            # Reads the same settings keys consumed by the in-renderer
            # notifier (``notify_manual``, ``notify_automatic_mode``) plus
            # the per-routine ``notify_on_complete`` flag.
            try:
                row = get_execution_by_id(conn, exec_id)
                if row:
                    _dispatch_desktop_notification(conn, row)
            except Exception:
                logging.getLogger(__name__).exception(
                    "Desktop notification hook raised for exec_id=%s", exec_id,
                )
            # Persisting progress must never be able to strand the
            # execution's concurrency slot. ``admission.note_finished`` is what
            # returns that slot; if it is skipped the slot is held for the life
            # of the process, and after ``max_concurrent`` such failures every
            # Deep Dive and Deep Sweep is rejected with HTTP 429 while nothing
            # is actually running. A locked database past the 5 s busy_timeout,
            # a full disk, or a shutdown race is enough to trigger it.
            try:
                events = progress_store.get_events(exec_id)
                save_progress_events(conn, exec_id, events)
            except Exception:
                logging.getLogger(__name__).exception(
                    "Failed to persist progress events for exec_id=%s", exec_id,
                )
            finally:
                try:
                    progress_store.cleanup(exec_id)
                except Exception:
                    logging.getLogger(__name__).exception(
                        "progress_store.cleanup failed for exec_id=%s", exec_id,
                    )
                admission.note_finished(exec_id)

    t = threading.Thread(target=_run, daemon=True, name=f"exec-{exec_id}")
    t.start()


def _reject_if_at_manual_cap() -> None:
    """Raise 429 when the admission controller is at the manual cap (IMPL-R2)."""
    if not admission.try_admit(kind="manual"):
        raise HTTPException(
            status_code=429,
            detail=(
                f"resmon is already running the maximum of {admission.max()} "
                "concurrent executions. Wait for one to finish or raise the "
                "limit in Settings \u2192 Advanced."
            ),
            headers={"Retry-After": "5"},
        )


@app.post("/api/search/dive")
def search_dive(body: DiveRequest):
    _reject_if_at_manual_cap()
    conn = _get_db()
    engine = SweepEngine(
        db_conn=conn,
        config={"ai_enabled": body.ai_enabled, "ai_settings": body.ai_settings},
    )
    query_params = {
        "query": body.query,
        "keywords": body.keywords,
        "date_from": body.date_from,
        "date_to": body.date_to,
        "max_results": body.max_results,
    }
    exec_id = engine.prepare_execution("deep_dive", [body.repository], query_params)
    # Update 3 / 4_27_26: link the new execution back to the saved
    # configuration the user picked in ConfigLoader (if any).
    if body.saved_configuration_id is not None:
        set_execution_saved_configuration(conn, exec_id, body.saved_configuration_id)
    progress_store.register(exec_id)
    _launch_execution(engine, exec_id, conn, ephemeral_credentials=body.ephemeral_credentials)
    return {"execution_id": exec_id}


@app.post("/api/search/sweep")
def search_sweep(body: SweepRequest):
    _reject_if_at_manual_cap()
    conn = _get_db()
    engine = SweepEngine(
        db_conn=conn,
        config={"ai_enabled": body.ai_enabled, "ai_settings": body.ai_settings},
    )
    query_params = {
        "query": body.query,
        "keywords": body.keywords,
        "date_from": body.date_from,
        "date_to": body.date_to,
        "max_results": body.max_results,
    }
    exec_id = engine.prepare_execution("deep_sweep", body.repositories, query_params)
    # Update 3 / 4_27_26: link the new execution back to the saved
    # configuration the user picked in ConfigLoader (if any).
    if body.saved_configuration_id is not None:
        set_execution_saved_configuration(conn, exec_id, body.saved_configuration_id)
    progress_store.register(exec_id)
    _launch_execution(engine, exec_id, conn, ephemeral_credentials=body.ephemeral_credentials)
    return {"execution_id": exec_id}


# ---------------------------------------------------------------------------
# Routines CRUD
# ---------------------------------------------------------------------------

def _serialize_routine_for_config(routine: dict) -> dict:
    """Return the ``parameters`` JSON payload for a routine-mirror config row.

    The mirror row lives in ``saved_configurations`` with ``config_type='routine'``
    so that the Configurations page can list it alongside manual configs. The
    ``linked_routine_id`` key is what ties the two rows together across
    sync/update/delete operations.
    """
    params = routine.get("parameters")
    if isinstance(params, str):
        try:
            params = json.loads(params)
        except (json.JSONDecodeError, TypeError):
            params = {}
    return {
        "linked_routine_id": routine["id"],
        "schedule_cron": routine.get("schedule_cron", ""),
        "parameters": params or {},
        "is_active": bool(routine.get("is_active")),
        "email_enabled": bool(routine.get("email_enabled")),
        "email_ai_summary_enabled": bool(routine.get("email_ai_summary_enabled")),
        "ai_enabled": bool(routine.get("ai_enabled")),
        "notify_on_complete": bool(routine.get("notify_on_complete")),
        "execution_location": routine.get("execution_location", "local"),
    }


def _find_routine_config(conn, routine_id: int) -> Optional[dict]:
    for row in get_configurations(conn, config_type="routine"):
        raw = row.get("parameters")
        if isinstance(raw, str):
            try:
                raw = json.loads(raw)
            except (json.JSONDecodeError, TypeError):
                continue
        if isinstance(raw, dict) and raw.get("linked_routine_id") == routine_id:
            return row
    return None


def _sync_routine_config(conn, routine_id: int) -> None:
    routine = get_routine_by_id(conn, routine_id)
    if not routine:
        return
    payload = _serialize_routine_for_config(routine)
    existing = _find_routine_config(conn, routine_id)
    if existing is not None:
        update_configuration(conn, existing["id"], {
            "name": routine["name"],
            "parameters": json.dumps(payload),
        })
    else:
        insert_configuration(conn, {
            "name": routine["name"],
            "config_type": "routine",
            "parameters": json.dumps(payload),
        })


def _delete_routine_config(conn, routine_id: int) -> None:
    existing = _find_routine_config(conn, routine_id)
    if existing is not None:
        delete_configuration(conn, existing["id"])


# ---------------------------------------------------------------------------
# Scheduler CRUD sync helpers (IMPL-R5)
#
# Every routine endpoint that mutates the local row mirrors the change to
# the APScheduler jobstore so schedule state matches the DB. Scheduler
# exceptions are logged but never propagated, so a scheduler fault cannot
# prevent the DB mutation from completing.
# ---------------------------------------------------------------------------

_scheduler_sync_logger = logging.getLogger(__name__)


def _sched_add_routine(routine_id: int) -> None:
    if scheduler is None:
        return
    conn = _get_db()
    try:
        row = get_routine_by_id(conn, routine_id)
    finally:
        _close_db(conn)
    if not row or not row.get("is_active"):
        return
    try:
        scheduler.add_routine(row)
    except Exception:
        _scheduler_sync_logger.exception(
            "scheduler.add_routine failed for routine_id=%s", routine_id,
        )


def _sched_update_routine(routine_id: int) -> None:
    if scheduler is None:
        return
    conn = _get_db()
    try:
        row = get_routine_by_id(conn, routine_id)
    finally:
        _close_db(conn)
    if not row:
        return
    try:
        if row.get("is_active"):
            scheduler.update_routine(routine_id, row)
        else:
            scheduler.remove_routine(routine_id)
    except Exception:
        _scheduler_sync_logger.exception(
            "scheduler sync failed on update for routine_id=%s", routine_id,
        )


def _sched_remove_routine(routine_id: int) -> None:
    if scheduler is None:
        return
    try:
        scheduler.remove_routine(routine_id)
    except Exception:
        _scheduler_sync_logger.exception(
            "scheduler.remove_routine failed for routine_id=%s", routine_id,
        )


@app.post("/api/renderer/heartbeat")
def renderer_heartbeat():
    """Renderer-presence ping.

    The Electron renderer posts here every few seconds while it is
    running. The backend uses the most recent ping to decide whether
    to suppress its own desktop-notification dispatch (which would
    otherwise duplicate the in-renderer ``new Notification(...)`` and,
    on macOS, surface under ``Script Editor`` because it's invoked via
    ``osascript``). When the heartbeat is stale (renderer closed), the
    backend resumes dispatching so the headless-daemon path still
    works.
    """
    global _renderer_last_heartbeat_ts
    _renderer_last_heartbeat_ts = time.time()
    return {"ok": True, "ttl_sec": _RENDERER_HEARTBEAT_TTL_SEC}


@app.get("/api/routines")
def list_routines():
    conn = _get_db()
    try:
        routines = get_routines(conn)
        # Enrich with last_execution / last_status so the Routines table
        # can show the timestamp and status of each routine's most recent
        # run. ``last_executed_at`` is stamped at fire-time; the status is
        # resolved from the most recent ``executions`` row that carries
        # the routine_id FK.
        for r in routines:
            rid = r.get("id")
            r["last_execution"] = r.get("last_executed_at")
            last_status = None
            if rid is not None:
                try:
                    row = conn.execute(
                        "SELECT status FROM executions "
                        "WHERE routine_id = ? "
                        "ORDER BY start_time DESC LIMIT 1",
                        (int(rid),),
                    ).fetchone()
                    if row is not None:
                        last_status = row["status"] if isinstance(row, sqlite3.Row) else row[0]
                except Exception:
                    last_status = None
            r["last_status"] = last_status
        return routines
    finally:
        _close_db(conn)


@app.get("/api/routines/{routine_id}")
def get_routine(routine_id: int):
    """Fetch a single routine by ID.

    The renderer's notification path needs the per-routine
    ``notify_on_complete`` flag to decide whether to fire a desktop
    notification under ``notify_automatic_mode == 'selected'``. Without
    this endpoint the renderer's fetch silently 404s and the per-routine
    opt-in is treated as ``false``, which suppresses notifications even
    when the user enabled the per-row toggle.
    """
    conn = _get_db()
    try:
        routine = get_routine_by_id(conn, routine_id)
        if not routine:
            raise HTTPException(404, "Routine not found")
        # Coerce the same boolean-ish columns the list endpoint exposes
        # so the renderer doesn't have to re-coerce ``0/1`` integers.
        for col in (
            "is_active",
            "email_enabled",
            "email_ai_summary_enabled",
            "ai_enabled",
            "notify_on_complete",
        ):
            if col in routine:
                routine[col] = bool(routine[col])
        return routine
    finally:
        _close_db(conn)


@app.post("/api/routines", status_code=201)
def create_routine(body: RoutineCreate):
    conn = _get_db()
    try:
        routine_dict = {
            "name": body.name,
            "schedule_cron": body.schedule_cron,
            "parameters": json.dumps(body.parameters),
            # Blank is stored as NULL rather than "": ``intent_for`` treats both
            # as absent, and one representation of absent keeps the column
            # answerable with a plain ``IS NULL``.
            "intent": (body.intent or "").strip() or None,
            "is_active": int(body.is_active),
            "email_enabled": int(body.email_enabled),
            "email_ai_summary_enabled": int(body.email_ai_summary_enabled),
            "ai_enabled": int(body.ai_enabled),
            "ai_settings": json.dumps(body.ai_settings) if body.ai_settings else None,
            "storage_settings": json.dumps(body.storage_settings) if body.storage_settings else None,
            "notify_on_complete": int(body.notify_on_complete),
            "execution_location": "local",
        }
        rid = insert_routine(conn, routine_dict)
        _sync_routine_config(conn, rid)
        if body.is_active:
            _sched_add_routine(rid)
        return {"id": rid, "name": body.name}
    finally:
        _close_db(conn)


@app.put("/api/routines/{routine_id}")
def update_routine_endpoint(routine_id: int, body: RoutineUpdate):
    conn = _get_db()
    try:
        existing = get_routine_by_id(conn, routine_id)
        if not existing:
            raise HTTPException(404, "Routine not found")
        updates = {}
        if body.name is not None:
            updates["name"] = body.name
        if body.schedule_cron is not None:
            updates["schedule_cron"] = body.schedule_cron
        if body.parameters is not None:
            updates["parameters"] = json.dumps(body.parameters)
        if body.intent is not None:
            # An empty string is a *clear*, not a no-op: the editor sends the
            # whole form, so a user who deletes the sentence means to remove it.
            updates["intent"] = body.intent.strip() or None
        if body.is_active is not None:
            updates["is_active"] = int(body.is_active)
        if body.email_enabled is not None:
            updates["email_enabled"] = int(body.email_enabled)
        if body.email_ai_summary_enabled is not None:
            updates["email_ai_summary_enabled"] = int(body.email_ai_summary_enabled)
        if body.ai_enabled is not None:
            updates["ai_enabled"] = int(body.ai_enabled)
        if body.ai_settings is not None:
            updates["ai_settings"] = json.dumps(body.ai_settings)
        if body.storage_settings is not None:
            updates["storage_settings"] = json.dumps(body.storage_settings)
        if body.notify_on_complete is not None:
            updates["notify_on_complete"] = int(body.notify_on_complete)
        update_routine(conn, routine_id, updates)
        _sync_routine_config(conn, routine_id)
        _sched_update_routine(routine_id)
        return {"id": routine_id, **updates}
    finally:
        _close_db(conn)


@app.delete("/api/routines/{routine_id}")
def delete_routine_endpoint(routine_id: int):
    conn = _get_db()
    try:
        existing = get_routine_by_id(conn, routine_id)
        if not existing:
            raise HTTPException(404, "Routine not found")
        _sched_remove_routine(routine_id)
        _delete_routine_config(conn, routine_id)
        delete_routine(conn, routine_id)
        return {"success": True}
    finally:
        _close_db(conn)


@app.post("/api/routines/{routine_id}/activate")
def activate_routine(routine_id: int):
    conn = _get_db()
    try:
        existing = get_routine_by_id(conn, routine_id)
        if not existing:
            raise HTTPException(404, "Routine not found")
        update_routine(conn, routine_id, {"is_active": 1})
        _sync_routine_config(conn, routine_id)
        _sched_add_routine(routine_id)
        return {"id": routine_id, "is_active": True}
    finally:
        _close_db(conn)


@app.post("/api/routines/{routine_id}/run")
def run_routine_now(routine_id: int):
    """Run a routine immediately, outside its schedule.

    Writing the MCP contract found that resmon had no way to do this at all:
    routines could be activated or deactivated, and running one now meant
    rebuilding its configuration by hand as a sweep. That is a gap in the
    application rather than only in the tool surface -- "run my arXiv routine
    now" is something a person should be able to do from the interface too.

    Deliberately a thin wrapper over ``_dispatch_routine_fire``, the same
    function the scheduler calls, so a manual run and a scheduled fire take one
    code path and cannot drift apart. Everything that makes a scheduled fire
    correct -- admission control, the routine_id stamp, progress registration,
    the last_executed_at update -- applies here for free because it is
    literally the same code.

    An **inactive** routine does run, and the response says so. ``is_active``
    governs whether the scheduler fires a routine on its own; it is not a
    statement that the routine may never run. Refusing here would mean a user
    has to activate a routine, run it, and deactivate it again to get one
    result.
    """
    conn = _get_db()
    try:
        existing = get_routine_by_id(conn, routine_id)
        if not existing:
            raise HTTPException(404, "Routine not found")

        was_inactive = not bool(existing.get("is_active"))
        exec_id = _dispatch_routine_fire(
            routine_id, existing.get("parameters") or "{}", allow_inactive=True,
        )

        if exec_id is None:
            # The routine exists and we were willing to run it, so the only
            # remaining reason is admission control -- resmon is already
            # running as many executions as it allows. Saying that plainly
            # beats a generic failure the caller cannot act on.
            raise HTTPException(
                409,
                "resmon is already running as many executions as it allows at "
                "once. Wait for one to finish and try again.",
            )

        return {
            "execution_id": exec_id,
            "routine_id": routine_id,
            "was_inactive": was_inactive,
            "detail": (
                "This routine is not scheduled; it was run once because you "
                "asked for it." if was_inactive else
                "Running now, in addition to its schedule."
            ),
        }
    finally:
        _close_db(conn)


@app.post("/api/routines/{routine_id}/deactivate")
def deactivate_routine(routine_id: int):
    conn = _get_db()
    try:
        existing = get_routine_by_id(conn, routine_id)
        if not existing:
            raise HTTPException(404, "Routine not found")
        update_routine(conn, routine_id, {"is_active": 0})
        _sync_routine_config(conn, routine_id)
        _sched_remove_routine(routine_id)
        return {"id": routine_id, "is_active": False}
    finally:
        _close_db(conn)


# ---------------------------------------------------------------------------
# Executions
# ---------------------------------------------------------------------------

def _enrich_execution_row(row: dict) -> dict:
    """Add frontend-friendly fields (query, total_results, new_results).

    Parses the JSON ``parameters`` blob to surface the search query, and
    mirrors ``result_count`` / ``new_result_count`` under the names the UI
    expects. The original columns are preserved.
    """
    if not row:
        return row
    params_raw = row.get("parameters")
    query_val = None
    keywords_val: list[str] | None = None
    repos_val: list[str] | None = None
    if params_raw:
        try:
            params = json.loads(params_raw) if isinstance(params_raw, str) else params_raw
            if isinstance(params, dict):
                query_val = (
                    params.get("query")
                    or params.get("q")
                    or params.get("search_query")
                )
                kw = params.get("keywords")
                if isinstance(kw, list) and kw:
                    keywords_val = [str(k) for k in kw]
                repos = params.get("repositories")
                if isinstance(repos, list) and repos:
                    repos_val = [str(r) for r in repos]
                elif params.get("repository"):
                    repos_val = [str(params["repository"])]
        except (ValueError, TypeError):
            query_val = None
    # Fallback: legacy rows that predate keyword-list persistence only store
    # the flat query string. We intentionally do NOT split on whitespace here
    # because an unquoted multi-word term like ``machine learning`` would be
    # mangled into ``['machine', 'learning']``. Preserve the raw query as a
    # single keyword so multi-word terms stay intact; fresh executions always
    # carry an explicit ``keywords`` list which takes precedence above.
    if keywords_val is None and isinstance(query_val, str) and query_val.strip():
        keywords_val = [query_val.strip()]
    row["query"] = query_val
    row["keywords"] = keywords_val
    row["repositories"] = repos_val
    row["total_results"] = row.get("result_count")
    row["new_results"] = row.get("new_result_count")
    return row


def _source_outcomes(conn, exec_ids: list[int]) -> dict[int, dict]:
    """A compact per-execution summary of which sources actually answered.

    One query for a whole page rather than one per row: the Results list asks
    for fifty executions at a time, and "n of m sources could not answer"
    belongs on the row the user is already looking at rather than behind a
    click. ``could_not_answer`` counts the zeros that were **not** answers --
    an outage, an unreadable reply, a window the source cannot express, a
    missing key, a retired source -- and ``not_recorded`` counts the zeros
    resmon never observed, which are deliberately not folded into either
    number.
    """
    if not exec_ids:
        return {}
    placeholders = ",".join("?" for _ in exec_ids)
    rows = conn.execute(
        f"""
        SELECT execution_id, source, status, result_count, zero_reason
        FROM execution_sources
        WHERE execution_id IN ({placeholders})
        """,
        [int(i) for i in exec_ids],
    ).fetchall()

    summary: dict[int, dict] = {
        int(i): {
            "selected": 0, "answered": 0,
            "could_not_answer": 0, "not_recorded": 0,
            "sources_that_could_not_answer": [],
        }
        for i in exec_ids
    }
    for row in rows:
        entry = summary[int(row["execution_id"])]
        entry["selected"] += 1
        reason = row["zero_reason"]
        count = int(row["result_count"] or 0)
        if zero_answered(row["status"], count, reason):
            entry["answered"] += 1
        elif row["status"] == "ok" and count == 0 and reason in (None, "not_recorded"):
            entry["not_recorded"] += 1
        else:
            entry["could_not_answer"] += 1
            entry["sources_that_could_not_answer"].append(row["source"])
    return summary


@app.get("/api/executions")
def list_executions(
    limit: int = Query(50, ge=1, le=500),
    offset: int = Query(0, ge=0),
    type: Optional[str] = Query(None, alias="type"),
):
    conn = _get_db()
    try:
        rows = get_executions(conn, limit=limit, offset=offset, execution_type=type)
        outcomes = _source_outcomes(conn, [int(r["id"]) for r in rows])
        for row in rows:
            _enrich_execution_row(row)
            row["source_outcomes"] = outcomes.get(int(row["id"]))
        return rows
    finally:
        _close_db(conn)


@app.get("/api/executions/active")
def active_executions():
    return {"active_ids": progress_store.get_active_ids()}


@app.get("/api/executions/{exec_id}")
def get_execution(exec_id: int):
    conn = _get_db()
    try:
        row = get_execution_by_id(conn, exec_id)
        if not row:
            raise HTTPException(404, "Execution not found")
        _enrich_execution_row(row)
        row["source_outcomes"] = _source_outcomes(conn, [exec_id]).get(exec_id)
        return row
    finally:
        _close_db(conn)


@app.get("/api/executions/{exec_id}/report")
def get_execution_report(exec_id: int):
    conn = _get_db()
    try:
        row = get_execution_by_id(conn, exec_id)
        if not row:
            raise HTTPException(404, "Execution not found")
        rpath = row.get("result_path")
        if not rpath or not Path(rpath).exists():
            raise HTTPException(404, "Report not found")
        return {"report_text": Path(rpath).read_text(encoding="utf-8")}
    finally:
        _close_db(conn)


@app.get("/api/executions/{exec_id}/log")
def get_execution_log(exec_id: int):
    conn = _get_db()
    try:
        row = get_execution_by_id(conn, exec_id)
        if not row:
            raise HTTPException(404, "Execution not found")
        lpath = row.get("log_path")
        if not lpath or not Path(lpath).exists():
            raise HTTPException(404, "Log not found")
        return {"log_text": Path(lpath).read_text(encoding="utf-8")}
    finally:
        _close_db(conn)


@app.delete("/api/executions/{exec_id}")
def delete_execution(exec_id: int):
    conn = _get_db()
    try:
        row = get_execution_by_id(conn, exec_id)
        if not row:
            raise HTTPException(404, "Execution not found")
        conn.execute("DELETE FROM executions WHERE id = ?", (exec_id,))
        conn.commit()
        return {"success": True}
    finally:
        _close_db(conn)


@app.post("/api/executions/export")
def export_executions(body: ExecutionExport):
    """Bundle the reports and logs for the selected executions into a .zip.

    The output path respects the Storage tab's configured export directory
    when set; otherwise a temporary file is used. Raises 404 if no executions
    in the selection exist.
    """
    conn = _get_db()
    try:
        rows = []
        for eid in body.ids:
            row = get_execution_by_id(conn, eid)
            if row:
                rows.append(row)
        if not rows:
            raise HTTPException(404, "No matching executions found")

        export_dir = get_setting(conn, "export_directory") or ""
        if export_dir:
            out_dir = Path(export_dir).expanduser()
            try:
                out_dir.mkdir(parents=True, exist_ok=True)
            except Exception as exc:
                raise HTTPException(400, f"Invalid export_directory: {exc}")
            fname = f"resmon_executions_{datetime.now().strftime('%Y%m%dT%H%M%S')}.zip"
            out_path = out_dir / fname
        else:
            tmp = tempfile.NamedTemporaryFile(suffix=".zip", delete=False)
            tmp.close()
            out_path = Path(tmp.name)

        _build_execution_zip(rows, out_path)
        return {"path": str(out_path), "count": len(rows)}
    finally:
        _close_db(conn)


def _build_execution_zip(rows: list[dict], out_path: Path) -> Path:
    """Package report + logs + metadata for each execution row into *out_path*.

    Extracted from :func:`export_executions` so the same bundle can be
    attached to routine-completion emails without duplicating logic.
    """
    manifest: list[dict] = []
    with tempfile.TemporaryDirectory(prefix="resmon_export_") as staging_root:
        staging = Path(staging_root)
        for row in rows:
            eid = row["id"]
            folder = f"execution_{eid}"
            manifest.append({
                "id": eid,
                "execution_type": row.get("execution_type"),
                "query": row.get("query"),
                "status": row.get("status"),
                "start_time": row.get("start_time"),
                "end_time": row.get("end_time"),
                "total_results": row.get("total_results"),
                "new_results": row.get("new_results"),
            })
            exec_stage = staging / folder
            exec_stage.mkdir(parents=True, exist_ok=True)

            rpath = row.get("result_path")
            report_stem = "report"
            if rpath and Path(rpath).exists():
                report_stem = Path(rpath).stem
                shutil.copy(rpath, exec_stage / Path(rpath).name)
                try:
                    from implementation_scripts.report_exporter import export_report_bundle
                    export_report_bundle(Path(rpath), exec_stage, stem=report_stem)
                except Exception as exc:  # pragma: no cover - defensive
                    logging.getLogger(__name__).warning(
                        "Report bundle generation failed for execution %d: %s",
                        eid, exc,
                    )

            (exec_stage / "metadata.json").write_text(
                json.dumps({k: row.get(k) for k in row.keys()}, indent=2, default=str),
                encoding="utf-8",
            )
            lpath = row.get("log_path")
            if lpath and Path(lpath).exists():
                shutil.copy(lpath, exec_stage / Path(lpath).name)

        (staging / "manifest.json").write_text(
            json.dumps(manifest, indent=2), encoding="utf-8",
        )

        out_path.parent.mkdir(parents=True, exist_ok=True)
        with zipfile.ZipFile(out_path, "w", zipfile.ZIP_DEFLATED) as zf:
            for fpath in sorted(staging.rglob("*")):
                if fpath.is_file():
                    zf.write(fpath, arcname=str(fpath.relative_to(staging)))
    return out_path


@app.post("/api/executions/{exec_id}/cancel")
def cancel_execution(exec_id: int):
    """Request cooperative cancellation of a running execution."""
    if not progress_store.is_active(exec_id):
        raise HTTPException(409, "Execution not running")
    progress_store.request_cancel(exec_id)
    return {"status": "cancellation_requested"}


@app.get("/api/executions/{exec_id}/progress/stream")
async def stream_progress(exec_id: int, last_event_id: int = 0):
    conn = _get_db()
    row = get_execution_by_id(conn, exec_id)
    if not row:
        raise HTTPException(404, "Execution not found")

    # Helper: yield persisted events from DB as a batch, skipping any
    # events the client already received (via cursor / last_event_id).
    async def _batch_from_db(cursor: int = 0):
        persisted = get_progress_events(conn, exec_id)
        for i, event in enumerate(persisted):
            if i < cursor:
                continue
            yield f"id: {i}\nevent: progress\ndata: {json.dumps(event, default=str)}\n\n"

    # If the execution is already complete and not in the live store,
    # return persisted events as a batch and close.
    if not progress_store.is_active(exec_id):
        # Re-read status in case it was updated after the initial fetch
        fresh = get_execution_by_id(conn, exec_id)
        if fresh and fresh["status"] in ("completed", "failed", "cancelled"):
            return StreamingResponse(
                _batch_from_db(last_event_id),
                media_type="text/event-stream",
                headers={
                    "Cache-Control": "no-cache",
                    "Connection": "keep-alive",
                    "X-Accel-Buffering": "no",
                },
            )

    # Live stream from progress_store
    async def _event_generator():
        cursor = last_event_id
        while True:
            events = progress_store.get_events(exec_id, since=cursor)
            for i, event in enumerate(events):
                event_id = cursor + i
                yield f"id: {event_id}\nevent: progress\ndata: {json.dumps(event, default=str)}\n\n"
            cursor += len(events)

            if not progress_store.is_active(exec_id):
                # Execution finished — deliver any persisted events that
                # were missed (e.g. cleanup ran between polls).  Retry a
                # few times in case save_progress_events hasn't committed.
                persisted: list[dict] = []
                for _attempt in range(5):
                    persisted = get_progress_events(conn, exec_id)
                    if persisted and len(persisted) >= cursor:
                        break
                    await asyncio.sleep(0.3)
                for i, event in enumerate(persisted):
                    if i < cursor:
                        continue
                    yield f"id: {i}\nevent: progress\ndata: {json.dumps(event, default=str)}\n\n"
                break

            # Heartbeat comment to flush output buffers
            yield ": heartbeat\n\n"
            await asyncio.sleep(0.3)

    return StreamingResponse(
        _event_generator(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
        },
    )


@app.get("/api/executions/{exec_id}/progress/events")
def get_execution_progress_events(exec_id: int, response: Response):
    conn = _get_db()
    row = get_execution_by_id(conn, exec_id)
    if not row:
        raise HTTPException(404, "Execution not found")
    # Never cache progress polls — responses change every ~second during
    # an execution and Chromium's heuristic cache can otherwise serve
    # stale data for the entire run.
    response.headers["Cache-Control"] = "no-store, no-cache, must-revalidate"
    response.headers["Pragma"] = "no-cache"
    # Prefer live events if execution is still in memory (covers the
    # window between mark_complete and cleanup).  Fall back to persisted
    # events after cleanup removes the live store entry.
    if progress_store.is_registered(exec_id):
        return progress_store.get_events(exec_id)
    return get_progress_events(conn, exec_id)


# ---------------------------------------------------------------------------
# Configurations
# ---------------------------------------------------------------------------

@app.get("/api/configurations")
def list_configurations(config_type: Optional[str] = None):
    conn = _get_db()
    try:
        rows = get_configurations(conn, config_type=config_type)
        for r in rows:
            if isinstance(r.get("parameters"), str):
                try:
                    r["parameters"] = json.loads(r["parameters"])
                except (json.JSONDecodeError, TypeError):
                    pass
        return rows
    finally:
        _close_db(conn)


@app.post("/api/configurations", status_code=201)
def create_configuration(body: ConfigCreate):
    conn = _get_db()
    try:
        cid = insert_configuration(conn, {
            "name": body.name,
            "config_type": body.config_type,
            "parameters": json.dumps(body.parameters),
        })
        # Update 3 / 4_27_26: when the SaveConfigButton creates a config
        # from an existing manual execution, stamp the new config's id
        # back onto that execution row so the UI can surface a "Saved as"
        # indicator. "Last save wins" — a second save from the same
        # execution simply overwrites the column, exactly as the
        # recommendation document specified.
        if body.link_to_execution_id is not None:
            try:
                set_execution_saved_configuration(conn, body.link_to_execution_id, cid)
            except Exception:
                logging.getLogger(__name__).exception(
                    "Failed to stamp saved_configuration_id=%s on execution %s",
                    cid, body.link_to_execution_id,
                )
        return {"id": cid, "name": body.name, "config_type": body.config_type}
    finally:
        _close_db(conn)


@app.put("/api/configurations/{config_id}")
def update_configuration_endpoint(config_id: int, body: ConfigUpdate):
    conn = _get_db()
    try:
        row = conn.execute(
            "SELECT * FROM saved_configurations WHERE id = ?", (config_id,)
        ).fetchone()
        if not row:
            raise HTTPException(404, "Configuration not found")
        updates = {}
        if body.name is not None:
            updates["name"] = body.name
        if body.parameters is not None:
            updates["parameters"] = json.dumps(body.parameters)
        update_configuration(conn, config_id, updates)
        return {"id": config_id, **updates}
    finally:
        _close_db(conn)


@app.delete("/api/configurations/{config_id}")
def delete_configuration_endpoint(config_id: int):
    conn = _get_db()
    try:
        row = conn.execute(
            "SELECT * FROM saved_configurations WHERE id = ?", (config_id,)
        ).fetchone()
        if not row:
            raise HTTPException(404, "Configuration not found")
        row = dict(row)
        # Cascade: deleting a routine config also deletes its linked routine
        # so the two stay in lockstep (the UI surfaces a confirmation).
        if row.get("config_type") == "routine":
            raw = row.get("parameters") or "{}"
            try:
                payload = json.loads(raw) if isinstance(raw, str) else raw
            except (json.JSONDecodeError, TypeError):
                payload = {}
            rid = payload.get("linked_routine_id") if isinstance(payload, dict) else None
            if isinstance(rid, int) and get_routine_by_id(conn, rid):
                delete_routine(conn, rid)
        delete_configuration(conn, config_id)
        return {"success": True}
    finally:
        _close_db(conn)


@app.post("/api/configurations/export")
def export_configurations(body: ConfigExport):
    conn = _get_db()
    try:
        # If the user has configured an export directory in Storage settings,
        # write the zip there with a timestamped filename; otherwise fall back
        # to a temporary file.
        export_dir = get_setting(conn, "export_directory") or ""
        if export_dir:
            out_dir = Path(export_dir).expanduser()
            try:
                out_dir.mkdir(parents=True, exist_ok=True)
            except Exception as exc:
                raise HTTPException(400, f"Invalid export_directory: {exc}")
            fname = f"resmon_configs_{datetime.now().strftime('%Y%m%dT%H%M%S')}.zip"
            out_path = out_dir / fname
            export_configs(conn, body.ids, out_path)
            return {"path": str(out_path)}
        with tempfile.NamedTemporaryFile(suffix=".zip", delete=False) as tmp:
            export_configs(conn, body.ids, Path(tmp.name))
            return {"path": tmp.name}
    finally:
        _close_db(conn)


@app.post("/api/configurations/import")
async def import_configurations(files: list[UploadFile] = File(...)):
    conn = _get_db()
    try:
        tmp_paths = []
        for f in files:
            tmp = tempfile.NamedTemporaryFile(suffix=".json", delete=False)
            tmp.write(await f.read())
            tmp.close()
            tmp_paths.append(Path(tmp.name))
        ids = import_configs(conn, tmp_paths)

        # Update 2 — Configurations/Routines lockstep:
        # Every imported routine-config must be mirrored as a real routine
        # row so the Routines page lists it. The freshly-created routine
        # is *deactivated by default* per the user requirement: bulk
        # imports never auto-activate. We then rewrite the imported
        # config row's parameters JSON so ``linked_routine_id`` points at
        # the new routine, keeping the lockstep invariant the rest of
        # the app already enforces (delete cascade, edit dispatch, etc.).
        routines_created = 0
        for cid in ids:
            row = conn.execute(
                "SELECT * FROM saved_configurations WHERE id = ?", (cid,)
            ).fetchone()
            if not row:
                continue
            row = dict(row)
            if row.get("config_type") != "routine":
                continue
            raw = row.get("parameters") or "{}"
            try:
                payload = json.loads(raw) if isinstance(raw, str) else (raw or {})
            except (json.JSONDecodeError, TypeError):
                payload = {}
            if not isinstance(payload, dict):
                payload = {}
            inner_params = payload.get("parameters") if isinstance(payload.get("parameters"), dict) else {}
            ai_settings = payload.get("ai_settings")
            routine_dict = {
                "name": row.get("name") or "Imported Routine",
                "schedule_cron": payload.get("schedule_cron") or "0 8 * * *",
                "parameters": json.dumps(inner_params),
                "is_active": 0,  # deactivated by default on import
                "email_enabled": int(bool(payload.get("email_enabled"))),
                "email_ai_summary_enabled": int(bool(payload.get("email_ai_summary_enabled"))),
                "ai_enabled": int(bool(payload.get("ai_enabled"))),
                "ai_settings": json.dumps(ai_settings) if isinstance(ai_settings, dict) else None,
                "storage_settings": None,
                "notify_on_complete": int(bool(payload.get("notify_on_complete"))),
                # An export taken before the cloud service was removed may
                # still say "cloud"; such a routine has nowhere to run.
                "execution_location": "local",
            }
            try:
                rid = insert_routine(conn, routine_dict)
            except Exception as exc:
                logger.error("Failed to create routine for imported config %s: %s", cid, exc)
                continue
            # Rewrite the imported config row's parameters so it links to
            # the new routine and reflects the deactivated state. We do
            # NOT call ``_sync_routine_config`` here, because that helper
            # would insert a *second* mirror row when none with the new
            # ``linked_routine_id`` is found — instead, we update the
            # already-imported row in place.
            payload["linked_routine_id"] = rid
            payload["is_active"] = False
            update_configuration(conn, cid, {"parameters": json.dumps(payload)})
            routines_created += 1

        return {"imported": len(ids), "routines_created": routines_created, "errors": []}
    finally:
        _close_db(conn)


# ---------------------------------------------------------------------------
# Calendar
# ---------------------------------------------------------------------------

# ---------------------------------------------------------------------------
# Reference exports (Phase 2a)
# ---------------------------------------------------------------------------
#
# resmon's existing outputs -- Markdown, PDF, LaTeX -- are for reading. None of
# them import into Zotero, Mendeley, EndNote or Papers, which is where the
# papers a sweep found actually need to end up.


class ReferenceExportBody(BaseModel):
    document_ids: list[int]
    format: str = "bibtex"


def _reference_response(documents: list[dict], fmt: str, stem: str) -> Response:
    try:
        text, media_type, extension = reference_export.render(documents, fmt)
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from None
    return Response(
        content=text,
        media_type=media_type,
        headers={
            "Content-Disposition": f'attachment; filename="{stem}.{extension}"',
            "X-Resmon-Document-Count": str(len(documents)),
        },
    )


@app.get("/api/executions/{exec_id}/references")
def export_execution_references(
    exec_id: int, format: str = "bibtex", only_new: bool = False,
):
    """Export one execution's papers as BibTeX, RIS or CSV."""
    conn = _get_db()
    try:
        if get_execution_by_id(conn, exec_id) is None:
            raise HTTPException(404, "Execution not found")
        documents = get_execution_documents(conn, exec_id, only_new=only_new)
        suffix = "-new" if only_new else ""
        return _reference_response(documents, format, f"resmon-execution-{exec_id}{suffix}")
    finally:
        _close_db(conn)


@app.post("/api/export/references")
def export_selected_references(body: ReferenceExportBody):
    """Export an explicit selection of papers, for a filtered view."""
    conn = _get_db()
    try:
        documents = get_documents_by_ids(conn, body.document_ids)
        return _reference_response(documents, body.format, "resmon-selection")
    finally:
        _close_db(conn)


# ---------------------------------------------------------------------------
# Explorer (Phase 2b)
# ---------------------------------------------------------------------------


class ExplorerFilters(BaseModel):
    query: Optional[str] = None
    sources: list[str] = []
    authors: list[str] = []
    categories: list[str] = []
    date_from: Optional[str] = None
    date_to: Optional[str] = None


class ExplorerSearchBody(ExplorerFilters):
    cursor: Optional[str] = None
    limit: int = explorer.DEFAULT_PAGE_SIZE
    # 1.9 — "newest" or "similarity". Not an enum, because an unknown value is
    # answered with the default rather than a 422: a renderer from a newer build
    # talking to an older backend should get papers, not a validation error.
    sort: str = "newest"


class ExplorerExportBody(ExplorerFilters):
    format: str = "bibtex"


def _filter_kwargs(body: ExplorerFilters) -> dict:
    return {
        "query": body.query,
        "sources": body.sources or None,
        "authors": body.authors or None,
        "categories": body.categories or None,
        "date_from": body.date_from,
        "date_to": body.date_to,
    }


def _embed_query(conn, text: str) -> tuple[Optional[bytes], Optional[str], Optional[str]]:
    """Embed a search phrase with the configured lane. ``(vector, model, reason)``.

    The reason is what the interface shows when a similarity sort could not
    rank, and it is never a bare failure: "no lane configured", "the model
    refused" and "the extension will not load" send a user to three different
    places.
    """
    lane = _current_embedding_lane(conn)
    if lane is None:
        return None, None, (
            "No embedding model is configured, so resmon cannot rank by meaning. "
            "Set one up in Settings → AI → Embeddings."
        )
    if not (text or "").strip():
        return None, None, "Ranking by meaning needs a search phrase."
    try:
        vectors = embeddings.embed_texts(lane, [text])
    except embeddings.EmbeddingUnavailable as exc:
        return None, None, exc.reason
    except Exception as exc:
        message = getattr(exc, "message", None) or str(exc)
        return None, None, f"The embedding call failed: {message}"
    if not vectors:
        return None, None, "The embedding model returned nothing for that phrase."
    return vector_index.pack_vector(vectors[0]), lane.model, None


@app.post("/api/explorer/search")
def explorer_search(body: ExplorerSearchBody):
    """Search the whole corpus. POST because the filter set is a structure.

    ``sort="similarity"`` embeds the search phrase and re-orders the same
    filtered set by distance from it. The filters still decide *which* papers;
    the sort decides only their order, so switching sorts cannot change what a
    user is looking at.
    """
    conn = _get_db()
    try:
        vector = model = reason = None
        if body.sort == "similarity":
            vector, model, reason = _embed_query(conn, body.query or "")
        result = explorer.search(
            conn, cursor=body.cursor, limit=body.limit, sort=body.sort,
            query_vector=vector, model=model, **_filter_kwargs(body),
        )
        if reason:
            # The request asked for a ranking and did not get one. Saying so is
            # the difference between a list a user can trust and a control that
            # appears to do nothing.
            result["similarity_unavailable"] = reason
        return result
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from None
    finally:
        _close_db(conn)


@app.get("/api/documents/{document_id}/similar")
def document_similar(document_id: int, k: int = 10):
    """The papers nearest this one, with distances and their sources.

    Costs one index query and nothing at the provider: the document's vector is
    already stored, so "more like this" never calls an embedding model.
    """
    conn = _get_db()
    try:
        lane = _current_embedding_lane(conn)
        index_model = vector_index.index_state(conn)["model"]
        model = index_model or (lane.model if lane else None)
        if not model:
            return {
                "document_id": document_id,
                "model": None,
                "neighbours": [],
                "reason": (
                    "Nothing is embedded yet, so resmon has nothing to compare this "
                    "paper against. Set up an embedding model in Settings → AI."
                ),
            }
        return explorer.similar_to(conn, document_id, model, k=max(1, min(int(k), 50)))
    finally:
        _close_db(conn)


def _coverage_for_routine(conn, routine_id: int) -> dict:
    """Shared by the HTTP route and the MCP surface, so they cannot diverge."""
    routine = get_routine_by_id(conn, routine_id)
    if routine is None:
        raise HTTPException(404, f"No routine with id {routine_id}.")

    intent_text, intent_source = coverage_audit.intent_for(routine)
    if not intent_text:
        return {
            "routine_id": routine_id,
            "routine_name": routine.get("name"),
            "intent": "", "intent_source": intent_source,
            "model": None, "cannot_see": coverage_audit.CANNOT_SEE,
            "results": 0, "results_embedded": 0,
            "off_target": [], "off_target_total": 0,
            "missed_in_corpus": [], "missed_in_corpus_total": 0,
            "missed_in_corpus_total_is_lower_bound": False,
            "distribution": None,
            "reason": (
                "This routine has no intent and no keywords, so there is nothing to "
                "compare its results against. Add a sentence describing what it is "
                "for in the routine's settings."
            ),
        }

    model = vector_index.index_state(conn)["model"]
    lane = _current_embedding_lane(conn)
    model = model or (lane.model if lane else None)
    if not model:
        return {
            "routine_id": routine_id,
            "routine_name": routine.get("name"),
            "intent": intent_text, "intent_source": intent_source,
            "model": None, "cannot_see": coverage_audit.CANNOT_SEE,
            "results": 0, "results_embedded": 0,
            "off_target": [], "off_target_total": 0,
            "missed_in_corpus": [], "missed_in_corpus_total": 0,
            "missed_in_corpus_total_is_lower_bound": False,
            "distribution": None,
            "reason": (
                "Nothing is embedded yet, so resmon cannot compare this routine's "
                "results against its intent. Set up an embedding model in "
                "Settings → AI → Embeddings."
            ),
        }

    vector, embedded_model, reason = _embed_query(conn, intent_text)
    if vector is None:
        return {
            "routine_id": routine_id,
            "routine_name": routine.get("name"),
            "intent": intent_text, "intent_source": intent_source,
            "model": model, "cannot_see": coverage_audit.CANNOT_SEE,
            "results": 0, "results_embedded": 0,
            "off_target": [], "off_target_total": 0,
            "missed_in_corpus": [], "missed_in_corpus_total": 0,
            "missed_in_corpus_total_is_lower_bound": False,
            "distribution": None,
            "reason": reason,
        }
    audit = coverage_audit.audit_routine(
        conn, routine, embedded_model or model, vector
    )
    # Composed once, here, so the Routines page, the report and the MCP surface
    # all say the same sentence rather than three near-identical ones.
    audit["summary"] = coverage_audit.summary_line(audit)
    return audit


@app.get("/api/routines/{routine_id}/coverage")
def routine_coverage(routine_id: int):
    """Is this routine finding what its owner meant, and what is it missing?

    Two lists, both scoped to the corpus resmon already holds — which is the one
    claim this endpoint is entitled to make, and it returns the sentence saying
    so rather than leaving the interface to remember it.
    """
    conn = _get_db()
    try:
        return _coverage_for_routine(conn, routine_id)
    finally:
        _close_db(conn)


@app.get("/api/documents/{document_id}/links")
def document_links(document_id: int):
    """What else in the corpus looks like the same work as this paper.

    A link is an assertion laid beside two records, never a merge: both rows stay,
    both provenances stay, and nothing is hidden. Each link names the ``method``
    that produced it, because "these two share a DOI" and "these two have
    near-identical titles and nearby vectors" are different strengths of claim.
    """
    conn = _get_db()
    try:
        return near_duplicates.links_for(conn, document_id)
    finally:
        _close_db(conn)


class DocumentIdsBody(BaseModel):
    document_ids: list[int] = []


@app.post("/api/links/for-documents")
def links_for_documents(body: DocumentIdsBody):
    """Links for a page of results in one round trip.

    The same shape as ``/api/lifecycle/for-documents`` and for the same reason:
    the Explorer renders fifty rows, and fifty requests to badge them is the
    thing that endpoint exists to avoid.
    """
    conn = _get_db()
    try:
        ids = [int(i) for i in body.document_ids][:500]
        return {"links": near_duplicates.links_map(conn, ids)}
    finally:
        _close_db(conn)


@app.post("/api/links/collapse-preview")
def links_collapse_preview(body: DocumentIdsBody):
    """Which of these ids a collapse *would* fold, without folding anything.

    The interface asks for this only when the reader has switched collapse on.
    It returns a grouping; the rows themselves are untouched and the totals a
    page reports are computed without it.
    """
    conn = _get_db()
    try:
        ids = [int(i) for i in body.document_ids][:500]
        return near_duplicates.collapse_groups(conn, ids)
    finally:
        _close_db(conn)


@app.get("/api/links/status")
def links_status():
    """How many links are stored, by method, and the scan's state."""
    conn = _get_db()
    try:
        payload = near_duplicates.links_job.status(conn)
        payload["capability"] = _embedding_capability(conn)
        return payload
    finally:
        _close_db(conn)


@app.post("/api/links/scan")
def links_scan():
    """Find near-duplicates across the corpus. Returns immediately.

    Refused before it starts when there is nothing to compare, rather than
    running and reporting zero — "no near-duplicates" and "nothing is embedded"
    are different answers and only one of them is about the corpus.
    """
    conn = _get_db()
    try:
        lane = _current_embedding_lane(conn)
        model = vector_index.index_state(conn)["model"] or (lane.model if lane else None)
        if not model:
            raise HTTPException(
                400,
                "Nothing is embedded yet, so there are no vectors to compare. Set up "
                "an embedding model in Settings → AI → Embeddings and run the backfill.",
            )
        try:
            started = near_duplicates.links_job.start(_open_connection, model)
        except RuntimeError as exc:
            raise HTTPException(409, str(exc)) from None
        return {"status": "started", "run": started}
    finally:
        _close_db(conn)


@app.post("/api/links/scan/cancel")
def links_scan_cancel():
    """Stop after the document in flight. Links already written are kept."""
    return near_duplicates.links_job.cancel()


@app.post("/api/explorer/facets")
def explorer_facets(body: ExplorerFilters):
    """Available filter values and their counts, for the current filters."""
    conn = _get_db()
    try:
        return explorer.facets(conn, **_filter_kwargs(body))
    finally:
        _close_db(conn)


@app.post("/api/explorer/export")
def explorer_export(body: ExplorerExportBody):
    """Export everything matching the current filters, not just the page shown.

    Reuses the same renderers as the per-execution export; only the way the
    documents are selected differs.
    """
    conn = _get_db()
    try:
        ids = explorer.matching_ids(conn, **_filter_kwargs(body))
        documents = get_documents_by_ids(conn, ids)
        return _reference_response(documents, body.format, "resmon-explorer")
    finally:
        _close_db(conn)


# ---------------------------------------------------------------------------
# Analytics (Phase 2a)
# ---------------------------------------------------------------------------
#
# Every endpoint here reads data already in the database -- the corpus, the
# per-execution join table, and the routines. No external calls.
#
# Payloads always carry ``sample_size``, and any derived statistic carries
# ``sufficient``. See implementation_scripts/analytics.py for the thin-corpus
# policy: counts are always reported, medians and rates only once they mean
# something. The interface uses those flags to say "not enough data yet" rather
# than drawing a chart from three points.
#
# Cached since 1.6: recomputing five GROUP-BY passes on every page load was
# fine at a few hundred papers and is not fine at a hundred thousand. Results
# are cached against a cheap fingerprint of the tables analytics reads:
# MAX(id) and COUNT(*) catch inserts and deletions, MAX(end_time) catches an
# execution completing, routines.updated_at catches renames and toggles. The
# db path + generation in the key keep separate databases (including the test
# suite's fresh per-test databases) from ever sharing an entry.

_ANALYTICS_CACHE_MAX = 32
_analytics_cache: "OrderedDict[tuple, tuple[tuple, object]]" = OrderedDict()
_analytics_cache_lock = threading.Lock()


def _analytics_fingerprint(conn) -> tuple:
    """A tuple that changes whenever any input to the analytics queries can."""
    row = conn.execute(
        "SELECT"
        " (SELECT COUNT(*) FROM documents),"
        " (SELECT IFNULL(MAX(id), 0) FROM documents),"
        " (SELECT COUNT(*) FROM executions),"
        " (SELECT IFNULL(MAX(id), 0) FROM executions),"
        " (SELECT IFNULL(MAX(end_time), '') FROM executions),"
        " (SELECT COUNT(*) FROM execution_documents),"
        " (SELECT COUNT(*) FROM routines),"
        " (SELECT IFNULL(MAX(updated_at), '') FROM routines),"
        # The watchdog rides the same cache, so its inputs belong in the same
        # fingerprint. Without these two a source that started erroring, or a
        # finding the user just muted, would keep serving the previous answer.
        " (SELECT COUNT(*) FROM execution_sources),"
        " (SELECT IFNULL(MAX(recorded_at), '') FROM execution_sources),"
        " (SELECT COUNT(*) FROM watchdog_mutes),"
        " (SELECT IFNULL(MAX(muted_at), '') FROM watchdog_mutes)"
    ).fetchone()
    return tuple(row)


def _cached_analytics(name: str, params: tuple, conn, compute):
    key = (str(_db_path or ""), _db_generation, name, params)
    fingerprint = _analytics_fingerprint(conn)
    with _analytics_cache_lock:
        hit = _analytics_cache.get(key)
        if hit is not None and hit[0] == fingerprint:
            _analytics_cache.move_to_end(key)
            return hit[1]
    result = compute()
    with _analytics_cache_lock:
        _analytics_cache[key] = (fingerprint, result)
        _analytics_cache.move_to_end(key)
        while len(_analytics_cache) > _ANALYTICS_CACHE_MAX:
            _analytics_cache.popitem(last=False)
    return result


@app.get("/api/analytics/overview")
def analytics_overview():
    """Everything the Analytics page needs, in one round trip."""
    conn = _get_db()
    try:
        return _cached_analytics("overview", (), conn, lambda: analytics.overview(conn))
    finally:
        _close_db(conn)


@app.get("/api/analytics/summary")
def analytics_summary():
    conn = _get_db()
    try:
        return _cached_analytics(
            "summary", (), conn, lambda: analytics.corpus_summary(conn))
    finally:
        _close_db(conn)


@app.get("/api/analytics/source-contribution")
def analytics_source_contribution():
    """Per source: papers delivered, and how many nothing else found."""
    conn = _get_db()
    try:
        return _cached_analytics(
            "source_contribution", (), conn,
            lambda: analytics.source_contribution(conn))
    finally:
        _close_db(conn)


@app.get("/api/analytics/discovery-lag")
def analytics_discovery_lag():
    """Median days between publication and resmon first seeing each paper."""
    conn = _get_db()
    try:
        return _cached_analytics(
            "discovery_lag", (), conn, lambda: analytics.discovery_lag(conn))
    finally:
        _close_db(conn)


@app.get("/api/analytics/routine-health")
def analytics_routine_health():
    """Per routine: new results per run, and whether it has gone quiet."""
    conn = _get_db()
    try:
        return _cached_analytics(
            "routine_health", (), conn, lambda: analytics.routine_health(conn))
    finally:
        _close_db(conn)


@app.get("/api/analytics/publication-volume")
def analytics_publication_volume(group_by: str = "source", months: int = 12):
    """Papers per publication month, split by source or subject category."""
    if group_by not in ("source", "category"):
        raise HTTPException(400, "group_by must be 'source' or 'category'")
    conn = _get_db()
    try:
        return _cached_analytics(
            "publication_volume", (group_by, int(months)), conn,
            lambda: analytics.publication_volume(conn, group_by=group_by, months=months))
    finally:
        _close_db(conn)


# ---------------------------------------------------------------------------
# The reproducible search record (1.7 — PRISMA-shaped export)
#
# Every systematic review's methods section needs the same account, and it is
# assembled by hand in spreadsheets essentially everywhere. resmon already
# records all of it. See implementation_scripts/search_record.py for why the
# figures are labeled with the PRISMA box they belong in — and, where there is
# no honest match, labeled as having none.
# ---------------------------------------------------------------------------


@app.get("/api/executions/{exec_id}/search-record")
def execution_search_record(exec_id: int, format: str = "json"):
    """The complete, dated account of one search.

    ``?format=markdown`` returns a methods-section-shaped document as
    ``text/markdown`` rather than JSON.
    """
    if format not in ("json", "markdown"):
        raise HTTPException(400, "format must be 'json' or 'markdown'")
    conn = _get_db()
    try:
        record = search_record.build(conn, exec_id)
    except LookupError as exc:
        raise HTTPException(404, str(exc))
    finally:
        _close_db(conn)

    if format == "markdown":
        return Response(
            content=search_record.to_markdown(record),
            media_type="text/markdown; charset=utf-8",
            headers={
                "Content-Disposition":
                    f'attachment; filename="resmon-search-record-{exec_id}.md"',
            },
        )
    return record


# ---------------------------------------------------------------------------
# Corpus lifecycle (1.7 — papers change after you find them)
#
# The only feature in 1.7 that talks to the network, which is why the check is
# explicit rather than automatic: quietly asking a third party about every paper
# a user has ever collected is not something to do on their behalf unasked.
#
# It runs on a background thread because it is bounded by outbound requests, not
# by CPU, and a corpus of a few thousand papers would hold a request open for
# minutes. One run at a time; the page polls GET /api/lifecycle for progress.
# ---------------------------------------------------------------------------

_lifecycle_lock = threading.Lock()
_lifecycle_run: dict = {"running": False, "started_at": None, "last": None,
                        "error": None, "stop_requested": False}


class LifecycleCheckRequest(BaseModel):
    limit: int = Field(default=lifecycle.DEFAULT_LIMIT, ge=1, le=5000)
    # Repeat the bounded slice until the corpus is covered. At the old default a
    # 15,000-paper corpus needed seventy-nine presses of the button; this is the
    # option that makes "check everything" a single action.
    run_until_done: bool = False


def _lifecycle_should_stop() -> bool:
    with _lifecycle_lock:
        return bool(_lifecycle_run.get("stop_requested"))


def _run_lifecycle_check(limit: int, run_until_done: bool) -> None:
    """Body of the background check. Owns its own connection."""
    conn = _get_db()
    try:
        summary = lifecycle.check_corpus(
            conn, limit=limit, run_until_done=run_until_done,
            should_stop=_lifecycle_should_stop,
        )
        with _lifecycle_lock:
            _lifecycle_run["last"] = {
                "checked_now": summary["checked_now"],
                "remaining": summary["remaining"],
                "errors": summary["errors"],
                "checked_at": summary["checked_at"],
            }
            _lifecycle_run["error"] = None
    except Exception as exc:
        logging.getLogger(__name__).exception("Lifecycle check failed")
        with _lifecycle_lock:
            _lifecycle_run["error"] = str(exc)
    finally:
        with _lifecycle_lock:
            _lifecycle_run["running"] = False
        _close_db(conn)


@app.post("/api/lifecycle/check")
def lifecycle_check(request: LifecycleCheckRequest):
    """Start a bounded lifecycle check over the least recently checked papers.

    Returns immediately. Poll ``GET /api/lifecycle`` for progress and results.
    """
    with _lifecycle_lock:
        if _lifecycle_run["running"]:
            raise HTTPException(
                409, "A lifecycle check is already running.",
            )
        _lifecycle_run["running"] = True
        _lifecycle_run["started_at"] = datetime.now(timezone.utc).strftime(
            "%Y-%m-%dT%H:%M:%SZ")
        _lifecycle_run["error"] = None
        _lifecycle_run["stop_requested"] = False

    thread = threading.Thread(
        target=_run_lifecycle_check,
        args=(request.limit, request.run_until_done),
        daemon=True, name="lifecycle-check",
    )
    thread.start()
    return {
        "status": "started",
        "limit": request.limit,
        "run_until_done": request.run_until_done,
    }


@app.post("/api/lifecycle/stop")
def lifecycle_stop():
    """Ask a running check to stop after its current slice.

    Cooperative rather than abrupt: the papers already checked keep their
    results, and the rest stay unchecked rather than being recorded as clean.
    """
    with _lifecycle_lock:
        if not _lifecycle_run["running"]:
            return {"status": "idle"}
        _lifecycle_run["stop_requested"] = True
    return {"status": "stopping"}


@app.get("/api/lifecycle")
def lifecycle_report():
    """Recorded lifecycle events, and how much of the corpus they cover."""
    conn = _get_db()
    try:
        payload = lifecycle.report(conn)
        with _lifecycle_lock:
            payload["run"] = dict(_lifecycle_run)
        return payload
    finally:
        _close_db(conn)


class LifecycleForDocumentsRequest(BaseModel):
    document_ids: list[int] = Field(default_factory=list, max_length=500)


@app.post("/api/lifecycle/for-documents")
def lifecycle_for_documents(request: LifecycleForDocumentsRequest):
    """Lifecycle events for a page of results, in one round trip.

    The Explorer renders fifty papers at a time and needs to badge each one.
    Asking per row would be fifty requests to paint one screen; this is one.
    Ids with no events are simply absent from the map.
    """
    ids = [int(i) for i in request.document_ids][:500]
    if not ids:
        return {"events": {}, "checked": {}}

    placeholders = ",".join("?" for _ in ids)
    conn = _get_db()
    try:
        rows = conn.execute(
            f"""
            SELECT * FROM document_lifecycle
            WHERE document_id IN ({placeholders})
            ORDER BY CASE severity
                         WHEN 'critical' THEN 0
                         WHEN 'caution' THEN 1
                         ELSE 2
                     END,
                     notice_date DESC
            """,
            ids,
        ).fetchall()
        events: dict[str, list] = {}
        for row in rows:
            events.setdefault(str(row["document_id"]), []).append(dict(row))

        # Whether each paper has been looked at travels with the events, so the
        # interface can tell "nothing has happened to this paper" apart from
        # "nobody has checked this paper" — which look identical otherwise.
        checked_rows = conn.execute(
            f"""
            SELECT document_id, checked_at, status
            FROM document_lifecycle_checks
            WHERE document_id IN ({placeholders})
            """,
            ids,
        ).fetchall()
        checked = {
            str(r["document_id"]): {"checked_at": r["checked_at"],
                                    "status": r["status"]}
            for r in checked_rows
        }
        return {"events": events, "checked": checked}
    finally:
        _close_db(conn)


@app.get("/api/documents/{doc_id}/lifecycle")
def document_lifecycle(doc_id: int):
    """Lifecycle events recorded against one paper."""
    conn = _get_db()
    try:
        row = conn.execute(
            "SELECT id FROM documents WHERE id = ?", (int(doc_id),)
        ).fetchone()
        if row is None:
            raise HTTPException(404, f"No document with id {doc_id}")
        checked = conn.execute(
            "SELECT checked_at, status FROM document_lifecycle_checks "
            "WHERE document_id = ?", (int(doc_id),),
        ).fetchone()
        return {
            "document_id": int(doc_id),
            "events": get_lifecycle_for_document(conn, doc_id),
            # Without this an empty list is ambiguous: it could mean nothing has
            # happened to the paper, or that nobody has ever looked.
            "checked_at": checked["checked_at"] if checked else None,
            "check_status": checked["status"] if checked else None,
        }
    finally:
        _close_db(conn)


# ---------------------------------------------------------------------------
# Why am I seeing this? (1.7 — match transparency)
#
# Two directions on the same question. Per paper: which keywords are locally
# verifiable in it, and — stated every time — what resmon cannot see. Per
# keyword: how many papers it brought in that no other keyword did.
#
# The load-bearing constraint is in implementation_scripts/match_explain.py:
# resmon does not know why a relevance-ranked source returned something, and
# never claims to.
# ---------------------------------------------------------------------------


@app.get("/api/documents/{doc_id}/why")
def document_why(doc_id: int, execution_id: Optional[int] = None):
    """What is locally verifiable about why this paper is in the corpus."""
    conn = _get_db()
    try:
        return match_explain.explain_document(
            conn, doc_id, execution_id=execution_id,
        )
    except LookupError as exc:
        raise HTTPException(404, str(exc))
    finally:
        _close_db(conn)


@app.get("/api/analytics/keyword-contribution")
def analytics_keyword_contribution(execution_id: Optional[int] = None):
    """Per keyword: papers it found that no other keyword did.

    Scoped to one execution with ``?execution_id=``, otherwise to every keyword
    ever searched against the whole corpus. Cached like the other analytics —
    it reads every candidate document once, which is not free on a large corpus.
    """
    conn = _get_db()
    try:
        return _cached_analytics(
            "keyword_contribution", (execution_id,), conn,
            lambda: match_explain.keyword_contribution(
                conn, execution_id=execution_id,
            ),
        )
    except LookupError as exc:
        raise HTTPException(404, str(exc))
    finally:
        _close_db(conn)


# ---------------------------------------------------------------------------
# Watchdog (1.7 — "it tells you the truth")
#
# Silence from a literature monitor is ambiguous: it means either "nothing was
# published" or "this stopped working", and the user cannot tell which. These
# endpoints serve the difference. See implementation_scripts/watchdog.py for
# the rules and the reasoning behind each threshold.
# ---------------------------------------------------------------------------


class WatchdogMuteRequest(BaseModel):
    finding_key: str = Field(min_length=1, max_length=200)
    note: Optional[str] = Field(default=None, max_length=500)


@app.get("/api/watchdog")
def watchdog_report():
    """Findings, what could not be judged yet, and the thresholds used."""
    conn = _get_db()
    try:
        # The watchdog writes when it prunes mutes whose condition resolved, so
        # it cannot be served from a pure-read cache without that prune being
        # skipped on every hit. The prune is cheap and the compute is a handful
        # of indexed queries; correctness wins over the cache here.
        return watchdog.report(conn)
    finally:
        _close_db(conn)


@app.post("/api/watchdog/mute")
def watchdog_mute(request: WatchdogMuteRequest):
    """Acknowledge one finding so it stops counting toward the alarm total.

    Muting is per finding, never per source or per routine: the mute is dropped
    automatically once the condition clears, so the same source failing again
    later is reported again.
    """
    conn = _get_db()
    try:
        watchdog.mute(conn, request.finding_key, request.note)
        return {"status": "muted", "finding_key": request.finding_key}
    finally:
        _close_db(conn)


@app.post("/api/watchdog/unmute")
def watchdog_unmute(request: WatchdogMuteRequest):
    """Un-acknowledge a finding, returning it to the alarm total."""
    conn = _get_db()
    try:
        watchdog.unmute(conn, request.finding_key)
        return {"status": "unmuted", "finding_key": request.finding_key}
    finally:
        _close_db(conn)


@app.get("/api/calendar/events")
def calendar_events(
    start: Optional[str] = None,
    end: Optional[str] = None,
):
    conn = _get_db()
    try:
        execs = get_executions(conn, limit=500)
        events = []
        # Status → dot color. ``cancelled`` now uses the same red as the
        # Dashboard/Results badge-cancelled palette (was amber/orange); the
        # orange slot is reclaimed by the new ``scheduled`` status for
        # upcoming routine fires.
        status_color = {
            "completed": "#22c55e",  # green
            "running":   "#3b82f6",  # blue
            "failed":    "#ef4444",  # red
            "cancelled": "#ef4444",  # red (matches badge-cancelled)
            "scheduled": "#f59e0b",  # orange
        }
        for ex in execs:
            _enrich_execution_row(ex)
            status = ex.get("status") or "unknown"
            query = ex.get("query")
            type_label = ex.get("execution_type", "execution")
            title_suffix = f": {query}" if query else ""
            # Compute a non-zero-duration end so FullCalendar never falls
            # back to its ``defaultTimedEventDuration`` (1 h) for an event
            # whose persisted end equals start (e.g. an in-flight or
            # null-end-time row); a 1-h default starting at, say, 11:30 PM
            # would spill into the next calendar cell and render as a
            # multi-day bar in dayGrid views (see Bug 2).
            start_iso = ex["start_time"]
            end_iso = ex.get("end_time") or start_iso
            if end_iso == start_iso:
                try:
                    _start_dt = datetime.fromisoformat(start_iso.replace("Z", "+00:00"))
                    end_iso = (_start_dt + timedelta(minutes=1)).isoformat()
                except (ValueError, AttributeError):
                    pass
            events.append({
                "id": ex["id"],
                "title": f"{type_label} #{ex['id']}{title_suffix}",
                "start": start_iso,
                "end": end_iso,
                "allDay": False,
                "color": status_color.get(status, "#6b7280"),
                "execution_id": ex["id"],
                "routine_id": ex.get("routine_id"),
                "saved_configuration_id": ex.get("saved_configuration_id"),
                "saved_configuration_name": ex.get("saved_configuration_name"),
                "type": type_label,
                "status": status,
                "query": query,
                "total_results": ex.get("total_results"),
                "new_results": ex.get("new_results"),
            })

        # Future (scheduled) routine fires — expand each active routine's
        # cron expression into upcoming events so the user can see when
        # the next runs will happen. We use APScheduler's CronTrigger,
        # which we already depend on (ADQ-3).
        try:
            from apscheduler.triggers.cron import CronTrigger  # type: ignore
            try:
                from tzlocal import get_localzone  # type: ignore
                _local_tz = get_localzone()
            except Exception:
                _local_tz = None  # fall through to APScheduler default

            # Window: caller-supplied ``start``/``end`` (FullCalendar sends
            # ISO-8601 strings), otherwise today → +12 months. The 12-month
            # ceiling matches the user-facing horizon notice rendered on
            # the Calendar page when the user navigates past it.
            now = datetime.now(timezone.utc)
            CALENDAR_HORIZON_DAYS = 366
            try:
                window_start = datetime.fromisoformat(start.replace("Z", "+00:00")) if start else now
            except (ValueError, AttributeError):
                window_start = now
            try:
                window_end = datetime.fromisoformat(end.replace("Z", "+00:00")) if end else now + timedelta(days=CALENDAR_HORIZON_DAYS)
            except (ValueError, AttributeError):
                window_end = now + timedelta(days=CALENDAR_HORIZON_DAYS)
            # Never expand past fires; real executions already cover history.
            if window_start < now:
                window_start = now
            # Clamp the upper end to the 12-month horizon regardless of
            # what FullCalendar requests, so a year-view query cannot
            # explode the per-routine fire count for high-frequency cadences.
            _hard_horizon = now + timedelta(days=CALENDAR_HORIZON_DAYS)
            if window_end > _hard_horizon:
                window_end = _hard_horizon

            # Hard cap per-routine so a pathological cron (e.g. ``* * * * *``)
            # can't produce tens of thousands of events per request. Raised
            # alongside the 90-day → 12-month window extension so that
            # daily / weekly / monthly cadences fully populate the year and
            # sub-hourly cadences still render a meaningful prefix.
            MAX_PER_ROUTINE = 2000

            from implementation_scripts.scheduler import _build_trigger as _sched_build_trigger  # type: ignore
            for r in get_routines(conn):
                if not r.get("is_active"):
                    continue
                params = r.get("parameters")
                if isinstance(params, str):
                    try:
                        params = json.loads(params)
                    except (json.JSONDecodeError, TypeError):
                        params = {}
                elif not isinstance(params, dict):
                    params = {}
                # Build the same trigger the live scheduler would use:
                # structured ``_schedule`` block (IntervalTrigger or the
                # custom monthly/yearly trigger) when present, otherwise
                # the legacy 5-field cron string.
                cron_expr = (r.get("schedule_cron") or "").strip()
                if not cron_expr and not (isinstance(params, dict) and params.get("_schedule")):
                    continue
                try:
                    trigger, _desc = _sched_build_trigger({
                        "id": r["id"],
                        "schedule_cron": cron_expr or "0 0 * * *",
                        "parameters": params,
                    })
                except (ValueError, TypeError):
                    continue
                kw_list = params.get("keywords") if isinstance(params, dict) else None
                query_hint = ", ".join(kw_list) if isinstance(kw_list, list) and kw_list else ""

                # CronTrigger.get_next_fire_time takes a ``previous_fire_time``
                # and a ``now``; iterate by feeding each fire time back in.
                prev = None
                cursor = window_start
                for _ in range(MAX_PER_ROUTINE):
                    nxt = trigger.get_next_fire_time(prev, cursor)
                    if nxt is None or nxt > window_end:
                        break
                    # Emit a tiny non-zero duration so FullCalendar never
                    # falls back to ``defaultTimedEventDuration`` (1 h) for
                    # late-night fires that would otherwise spill into the
                    # next day's cell as a multi-day bar (see Bug 2).
                    nxt_end = nxt + timedelta(minutes=1)
                    events.append({
                        "id": f"routine-{r['id']}-{nxt.isoformat()}",
                        "title": f"routine #{r['id']}: {r.get('name') or ''}".strip(),
                        "start": nxt.isoformat(),
                        "end": nxt_end.isoformat(),
                        "allDay": False,
                        "color": status_color["scheduled"],
                        "execution_id": None,
                        "routine_id": r["id"],
                        "type": "routine",
                        "status": "scheduled",
                        "query": query_hint,
                        "total_results": None,
                        "new_results": None,
                    })
                    prev = nxt
                    cursor = nxt
        except ImportError:
            # APScheduler not installed in this environment — skip the
            # scheduled expansion but still return historical executions.
            pass

        return events
    finally:
        _close_db(conn)


# ---------------------------------------------------------------------------
# Settings (email, ai, cloud, storage)
# ---------------------------------------------------------------------------

_SETTINGS_GROUPS = {
    "email": ["smtp_server", "smtp_port", "smtp_username", "smtp_from", "smtp_to"],
    "ai": [
        "ai_provider",
        "ai_model",
        "ai_local_model",
        "ai_summary_length",
        "ai_tone",
        "ai_extraction_goals",
        "ai_temperature",
        "ai_show_audit_prefix",
        "ai_custom_base_url",
        "ai_custom_header_prefix",
        # Update 2 — Feature 1 extension: per-provider default-model map,
        # stored as a JSON-encoded ``{provider: model_id}`` dict so the
        # AI tab can restore the user's previously chosen model when they
        # switch providers without re-loading the model list.
        "ai_default_models",
        # 1.8b — the fallback chain, a JSON list of lane objects. When present
        # it is the whole chain; ai_provider / ai_model are kept in step with
        # lane 0 by the Settings tab so an older build (and the report's audit
        # label) still find what they expect.
        "ai_chain",
        "ai_local_endpoint",
        # 1.8.5 — see the note on ``_AI_SETTING_KEYS``. Without these three the
        # PUT silently discarded them and ``get_ai_cli_status``'s read of
        # ``ai_cli_path`` could never return anything but "".
        "ai_cli_path",
        "ai_subscription_doc_cap",
        "ai_effort",
    ],
    # 1.9 — the embedding lane. Its key list is owned by
    # ``embeddings.EMBEDDING_SETTING_KEYS`` rather than written out here, and the
    # same tuple is spliced into the engine loader's read list below. Ledger 33
    # was a setting that appeared in one of those two places and not the other:
    # the PUT stored it and no run ever read it, for a whole release. One tuple,
    # two uses, and ``test_embeddings_settings.py`` asserts both against it.
    "embeddings": list(embeddings.EMBEDDING_SETTING_KEYS),
    "cloud": ["cloud_provider", "cloud_auto_backup"],
    "storage": ["pdf_policy", "txt_policy", "archive_after_days", "export_directory"],
    "notifications": ["notify_manual", "notify_automatic_mode"],
}


def _get_settings_group(conn, group: str) -> dict:
    keys = _SETTINGS_GROUPS.get(group, [])
    result = {}
    for k in keys:
        val = get_setting(conn, k)
        result[k] = val if val is not None else ""
    return result


def _set_settings_group(conn, group: str, data: dict) -> None:
    keys = _SETTINGS_GROUPS.get(group, [])
    for k, v in data.items():
        if k in keys:
            set_setting(conn, k, str(v))


@app.get("/api/settings/email")
def get_email_settings():
    conn = _get_db()
    try:
        return _get_settings_group(conn, "email")
    finally:
        _close_db(conn)


@app.put("/api/settings/email")
def update_email_settings(body: SettingsBody):
    conn = _get_db()
    try:
        _set_settings_group(conn, "email", body.settings)
        return {"success": True}
    finally:
        _close_db(conn)


@app.post("/api/settings/email/test")
def send_test_email_endpoint():
    """Send a test email using the currently-stored SMTP settings.

    Loads the SMTP config via the same helper used for routine
    completion emails (settings table + keychain for the password) and
    invokes :func:`email_notifier.send_test_email`. Returns HTTP 400
    with a human-readable reason when configuration is incomplete or
    the SMTP handshake fails.
    """
    from implementation_scripts import email_notifier
    from implementation_scripts.email_sender import _load_smtp_config

    conn = _get_db()
    try:
        smtp_config = _load_smtp_config(conn)
    finally:
        _close_db(conn)

    if smtp_config is None:
        raise HTTPException(
            status_code=400,
            detail=(
                "SMTP not fully configured. Fill in SMTP server, username, "
                "recipient, and store the SMTP password in the keychain."
            ),
        )

    # The recipient field accepts comma-separated addresses; for the
    # test message we deliver to the first address only.
    recipient_raw = smtp_config.get("recipient", "") or ""
    first_recipient = recipient_raw.split(",")[0].strip()
    if not first_recipient:
        raise HTTPException(
            status_code=400,
            detail="No recipient email is configured.",
        )
    smtp_config["recipient"] = first_recipient

    try:
        ok = email_notifier.send_test_email(smtp_config)
    except Exception as exc:  # defensive — send_test_email swallows RuntimeError
        raise HTTPException(status_code=400, detail=f"Test failed: {exc}") from None

    if not ok:
        raise HTTPException(
            status_code=400,
            detail=(
                "Test email failed to send. Check SMTP host, port, username, "
                "and App Password, then try again."
            ),
        )
    return {"success": True, "recipient": first_recipient}


@app.get("/api/settings/ai")
def get_ai_settings():
    conn = _get_db()
    try:
        return _get_settings_group(conn, "ai")
    finally:
        _close_db(conn)


@app.put("/api/settings/ai")
def update_ai_settings(body: SettingsBody):
    conn = _get_db()
    try:
        _set_settings_group(conn, "ai", body.settings)
        return {"success": True}
    finally:
        _close_db(conn)


@app.get("/api/settings/ai/cli-status")
def get_ai_cli_status():
    """Report whether each subscription-lane CLI can be found, and where.

    Detection only — this never runs the binary, so it cannot say whether
    anyone is logged in. That distinction is deliberate and is carried in the
    response: a CLI that is present but logged out fails on first use with
    ``CLI_AUTH``, and claiming "ready" here would be a promise this endpoint
    has not checked.

    ``tried`` is returned because "not found" on its own is unhelpful. A
    packaged app launched from the Finder searches a far smaller PATH than a
    terminal does, so showing the candidate paths is what lets someone see that
    resmon looked in the wrong place rather than that their CLI is broken.
    """
    from implementation_scripts.ai_cli import SUPPORTED_CLI_PROVIDERS, discover_cli

    conn = _get_db()
    try:
        settings = _get_settings_group(conn, "ai")
    finally:
        _close_db(conn)

    configured = str(settings.get("ai_cli_path") or "").strip() or None
    providers = []
    for provider in SUPPORTED_CLI_PROVIDERS:
        # The configured path is a single setting, so it is only meaningful for
        # the provider it was set for. Applying it to both would report Codex
        # as "found" at the path of the Claude binary.
        explicit = configured if settings.get("ai_provider") == provider else None
        entry = discover_cli(provider, explicit).to_dict()
        entry["login_checked"] = False
        providers.append(entry)

    return {"providers": providers}


# ---------------------------------------------------------------------------
# Embeddings (1.9)
# ---------------------------------------------------------------------------


def _load_embedding_settings(conn) -> dict:
    """Read the persisted ``embedding_*`` settings.

    Reads the **same tuple** ``_SETTINGS_GROUPS["embeddings"]`` is built from, so
    a key cannot be storable and unreadable. Ledger 33 was that gap on the
    subscription lane, and it survived a release because the test for it
    monkeypatched the read path. ``test_embeddings_settings.py`` goes through
    the real endpoints instead.
    """
    out: dict = {}
    for key in embeddings.EMBEDDING_SETTING_KEYS:
        try:
            value = get_setting(conn, key)
        except Exception:
            value = None
        if value is not None:
            out[key] = value
    return out


def _current_embedding_lane(conn):
    """The configured lane, or ``None``. ``None`` means the feature is off."""
    return embeddings.build_lane(_load_embedding_settings(conn))


def _embedding_capability(conn) -> dict:
    """Whether this backend can rank at all, and what by.

    ``available`` is the single answer the renderer gates on: it needs both a
    loadable extension **and** vectors in the index. Either missing means the
    sort option and the similar panel are absent rather than present and empty.
    """
    extension = vector_index.extension_status(conn)
    lane = _current_embedding_lane(conn)
    index = vector_index.index_state(conn)
    reason = extension["reason"]
    if extension["extension"] and index["rows"] == 0:
        reason = (
            "The vector extension is loaded, but nothing is embedded yet. "
            "Configure an embedding model in Settings → AI and run the backfill."
        )
    return {
        "available": bool(extension["extension"]) and index["rows"] > 0,
        "extension": extension["extension"],
        "reason": reason,
        "model": index["model"] or (lane.model if lane else None),
        "indexed": index["rows"],
    }


@app.get("/api/settings/embeddings")
def get_embedding_settings():
    """The stored settings, plus everything the tab needs to render honestly.

    ``providers`` carries a *can embed* answer for every provider resmon lists,
    including the ones that cannot, so the interface states the limitation rather
    than quietly omitting the option. The evidence string travels with it: a user
    reading "Anthropic does not offer an embeddings API" can see what that rests
    on.
    """
    conn = _get_db()
    try:
        stored = _get_settings_group(conn, "embeddings")
        lane = _current_embedding_lane(conn)
        providers = [
            {
                "provider": name,
                "state": answer.state,
                "reason": answer.reason,
                "evidence": answer.evidence,
                "offered": answer.offered,
                "default_model": answer.default_model,
                "suggested_models": embeddings.suggested_models(name),
            }
            for name, answer in sorted(embeddings.PROVIDER_EMBEDDING.items())
        ]
        return {
            "settings": stored,
            "providers": providers,
            "lane": lane.to_dict() if lane else None,
            "capability": _embedding_capability(conn),
            "status": embedding_job.backfill_job.status(
                conn, lane.model if lane else None
            ),
        }
    finally:
        _close_db(conn)


@app.put("/api/settings/embeddings")
def update_embedding_settings(body: SettingsBody):
    """Store the settings, refusing a provider that cannot embed.

    The refusal is **here**, at configuration, and not at backfill: P8. A user
    who picks Anthropic learns it when they pick it, with the reason, rather than
    after waiting for a run that was never going to produce anything.
    """
    provider = str(body.settings.get("embedding_provider") or "").strip().lower()
    if provider:
        answer = embeddings.can_embed(provider)
        if answer.state == "no":
            raise HTTPException(400, answer.reason)
    conn = _get_db()
    try:
        previous = _current_embedding_lane(conn)
        _set_settings_group(conn, "embeddings", body.settings)
        current = _current_embedding_lane(conn)
        # A model change invalidates the index, not the vectors. Rebuilding here
        # rather than at the next query means the Settings page can say what the
        # index now holds, and a user who switches back to a model they already
        # embedded gets their ranking back without re-embedding anything.
        if current and (previous is None or previous.model != current.model):
            vector_index.rebuild(conn, current.model)
        return {"success": True, "capability": _embedding_capability(conn)}
    finally:
        _close_db(conn)


class EmbeddingProbeBody(BaseModel):
    """An unsaved lane to probe, so a user can test before committing to it."""

    settings: Optional[dict] = None


@app.post("/api/embeddings/probe")
def probe_embedding_lane(body: EmbeddingProbeBody | None = None):
    """Ask the configured (or supplied) lane to embed one short string.

    This is what turns a claim about a provider into a fact about this machine.
    ``PROVIDER_EMBEDDING`` says what a vendor serves; only a probe says whether
    this endpoint, this key and this model answer — and for a local server that
    lists models and still refuses to embed, the probe is the entire difference
    between a usable lane and a corpus with nothing to rank (P9).
    """
    conn = _get_db()
    try:
        if body is not None and body.settings:
            merged = {**_load_embedding_settings(conn), **body.settings}
            lane = embeddings.build_lane(merged)
            if lane is None:
                provider = str(merged.get("embedding_provider") or "").strip().lower()
                answer = embeddings.can_embed(provider) if provider else None
                return {
                    "ok": False,
                    "dims": None,
                    "model": merged.get("embedding_model"),
                    "reason": answer.reason if answer and answer.state == "no" else (
                        "That is not a complete embedding lane: it needs to be enabled, "
                        "with a provider and a model."
                    ),
                }
        else:
            lane = _current_embedding_lane(conn)
        result = embeddings.probe_lane(lane)
        # A successful probe is the only place resmon learns the width, so it is
        # persisted: the interface can then say "768-dimensional" before a
        # backfill rather than after.
        if result["ok"] and lane is not None and result["dims"]:
            set_setting(conn, "embedding_dims", str(result["dims"]))
        return result
    finally:
        _close_db(conn)


@app.get("/api/embeddings/status")
def embedding_status():
    """N of M embedded with model X, the run, the index, and the extension."""
    conn = _get_db()
    try:
        lane = _current_embedding_lane(conn)
        payload = embedding_job.backfill_job.status(conn, lane.model if lane else None)
        payload["lane"] = lane.to_dict() if lane else None
        payload["capability"] = _embedding_capability(conn)
        return payload
    finally:
        _close_db(conn)


@app.get("/api/embeddings/estimate")
def embedding_estimate():
    """What a backfill would cost, before it starts.

    Built from the real pending set and the real text builder, not from an
    average: the number a user is shown is computed from the documents that will
    actually be sent.
    """
    conn = _get_db()
    try:
        lane = _current_embedding_lane(conn)
        if lane is None:
            raise HTTPException(400, "No embedding lane is configured.")
        todo = embedding_job.pending_ids(conn, lane.model)
        texts: list[str] = []
        for start in range(0, len(todo), 500):
            chunk = todo[start:start + 500]
            rows = conn.execute(
                f"SELECT title, abstract FROM documents WHERE id IN "
                f"({','.join('?' for _ in chunk)})",
                chunk,
            ).fetchall()
            for row in rows:
                text, _fields = embeddings.build_text(
                    row["title"], row["abstract"], lane.input_limit
                )
                if text.strip():
                    texts.append(text)
        return embeddings.estimate_cost(lane, texts)
    finally:
        _close_db(conn)


@app.post("/api/embeddings/backfill")
def start_embedding_backfill():
    """Embed every document lacking a vector for the active model.

    Returns immediately; poll ``GET /api/embeddings/status``. Resumable by
    construction — the work remaining is a query, not a stored cursor — so a
    cancelled run restarts where the corpus is, not where the last run thought
    it was.
    """
    conn = _get_db()
    try:
        lane = _current_embedding_lane(conn)
        if lane is None:
            raise HTTPException(
                400,
                "No embedding lane is configured. Choose a provider and model in "
                "Settings → AI → Embeddings first.",
            )
        probe = embeddings.probe_lane(lane)
        if not probe["ok"]:
            # Refused before the run rather than during it. A thousand documents
            # against a model that cannot embed is a thousand identical
            # refusals, and on a metered provider it is a thousand charges.
            raise HTTPException(400, probe["reason"])
        try:
            started = embedding_job.backfill_job.start(_open_connection, lane)
        except RuntimeError as exc:
            raise HTTPException(409, str(exc)) from None
        return {"status": "started", "run": started}
    finally:
        _close_db(conn)


@app.post("/api/embeddings/backfill/cancel")
def cancel_embedding_backfill():
    """Stop after the batch in flight. Vectors already written are kept."""
    return embedding_job.backfill_job.cancel()


@app.post("/api/embeddings/rebuild")
def rebuild_embedding_index():
    """Rebuild the vector index from the canonical table.

    Exposed because the index is derived and the table is not: a database copied
    from a machine that could not load the extension arrives with every vector
    and no index, and this is the one action that fixes it.
    """
    conn = _get_db()
    try:
        lane = _current_embedding_lane(conn)
        if lane is None:
            raise HTTPException(400, "No embedding lane is configured.")
        return vector_index.rebuild(conn, lane.model)
    finally:
        _close_db(conn)


@app.get("/api/settings/cloud")
def get_cloud_settings():
    conn = _get_db()
    try:
        return _get_settings_group(conn, "cloud")
    finally:
        _close_db(conn)


@app.put("/api/settings/cloud")
def update_cloud_settings(body: SettingsBody):
    conn = _get_db()
    try:
        _set_settings_group(conn, "cloud", body.settings)
        return {"success": True}
    finally:
        _close_db(conn)


@app.get("/api/settings/storage")
def get_storage_settings():
    conn = _get_db()
    try:
        return _get_settings_group(conn, "storage")
    finally:
        _close_db(conn)


@app.put("/api/settings/storage")
def update_storage_settings(body: SettingsBody):
    conn = _get_db()
    try:
        _set_settings_group(conn, "storage", body.settings)
        return {"success": True}
    finally:
        _close_db(conn)


@app.get("/api/settings/notifications")
def get_notification_settings():
    conn = _get_db()
    try:
        raw = _get_settings_group(conn, "notifications")
        manual_raw = str(raw.get("notify_manual", "")).strip().lower()
        notify_manual = manual_raw in ("1", "true", "yes", "on")
        mode = str(raw.get("notify_automatic_mode", "")).strip().lower()
        if mode not in ("all", "selected", "none"):
            mode = "none"
        # Default notify_manual to True on first load when unset
        if raw.get("notify_manual", "") == "":
            notify_manual = True
        return {"notify_manual": notify_manual, "notify_automatic_mode": mode}
    finally:
        _close_db(conn)


@app.put("/api/settings/notifications")
def update_notification_settings(body: SettingsBody):
    data = body.settings or {}
    cleaned: dict = {}
    if "notify_manual" in data:
        cleaned["notify_manual"] = "1" if bool(data["notify_manual"]) else "0"
    if "notify_automatic_mode" in data:
        mode = str(data["notify_automatic_mode"]).strip().lower()
        if mode not in ("all", "selected", "none"):
            raise HTTPException(400, "notify_automatic_mode must be 'all', 'selected', or 'none'")
        cleaned["notify_automatic_mode"] = mode
    conn = _get_db()
    try:
        _set_settings_group(conn, "notifications", cleaned)
        return {"success": True}
    finally:
        _close_db(conn)


# ---------------------------------------------------------------------------
# Execution admission settings (IMPL-R1)
# ---------------------------------------------------------------------------

_EXEC_SETTINGS_DEFAULTS = {
    "max_concurrent_executions": "3",
    "routine_fire_queue_limit": "16",
}


def _load_execution_settings_from_db(conn) -> tuple[int, int]:
    """Read admission settings from app_settings, writing defaults if absent."""
    raw_max = get_setting(conn, "max_concurrent_executions")
    if raw_max is None:
        raw_max = _EXEC_SETTINGS_DEFAULTS["max_concurrent_executions"]
        set_setting(conn, "max_concurrent_executions", raw_max)
    raw_qlimit = get_setting(conn, "routine_fire_queue_limit")
    if raw_qlimit is None:
        raw_qlimit = _EXEC_SETTINGS_DEFAULTS["routine_fire_queue_limit"]
        set_setting(conn, "routine_fire_queue_limit", raw_qlimit)
    try:
        max_concurrent = int(raw_max)
    except (TypeError, ValueError):
        max_concurrent = int(_EXEC_SETTINGS_DEFAULTS["max_concurrent_executions"])
    try:
        queue_limit = int(raw_qlimit)
    except (TypeError, ValueError):
        queue_limit = int(_EXEC_SETTINGS_DEFAULTS["routine_fire_queue_limit"])
    return max_concurrent, queue_limit


def _hydrate_admission_from_db() -> None:
    """Apply persisted execution settings to the admission singleton."""
    conn = _get_db()
    try:
        max_concurrent, queue_limit = _load_execution_settings_from_db(conn)
    finally:
        _close_db(conn)
    admission.set_max(max_concurrent)
    admission.set_queue_limit(queue_limit)


def _init_admission_on_startup() -> None:
    _hydrate_admission_from_db()


def _migrate_legacy_ai_key_on_startup() -> None:
    """Update 2 — Feature 1: one-shot transparent migration of any
    legacy global ``ai_api_key`` keyring slot into the per-provider
    ``{provider}_api_key`` slot. Idempotent — calling it on every
    startup is safe and a no-op when no legacy slot exists.
    """
    try:
        conn = _get_db()
        try:
            provider = get_setting(conn, "ai_provider")
        finally:
            _close_db(conn)
        migrate_legacy_global_ai_key(provider)
    except Exception:  # pragma: no cover - defensive
        logger.exception("Legacy AI-key migration failed")


# ---------------------------------------------------------------------------
# Scheduler lifecycle (IMPL-R4)
#
# A single module-level ``ResmonScheduler`` is instantiated at FastAPI
# startup. The dispatcher is installed via ``set_dispatcher`` so the
# scheduler module stays decoupled from FastAPI and the SweepEngine. The
# real dispatcher body lands in IMPL-R6; the placeholder below only logs
# the fire so APScheduler can run end-to-end and tests can exercise the
# wiring path.
# ---------------------------------------------------------------------------

scheduler: ResmonScheduler | None = None


def _dispatch_routine_fire(
    routine_id: int,
    parameters: str,
    *,
    allow_inactive: bool = False,
) -> int | None:
    """Fire a routine: prepare execution, admit, launch, stamp.

    Follows the pseudocode in ``resmon_routines.md`` Appendix A.1. Returns the
    new execution id, or ``None`` if the routine row is missing or inactive, or
    if the admission controller enqueues / drops the fire. Admission slot
    release happens inside ``_launch_execution``'s ``finally`` via
    ``admission.note_finished``.

    ``allow_inactive`` exists for ``POST /api/routines/{id}/run``. Skipping an
    inactive routine is right for a *scheduled* fire -- deactivating is how a
    user stops one running on its own. A manual run is an explicit instruction,
    so ``is_active`` governs scheduling rather than permission, and the endpoint
    says in its response that the routine was inactive rather than running it
    silently. The scheduler never passes this, so its behavior is unchanged.

    The return value is new. The scheduler ignores it, which is why widening it
    is safe; the endpoint needs it, because "which execution did you just
    start" is the only useful thing to answer with.
    """
    dispatch_logger = logging.getLogger(__name__)
    conn = _get_db()
    try:
        row = get_routine_by_id(conn, routine_id)
        if not row:
            dispatch_logger.info(
                "Routine fire skipped: routine_id=%s missing", routine_id,
            )
            return None
        if not row.get("is_active") and not allow_inactive:
            dispatch_logger.info(
                "Routine fire skipped: routine_id=%s inactive", routine_id,
            )
            return None

        try:
            params = json.loads(parameters or "{}")
        except (json.JSONDecodeError, TypeError):
            dispatch_logger.exception(
                "Routine fire parameters unparseable: routine_id=%s", routine_id,
            )
            return None
        if not isinstance(params, dict):
            params = {}
        repositories = list(params.get("repositories") or [])

        if not admission.try_admit(
            kind="routine", routine_id=routine_id, params_json=parameters,
        ):
            return None

        ai_settings_raw = row.get("ai_settings")
        try:
            ai_settings = json.loads(ai_settings_raw) if ai_settings_raw else None
        except (json.JSONDecodeError, TypeError):
            ai_settings = None

        engine = SweepEngine(
            db_conn=conn,
            config={
                "ai_enabled": bool(row.get("ai_enabled")),
                "ai_settings": ai_settings,
            },
        )
        exec_id = engine.prepare_execution(
            "automated_sweep", repositories, params,
        )

        try:
            conn.execute(
                "UPDATE executions SET routine_id = ? WHERE id = ?",
                (int(routine_id), int(exec_id)),
            )
            conn.commit()
        except Exception:
            dispatch_logger.exception(
                "Failed to stamp routine_id on execution row: routine_id=%s exec_id=%s",
                routine_id, exec_id,
            )

        progress_store.register(exec_id)
        _launch_execution(engine, exec_id, conn, ephemeral_credentials=None)

        try:
            conn.execute(
                "UPDATE routines SET last_executed_at = datetime('now') WHERE id = ?",
                (int(routine_id),),
            )
            conn.commit()
        except Exception:
            dispatch_logger.exception(
                "Failed to stamp last_executed_at: routine_id=%s", routine_id,
            )
        return int(exec_id)
    finally:
        _close_db(conn)


def _init_scheduler_on_startup() -> None:
    global scheduler
    # Update 4 / Fix D — When the Electron main process spawns this
    # backend as a fallback (because no live daemon was found), it sets
    # RESMON_DISABLE_SCHEDULER=1 to keep the scheduler off. The launchd
    # daemon is the sole owner of the APScheduler instance so two
    # processes never race against the shared SQLite jobstore. Routine
    # CRUD endpoints already no-op when ``scheduler is None``.
    if os.environ.get("RESMON_DISABLE_SCHEDULER") == "1":
        logging.getLogger(__name__).info(
            "RESMON_DISABLE_SCHEDULER=1 — scheduler not started in this process"
        )
        scheduler = None
        return
    set_dispatcher(_dispatch_routine_fire)
    # When tests override the app DB to ``:memory:``, give the APScheduler
    # jobstore a disposable on-disk SQLite so its SingletonThreadPool can
    # share schema across worker threads. Tests clean up via ``shutdown``.
    if _db_path == ":memory:":
        import tempfile as _tempfile
        _tmp = _tempfile.NamedTemporaryFile(
            prefix="resmon-test-scheduler-", suffix=".sqlite", delete=False,
        )
        _tmp.close()
        scheduler = ResmonScheduler(db_url=f"sqlite:///{_tmp.name}")
    else:
        scheduler = ResmonScheduler()
    scheduler.start()
    conn = _get_db()
    try:
        routines = get_routines(conn)
    finally:
        _close_db(conn)
    # Update 4 / Fix A: drop any orphan apscheduler_jobs rows whose id
    # is not in the current set of active routines. This catches ghost
    # jobs that survived a delete in a process that did not own the
    # scheduler (e.g., a renderer-spawned backend serving the DELETE
    # while the launchd daemon owned the scheduler), and any pre-patch
    # ghosts that existed before the cascade in delete_routine.
    active_ids = {str(r["id"]) for r in routines if r.get("is_active")}
    try:
        scheduler.reconcile_jobstore(active_ids)
    except Exception:
        logging.getLogger(__name__).exception(
            "Scheduler jobstore reconciliation failed on startup",
        )
    for r in routines:
        if r.get("is_active"):
            try:
                scheduler.add_routine(r)
            except Exception:
                logging.getLogger(__name__).exception(
                    "Failed to register routine on startup: id=%s", r.get("id"),
                )


def _shutdown_scheduler() -> None:
    global scheduler
    if scheduler is not None:
        try:
            scheduler.shutdown()
        finally:
            scheduler = None
    set_dispatcher(None)


@app.get("/api/scheduler/jobs")
def get_scheduler_jobs():
    if scheduler is None:
        return []
    return scheduler.get_active_jobs()


@app.get("/api/settings/execution")
def get_execution_settings():
    conn = _get_db()
    try:
        max_concurrent, queue_limit = _load_execution_settings_from_db(conn)
        return {
            "max_concurrent_executions": max_concurrent,
            "routine_fire_queue_limit": queue_limit,
        }
    finally:
        _close_db(conn)


@app.put("/api/settings/execution")
def update_execution_settings(body: ExecutionSettingsBody):
    if not (1 <= body.max_concurrent_executions <= 8):
        raise HTTPException(400, "max_concurrent_executions must be between 1 and 8")
    if not (1 <= body.routine_fire_queue_limit <= 64):
        raise HTTPException(400, "routine_fire_queue_limit must be between 1 and 64")
    conn = _get_db()
    try:
        set_setting(conn, "max_concurrent_executions", str(body.max_concurrent_executions))
        set_setting(conn, "routine_fire_queue_limit", str(body.routine_fire_queue_limit))
    finally:
        _close_db(conn)
    admission.set_max(body.max_concurrent_executions)
    admission.set_queue_limit(body.routine_fire_queue_limit)
    return {
        "success": True,
        "max_concurrent_executions": body.max_concurrent_executions,
        "routine_fire_queue_limit": body.routine_fire_queue_limit,
    }


# ---------------------------------------------------------------------------
# Credentials
# ---------------------------------------------------------------------------

@app.post("/api/credentials/validate")
def validate_credential(body: CredentialValidate):
    valid = validate_api_key(body.provider, body.key, base_url=body.base_url)
    return {"valid": valid}


@app.post("/api/ai/models")
def list_ai_models(body: AIModelsRequest):
    """Return the list of model IDs the BYOK credential can access.

    The caller may send a freshly-typed ``key`` or rely on the credential
    already stored in the OS keyring for ``{provider}_api_key`` (or
    ``custom_llm_api_key`` for the Custom provider). ``local`` uses no
    key and requires ``endpoint`` instead.
    """
    provider = (body.provider or "").strip().lower()
    if not provider:
        raise HTTPException(400, "Provider is required.")

    # Subscription lanes have no key to look up, and asking for one would be
    # the false "API key missing" all over again. They are answered from the
    # CLI itself, and the response says which kind of answer it is: claude has
    # no models command and offers documented aliases, codex reports a real
    # catalog through `codex debug models`.
    if provider in SUBSCRIPTION_PROVIDERS:
        catalog = list_subscription_catalog(
            provider, (body.binary_path or "").strip() or None,
        )
        if catalog.error:
            raise HTTPException(400, catalog.error)
        return catalog.to_dict()

    key: Optional[str] = (body.key or "").strip() or None
    if key is None and provider != "local":
        cred_name = (
            "custom_llm_api_key" if provider == "custom" else f"{provider}_api_key"
        )
        if cred_name in AI_CREDENTIAL_NAMES:
            key = get_credential(cred_name)
        if not key:
            raise HTTPException(
                400,
                "No API key available for this provider. Enter a key above or "
                "save one first.",
            )

    try:
        models = ai_list_available_models(
            provider=provider,
            key=key,
            base_url=(body.base_url or "").strip() or None,
            header_prefix=(body.header_prefix or "Bearer").strip() or "Bearer",
            endpoint=(body.endpoint or "").strip() or None,
        )
    except ModelListError as exc:
        raise HTTPException(400, str(exc))
    return {"models": models}


@app.put("/api/credentials/{key_name}")
def store_credential_endpoint(key_name: str, body: CredentialStore):
    allowed = catalog_credential_names() | AI_CREDENTIAL_NAMES | SMTP_CREDENTIAL_NAMES
    if key_name not in allowed:
        raise HTTPException(
            status_code=400,
            detail=f"Unknown credential name: {key_name}",
        )
    store_credential(key_name, body.value)
    return {"success": True}


@app.delete("/api/credentials/{key_name}")
def delete_credential_endpoint(key_name: str):
    delete_credential(key_name)
    return {"success": True}


# ---------------------------------------------------------------------------
# Cloud (Google Drive storage integration — unrelated to resmon-cloud)
# ---------------------------------------------------------------------------

@app.post("/api/cloud/link")
def cloud_link():
    # Pre-flight: the Google OAuth client secrets file is required for the
    # InstalledAppFlow. If it is absent, return a descriptive 400 so the
    # UI can surface actionable guidance instead of a generic 500.
    from implementation_scripts.config import PROJECT_ROOT as _PROJECT_ROOT
    secrets_path = _PROJECT_ROOT / "credentials.json"
    if not secrets_path.exists():
        raise HTTPException(
            400,
            (
                "Google Drive credentials not configured. "
                "Google Drive linking requires an OAuth client secrets file "
                f"at '{secrets_path}'. Create an OAuth 2.0 Client ID of type "
                "'Desktop app' in the Google Cloud Console, download the "
                "credentials.json, and place it at that path, then try again."
            ),
        )
    success = authorize_google_drive()
    if not success:
        raise HTTPException(
            500,
            (
                "Google Drive authorization failed. Check that credentials.json "
                "is valid and that the OAuth consent screen is configured for "
                "your Google account."
            ),
        )
    return {"auth_url": "oauth_completed"}


@app.post("/api/cloud/unlink")
def cloud_unlink():
    revoke_authorization()
    return {"success": True}


@app.get("/api/cloud/status")
def cloud_status():
    # ``is_linked`` reflects link state (token stored, user completed OAuth).
    # ``api_ok`` is a live probe of the Drive API; it can be False even when
    # linked (e.g. the Drive API is not enabled on the OAuth project).
    linked = cloud_is_token_stored()
    if not linked:
        return {"is_linked": False, "api_ok": False, "api_reason": "no_token"}
    ok, reason = cloud_probe_api()
    return {"is_linked": True, "api_ok": ok, "api_reason": reason}


@app.post("/api/cloud/backup")
def cloud_backup(body: CloudBackup):
    if not cloud_check_connection():
        raise HTTPException(400, "Cloud storage not linked")
    result = upload_directory(REPORTS_DIR)
    return {
        "success": True,
        "uploaded": len(result.get("uploaded_ids", [])),
        "total_files": result.get("total_files", 0),
        "folder_name": result.get("folder_name"),
        "web_view_link": result.get("web_view_link"),
    }


# ---------------------------------------------------------------------------
# Service unit install / uninstall (IMPL-26)
# ---------------------------------------------------------------------------

from implementation_scripts import service_manager as _service_manager


class ServiceInstallBody(BaseModel):
    # The wire field stays "register" - that is what AdvancedSettings.tsx posts -
    # but the Python attribute is renamed because "register" shadows an
    # attribute on pydantic's BaseModel and emitted a UserWarning on every
    # import of this module.
    model_config = ConfigDict(populate_by_name=True)

    register_service: bool = Field(
        default=False,  # default False so the OS step is explicit
        alias="register",
    )
    port: Optional[int] = None


@app.get("/api/service/status")
def service_status():
    """Return whether the daemon unit file is installed and its path."""
    return {
        "installed": _service_manager.is_installed(),
        "unit_path": str(_service_manager.unit_path()),
        "platform": sys.platform,
    }


@app.get("/api/service/daemon-status")
def service_daemon_status():
    """Return ground-truth daemon status read from ``daemon.lock``.

    Update 4 / Fix E. Unlike ``/api/health`` (which always describes the
    *current* backend), this endpoint reads the on-disk daemon lock file
    and probes the daemon's actual port. The Advanced tab uses it so that
    a renderer-spawned fallback backend cannot masquerade as the daemon.

    Response shape::

        {
          "lock_present": bool,
          "running": bool,                # true iff lock present AND health probe succeeds
          "pid": int | None,              # from the live health probe
          "port": int | None,
          "version": str | None,
          "started_at": str | None,
          "lock_pid": int | None,         # raw lock-file payload (for diagnostics)
          "lock_port": int | None,
          "lock_version": str | None,
          "error": str | None,            # populated when lock_present but probe failed
        }
    """
    from implementation_scripts import daemon as _daemon

    payload = _daemon.read_lock()
    if not payload:
        return {
            "lock_present": False,
            "running": False,
            "pid": None,
            "port": None,
            "version": None,
            "started_at": None,
            "lock_pid": None,
            "lock_port": None,
            "lock_version": None,
            "error": None,
        }

    lock_pid = payload.get("pid") if isinstance(payload.get("pid"), int) else None
    lock_port = payload.get("port") if isinstance(payload.get("port"), int) else None
    lock_version = payload.get("version") if isinstance(payload.get("version"), str) else None

    base = {
        "lock_present": True,
        "running": False,
        "pid": None,
        "port": None,
        "version": None,
        "started_at": None,
        "lock_pid": lock_pid,
        "lock_port": lock_port,
        "lock_version": lock_version,
        "error": None,
    }

    if lock_port is None:
        base["error"] = "lock file missing port"
        return base

    # Probe the daemon's actual port. Short timeout — this endpoint is
    # polled from the Advanced tab on a 5 s cadence.
    try:
        with httpx.Client(timeout=1.5) as client:
            resp = client.get(f"http://127.0.0.1:{lock_port}/api/health")
        if resp.status_code != 200:
            base["error"] = f"health probe HTTP {resp.status_code}"
            return base
        data = resp.json()
    except Exception as exc:
        base["error"] = f"health probe failed: {exc.__class__.__name__}"
        return base

    # If the probe came back from *this* process, the lock points at the
    # current backend rather than a separate daemon — flag it so the UI
    # can render the distinction honestly.
    probed_pid = data.get("pid") if isinstance(data.get("pid"), int) else None
    base.update(
        {
            "running": True,
            "pid": probed_pid,
            "port": lock_port,
            "version": data.get("version") if isinstance(data.get("version"), str) else None,
            "started_at": data.get("started_at") if isinstance(data.get("started_at"), str) else None,
            "is_self": probed_pid == os.getpid(),
        }
    )
    return base


@app.post("/api/service/install")
def service_install(body: ServiceInstallBody = ServiceInstallBody()):
    """Render the platform unit template and write it to the install path.

    ``register=True`` additionally asks the OS service manager to enable the
    unit at login (launchctl / systemctl / schtasks).
    """
    try:
        path = _service_manager.install(port=body.port, register=body.register_service)
    except Exception as exc:  # registration failure
        raise HTTPException(500, f"Service install failed: {exc}")
    return {"installed": True, "unit_path": str(path)}


@app.post("/api/service/uninstall")
def service_uninstall(body: ServiceInstallBody = ServiceInstallBody()):
    """Remove the unit file; optionally deregister with the OS first."""
    try:
        removed = _service_manager.uninstall(deregister=body.register_service)
    except Exception as exc:
        raise HTTPException(500, f"Service uninstall failed: {exc}")
    return {"installed": False, "unit_path": str(_service_manager.unit_path()), "removed": removed}


# ---------------------------------------------------------------------------
# App factory / shutdown helpers (shared between Electron-spawn and daemon paths)
# ---------------------------------------------------------------------------

def create_app(db_path: str | None = None) -> FastAPI:
    """Return the configured FastAPI application.

    Both the Electron-spawned ``main()`` entrypoint and the standalone
    ``resmon-daemon`` entrypoint call this factory so that identical routes,
    middleware, and database initialization are applied to every process.
    """
    global _db_path, _shared_conn, _db_initialized
    if db_path is not None:
        _db_path = db_path
        _shared_conn = None
        _db_initialized = False
    # Eagerly initialize so the first request does not race.
    _get_db()
    return app


def flush_running_executions(reason: str = "daemon_restart") -> int:
    """Mark any ``running`` executions as ``failed`` with the given cancel_reason.

    Called during graceful shutdown so that rows are not left in a permanent
    ``running`` state after the daemon exits. Returns the number of rows flushed.
    """
    try:
        conn = _get_db()
    except Exception:
        return 0
    rows = conn.execute(
        "SELECT id FROM executions WHERE status = 'running'"
    ).fetchall()
    if not rows:
        return 0
    now = datetime.now(timezone.utc).isoformat()
    for row in rows:
        update_execution_status(
            conn,
            int(row["id"]),
            "failed",
            end_time=now,
            cancel_reason=reason,
            error_message=f"Execution flushed on {reason}",
        )
    return len(rows)


# ---------------------------------------------------------------------------
# Settings → Advanced → Danger Zone (Update 3 / 4_27_26)
# ---------------------------------------------------------------------------
#
# Bulk irreversible erase / reset endpoints exposed in the Advanced tab.
# The renderer guards each destructive call with a typed-CONFIRM modal, but
# the backend re-validates the literal ``"CONFIRM"`` string on the wire so
# stray client code can't accidentally wipe data.


class AdminConfirmBody(BaseModel):
    confirm: str = ""


def _require_confirm(body: AdminConfirmBody) -> None:
    if body.confirm != "CONFIRM":
        raise HTTPException(
            status_code=400,
            detail="This action is irreversible. Type CONFIRM exactly to proceed.",
        )


def _erase_ai_keys() -> int:
    for name in AI_CREDENTIAL_NAMES:
        delete_credential(name)
    # Legacy single global slot from pre-update_2 builds, if present.
    delete_credential("ai_api_key")
    return len(AI_CREDENTIAL_NAMES)


def _erase_repo_keys() -> int:
    names = sorted(catalog_credential_names())
    for name in names:
        delete_credential(name)
    return len(names)


def _erase_configs(conn) -> int:
    """Delete every saved configuration plus any linked routines."""
    rows = conn.execute(
        "SELECT id, parameters, config_type FROM saved_configurations"
    ).fetchall()
    for row in rows:
        if row["config_type"] != "routine":
            continue
        raw = row["parameters"] or "{}"
        try:
            payload = json.loads(raw) if isinstance(raw, str) else raw
        except (json.JSONDecodeError, TypeError):
            payload = {}
        rid = payload.get("linked_routine_id") if isinstance(payload, dict) else None
        if isinstance(rid, int) and get_routine_by_id(conn, rid):
            delete_routine(conn, rid)
    count = conn.execute("SELECT COUNT(*) FROM saved_configurations").fetchone()[0]
    conn.execute("DELETE FROM saved_configurations")
    conn.execute("DELETE FROM sqlite_sequence WHERE name='saved_configurations'")
    return int(count)


def _erase_executions(conn) -> int:
    """Delete every execution row and reset the AUTOINCREMENT counter."""
    count = conn.execute("SELECT COUNT(*) FROM executions").fetchone()[0]
    # execution_documents has ON DELETE CASCADE on executions(id); explicit
    # DELETE here is belt-and-braces against pragma drift.
    conn.execute("DELETE FROM execution_documents")
    conn.execute("DELETE FROM executions")
    conn.execute("DELETE FROM sqlite_sequence WHERE name='executions'")
    return int(count)


def _erase_corpus(conn) -> int:
    """Delete every paper resmon has collected.

    Until 1.7.0 nothing in the Danger Zone did this. "Erase all app data" and
    even "Factory reset" removed executions, configurations and keys while
    leaving the entire corpus in place -- on a real install that meant tens of
    thousands of papers surviving a reset that said it erased everything. The
    labels were not merely incomplete; "Factory reset" promised a clean slate it
    did not deliver, which is precisely the kind of thing 1.7 exists to stop.

    ``documents`` is the root: authors, categories, the execution join table and
    both lifecycle tables all cascade from it, and an AFTER DELETE trigger keeps
    the full-text index in step. The index is rebuilt afterwards anyway, because
    a stale FTS row would surface a paper that no longer exists.
    """
    count = conn.execute("SELECT COUNT(*) FROM documents").fetchone()[0]
    conn.execute("DELETE FROM documents")
    conn.execute("DELETE FROM sqlite_sequence WHERE name='documents'")
    try:
        conn.execute("INSERT INTO documents_fts(documents_fts) VALUES ('rebuild')")
    except sqlite3.Error:
        # An install predating the search index has no FTS table to rebuild.
        pass
    return int(count)


def _reset_settings(conn) -> int:
    """Clear every row in app_settings except the schema-version marker."""
    # Preserve only the schema-version marker so the next daemon start
    # doesn't re-run migrations.
    count = conn.execute(
        "SELECT COUNT(*) FROM app_settings WHERE key != 'schema_version'"
    ).fetchone()[0]
    conn.execute("DELETE FROM app_settings WHERE key != 'schema_version'")
    return int(count)


@app.post("/api/admin/erase-ai-keys")
def admin_erase_ai_keys():
    n = _erase_ai_keys()
    return {"success": True, "ai_keys_removed": n}


@app.post("/api/admin/erase-repo-keys")
def admin_erase_repo_keys():
    n = _erase_repo_keys()
    return {"success": True, "repo_keys_removed": n}


@app.post("/api/admin/erase-configs")
def admin_erase_configs(body: AdminConfirmBody):
    _require_confirm(body)
    conn = _get_db()
    try:
        n = _erase_configs(conn)
        conn.commit()
        return {"success": True, "configs_removed": n}
    finally:
        _close_db(conn)


@app.post("/api/admin/erase-executions")
def admin_erase_executions(body: AdminConfirmBody):
    _require_confirm(body)
    conn = _get_db()
    try:
        n = _erase_executions(conn)
        conn.commit()
        return {"success": True, "executions_removed": n}
    finally:
        _close_db(conn)


@app.post("/api/admin/erase-execution-data")
def admin_erase_execution_data(body: AdminConfirmBody):
    """Erase all configs + all executions. Settings and API keys untouched."""
    _require_confirm(body)
    conn = _get_db()
    try:
        c = _erase_configs(conn)
        e = _erase_executions(conn)
        conn.commit()
        return {"success": True, "configs_removed": c, "executions_removed": e}
    finally:
        _close_db(conn)


@app.post("/api/admin/erase-app-data")
def admin_erase_app_data(body: AdminConfirmBody):
    """Erase the corpus + configs + executions + every API key.

    The corpus is included as of 1.7.0. "All app data" that left every collected
    paper behind was not a description of what this did.
    """
    _require_confirm(body)
    conn = _get_db()
    try:
        c = _erase_configs(conn)
        e = _erase_executions(conn)
        d = _erase_corpus(conn)
        conn.commit()
    finally:
        _close_db(conn)
    a = _erase_ai_keys()
    r = _erase_repo_keys()
    return {
        "success": True,
        "configs_removed": c,
        "executions_removed": e,
        "documents_removed": d,
        "ai_keys_removed": a,
        "repo_keys_removed": r,
    }


@app.post("/api/admin/erase-corpus")
def admin_erase_corpus(body: AdminConfirmBody):
    """Erase every collected paper. Executions, configs and keys are kept."""
    _require_confirm(body)
    conn = _get_db()
    try:
        n = _erase_corpus(conn)
        conn.commit()
        return {"success": True, "documents_removed": n}
    finally:
        _close_db(conn)


@app.post("/api/admin/reset-settings")
def admin_reset_settings(body: AdminConfirmBody):
    """Reset every setting plus erase every API key. Configs/executions kept."""
    _require_confirm(body)
    conn = _get_db()
    try:
        n = _reset_settings(conn)
        conn.commit()
    finally:
        _close_db(conn)
    a = _erase_ai_keys()
    r = _erase_repo_keys()
    # Also clear the SMTP password stored under SMTP_CREDENTIAL_NAMES so a
    # settings reset truly removes every secret tied to settings.
    for name in SMTP_CREDENTIAL_NAMES:
        delete_credential(name)
    return {
        "success": True,
        "settings_cleared": n,
        "ai_keys_removed": a,
        "repo_keys_removed": r,
    }


@app.post("/api/admin/factory-reset")
def admin_factory_reset(body: AdminConfirmBody):
    """Erase every secret, config, execution, setting, and collected paper.

    The corpus is included as of 1.7.0 — a "factory reset" that left tens of
    thousands of papers on disk was the single most misleading label in the app.
    """
    _require_confirm(body)
    conn = _get_db()
    try:
        c = _erase_configs(conn)
        e = _erase_executions(conn)
        d = _erase_corpus(conn)
        s = _reset_settings(conn)
        conn.commit()
    finally:
        _close_db(conn)
    a = _erase_ai_keys()
    r = _erase_repo_keys()
    for name in SMTP_CREDENTIAL_NAMES:
        delete_credential(name)
    return {
        "success": True,
        "configs_removed": c,
        "executions_removed": e,
        "documents_removed": d,
        "settings_cleared": s,
        "ai_keys_removed": a,
        "repo_keys_removed": r,
    }




def close_db() -> None:
    """Close every sqlite connection this process opened, except the unsafe ones.

    Since BUG-020 each thread holds its own connection, so closing only the
    anchor would leave the rest open -- and an in-memory database stays alive
    while any connection to it remains, which would leak state between tests.

    **A connection owned by another thread that is still alive is not closed.**
    Connections are opened with ``check_same_thread=False``, so sqlite3 does
    nothing to serialize a close against a query running on another thread; the
    C library is handed a connection mid-statement and the process dies with
    SIGSEGV rather than raising anything Python can catch. This was found on
    2026-08-31 in the v1.8.1 release CI: an end-to-end test passed, then the
    suite segfaulted here during fixture teardown while an execution worker was
    still running. It reproduced once in twenty-five runs.

    It is not only a test problem. ``daemon.py`` calls this on shutdown after
    flushing running executions and stopping the scheduler -- neither of which
    joins the ``exec-`` worker threads -- so the same race can take down the
    real application as it quits.

    Deferred connections go back on the list, so the next call collects them
    once their owner has finished. Leaking a connection until then is strictly
    better than the alternative: it costs a file handle, and the generation bump
    below means the owner rebuilds rather than reusing it either way.
    """
    global _shared_conn, _db_initialized, _db_generation
    with _db_lock:
        entries = list(_db_conns)
        _db_conns.clear()

    current = threading.current_thread()
    deferred: list[tuple[sqlite3.Connection, threading.Thread]] = []
    for conn, owner in entries:
        # Closing our own connection is always safe: this thread cannot be
        # inside a query on it while it is here.
        if owner is not current and owner.is_alive():
            deferred.append((conn, owner))
            continue
        try:
            conn.close()
        except Exception:
            pass

    if deferred:
        with _db_lock:
            _db_conns.extend(deferred)
        logging.getLogger(__name__).warning(
            "close_db left %d connection(s) open: their owning threads (%s) are "
            "still running. They will be closed by the next call.",
            len(deferred),
            ", ".join(sorted({owner.name for _, owner in deferred})),
        )

    _shared_conn = None
    _db_initialized = False
    # Move the generation on so any thread still holding a reference rebuilds
    # rather than using a closed connection.
    _db_generation += 1


# ---------------------------------------------------------------------------
# Entrypoint
# ---------------------------------------------------------------------------

def write_port_file(port: int) -> None:
    """Record the port this process is serving on, for the MCP server to find.

    Best-effort by design: a read-only or missing state directory must not stop
    the backend starting. The MCP server falls back to RESMON_PORT and then the
    default, and confirms whatever it finds with GET /api/health before using
    it, so a stale or absent file costs a probe rather than a wrong answer.
    """
    try:
        PORT_FILE.parent.mkdir(parents=True, exist_ok=True)
        PORT_FILE.write_text(str(int(port)), encoding="utf-8")
    except OSError:
        logging.getLogger(__name__).warning(
            "Could not write the port file at %s; the MCP server will fall back "
            "to RESMON_PORT or the default port.", PORT_FILE,
        )


def remove_port_file() -> None:
    """Delete the port file on the way out. Never raises."""
    try:
        PORT_FILE.unlink()
    except OSError:
        pass


def main():
    import uvicorn
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8742
    create_app()
    print(f"{APP_NAME} v{APP_VERSION}")
    write_port_file(port)
    try:
        uvicorn.run(app, host="127.0.0.1", port=port)
    finally:
        remove_port_file()


if __name__ == "__main__":
    main()
