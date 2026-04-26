"""APScheduler wire-up, worker callable, and reaper for ``resmon-cloud``.

IMPL-32 deliverables:

* :func:`build_jobstore` — SQLAlchemyJobStore against ``config.database_url``.
* :func:`build_scheduler` — AsyncIOScheduler with ``misfire_grace_time=3600``
  and the SQLAlchemy jobstore (production), or any injected pair
  (tests — typically BackgroundScheduler + MemoryJobStore for synchronous
  ``TestClient`` pytest harnesses).
* :class:`WorkerContext` — stores the app-scoped handles (stores, KMS,
  credential store, sweep runner) the job function needs at fire time.
  Registered via :func:`register_worker_context` keyed on a string id; the
  top-level :func:`run_routine_job` entrypoint (importable by APScheduler's
  SQLAlchemy jobstore, which pickles a module-qualified reference) looks it
  up on invocation.
* :func:`run_routine_job` — top-level worker callable with the signature
  required by §10.1: ``args = (user_id, routine_id, execution_id)``. Loads
  credentials, decrypts them, builds the ``ephemeral_credentials`` dict, and
  hands off to the configured :class:`SweepRunner`.
* :func:`reap_stuck_executions` — five-minute reaper that marks ``running``
  rows untouched for more than ``threshold_seconds`` (default 600) as
  ``failed`` with ``cancel_reason='node_restart'`` (§10.4 V-E2).
* :func:`default_sweep_runner` — wraps :class:`SweepEngine` against a
  temporary SQLite database; returns an ``{artifact_uri, stats}`` dict.

Scheduler lifecycle (start / shutdown) is owned by the FastAPI app's
startup and shutdown hooks, which are added when the service is deployed
for real. The hermetic pytest harness drives the scheduler explicitly.
"""

from __future__ import annotations

import logging
import uuid
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from threading import RLock
from typing import Any, Callable, Dict, Optional, Protocol

from .config import CloudConfig


logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# Jobstore + scheduler construction
# ---------------------------------------------------------------------------


_scheduler: Optional[Any] = None


def build_jobstore(config: CloudConfig):
    """Return a SQLAlchemyJobStore pointed at ``config.database_url``."""
    try:
        from apscheduler.jobstores.sqlalchemy import SQLAlchemyJobStore
    except ModuleNotFoundError as exc:  # pragma: no cover - optional dep
        raise RuntimeError(
            "apscheduler is required to build the cloud jobstore. "
            "Install with `pip install apscheduler`."
        ) from exc
    return SQLAlchemyJobStore(url=config.database_url)


def build_scheduler(
    config: CloudConfig,
    *,
    jobstore: Any = None,
    scheduler_cls: Any = None,
    executor: Any = None,
) -> Any:
    """Construct and return an APScheduler instance per §10.1.

    Defaults to :class:`AsyncIOScheduler` + :class:`SQLAlchemyJobStore` with
    ``misfire_grace_time=3600``. Tests override ``scheduler_cls`` with
    :class:`BackgroundScheduler` and ``jobstore`` with ``MemoryJobStore`` to
    keep the pytest harness synchronous and hermetic.
    """
    try:
        from apscheduler.schedulers.asyncio import AsyncIOScheduler
    except ModuleNotFoundError as exc:  # pragma: no cover
        raise RuntimeError("apscheduler is required") from exc

    chosen_cls = scheduler_cls or AsyncIOScheduler
    chosen_store = jobstore if jobstore is not None else build_jobstore(config)

    kwargs: Dict[str, Any] = {
        "jobstores": {"default": chosen_store},
        "job_defaults": {
            "coalesce": True,
            "max_instances": 1,
            "misfire_grace_time": 3600,
        },
    }
    if executor is not None:
        kwargs["executors"] = {"default": executor}
    return chosen_cls(**kwargs)


def get_scheduler() -> Optional[Any]:
    """Return the process-wide APScheduler instance, if one has been started."""
    return _scheduler


def start_scheduler(scheduler: Any) -> None:
    """Register a constructed scheduler as the process-wide instance."""
    global _scheduler
    _scheduler = scheduler


def reset_scheduler_for_testing() -> None:
    global _scheduler
    _scheduler = None


# ---------------------------------------------------------------------------
# Worker context registry
# ---------------------------------------------------------------------------


