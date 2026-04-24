# resmon_scripts/implementation_scripts/sweep_engine.py
"""Sweep engine: orchestrates query → normalize → dedup → report pipeline."""

import json
import logging
import sqlite3
import threading
import time
from dataclasses import asdict
from pathlib import Path
from typing import Optional

from .api_registry import get_client, list_repositories
from .config import REPORTS_DIR
from .credential_manager import get_credential_for
from .database import (
    insert_execution,
    update_execution_status,
    update_current_stage,
    link_execution_document,
    get_document_by_source,
    get_execution_by_id,
    get_setting,
)
from .logger import TaskLogger
from .normalizer import normalize_result, validate_result, deduplicate_batch
from .progress import progress_store
from .report_generator import generate_report, save_report
from .utils import now_iso

logger = logging.getLogger(__name__)


class _ExecutionCancelled(Exception):
    """Raised internally when cooperative cancellation is detected mid-query."""


# Repositories that require an API key in order to return any results.
# Keyed by the repository name as registered in ``api_registry`` and mapped
# to the credential name used by ``credential_manager``.
_REQUIRED_CREDENTIALS: dict[str, str] = {
    "core": "core_api_key",
    "ieee": "ieee_api_key",
    "nasa_ads": "nasa_ads_api_key",
    "springer": "springer_api_key",
}


