"""resmon — Research Monitor backend (FastAPI application)."""

import asyncio
import json
import os
import sqlite3
import shutil
import sys
import tempfile
import threading
import time
import zipfile
import logging
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional

import httpx

# Ensure the implementation_scripts package is importable
sys.path.insert(0, str(Path(__file__).resolve().parent))

from fastapi import FastAPI, HTTPException, Query, UploadFile, File
from fastapi.middleware.cors import CORSMiddleware
from starlette.requests import Request
from starlette.responses import Response, StreamingResponse
from starlette.types import ASGIApp, Receive, Scope, Send
from pydantic import BaseModel

from implementation_scripts.config import APP_NAME, APP_VERSION, DEFAULT_DB_PATH, REPORTS_DIR
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
    update_execution_status,
    get_configurations,
    insert_configuration,
    update_configuration,
    delete_configuration,
    get_setting,
    set_setting,
    save_progress_events,
    get_progress_events,
    SCHEMA_VERSION,
    get_schema_version,
    upsert_cloud_routine,
    upsert_cloud_execution,
    get_cloud_executions,
    get_cloud_routines,
    clear_cloud_mirror,
    get_last_synced_version,
    set_last_synced_version,
    record_cloud_cache_entry,
    touch_cloud_cache_entry,
    get_cloud_cache_entry,
    get_cloud_cache_total_bytes,
    evict_cloud_cache_if_needed,
    CLOUD_CACHE_MAX_BYTES_DEFAULT,
)
from implementation_scripts.credential_manager import (
    store_credential,
    get_credential,
    delete_credential,
    validate_api_key,
    push_ephemeral,
    pop_ephemeral,
    AI_CREDENTIAL_NAMES,
    SMTP_CREDENTIAL_NAMES,
)
from implementation_scripts.llm_factory import build_llm_client_from_settings
from implementation_scripts.ai_models import (
    list_available_models as ai_list_available_models,
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

app = FastAPI(title=APP_NAME, version=APP_VERSION)


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

_db_path: str | None = None  # overridable for testing
_shared_conn = None  # cached connection (reused for all requests)
_db_initialized = False


def _get_db():
    """Return a shared, initialized database connection."""
    global _shared_conn, _db_initialized
    if _shared_conn is not None:
        return _shared_conn
    path = _db_path or None
    if path == ":memory:":
        _shared_conn = sqlite3.connect(":memory:", check_same_thread=False)
        _shared_conn.row_factory = sqlite3.Row
        _shared_conn.execute("PRAGMA foreign_keys=ON;")
    else:
        db_str = str(path) if path else str(DEFAULT_DB_PATH)
        _shared_conn = sqlite3.connect(db_str, check_same_thread=False, timeout=30)
        _shared_conn.row_factory = sqlite3.Row
        _shared_conn.execute("PRAGMA journal_mode=WAL;")
        _shared_conn.execute("PRAGMA foreign_keys=ON;")
        _shared_conn.execute("PRAGMA busy_timeout=5000;")
    if not _db_initialized:
        init_db(conn=_shared_conn)
        _db_initialized = True
    return _shared_conn


def _close_db(conn):
    """No-op — connections are shared and kept open."""
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

class RoutineCreate(BaseModel):
    name: str
    schedule_cron: str
    parameters: dict
    is_active: bool = True
    email_enabled: bool = False
    email_ai_summary_enabled: bool = False
    ai_enabled: bool = False
    ai_settings: Optional[dict] = None
    storage_settings: Optional[dict] = None
    notify_on_complete: bool = False
    execution_location: str = "local"

class RoutineUpdate(BaseModel):
    name: Optional[str] = None
    schedule_cron: Optional[str] = None
    parameters: Optional[dict] = None
    is_active: Optional[bool] = None
    email_enabled: Optional[bool] = None
    email_ai_summary_enabled: Optional[bool] = None
    ai_enabled: Optional[bool] = None
    ai_settings: Optional[dict] = None
    storage_settings: Optional[dict] = None
    notify_on_complete: Optional[bool] = None
    execution_location: Optional[str] = None

class ConfigCreate(BaseModel):
    name: str
    config_type: str
    parameters: dict

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
    """Liveness endpoint. Returns process identity so clients can attach-or-spawn."""
    return {
        "status": "ok",
        "pid": os.getpid(),
        "started_at": _STARTED_AT,
        "version": APP_VERSION,
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
    """Return {name: {"present": bool}} for every known credential name.

    Never returns the raw credential value.
    """
    names = sorted(
        catalog_credential_names()
        | AI_CREDENTIAL_NAMES
        | SMTP_CREDENTIAL_NAMES
    )
    return {name: {"present": get_credential(name) is not None} for name in names}


# ---------------------------------------------------------------------------
# AI summarization wiring (IMPL-AI8)
# ---------------------------------------------------------------------------

# Keys that participate in the LLM-factory settings payload. Persisted
# values live in ``app_settings``; a per-execution override may be passed
# through ``engine.config["ai_settings"]`` (request-body payload) and wins
# on merge.
_AI_SETTING_KEYS: tuple[str, ...] = (
    "ai_provider",
    "ai_model",
    "ai_local_model",
    "ai_local_endpoint",
    "ai_custom_base_url",
    "ai_summary_length",
    "ai_tone",
    "ai_extraction_goals",
    "ai_show_audit_prefix",
)

# IMPL-AI13: per-execution override dicts sent through the request body use
# short keys (``length``, ``tone``, ``model``). Translate them onto the
# canonical ``ai_*`` names before merging so the override actually wins.
_AI_OVERRIDE_KEY_MAP: dict[str, str] = {
    "length": "ai_summary_length",
    "tone": "ai_tone",
    "model": "ai_model",
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


def _apply_ai_settings_to_engine(
    engine: SweepEngine,
    exec_id: int,
    conn,
    ephemeral_credentials: Optional[dict[str, str]],
) -> None:
    """Attach ``engine.llm_client`` and ``engine.config['ai_prompt_params']``.

    Behavior:

    * Always merge persisted ``ai_*`` settings with the per-execution
      override in ``engine.config["ai_settings"]`` (override wins).
    * Build a client via :func:`build_llm_client_from_settings`. If the
      factory returns ``None`` and ``ai_enabled`` was requested, emit a
      single ``log_entry`` progress event explaining which knob is missing;
      never raise.
    * If the factory raises ``ValueError`` (e.g. insecure custom base URL),
      log the error to the progress stream and fall back to no LLM.
    * Populate ``engine.config["ai_prompt_params"]`` from the merged
      settings so :class:`SummarizationPipeline` can honor Summary-Length
      / Tone selectors.
    """
    persisted = _load_ai_settings_from_db(conn)
    override = _normalize_ai_override(engine.config.get("ai_settings"))
    merged = {**persisted, **override}

    ai_enabled = bool(engine.config.get("ai_enabled"))
    engine.config["ai_prompt_params"] = _build_prompt_params(merged)

    if not ai_enabled:
        engine.llm_client = None
        return

    try:
        client = build_llm_client_from_settings(
            merged, ephemeral=ephemeral_credentials or None,
        )
    except ValueError as exc:
        # Insecure custom base URL or similar; never leak credentials.
        progress_store.emit(exec_id, {
            "type": "log_entry",
            "level": "warn",
            "message": f"AI skipped: {exc}",
            "timestamp": datetime.now(timezone.utc).isoformat(),
        })
        engine.llm_client = None
        return

    if client is None:
        provider = str(merged.get("ai_provider") or "").strip().lower()
        if not provider:
            reason = "AI skipped: provider not configured"
        else:
            reason = "AI skipped: API key missing"
        progress_store.emit(exec_id, {
            "type": "log_entry",
            "level": "warn",
            "message": reason,
            "timestamp": datetime.now(timezone.utc).isoformat(),
        })
        engine.llm_client = None
        return

    engine.llm_client = client


def _launch_execution(
    engine: SweepEngine,
    exec_id: int,
    conn,
    ephemeral_credentials: Optional[dict[str, str]] = None,
) -> None:
    """Run the pipeline in a background thread, then persist progress events."""

    def _run() -> None:
        admission.note_admitted(exec_id)
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
            events = progress_store.get_events(exec_id)
            save_progress_events(conn, exec_id, events)
            progress_store.cleanup(exec_id)
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
    if row.get("execution_location") == "cloud":
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
        if row.get("is_active") and row.get("execution_location") != "cloud":
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


@app.post("/api/routines", status_code=201)
def create_routine(body: RoutineCreate):
    conn = _get_db()
    try:
        routine_dict = {
            "name": body.name,
            "schedule_cron": body.schedule_cron,
            "parameters": json.dumps(body.parameters),
            "is_active": int(body.is_active),
            "email_enabled": int(body.email_enabled),
            "email_ai_summary_enabled": int(body.email_ai_summary_enabled),
            "ai_enabled": int(body.ai_enabled),
            "ai_settings": json.dumps(body.ai_settings) if body.ai_settings else None,
            "storage_settings": json.dumps(body.storage_settings) if body.storage_settings else None,
            "notify_on_complete": int(body.notify_on_complete),
            "execution_location": body.execution_location,
        }
        if routine_dict["execution_location"] not in ("local", "cloud"):
            raise HTTPException(400, "execution_location must be 'local' or 'cloud'")
        rid = insert_routine(conn, routine_dict)
        _sync_routine_config(conn, rid)
        if body.is_active and routine_dict.get("execution_location", "local") == "local":
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
        if body.execution_location is not None:
            if body.execution_location not in ("local", "cloud"):
                raise HTTPException(400, "execution_location must be 'local' or 'cloud'")
            updates["execution_location"] = body.execution_location
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
# Local ⇄ Cloud migration (IMPL-37, §12.1)
#
# The desktop orchestrates cross-scope migration in two steps so that the
# cloud side can authenticate against its own JWT:
#
#   "Move to Cloud": renderer POSTs the local routine body to
#   ``/api/v2/routines`` (cloud, JWT-gated), then calls
#   ``POST /api/routines/{id}/released-to-cloud`` here to delete the local
#   row. Historical executions stay attached to their original routine_id
#   on whichever side produced them.
#
#   "Move to Local": renderer DELETEs the cloud routine, then POSTs the
#   body to ``/api/routines/adopt-from-cloud`` (this endpoint) which
#   inserts a local row preserving name, schedule_cron, parameters, and
#   notification flags verbatim.
#
# The endpoints only own the local half of each flow. The cloud half runs
# under ``cloudClient`` on the renderer so JWT headers are handled by the
# existing ``IMPL-30`` wrapper.
# ---------------------------------------------------------------------------


class RoutineAdoptFromCloud(BaseModel):
    name: str
    schedule_cron: str
    parameters: dict
    email_enabled: bool = False
    email_ai_summary_enabled: bool = False
    ai_enabled: bool = False
    notify_on_complete: bool = False
    ai_settings: Optional[dict] = None
    storage_settings: Optional[dict] = None


@app.post("/api/routines/{routine_id}/released-to-cloud", status_code=200)
def routine_released_to_cloud(routine_id: int):
    """Delete a local routine after it has been successfully mirrored to cloud.

    Called by the renderer after a successful ``POST /api/v2/routines`` so
    the local copy does not keep firing alongside the cloud scheduler.
    The renderer is responsible for the atomicity of the two-step flow.
    """
    conn = _get_db()
    try:
        existing = get_routine_by_id(conn, routine_id)
        if not existing:
            raise HTTPException(404, "Routine not found")
        _sched_remove_routine(routine_id)
        delete_routine(conn, routine_id)
        return {"released": True, "id": routine_id}
    finally:
        _close_db(conn)


@app.post("/api/routines/adopt-from-cloud", status_code=201)
def routine_adopt_from_cloud(body: RoutineAdoptFromCloud):
    """Create a local routine populated from a cloud routine body.

    Used by "Move to Local" after the renderer has successfully deleted
    the cloud copy via ``DELETE /api/v2/routines/{cloud_id}``. Preserves
    name, cron, and parameters exactly so the migration round-trip is
    lossless.
    """
    conn = _get_db()
    try:
        routine_dict = {
            "name": body.name,
            "schedule_cron": body.schedule_cron,
            "parameters": json.dumps(body.parameters),
            "is_active": 1,
            "email_enabled": int(body.email_enabled),
            "email_ai_summary_enabled": int(body.email_ai_summary_enabled),
            "ai_enabled": int(body.ai_enabled),
            "ai_settings": json.dumps(body.ai_settings) if body.ai_settings else None,
            "storage_settings": json.dumps(body.storage_settings) if body.storage_settings else None,
            "notify_on_complete": int(body.notify_on_complete),
            "execution_location": "local",
        }
        rid = insert_routine(conn, routine_dict)
        _sched_add_routine(rid)
        return {"id": rid, "name": body.name, "execution_location": "local"}
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


@app.get("/api/executions")
def list_executions(
    limit: int = Query(50, ge=1, le=500),
    offset: int = Query(0, ge=0),
    type: Optional[str] = Query(None, alias="type"),
):
    conn = _get_db()
    try:
        rows = get_executions(conn, limit=limit, offset=offset, execution_type=type)
        for row in rows:
            _enrich_execution_row(row)
        return rows
    finally:
        _close_db(conn)


@app.get("/api/executions/active")
def active_executions():
    return {"active_ids": progress_store.get_active_ids()}


@app.get("/api/executions/merged")
def list_executions_merged(
    limit: int = 200,
    filter: str = "all",
):
    """Return local + cloud executions merged and sorted by start time.

    ``filter`` ∈ {``all``, ``local``, ``cloud``} powers the Results page
    filter chip. Each row carries an ``execution_location`` field
    (``"local"`` or ``"cloud"``) so the UI can render the Local / Cloud
    badge without inspecting the id type. Registered before
    ``/api/executions/{exec_id}`` so the literal ``merged`` segment wins
    over the int-typed path parameter.
    """
    filter_v = (filter or "all").strip().lower()
    if filter_v not in {"all", "local", "cloud"}:
        raise HTTPException(400, "filter must be one of: all, local, cloud")
    limit = max(1, min(int(limit), 1000))
    conn = _get_db()

    merged: list[dict] = []
    if filter_v in ("all", "local"):
        for row in get_executions(conn, limit=limit):
            row = dict(row)
            row["execution_location"] = "local"
            _enrich_execution_row(row)
            merged.append(row)
    if filter_v in ("all", "cloud"):
        for row in get_cloud_executions(conn, limit=limit):
            row = dict(row)
            row["execution_location"] = "cloud"
            row.setdefault("start_time", row.get("started_at"))
            row.setdefault("end_time", row.get("finished_at"))
            row["execution_type"] = "cloud_routine"
            merged.append(row)

    def _ts(r: dict) -> str:
        return str(r.get("start_time") or r.get("started_at") or "")

    merged.sort(key=_ts, reverse=True)
    return merged[:limit]


@app.get("/api/executions/{exec_id}")
def get_execution(exec_id: int):
    conn = _get_db()
    try:
        row = get_execution_by_id(conn, exec_id)
        if not row:
            raise HTTPException(404, "Execution not found")
        return _enrich_execution_row(row)
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
        return {"imported": len(ids), "errors": []}
    finally:
        _close_db(conn)


# ---------------------------------------------------------------------------
# Calendar
# ---------------------------------------------------------------------------

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
            events.append({
                "id": ex["id"],
                "title": f"{type_label} #{ex['id']}{title_suffix}",
                "start": ex["start_time"],
                "end": ex.get("end_time") or ex["start_time"],
                "color": status_color.get(status, "#6b7280"),
                "execution_id": ex["id"],
                "routine_id": ex.get("routine_id"),
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
            from datetime import timedelta

            # Window: caller-supplied ``start``/``end`` (FullCalendar sends
            # ISO-8601 strings), otherwise today → +90 days.
            now = datetime.now(timezone.utc)
            try:
                window_start = datetime.fromisoformat(start.replace("Z", "+00:00")) if start else now
            except (ValueError, AttributeError):
                window_start = now
            try:
                window_end = datetime.fromisoformat(end.replace("Z", "+00:00")) if end else now + timedelta(days=90)
            except (ValueError, AttributeError):
                window_end = now + timedelta(days=90)
            # Never expand past fires; real executions already cover history.
            if window_start < now:
                window_start = now

            # Hard cap per-routine so a pathological cron (e.g. ``* * * * *``)
            # can't produce tens of thousands of events per request.
            MAX_PER_ROUTINE = 200

            for r in get_routines(conn):
                if not r.get("is_active"):
                    continue
                cron_expr = (r.get("schedule_cron") or "").strip()
                if not cron_expr:
                    continue
                try:
                    trigger = CronTrigger.from_crontab(cron_expr, timezone=timezone.utc)
                except (ValueError, TypeError):
                    continue
                params = r.get("parameters")
                if isinstance(params, str):
                    try:
                        params = json.loads(params)
                    except (json.JSONDecodeError, TypeError):
                        params = {}
                elif not isinstance(params, dict):
                    params = {}
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
                    events.append({
                        "id": f"routine-{r['id']}-{nxt.isoformat()}",
                        "title": f"routine #{r['id']}: {r.get('name') or ''}".strip(),
                        "start": nxt.isoformat(),
                        "end": nxt.isoformat(),
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
    ],
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


@app.on_event("startup")
def _init_admission_on_startup() -> None:
    _hydrate_admission_from_db()


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


def _dispatch_routine_fire(routine_id: int, parameters: str) -> None:
    """Fire a scheduled routine: prepare execution, admit, launch, stamp.

    Follows the pseudocode in ``resmon_routines.md`` Appendix A.1. Returns
    early if the routine row is missing or inactive, or if the admission
    controller enqueues / drops the fire. Admission slot release happens
    inside ``_launch_execution``'s ``finally`` via ``admission.note_finished``.
    """
    dispatch_logger = logging.getLogger(__name__)
    conn = _get_db()
    try:
        row = get_routine_by_id(conn, routine_id)
        if not row or not row.get("is_active"):
            dispatch_logger.info(
                "Routine fire skipped: routine_id=%s missing or inactive", routine_id,
            )
            return

        try:
            params = json.loads(parameters or "{}")
        except (json.JSONDecodeError, TypeError):
            dispatch_logger.exception(
                "Routine fire parameters unparseable: routine_id=%s", routine_id,
            )
            return
        if not isinstance(params, dict):
            params = {}
        repositories = list(params.get("repositories") or [])

        if not admission.try_admit(
            kind="routine", routine_id=routine_id, params_json=parameters,
        ):
            return

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
    finally:
        _close_db(conn)


@app.on_event("startup")
def _init_scheduler_on_startup() -> None:
    global scheduler
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
    for r in routines:
        if r.get("is_active"):
            try:
                scheduler.add_routine(r)
            except Exception:
                logging.getLogger(__name__).exception(
                    "Failed to register routine on startup: id=%s", r.get("id"),
                )


@app.on_event("shutdown")
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
# Cloud account authentication (IMPL-30)
# ---------------------------------------------------------------------------
#
# Per resmon_routines_and_accounts.md §§8.2–8.3, Electron-main captures the
# IdP session after the modal sign-in completes. The refresh token is passed
# here and stored in the OS keyring under service=``resmon``,
# account=``cloud_refresh_token`` (matching the path expected by
# ``security find-generic-password -s resmon -a cloud_refresh_token``).
# Access tokens are NEVER persisted here — they live only in renderer memory.

_CLOUD_REFRESH_KEY = "cloud_refresh_token"
_CLOUD_EMAIL_SETTING = "cloud_account_email"
_CLOUD_SYNC_SETTING = "sync_state"


class CloudSessionBody(BaseModel):
    refresh_token: str
    email: Optional[str] = None


class CloudSyncToggleBody(BaseModel):
    enabled: bool


@app.post("/api/cloud-auth/session")
def cloud_auth_session(body: CloudSessionBody):
    """Persist the refresh token + account email captured from the IdP modal.

    Electron-main calls this immediately after the ``/auth/callback`` redirect
    fires. The refresh token lands in the OS keyring (never on disk in plain
    text); the email is stored in the standard settings table for display.
    """
    if not body.refresh_token:
        raise HTTPException(400, "refresh_token is required")
    store_credential(_CLOUD_REFRESH_KEY, body.refresh_token)
    conn = _get_db()
    set_setting(conn, _CLOUD_EMAIL_SETTING, body.email or "")
    return {"signed_in": True, "email": body.email or ""}


@app.get("/api/cloud-auth/status")
def cloud_auth_status():
    """Return presence of a stored refresh token and the cached email."""
    refresh = get_credential(_CLOUD_REFRESH_KEY)
    conn = _get_db()
    email = get_setting(conn, _CLOUD_EMAIL_SETTING) or ""
    sync_state = get_setting(conn, _CLOUD_SYNC_SETTING) or "off"
    return {
        "signed_in": refresh is not None,
        "email": email,
        "sync_state": sync_state,
    }


@app.delete("/api/cloud-auth/session")
def cloud_auth_signout():
    """Delete the keyring refresh token and clear the cached email."""
    delete_credential(_CLOUD_REFRESH_KEY)
    conn = _get_db()
    set_setting(conn, _CLOUD_EMAIL_SETTING, "")
    return {"signed_in": False}


@app.post("/api/cloud-auth/refresh")
def cloud_auth_refresh():
    """Exchange the stored refresh token with the IdP for a fresh access token.

    The IdP refresh endpoint is read from the ``CLOUD_IDP_REFRESH_URL``
    environment variable (12-factor injection per §7.2). If unset, the
    endpoint returns 501 so the renderer can surface a clear "cloud not
    configured on this build" state.
    """
    refresh = get_credential(_CLOUD_REFRESH_KEY)
    if not refresh:
        raise HTTPException(401, "Not signed in")
    url = os.environ.get("CLOUD_IDP_REFRESH_URL")
    if not url:
        raise HTTPException(501, "Cloud IdP refresh endpoint not configured")
    try:
        resp = httpx.post(
            url,
            json={"refresh_token": refresh},
            timeout=10.0,
        )
    except httpx.HTTPError as exc:
        raise HTTPException(502, f"IdP refresh failed: {exc}")
    if resp.status_code == 401:
        # Refresh token rejected — force the client to sign in again.
        delete_credential(_CLOUD_REFRESH_KEY)
        raise HTTPException(401, "Refresh token rejected; sign in again")
    if resp.status_code >= 400:
        raise HTTPException(502, f"IdP refresh failed: {resp.status_code}")
    payload = resp.json()
    access = payload.get("access_token")
    expires_in = int(payload.get("expires_in", 900))
    if not access:
        raise HTTPException(502, "IdP response missing access_token")
    # Rotate the refresh token if the IdP returns a new one (standard OAuth2).
    new_refresh = payload.get("refresh_token")
    if new_refresh:
        store_credential(_CLOUD_REFRESH_KEY, new_refresh)
    return {"access_token": access, "expires_in": expires_in}


@app.put("/api/cloud-auth/sync")
def cloud_auth_sync_toggle(body: CloudSyncToggleBody):
    """Toggle the ``sync_state`` setting consumed by the desktop sync hook."""
    conn = _get_db()
    set_setting(conn, _CLOUD_SYNC_SETTING, "on" if body.enabled else "off")
    return {"sync_state": "on" if body.enabled else "off"}


# ---------------------------------------------------------------------------
# Cloud-sync mirror endpoints (IMPL-36, §§12 + 14.1)
#
# The frontend `useCloudSync` hook fetches cloud pages from the cloud
# service directly (JWT-gated) and POSTs the normalized rows here so the
# daemon can mirror them into the local SQLite `cloud_routines` /
# `cloud_executions` tables, advance `sync_state.last_synced_version`, and
# power the merged Results view + Dashboard "Last cloud sync" card without
# re-querying the cloud on every render.
# ---------------------------------------------------------------------------


class CloudSyncIngestBody(BaseModel):
    routines: list[dict] = []
    executions: list[dict] = []
    next_version: int
    has_more: bool = False


class CloudCacheRecordBody(BaseModel):
    execution_id: str
    artifact_name: str
    local_path: str
    bytes: int
    max_bytes: int | None = None


@app.get("/api/cloud-sync/state")
def cloud_sync_state():
    """Return the last synced cursor and on-disk cache size."""
    conn = _get_db()
    return {
        "last_synced_version": get_last_synced_version(conn),
        "cache_bytes": get_cloud_cache_total_bytes(conn),
        "schema_version": get_schema_version(conn),
    }


@app.post("/api/cloud-sync/ingest")
def cloud_sync_ingest(body: CloudSyncIngestBody):
    """Upsert a page of cloud rows into the local mirror and advance cursor."""
    conn = _get_db()
    for r in body.routines:
        try:
            upsert_cloud_routine(conn, r)
        except Exception as exc:  # pragma: no cover - defensive
            raise HTTPException(400, f"invalid routine row: {exc}")
    for e in body.executions:
        try:
            upsert_cloud_execution(conn, e)
        except Exception as exc:  # pragma: no cover - defensive
            raise HTTPException(400, f"invalid execution row: {exc}")
    # Only advance the cursor forward.
    current = get_last_synced_version(conn)
    new_cursor = max(current, int(body.next_version or 0))
    if new_cursor > current:
        set_last_synced_version(conn, new_cursor)
    return {
        "last_synced_version": get_last_synced_version(conn),
        "ingested": {
            "routines": len(body.routines),
            "executions": len(body.executions),
        },
        "has_more": bool(body.has_more),
    }


@app.post("/api/cloud-sync/clear")
def cloud_sync_clear():
    """Wipe the cloud mirror + cache + cursor (V-G3 on sign-out)."""
    conn = _get_db()
    clear_cloud_mirror(conn)
    return {"cleared": True}


@app.get("/api/cloud-sync/executions")
def cloud_sync_executions(limit: int = 500):
    """Return cloud-mirror executions (newest-first)."""
    conn = _get_db()
    limit = max(1, min(int(limit), 2000))
    return get_cloud_executions(conn, limit=limit)


@app.get("/api/cloud-sync/routines")
def cloud_sync_routines():
    """Return cloud-mirror routines."""
    conn = _get_db()
    return get_cloud_routines(conn)


@app.post("/api/cloud-sync/cache/record")
def cloud_sync_cache_record(body: CloudCacheRecordBody):
    """Record a freshly downloaded cloud artifact and evict LRU entries."""
    conn = _get_db()
    record_cloud_cache_entry(
        conn,
        body.execution_id,
        body.artifact_name,
        body.local_path,
        body.bytes,
    )
    ceiling = (
        int(body.max_bytes)
        if body.max_bytes is not None
        else CLOUD_CACHE_MAX_BYTES_DEFAULT
    )
    evicted = evict_cloud_cache_if_needed(conn, max_bytes=ceiling)
    return {
        "recorded": {
            "execution_id": body.execution_id,
            "artifact_name": body.artifact_name,
            "bytes": body.bytes,
        },
        "evicted": evicted,
        "cache_bytes": get_cloud_cache_total_bytes(conn),
    }


@app.post("/api/cloud-sync/cache/touch")
def cloud_sync_cache_touch(body: CloudCacheRecordBody):
    """Bump the last-accessed timestamp on a cache entry (keeps it hot in LRU)."""
    conn = _get_db()
    touch_cloud_cache_entry(conn, body.execution_id, body.artifact_name)
    return {"touched": True}


@app.get("/api/cloud-sync/cache/{execution_id}/{artifact_name}")
def cloud_sync_cache_get(execution_id: str, artifact_name: str):
    """Return cache metadata for a specific (execution_id, artifact_name) pair."""
    conn = _get_db()
    entry = get_cloud_cache_entry(conn, execution_id, artifact_name)
    if entry is None:
        raise HTTPException(404, "not cached")
    return entry


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
    register: bool = False  # default False so the OS step is explicit
    port: Optional[int] = None


@app.get("/api/service/status")
def service_status():
    """Return whether the daemon unit file is installed and its path."""
    return {
        "installed": _service_manager.is_installed(),
        "unit_path": str(_service_manager.unit_path()),
        "platform": sys.platform,
    }


@app.post("/api/service/install")
def service_install(body: ServiceInstallBody = ServiceInstallBody()):
    """Render the platform unit template and write it to the install path.

    ``register=True`` additionally asks the OS service manager to enable the
    unit at login (launchctl / systemctl / schtasks).
    """
    try:
        path = _service_manager.install(port=body.port, register=body.register)
    except Exception as exc:  # registration failure
        raise HTTPException(500, f"Service install failed: {exc}")
    return {"installed": True, "unit_path": str(path)}


@app.post("/api/service/uninstall")
def service_uninstall(body: ServiceInstallBody = ServiceInstallBody()):
    """Remove the unit file; optionally deregister with the OS first."""
    try:
        removed = _service_manager.uninstall(deregister=body.register)
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


def close_db() -> None:
    """Close the shared sqlite connection, if open."""
    global _shared_conn, _db_initialized
    if _shared_conn is not None:
        try:
            _shared_conn.close()
        except Exception:
            pass
        _shared_conn = None
        _db_initialized = False


# ---------------------------------------------------------------------------
# Entrypoint
# ---------------------------------------------------------------------------

def main():
    import uvicorn
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8742
    create_app()
    print(f"{APP_NAME} v{APP_VERSION}")
    uvicorn.run(app, host="127.0.0.1", port=port)


if __name__ == "__main__":
    main()