class SweepRunner(Protocol):
    """Callable shape: run the sweep pipeline and return its artefacts."""

    def __call__(
        self,
        *,
        routine_parameters: dict,
        ephemeral_credentials: dict,
        execution_id: uuid.UUID,
    ) -> dict:
        ...


@dataclass
class WorkerContext:
    """Everything :func:`run_routine_job` needs at fire time."""

    routine_store: Any
    execution_store: Any
    credential_store: Any
    kms_client: Any
    sweep_runner: Any
    aad_fn: Callable[[uuid.UUID, str], bytes] = field(
        default=lambda uid, key: f"{uid}:{key}".encode("utf-8")
    )
    #: Optional REDIS_URL (from :class:`CloudConfig`). When set the
    #: IMPL-33 per-user token bucket uses a Redis backend; otherwise the
    #: in-memory backend is used (still keyed per user / repo).
    redis_url: Optional[str] = None
    #: Optional explicit per-repo ``(capacity, refill_per_sec)`` overrides.
    repo_rate_limits: Optional[Dict[str, Any]] = None
    #: IMPL-34 (§11.2) artifact uploader.  When set, after a successful
    #: sweep any ``{name: path_or_bytes}`` entries in the runner's
    #: ``result['artifact_files']`` dict are pushed to the object store
    #: via this callable and the resulting URIs are stored on the
    #: ``executions`` row (``artifact_uri`` = the bucket prefix).  The
    #: default is ``None`` for local-pytest harnesses that exercise the
    #: worker without an object store.
    artifact_uploader: Optional[Callable[..., Dict[str, str]]] = None
    #: IMPL-39 §13 kill-switch. When True, every fired job short-circuits
    #: to ``cancelled / cancel_reason='globally_disabled'`` before any
    #: upstream contact or credential decryption.
    global_execution_disable: bool = False
    #: IMPL-39 §13 Prometheus metrics sink (optional). When present,
    #: terminal-status counters are bumped at each job completion.
    metrics: Optional[Any] = None


_CONTEXTS: Dict[str, WorkerContext] = {}
_CONTEXT_LOCK = RLock()


def register_worker_context(key: str, ctx: WorkerContext) -> None:
    """Register a :class:`WorkerContext` under ``key``.

    ``key`` is persisted in each APScheduler job's kwargs (``context_key``).
    Using a string key (not a live object reference) keeps the job
    pickleable by :class:`SQLAlchemyJobStore`.
    """
    with _CONTEXT_LOCK:
        _CONTEXTS[key] = ctx


def unregister_worker_context(key: str) -> None:
    with _CONTEXT_LOCK:
        _CONTEXTS.pop(key, None)


def get_worker_context(key: str) -> WorkerContext:
    with _CONTEXT_LOCK:
        ctx = _CONTEXTS.get(key)
    if ctx is None:
        raise RuntimeError(
            f"No worker context registered for key={key!r}; "
            "call register_worker_context() before scheduling jobs."
        )
    return ctx


# ---------------------------------------------------------------------------
# Worker entrypoint
# ---------------------------------------------------------------------------