class SweepEngine:
    """Orchestrates complete sweep/dive workflows from query to report.

    Parameters
    ----------
    db_conn : sqlite3.Connection
        Active database connection (with init_db already applied).
    config : dict
        Query configuration: keywords, date_from, date_to, max_results, etc.
    llm_client : object | None
        Optional LLM client (RemoteLLMClient or LocalLLMClient) for AI summaries.
    """

    def __init__(
        self,
        db_conn: sqlite3.Connection,
        config: dict,
        llm_client=None,
    ) -> None:
        self.db = db_conn
        self.config = config
        self.llm_client = llm_client

    # ------------------------------------------------------------------
    # Public API
    # ------------------------------------------------------------------

    def execute_dive(self, repository: str, query_params: dict) -> dict:
        """Single-repo Targeted Deep Dive.

        Returns dict with execution_id, result_count, new_count, report_path, log_path.
        """
        return self._run(
            execution_type="deep_dive",
            repositories=[repository],
            query_params=query_params,
        )

    def execute_sweep(self, repositories: list[str], query_params: dict) -> dict:
        """Multi-repo Broad Deep Sweep.

        Returns dict with execution_id, result_count, new_count, report_path, log_path.
        """
        return self._run(
            execution_type="deep_sweep",
            repositories=repositories,
            query_params=query_params,
        )

    def prepare_execution(
        self,
        execution_type: str,
        repositories: list[str],
        query_params: dict,
    ) -> int:
        """Create the execution record and return exec_id without running the pipeline.

        This is the first phase of two-phase execution.  The caller is
        responsible for calling ``run_prepared(exec_id)`` afterwards (typically
        in a background thread).
        """
        start_time = now_iso()
        # Persist repositories inside the stored parameters so the execution
        # record has a self-contained description of what was run.
        query_params = dict(query_params)
        query_params.setdefault("repositories", list(repositories))
        params_json = json.dumps(query_params, default=str)

        exec_id = insert_execution(self.db, {
            "execution_type": execution_type,
            "parameters": params_json,
            "start_time": start_time,
        })

        # Stash metadata so run_prepared can retrieve it
        self._prepared: dict = {
            "exec_id": exec_id,
            "execution_type": execution_type,
            "repositories": repositories,
            "query_params": query_params,
            "start_time": start_time,
        }
        return exec_id

    def run_prepared(self, exec_id: int) -> dict:
        """Run the full pipeline for a previously prepared execution.

        This is the second phase of two-phase execution.  Emits progress
        events via ``progress_store`` and checks cancellation at every
        major checkpoint.
        """
        prep = getattr(self, "_prepared", None)
        if not prep or prep["exec_id"] != exec_id:
            # Recover metadata from DB if prepare was not called in this instance
            row = get_execution_by_id(self.db, exec_id)
            if not row:
                raise ValueError(f"No execution record for id={exec_id}")
            prep = {
                "exec_id": exec_id,
                "execution_type": row["execution_type"],
                "repositories": json.loads(row["parameters"]).get("repositories", []),
                "query_params": json.loads(row["parameters"]),
                "start_time": row["start_time"],
            }

        return self._run(
            execution_type=prep["execution_type"],
            repositories=prep["repositories"],
            query_params=prep["query_params"],
            exec_id=exec_id,
            start_time=prep["start_time"],
        )

    # ------------------------------------------------------------------
    # Internal pipeline
    # ------------------------------------------------------------------

    def _run(
        self,
        execution_type: str,
        repositories: list[str],
        query_params: dict,
        *,
        exec_id: int | None = None,
        start_time: str | None = None,
    ) -> dict:
        if start_time is None:
            start_time = now_iso()
        # Ensure repositories are persisted alongside the rest of the params
        # regardless of whether prepare_execution was used.
        query_params = dict(query_params)
        query_params.setdefault("repositories", list(repositories))
        params_json = json.dumps(query_params, default=str)
        wall_start = time.monotonic()

        # 1. Create execution record (skip if already prepared)
        if exec_id is None:
            exec_id = insert_execution(self.db, {
                "execution_type": execution_type,
                "parameters": params_json,
                "start_time": start_time,
            })

        store = progress_store

        # Emit execution_start
        store.emit(exec_id, {
            "type": "execution_start",
            "execution_id": exec_id,
            "execution_type": execution_type,
            "repositories": repositories,
            "total_repos": len(repositories),
            "timestamp": now_iso(),
        })

        # 2. Set up task logger
        ts_slug = start_time.replace(":", "").replace("-", "")[:15]
        log_filename = f"log_{execution_type}_{exec_id}_{ts_slug}.txt"
        log_path = REPORTS_DIR / "logs" / log_filename
        task_log = TaskLogger(
            log_path,
            operation_type=execution_type,
            execution_id=exec_id,
            params=query_params,
        )

        all_results = []
        missing_key_repos: list[str] = []
        repo_errors: list[dict] = []
        try:
            # 3. Query each repository
            store.emit(exec_id, {
                "type": "stage",
                "stage": "querying",
                "message": "Querying repositories...",
                "timestamp": now_iso(),
            })
            update_current_stage(self.db, exec_id, "querying")

            for i, repo_name in enumerate(repositories):
                # Cancellation checkpoint
                if store.should_cancel(exec_id):
                    return self._handle_cancellation(exec_id, task_log, all_results, wall_start)

                store.emit(exec_id, {
                    "type": "repo_start",
                    "repository": repo_name,
                    "index": i + 1,
                    "total_repos": len(repositories),
                    "timestamp": now_iso(),
                })

                task_log.log(f"Querying repository: {repo_name}")
                # Detect missing API keys for repositories that require one.
                cred_name = _REQUIRED_CREDENTIALS.get(repo_name)
                if cred_name and not get_credential_for(exec_id, cred_name):
                    missing_key_repos.append(repo_name)
                    task_log.log(
                        f"  {repo_name}: WARNING — no API key configured "
                        f"(credential '{cred_name}'); this repository will return 0 results"
                    )
                    store.emit(exec_id, {
                        "type": "repo_skipped_missing_key",
                        "repository": repo_name,
                        "credential_name": cred_name,
                        "index": i + 1,
                        "total_repos": len(repositories),
                        "timestamp": now_iso(),
                    })
                try:
                    client = get_client(repo_name)
                    # Thread the exec_id onto the client so that any
                    # ephemeral (per-execution) credentials are honored by
                    # credential_manager.get_credential_for.
                    try:
                        client._exec_id = exec_id
                    except Exception:
                        # Non-fatal: client may not inherit from BaseAPIClient.
                        pass
                    store.emit(exec_id, {
                        "type": "query_progress",
                        "repository": repo_name,
                        "phase": "search_start",
                        "query": query_params.get("query", ""),
                        "max_results": query_params.get("max_results", 100),
                        "timestamp": now_iso(),
                    })
                    results = self._search_with_heartbeat(
                        client=client,
                        repo_name=repo_name,
                        exec_id=exec_id,
                        query_params=query_params,
                    )
                    store.emit(exec_id, {
                        "type": "query_progress",
                        "repository": repo_name,
                        "phase": "search_done",
                        "result_count": len(results),
                        "timestamp": now_iso(),
                    })
                    task_log.log(f"  {repo_name}: {len(results)} results")
                    all_results.extend(results)

                    store.emit(exec_id, {
                        "type": "repo_done",
                        "repository": repo_name,
                        "index": i + 1,
                        "total_repos": len(repositories),
                        "result_count": len(results),
                        "timestamp": now_iso(),
                    })
                except _ExecutionCancelled:
                    # Mark the in-flight repo as errored for UI clarity, then
                    # short-circuit to the cancellation handler.
                    store.emit(exec_id, {
                        "type": "repo_error",
                        "repository": repo_name,
                        "index": i + 1,
                        "total_repos": len(repositories),
                        "error": "cancelled by user",
                        "timestamp": now_iso(),
                    })
                    task_log.log(f"  {repo_name}: CANCELLED by user")
                    return self._handle_cancellation(exec_id, task_log, all_results, wall_start)
                except Exception as exc:
                    task_log.log(f"  {repo_name}: ERROR - {exc}")
                    logger.warning("Query failed for %s: %s", repo_name, exc)
                    repo_errors.append({"repository": repo_name, "error": str(exc)})
                    store.emit(exec_id, {
                        "type": "repo_error",
                        "repository": repo_name,
                        "index": i + 1,
                        "total_repos": len(repositories),
                        "error": str(exc),
                        "timestamp": now_iso(),
                    })

            store.emit(exec_id, {
                "type": "log_entry",
                "message": f"Total raw results: {len(all_results)}",
                "timestamp": now_iso(),
            })
            task_log.log(f"Total raw results: {len(all_results)}")

            # 4. Normalize + deduplicate + insert
            # Cancellation checkpoint
            if store.should_cancel(exec_id):
                return self._handle_cancellation(exec_id, task_log, all_results, wall_start)

            store.emit(exec_id, {
                "type": "stage",
                "stage": "dedup",
                "message": f"Deduplicating {len(all_results)} results...",
                "timestamp": now_iso(),
            })
            update_current_stage(self.db, exec_id, "dedup")

            dedup_stats = deduplicate_batch(self.db, all_results)
            task_log.log(
                f"Dedup stats: total={dedup_stats['total']}, "
                f"new={dedup_stats['new']}, duplicates={dedup_stats['duplicates']}, "
                f"invalid={dedup_stats['invalid']}"
            )

            store.emit(exec_id, {
                "type": "dedup_stats",
                "total": dedup_stats["total"],
                "new": dedup_stats["new"],
                "duplicates": dedup_stats["duplicates"],
                "invalid": dedup_stats["invalid"],
                "timestamp": now_iso(),
            })

            # 5. Link documents to execution
            store.emit(exec_id, {
                "type": "stage",
                "stage": "linking",
                "message": "Linking documents to execution...",
                "timestamp": now_iso(),
            })
            update_current_stage(self.db, exec_id, "linking")

            new_count = 0
            total_to_link = len(all_results)
            link_emit_every = max(1, total_to_link // 20) if total_to_link else 1
            for link_idx, result in enumerate(all_results):
                nr = normalize_result(result)
                if not validate_result(nr):
                    continue
                doc_row = get_document_by_source(
                    self.db, nr.source_repository, nr.external_id
                )
                if doc_row:
                    is_new = doc_row.get("first_seen_at", "") >= start_time
                    link_execution_document(self.db, exec_id, doc_row["id"], is_new=is_new)
                    if is_new:
                        new_count += 1
                if total_to_link and (link_idx + 1) % link_emit_every == 0:
                    store.emit(exec_id, {
                        "type": "link_progress",
                        "processed": link_idx + 1,
                        "total": total_to_link,
                        "new_count": new_count,
                        "timestamp": now_iso(),
                    })

            # 6. Generate report
            store.emit(exec_id, {
                "type": "stage",
                "stage": "reporting",
                "message": "Generating report...",
                "timestamp": now_iso(),
            })
            update_current_stage(self.db, exec_id, "reporting")

            report_docs = self._build_report_docs(all_results)

            # 6b. Optional AI summarization — runs before report generation
            # so that per-document summaries (and the model identity) can
            # be embedded directly in the Markdown report. ``report_docs``
            # is mutated in place with an ``ai_summary`` key per entry.
            ai_model_label: Optional[str] = None
            if self.llm_client and self.config.get("ai_enabled") and report_docs:
                if store.should_cancel(exec_id):
                    return self._handle_cancellation(exec_id, task_log, all_results, wall_start)

                store.emit(exec_id, {
                    "type": "stage",
                    "stage": "summarizing",
                    "message": "Running AI summarization...",
                    "timestamp": now_iso(),
                })
                update_current_stage(self.db, exec_id, "summarizing")
                store.emit(exec_id, {
                    "type": "ai_start",
                    "timestamp": now_iso(),
                })

                try:
                    task_log.log("Running AI summarization...")
                    from .summarizer import SummarizationPipeline
                    prompt_params = self.config.get("ai_prompt_params") or {}
                    pipeline = SummarizationPipeline(
                        self.llm_client,
                        prompt_params=prompt_params,
                    )

                    # Build the text each document is summarized from.
                    # Title + abstract is the only body text we reliably
                    # have at this point in the pipeline; full-text PDF
                    # extraction happens later (Phase 2E).
                    doc_texts: list[str] = []
                    for doc in report_docs:
                        title = str(doc.get("title") or "").strip()
                        abstract = str(doc.get("abstract") or "").strip()
                        if title and abstract:
                            doc_texts.append(f"Title: {title}\n\nAbstract: {abstract}")
                        else:
                            doc_texts.append(title or abstract or "")

                    store.emit(exec_id, {
                        "type": "ai_progress",
                        "message": f"Summarizing {len(doc_texts)} documents...",
                        "completed": 0,
                        "total": len(doc_texts),
                        "timestamp": now_iso(),
                    })

                    # Per-document summarization loop. We intentionally do
                    # *not* call ``pipeline.summarize_batch`` here so that
                    # (a) cancellation can be honored between documents and
                    # (b) the UI can display granular per-article progress
                    # for long-running AI summarization jobs.
                    total_chars = 0
                    cancelled_mid_summary = False
                    total_docs = len(doc_texts)
                    for idx, (doc, text) in enumerate(zip(report_docs, doc_texts)):
                        if store.should_cancel(exec_id):
                            cancelled_mid_summary = True
                            task_log.log(
                                f"AI summarization cancelled after "
                                f"{idx}/{total_docs} documents."
                            )
                            break
                        try:
                            summary = pipeline.summarize_document(text)
                        except Exception as per_doc_exc:
                            # Failing one paper should not abort the whole
                            # batch; the user still wants summaries for the
                            # others. Log and continue.
                            task_log.log(
                                f"AI summary failed for document "
                                f"{idx + 1}/{total_docs} "
                                f"({str(doc.get('title') or '')[:60]}): "
                                f"{per_doc_exc}"
                            )
                            logger.warning(
                                "AI summary error on document %d: %s",
                                idx + 1, per_doc_exc,
                            )
                            summary = ""
                        if isinstance(summary, str) and summary.strip():
                            doc["ai_summary"] = summary.strip()
                            total_chars += len(summary)

                        completed = idx + 1
                        # Log-level progress every doc so the user can
                        # follow along in the Live Activity Log.
                        title_preview = str(doc.get("title") or "")[:80]
                        task_log.log(
                            f"AI summary {completed}/{total_docs}"
                            + (f": {title_preview}" if title_preview else "")
                        )
                        store.emit(exec_id, {
                            "type": "ai_progress",
                            "message": (
                                f"Summarizing document "
                                f"{completed}/{total_docs}..."
                            ),
                            "completed": completed,
                            "total": total_docs,
                            "timestamp": now_iso(),
                        })

                    if cancelled_mid_summary:
                        return self._handle_cancellation(
                            exec_id, task_log, all_results, wall_start,
                        )

                    # Provider/model label for the report header.
                    provider = str(prompt_params.get("_audit_provider") or "").strip()
                    if not provider:
                        provider = str(getattr(self.llm_client, "provider", "") or "").strip()
                    model = str(prompt_params.get("_audit_model") or "").strip()
                    if not model:
                        model = str(getattr(self.llm_client, "model", "") or "").strip()
                    if provider or model:
                        ai_model_label = f"{provider or 'unknown'}/{model or 'unknown'}"

                    task_log.log(
                        f"AI summaries produced for "
                        f"{sum(1 for d in report_docs if d.get('ai_summary'))} / "
                        f"{len(report_docs)} documents "
                        f"(total {total_chars} chars)"
                    )
                    store.emit(exec_id, {
                        "type": "ai_done",
                        "summary_length": total_chars,
                        "timestamp": now_iso(),
                    })
                except Exception as exc:
                    task_log.log(f"AI summarization failed: {exc}")
                    logger.warning("AI summarization error: %s", exc)
                    store.emit(exec_id, {
                        "type": "log_entry",
                        "message": f"AI summarization failed: {exc}",
                        "timestamp": now_iso(),
                    })

            report_metadata = {
                "query": query_params.get("query", ""),
                "keywords": query_params.get("keywords"),
                "repositories": list(repositories),
                "missing_key_repos": list(missing_key_repos),
                "date_from": query_params.get("date_from", "N/A"),
                "date_to": query_params.get("date_to", "N/A"),
                "total": dedup_stats["total"],
                "new": dedup_stats["new"],
                "ai_model": ai_model_label,
            }
            report_text = generate_report(report_docs, report_metadata)

            report_filename = f"report_{execution_type}_{exec_id}_{ts_slug}.md"
            report_path = REPORTS_DIR / "markdowns" / report_filename
            save_report(report_text, report_path)
            task_log.log(f"Report saved: {report_path}")

            store.emit(exec_id, {
                "type": "report_saved",
                "report_path": str(report_path),
                "timestamp": now_iso(),
            })

            # 7. Finalize
            store.emit(exec_id, {
                "type": "stage",
                "stage": "finalizing",
                "message": "Finalizing execution...",
                "timestamp": now_iso(),
            })
            update_current_stage(self.db, exec_id, "finalizing")

            end_time = now_iso()
            elapsed = time.monotonic() - wall_start

            # If *every* requested repository failed to produce results due
            # to an upstream or client error, surface the execution as
            # ``failed`` rather than ``completed`` so the Monitor/Results
            # pages and cancel/cleanup paths treat it as an error. When
            # only a subset of repos errored, the execution still
            # ``completed`` but the per-repo error messages remain visible
            # in the task log and as ``repo_error`` progress events.
            all_repos_errored = (
                len(repo_errors) > 0
                and len(repo_errors) == len(repositories)
            )
            final_status = "failed" if all_repos_errored else "completed"
            error_summary: Optional[str] = None
            if all_repos_errored:
                error_summary = "; ".join(
                    f"{e['repository']}: {e['error']}" for e in repo_errors
                )

            update_execution_status(
                self.db, exec_id, final_status,
                end_time=end_time,
                result_count=dedup_stats["total"] - dedup_stats["invalid"],
                new_result_count=dedup_stats["new"],
                log_path=str(log_path),
                result_path=str(report_path),
                error_message=error_summary,
            )
            task_log.finalize(
                status="FAILED" if all_repos_errored else "COMPLETED",
                stats={
                    "total": dedup_stats["total"],
                    "new": dedup_stats["new"],
                    "duplicates": dedup_stats["duplicates"],
                    **({"error": error_summary} if error_summary else {}),
                },
            )

            store.emit(exec_id, {
                "type": "complete",
                "status": final_status,
                "result_count": dedup_stats["total"] - dedup_stats["invalid"],
                "new_count": dedup_stats["new"],
                "elapsed": round(elapsed, 2),
                **({"error": error_summary} if error_summary else {}),
                "timestamp": now_iso(),
            })
            store.mark_complete(exec_id)

            # Auto-backup to cloud if enabled. Runs in a daemon thread so the
            # execution response is not blocked by upload latency. Failures
            # are logged but never raised — auto-backup is advisory.
            self._maybe_auto_backup(exec_id, task_log, report_path, log_path)

            return {
                "execution_id": exec_id,
                "result_count": dedup_stats["total"] - dedup_stats["invalid"],
                "new_count": dedup_stats["new"],
                "report_path": str(report_path),
                "log_path": str(log_path),
            }

        except Exception as exc:
            end_time = now_iso()
            elapsed = time.monotonic() - wall_start
            update_execution_status(
                self.db, exec_id, "failed",
                end_time=end_time,
                error_message=str(exc),
            )
            task_log.finalize(status="FAILED", stats={"error": str(exc)})
            logger.error("Sweep engine error (exec_id=%d): %s", exec_id, exc)

            store.emit(exec_id, {
                "type": "error",
                "error": str(exc),
                "timestamp": now_iso(),
            })
            store.emit(exec_id, {
                "type": "complete",
                "status": "failed",
                "result_count": 0,
                "new_count": 0,
                "elapsed": round(elapsed, 2),
                "timestamp": now_iso(),
            })
            store.mark_complete(exec_id)
            raise

    # ------------------------------------------------------------------
    # Cancellation
    # ------------------------------------------------------------------

    def _search_with_heartbeat(
        self,
        *,
        client,
        repo_name: str,
        exec_id: int,
        query_params: dict,
        heartbeat_interval: float = 2.0,
    ) -> list:
        """Run ``client.search()`` in a worker thread while emitting heartbeat
        progress events every ``heartbeat_interval`` seconds.

        This guarantees that a slow repository query (e.g. paginated bioRxiv
        fetches) still produces visible live-log activity for the frontend
        poller even though the underlying HTTP calls are synchronous.
        """
        store = progress_store
        result_holder: dict = {}

        def _worker() -> None:
            try:
                result_holder["results"] = client.search(
                    query=query_params.get("query", ""),
                    date_from=query_params.get("date_from"),
                    date_to=query_params.get("date_to"),
                    max_results=query_params.get("max_results", 100),
                )
            except BaseException as exc:  # re-raised in caller
                result_holder["error"] = exc

        t = threading.Thread(
            target=_worker, daemon=True, name=f"search-{repo_name}-{exec_id}"
        )
        start = time.monotonic()
        t.start()

        while t.is_alive():
            t.join(timeout=heartbeat_interval)
            if not t.is_alive():
                break
            # Cooperative cancellation: if the user requested cancel while
            # the underlying HTTP call is still in flight, abandon the worker
            # thread (it is a daemon and will exit when its request returns)
            # and raise immediately so the pipeline can tear down.
            if store.should_cancel(exec_id):
                raise _ExecutionCancelled()
            elapsed = time.monotonic() - start
            store.emit(exec_id, {
                "type": "query_progress",
                "repository": repo_name,
                "phase": "searching",
                "message": f"still querying {repo_name} ({elapsed:.0f}s elapsed)",
                "elapsed": round(elapsed, 1),
                "timestamp": now_iso(),
            })

        if "error" in result_holder:
            raise result_holder["error"]
        return result_holder.get("results", [])

    def _maybe_auto_backup(
        self,
        exec_id: int,
        task_log: TaskLogger,
        report_path: Path,
        log_path: Path,
    ) -> None:
        """Fire a Google Drive backup if ``cloud_auto_backup`` is enabled.

        Uploads **only this execution's** artifacts (report + log) under a
        per-execution folder name so the full reports history is not
        re-uploaded on every run. Users who want to mirror the entire
        reports tree can still click "Backup Now" on the Cloud Storage
        settings tab, which calls :func:`cloud_storage.upload_directory`.

        Runs the upload in a daemon thread so the execution returns
        immediately; failures are logged but never raised.
        """
        try:
            enabled = (get_setting(self.db, "cloud_auto_backup") or "").strip().lower() == "true"
        except Exception as exc:
            logger.warning("auto-backup setting read failed (exec_id=%d): %s", exec_id, exc)
            return
        if not enabled:
            return

        # Import lazily to avoid a circular dependency between sweep_engine
        # and the cloud_storage module and its Google API dependencies.
        try:
            from .cloud_storage import (
                check_connection as _cloud_check_connection,
                upload_paths as _upload_paths,
            )
        except Exception as exc:
            logger.warning("auto-backup import failed (exec_id=%d): %s", exec_id, exc)
            return

        try:
            if not _cloud_check_connection():
                task_log.log("Auto-backup skipped: cloud storage not linked.")
                return
        except Exception as exc:
            task_log.log(f"Auto-backup connection check failed: {exc}")
            return

        # Only this execution's artifacts. Missing files are filtered by
        # ``upload_paths`` itself.
        paths_to_upload = [p for p in (report_path, log_path) if p]
        folder_name = f"execution-{exec_id}-{time.strftime('%Y%m%d-%H%M%S')}"

        def _run() -> None:
            try:
                task_log.log(
                    f"Auto-backup: uploading execution #{exec_id} artifacts to Google Drive..."
                )
                result = _upload_paths(paths_to_upload, REPORTS_DIR, folder_name=folder_name)
                uploaded = len(result.get("uploaded_ids", []))
                total = result.get("total_files", 0)
                folder = result.get("folder_name") or ""
                task_log.log(
                    f"Auto-backup complete: uploaded {uploaded}/{total} files"
                    + (f" to '{folder}'." if folder else ".")
                )
            except Exception as exc:
                logger.warning("Auto-backup upload failed (exec_id=%d): %s", exec_id, exc)
                try:
                    task_log.log(f"Auto-backup failed: {exc}")
                except Exception:
                    pass

        threading.Thread(target=_run, name=f"resmon-autobackup-{exec_id}", daemon=True).start()

    def _handle_cancellation(
        self,
        exec_id: int,
        task_log: TaskLogger,
        partial_results: list,
        wall_start: float,
    ) -> dict:
        """Clean up and finalize after cooperative cancellation is detected."""
        store = progress_store
        end_time = now_iso()
        elapsed = time.monotonic() - wall_start

        update_execution_status(
            self.db, exec_id, "cancelled",
            end_time=end_time,
        )
        task_log.finalize(status="CANCELLED", stats={"partial_results": len(partial_results)})

        store.emit(exec_id, {
            "type": "cancelled",
            "timestamp": end_time,
        })
        store.emit(exec_id, {
            "type": "complete",
            "status": "cancelled",
            "result_count": 0,
            "new_count": 0,
            "elapsed": round(elapsed, 2),
            "timestamp": end_time,
        })
        store.mark_complete(exec_id)

        return {
            "execution_id": exec_id,
            "result_count": 0,
            "new_count": 0,
            "report_path": None,
            "log_path": None,
            "status": "cancelled",
        }

    # ------------------------------------------------------------------
    # Helpers
    # ------------------------------------------------------------------

    @staticmethod
    def _build_report_docs(results) -> list[dict]:
        """Convert NormalizedResult list to dicts for report_generator."""
        docs = []
        for r in results:
            nr = normalize_result(r)
            if not validate_result(nr):
                continue
            docs.append({
                "title": nr.title,
                "authors": nr.authors,
                "abstract": nr.abstract,
                "publication_date": nr.publication_date,
                "url": nr.url,
                "source_repository": nr.source_repository,
                "external_id": nr.external_id,
                "categories": nr.categories,
            })
        return docs