def run_routine_job(
    user_id: str,
    routine_id: Optional[str] = None,
    execution_id: Optional[str] = None,
    *,
    context_key: str,
) -> None:
    """Top-level APScheduler job callable.

    §10.1 prescribes ``args = (user_id, routine_id, execution_id)``. This
    function is module-level (hence pickleable by APScheduler's SQLAlchemy
    jobstore) and resolves the live handles via :func:`get_worker_context`.
    """
    uid = uuid.UUID(user_id)
    rid = uuid.UUID(routine_id) if routine_id else None
    eid: Optional[uuid.UUID] = uuid.UUID(execution_id) if execution_id else None

    ctx = get_worker_context(context_key)

    # Lazily import here so ``cloud.crypto`` (and ``nacl``) are only loaded
    # in processes that actually run jobs — the reaper has no need for them.
    from .crypto import Envelope, decrypt_credential
    from .executions import cloud_progress_store

    logger.info(
        "Cloud job fired: user_id=%s routine_id=%s execution_id=%s",
        uid, rid, eid,
    )

    routine = ctx.routine_store.get(uid, rid) if rid else None
    if rid is not None and routine is None:
        logger.error(
            "Cloud job aborting: routine %s not found for user %s", rid, uid
        )
        return

    # Either re-use a pre-allocated execution row (run-now path) or insert a
    # fresh ``running`` row now.
    if eid is None:
        exec_row = ctx.execution_store.insert(
            uid, rid, status="running",
        )
        eid = exec_row.execution_id
    else:
        ctx.execution_store.update(eid, status="running")

    cloud_progress_store.register(str(eid))
    cloud_progress_store.emit(
        str(eid),
        {
            "type": "execution_start",
            "execution_id": str(eid),
            "routine_id": str(rid) if rid else None,
            "timestamp": datetime.now(timezone.utc).isoformat(),
        },
    )

    # IMPL-39 §13: honor the GLOBAL_EXECUTION_DISABLE kill-switch *before*
    # any upstream contact or credential decryption. The execution row is
    # short-circuited to ``cancelled`` with a documented cancel_reason.
    if getattr(ctx, "global_execution_disable", False):
        logger.warning(
            "Cloud job aborted by GLOBAL_EXECUTION_DISABLE: "
            "user_id=%s execution_id=%s",
            uid, eid,
        )
        ctx.execution_store.update(
            eid,
            status="cancelled",
            finished_at=datetime.now(timezone.utc),
            cancel_reason="globally_disabled",
        )
        cloud_progress_store.emit(
            str(eid),
            {
                "type": "complete",
                "status": "cancelled",
                "cancel_reason": "globally_disabled",
                "execution_id": str(eid),
                "timestamp": datetime.now(timezone.utc).isoformat(),
            },
        )
        cloud_progress_store.mark_complete(str(eid))
        metrics = getattr(ctx, "metrics", None)
        if metrics is not None:
            metrics.record_execution_terminal("cancelled")
        return

    try:
        ephemeral_credentials = _decrypt_credentials_for_user(
            ctx, uid, Envelope, decrypt_credential
        )
    except Exception as exc:
        logger.exception(
            "Credential decryption failed for user_id=%s execution_id=%s",
            uid, eid,
        )
        _mark_failed(ctx, eid, exc, cloud_progress_store)
        return

    routine_params = dict(routine.parameters) if routine is not None else {}

    # IMPL-33 §10.3: install the per-user polite User-Agent + Redis token
    # bucket hook for the duration of this execution. Every outbound
    # ``safe_request`` from the sweep engine's API clients will consult
    # the hook before issuing its upstream HTTP call.
    from .rate_limit import build_hook_for_user, use_cloud_hook

    cloud_hook = build_hook_for_user(
        str(uid),
        redis_url=ctx.redis_url,
        repo_limits=ctx.repo_rate_limits,
    )

    try:
        with use_cloud_hook(cloud_hook):
            result = ctx.sweep_runner(
                routine_parameters=routine_params,
                ephemeral_credentials=ephemeral_credentials,
                execution_id=eid,
            )
    except Exception as exc:
        logger.exception("Sweep runner failed for execution_id=%s", eid)
        _mark_failed(ctx, eid, exc, cloud_progress_store)
        return

    artifact_uri = result.get("artifact_uri") if isinstance(result, dict) else None
    stats = result.get("stats") if isinstance(result, dict) else None

    # IMPL-34 §11.2: push report.md / run.log / progress.json to the
    # object store under ``<user_id>/<execution_id>/``. ``artifact_uri``
    # on the DB row points to the prefix; individual artifacts are
    # fetched via ``GET /api/v2/artifacts/{exec_id}/{name}``.
    artifact_files = (
        result.get("artifact_files") if isinstance(result, dict) else None
    )
    if artifact_files and ctx.artifact_uploader is not None:
        try:
            uploaded = ctx.artifact_uploader(
                user_id=uid, exec_id=eid, artifact_files=artifact_files,
            )
        except Exception as exc:
            logger.exception(
                "Artifact upload failed for execution_id=%s; marking failed", eid
            )
            _mark_failed(ctx, eid, exc, cloud_progress_store)
            return
        if uploaded and not artifact_uri:
            # Prefix URI derived from any uploaded key — all keys share
            # the same ``<user>/<exec>/`` parent by construction.
            sample = next(iter(uploaded.values()))
            artifact_uri = sample.rsplit("/", 1)[0] + "/"

    ctx.execution_store.update(
        eid,
        status="succeeded",
        finished_at=datetime.now(timezone.utc),
        artifact_uri=artifact_uri,
        stats=stats,
    )
    cloud_progress_store.emit(
        str(eid),
        {
            "type": "complete",
            "status": "succeeded",
            "execution_id": str(eid),
            "artifact_uri": artifact_uri,
            "timestamp": datetime.now(timezone.utc).isoformat(),
        },
    )
    cloud_progress_store.mark_complete(str(eid))
    logger.info(
        "Cloud job succeeded: execution_id=%s artifact_uri=%s",
        eid, artifact_uri,
    )
    metrics = getattr(ctx, "metrics", None)
    if metrics is not None:
        metrics.record_execution_terminal("succeeded")


def _mark_failed(ctx, eid: uuid.UUID, exc: BaseException, store) -> None:
    ctx.execution_store.update(
        eid,
        status="failed",
        finished_at=datetime.now(timezone.utc),
        stats={"error": f"{type(exc).__name__}: {exc}"},
    )
    metrics = getattr(ctx, "metrics", None)
    if metrics is not None:
        metrics.record_execution_terminal("failed")
    store.emit(
        str(eid),
        {
            "type": "complete",
            "status": "failed",
            "execution_id": str(eid),
            "error": f"{type(exc).__name__}: {exc}",
            "timestamp": datetime.now(timezone.utc).isoformat(),
        },
    )
    store.mark_complete(str(eid))


def _decrypt_credentials_for_user(
    ctx: WorkerContext,
    user_id: uuid.UUID,
    envelope_cls,
    decrypt_fn,
) -> dict:
    """Materialise the ``ephemeral_credentials`` dict from stored envelopes.

    Requires the credential store to expose ``list_keys`` + ``read_row``.
    If either is absent (e.g. a stub store with no decryption path) an
    empty dict is returned — the worker treats that as "no credentials
    available" and lets the sweep engine skip any key-gated repository.
    """
    reader = getattr(ctx.credential_store, "read_row", None)
    lister = getattr(ctx.credential_store, "list_keys", None)
    if reader is None or lister is None:
        return {}
    out: dict[str, str] = {}
    for key_name in lister(user_id):
        row = reader(user_id, key_name)
        if row is None:
            continue
        envelope = envelope_cls(
            ciphertext=row.ciphertext,
            nonce=row.nonce,
            wrapped_dek=row.wrapped_dek,
            kek_id=row.kek_id,
        )
        out[key_name] = decrypt_fn(
            envelope, ctx.kms_client, aad=ctx.aad_fn(user_id, key_name),
        )
    return out


# ---------------------------------------------------------------------------
# Reaper
# ---------------------------------------------------------------------------


def reap_stuck_executions(
    execution_store,
    *,
    threshold_seconds: int = 600,
    cancel_reason: str = "node_restart",
) -> list[uuid.UUID]:
    """Mark ``running`` rows untouched for > ``threshold_seconds`` as failed.

    Called every five minutes by :func:`schedule_reaper`. Returns the list
    of execution IDs that were marked failed — handy for the V-E2 pytest.
    """
    threshold = timedelta(seconds=threshold_seconds)
    reaped = execution_store.reap_stuck(
        threshold=threshold, cancel_reason=cancel_reason,
    )
    if reaped:
        logger.warning(
            "Reaper marked %d stuck execution(s) as failed "
            "(cancel_reason=%s): %s",
            len(reaped), cancel_reason, [str(r) for r in reaped],
        )
    return reaped


def schedule_reaper(
    scheduler,
    execution_store,
    *,
    interval_seconds: int = 300,
    threshold_seconds: int = 600,
    job_id: str = "resmon-cloud-reaper",
) -> None:
    """Register the reaper as a recurring scheduler job (§10.4 V-E2)."""
    from apscheduler.triggers.interval import IntervalTrigger

    scheduler.add_job(
        reap_stuck_executions,
        trigger=IntervalTrigger(seconds=interval_seconds),
        kwargs={
            "execution_store": execution_store,
            "threshold_seconds": threshold_seconds,
        },
        id=job_id,
        replace_existing=True,
        jobstore="default",
    )


# ---------------------------------------------------------------------------
# Default sweep runner
# ---------------------------------------------------------------------------


def default_sweep_runner(
    *,
    routine_parameters: dict,
    ephemeral_credentials: dict,
    execution_id: uuid.UUID,
) -> dict:  # pragma: no cover - heavyweight, exercised only in live deploys
    """Wrap :class:`SweepEngine` against a temp SQLite DB and return artefacts.

    The cloud worker re-uses the local two-phase sweep engine verbatim; the
    cloud ``execution_id`` (UUID) is distinct from the SQLite-scoped sweep
    exec_id (int) returned by :meth:`SweepEngine.prepare_execution`.
    """
    import sqlite3
    import tempfile
    from pathlib import Path

    from implementation_scripts.database import init_db  # type: ignore[import-not-found]
    from implementation_scripts.sweep_engine import SweepEngine  # type: ignore[import-not-found]
    from implementation_scripts.llm_factory import build_llm_client_from_settings  # type: ignore[import-not-found]
    from implementation_scripts.progress import progress_store as _local_progress_store  # type: ignore[import-not-found]

    tmp_dir = Path(tempfile.mkdtemp(prefix=f"resmon-cloud-{execution_id}-"))
    db_path = tmp_dir / "run.sqlite"
    conn = sqlite3.connect(str(db_path))
    try:
        init_db(conn=conn)
        engine = SweepEngine(conn, dict(routine_parameters))
        repositories = list(
            routine_parameters.get("repositories")
            or routine_parameters.get("repos")
            or []
        )
        query_params = dict(routine_parameters)
        query_params.setdefault("ephemeral_credentials", ephemeral_credentials)
        sweep_exec_id = engine.prepare_execution(
            execution_type="cloud_sweep",
            repositories=repositories,
            query_params=query_params,
        )

        # IMPL-AI8 (cloud parity): build the LLM client from routine
        # parameters (cloud has no per-user ``app_settings``; routine
        # ``parameters`` is the canonical source). Factory failures fall
        # back to a no-AI run with a ``log_entry`` diagnostic.
        merged_ai = {
            "ai_provider": routine_parameters.get("ai_provider"),
            "ai_model": routine_parameters.get("ai_model"),
            "ai_local_model": routine_parameters.get("ai_local_model"),
            "ai_local_endpoint": routine_parameters.get("ai_local_endpoint"),
            "ai_custom_base_url": routine_parameters.get("ai_custom_base_url"),
            "ai_summary_length": routine_parameters.get("ai_summary_length"),
            "ai_tone": routine_parameters.get("ai_tone"),
            "ai_extraction_goals": routine_parameters.get("ai_extraction_goals"),
        }
        ai_enabled = bool(routine_parameters.get("ai_enabled"))
        _length = str(merged_ai.get("ai_summary_length") or "").strip() or "standard"
        _tone = str(merged_ai.get("ai_tone") or "").strip() or "technical"
        engine.config["ai_prompt_params"] = {
            "length": _length,
            "tone": _tone,
            **(
                {"extraction_goals": str(merged_ai["ai_extraction_goals"])}
                if merged_ai.get("ai_extraction_goals") else {}
            ),
        }
        if ai_enabled:
            engine.config["ai_enabled"] = True
            try:
                client = build_llm_client_from_settings(
                    merged_ai, ephemeral=ephemeral_credentials or None,
                )
            except ValueError as exc:
                _local_progress_store.emit(sweep_exec_id, {
                    "type": "log_entry",
                    "level": "warn",
                    "message": f"AI skipped: {exc}",
                    "timestamp": datetime.now(timezone.utc).isoformat(),
                })
                client = None
            if client is None:
                provider = str(merged_ai.get("ai_provider") or "").strip().lower()
                reason = (
                    "AI skipped: provider not configured"
                    if not provider else "AI skipped: API key missing"
                )
                _local_progress_store.emit(sweep_exec_id, {
                    "type": "log_entry",
                    "level": "warn",
                    "message": reason,
                    "timestamp": datetime.now(timezone.utc).isoformat(),
                })
            engine.llm_client = client

        result = engine.run_prepared(sweep_exec_id)
    finally:
        conn.close()

    artifact_uri = result.get("report_path") if isinstance(result, dict) else None
    return {
        "artifact_uri": artifact_uri,
        "stats": {
            "result_count": (
                result.get("result_count") if isinstance(result, dict) else None
            ),
            "new_count": (
                result.get("new_count") if isinstance(result, dict) else None
            ),
        },
    }
