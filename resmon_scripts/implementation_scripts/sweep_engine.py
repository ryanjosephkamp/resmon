# resmon_scripts/implementation_scripts/sweep_engine.py
"""Sweep engine: orchestrates query → normalize → dedup → report pipeline."""

import json
import logging
import queue
import sqlite3
import threading
import time
from dataclasses import asdict
from pathlib import Path
from typing import Optional

from . import zero_reason as zero_reason_module
from .api_base import (
    EntityUnsupported,
    note_entity_unsupported,
    reset_search_outcome,
    search_outcome,
)
from .api_registry import (
    RETIRED_REPOSITORIES,
    get_client,
    list_repositories,
)
from . import entity_matching
from .repo_catalog import REPOSITORY_CATALOG, required_credential_for
from .config import REPORTS_DIR
from .credential_manager import get_credential_for
from .database import (
    insert_execution,
    update_execution_status,
    update_current_stage,
    link_execution_document,
    get_document_by_source,
    get_execution_by_id,
    get_execution_sources,
    get_setting,
    record_execution_source,
)
from . import source_coverage
from .logger import TaskLogger
from .embedding_job import embed_documents, pending_ids
from .near_duplicates import links_map
from .normalizer import normalize_result, validate_result, deduplicate_batch
from .progress import progress_store
from .report_generator import generate_report, save_report
from .utils import now_iso

logger = logging.getLogger(__name__)

# Slug -> the name the catalog shows a user. The zero-reason sentences name
# the source, and "ndl_search filters by publication year only" is not a
# sentence anybody wants to read.
_CATALOG_NAMES = {entry.slug: entry.name for entry in REPOSITORY_CATALOG}


def _source_display_name(slug: str) -> str:
    return _CATALOG_NAMES.get(slug, slug)


# How many sources one sweep asks at once. Asking several at a time asks no
# upstream any faster: every request to a source still waits on that source's
# own module-level RateLimiter, exactly as it did when sources were asked one
# after another. What this bounds is one run's footprint -- search threads,
# open connections and result sets held at once -- for a sweep that selects
# every source resmon has. The renderer says "up to eight at a time" on the
# repository selector, the Deep Sweep page's help and its tutorial; a change
# here changes those three.
_SOURCE_CONCURRENCY = 8

# How long a source may search before the live log says it is still at it,
# and how often after that. The cancel flag is read on the same beat.
_HEARTBEAT_SECONDS = 2.0


class _ExecutionCancelled(Exception):
    """Raised internally when cooperative cancellation is detected mid-query."""


def required_credential_for_sweep(repo_name: str) -> str | None:
    """Return the credential a repository needs before it is worth asking.

    This used to be a dict of three slugs written out here. The catalog
    already declared which sources require a key — four of them — and the two
    lists drifted: GovInfo's client returns an empty list the moment it finds
    no credential, and its own comment says "the sweep's existing catalog gate
    records missing_key", but the gate had never heard of it. The user was
    told resmon had not recorded whether GovInfo answered, when resmon knew
    perfectly well that it had never been asked.

    So the gate reads the catalog instead, and there is one list again. A new
    keyed source is covered the moment its catalog row says ``required``.
    ``test_source_constraints.py`` fails if the two ever separate.
    """
    return required_credential_for(repo_name)

# The recorded zero reasons that mean **resmon asked and the source did not
# answer**, as opposed to resmon never having asked it.
#
# ``zero_reason.DID_NOT_ANSWER`` is the wider set and is the right one for
# coverage, where the question is "can this source be counted as searched?".
# Deciding that a whole *run* failed is a stronger claim and needs the
# narrower one. ``missing_key`` is the settled case -- an execution must never
# be ``failed`` solely because a key was not configured
# (``test_missing_required_key_report.py``, 1.8.6) -- and ``retired``,
# ``entity_unsupported`` and ``window_unanswerable`` are the same fact in
# different clothes: resmon declined to ask, for a reason it can state, and
# nothing broke. A run made entirely of those completed; it simply had nowhere
# to look.
_ASKED_AND_DID_NOT_ANSWER = frozenset({"upstream_failure", "parse_failure"})


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
        # What an earlier run's sources were sent, carried in by a restart that
        # copied that run's parameters. This run records its own.
        inherited_queries = query_params.pop("author_queries", None) is not None
        params_json = json.dumps(query_params, default=str)
        wall_start = time.monotonic()

        # 1. Create execution record (skip if already prepared)
        if exec_id is None:
            exec_id = insert_execution(self.db, {
                "execution_type": execution_type,
                "parameters": params_json,
                "start_time": start_time,
            })
        elif inherited_queries:
            self._record_author_queries(exec_id, None)

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
        # 2.1 — every candidate that survived verification, keyed by
        # (source, external_id) so a paper returned by two sources is written
        # once with the **strongest** basis either of them supports.
        entity_matches: dict = {}
        missing_key_repos: list[str] = []
        repo_errors: list[dict] = []
        # One entry per source that came back with nothing, in the order the
        # sources were selected (not the order they answered in). Rendered
        # into the report's footer.
        zero_notes: list[dict] = []
        # Records each source returned, for every source whose search finished.
        # Only a cancelled run's report needs it: a finished report lists the
        # papers themselves.
        source_counts: dict[str, int] = {}
        # A person watch: what each source's author query sent, by slug.
        author_queries: dict[str, dict] = {}

        def cancelled(
            stage: str,
            *,
            report_docs: Optional[list[dict]] = None,
            dedup: Optional[dict] = None,
            linked: Optional[list[int]] = None,
            ai_model: Optional[str] = None,
        ) -> dict:
            """Finalize a cancelled run, leaving a report of what it collected.

            ``stage`` is where the cancel took effect: ``querying`` (sources
            still being asked), ``collected`` (every source finished, nothing
            stored yet) or ``summarizing`` (papers stored and linked). A report
            that cannot be written is logged and the run is still cancelled;
            the report is never allowed to turn a cancel into a failure.
            """
            report_path: Optional[Path] = None
            try:
                docs = (report_docs if report_docs is not None
                        else self._build_report_docs(all_results, entity_matches))
                partial = {n.get("slug") for n in zero_notes if n.get("partial")}
                watched = query_params.get("entity_profile") or None
                text = generate_report(docs, {
                    "query": query_params.get("query", ""),
                    "watch_profile": (watched or {}).get("display_name"),
                    "keywords": query_params.get("keywords"),
                    "repositories": list(repositories),
                    "missing_key_repos": list(missing_key_repos),
                    "zero_notes": list(zero_notes),
                    "duplicate_links": self._duplicate_links_for(linked) if linked else None,
                    "date_from": query_params.get("date_from", "N/A"),
                    "date_to": query_params.get("date_to", "N/A"),
                    "total": len(docs),
                    "new": dedup["new"] if dedup else None,
                    "ai_model": ai_model,
                    "cancellation": {
                        "stage": stage,
                        "stored": dedup is not None,
                        "answered": [
                            {"source": _source_display_name(slug), "count": source_counts[slug]}
                            for slug in repositories
                            if source_counts.get(slug) and slug not in partial
                        ],
                    },
                })
                report_path = (REPORTS_DIR / "markdowns"
                               / f"report_{execution_type}_{exec_id}_{ts_slug}.md")
                save_report(text, report_path)
                task_log.log(f"Report of the cancelled run saved: {report_path}")
                store.emit(exec_id, {
                    "type": "report_saved",
                    "report_path": str(report_path),
                    "timestamp": now_iso(),
                })
            except Exception as exc:
                logger.warning(
                    "Could not write the cancelled run's report (exec_id=%s): %s",
                    exec_id, exc,
                )
                task_log.log(f"The cancelled run's report could not be written: {exc}")
                report_path = None
            return self._handle_cancellation(
                exec_id, task_log, all_results, wall_start,
                report_path=report_path, log_path=log_path,
            )

        try:
            # 2.1 — a watch routine names a profile, and a routine that names one
            # resmon no longer holds must **fail loudly**. The alternative was a
            # run that quietly searched for nothing every morning: the profile is
            # gone, so no candidate can match it, so the routine reports zero
            # results for a reason nobody would ever see. A failed execution with
            # this sentence on it is visible in Results and in the Monitor.
            entity_mode = query_params.get("entity_mode")
            if entity_mode and query_params.get("entity_profile") is None:
                raise ValueError(
                    f"The watch profile this routine follows (id "
                    f"{query_params.get('entity_profile_id')}) no longer exists. "
                    f"Point the routine at another profile, or delete it."
                )
            if entity_mode == "retractions":
                return self._run_retractions(
                    exec_id=exec_id,
                    execution_type=execution_type,
                    query_params=query_params,
                    task_log=task_log,
                    log_path=log_path,
                    ts_slug=ts_slug,
                    start_time=start_time,
                    wall_start=wall_start,
                )

            # 3. Query the repositories, several at once
            store.emit(exec_id, {
                "type": "stage",
                "stage": "querying",
                "message": "Querying repositories...",
                "timestamp": now_iso(),
            })
            update_current_stage(self.db, exec_id, "querying")

            if self._query_sources(
                exec_id=exec_id,
                repositories=repositories,
                query_params=query_params,
                task_log=task_log,
                all_results=all_results,
                entity_matches=entity_matches,
                missing_key_repos=missing_key_repos,
                repo_errors=repo_errors,
                zero_notes=zero_notes,
                source_counts=source_counts,
                author_queries=author_queries,
            ):
                if query_params.get("entity_profile") is not None:
                    self._record_author_queries(exec_id, author_queries)
                return cancelled("querying")
            if query_params.get("entity_profile") is not None:
                self._record_author_queries(exec_id, author_queries)

            store.emit(exec_id, {
                "type": "log_entry",
                "message": f"Total raw results: {len(all_results)}",
                "timestamp": now_iso(),
            })
            task_log.log(f"Total raw results: {len(all_results)}")

            # 4. Normalize + deduplicate + insert
            # Cancellation checkpoint
            if store.should_cancel(exec_id):
                return cancelled("collected")

            store.emit(exec_id, {
                "type": "stage",
                "stage": "dedup",
                "message": f"Deduplicating {len(all_results)} results...",
                "timestamp": now_iso(),
            })
            update_current_stage(self.db, exec_id, "dedup")

            dedup_stats = deduplicate_batch(self.db, all_results)

            # 2.1 — the match rows, written **after** the documents exist
            # because a match points at a document id. Written for every
            # verified candidate, including the ones dedup recognised as
            # already in the corpus: a paper you already had is still this
            # person's paper, and a watch routine that only ever surfaced brand
            # new documents would go quiet for anyone whose work you already
            # collect.
            if entity_matches:
                written = self._record_entity_matches(
                    entity_matches, query_params.get("entity_profile"))
                task_log.log(
                    f"Watch profile: {written} verified match(es) recorded")

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
                # Computed since the beginning and never reported. It is the
                # figure a systematic reviewer needs: the same paper arriving
                # from two different databases.
                "cross_source": dedup_stats.get("cross_source", 0),
                "timestamp": now_iso(),
            })
            self._record_dedup(exec_id, dedup_stats)

            # 5. Link documents to execution
            store.emit(exec_id, {
                "type": "stage",
                "stage": "linking",
                "message": "Linking documents to execution...",
                "timestamp": now_iso(),
            })
            update_current_stage(self.db, exec_id, "linking")

            new_count = 0
            # The ids this run touched, for the embedding step below. Collected
            # here rather than re-queried: this loop already knows them, and a
            # second pass over the corpus to rediscover them would be a scan for
            # no reason.
            linked_ids: list[int] = []
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
                    linked_ids.append(int(doc_row["id"]))
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

            # 5b. Embed what this run touched (1.9).
            #
            # After linking rather than after dedup, because this is the first
            # point at which the document ids exist; before reporting, so a
            # sweep is finished when its papers are searchable. Never inside a
            # source call: an embedding endpoint that is slow or down must not
            # hold a rate-limited scholarly API's connection open.
            self._embed_linked_documents(exec_id, store, task_log, linked_ids)

            # 6. Generate report
            store.emit(exec_id, {
                "type": "stage",
                "stage": "reporting",
                "message": "Generating report...",
                "timestamp": now_iso(),
            })
            update_current_stage(self.db, exec_id, "reporting")

            report_docs = self._build_report_docs(all_results, entity_matches)

            # 6b. Optional AI summarization — runs before report generation
            # so that per-document summaries (and the model identity) can
            # be embedded directly in the Markdown report. ``report_docs``
            # is mutated in place with an ``ai_summary`` key per entry.
            ai_model_label: Optional[str] = None
            ai_lanes = list(getattr(self, "ai_lanes", None) or [])
            if not ai_lanes:
                # Pre-chain callers (and tests) set a single lane, or only a
                # client. Either is a one-lane chain.
                single = getattr(self, "ai_lane", None)
                if single is not None:
                    ai_lanes = [single]
            ai_possible = bool(ai_lanes) or self.llm_client is not None
            if ai_possible and self.config.get("ai_enabled") and report_docs:
                if store.should_cancel(exec_id):
                    return cancelled("summarizing", report_docs=report_docs,
                                     dedup=dedup_stats, linked=linked_ids)

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

                # Run the configured lanes in order (1.8b). The runner owns
                # client construction, lane demotion, and the execution_ai
                # rows -- one per lane, which is the shape that table was
                # built for.
                from .ai_chain import ChainRunner

                chain = ChainRunner(
                    ai_lanes,
                    db=self.db,
                    exec_id=exec_id,
                    prompt_params=self.config.get("ai_prompt_params") or {},
                    ephemeral=getattr(self, "ai_ephemeral", None),
                    primary_client=self.llm_client,
                )

                try:
                    task_log.log("Running AI summarization...")
                    prompt_params = self.config.get("ai_prompt_params") or {}

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

                    # Summarization loop, in slices of the primary lane's
                    # batch size.
                    #
                    # It used to be strictly one document per call, on purpose:
                    # cancellation could then be honored between documents and
                    # the live log could show per-article progress. Both still
                    # hold. Cancellation is checked between slices *and*
                    # reaches inside one -- ``_summarize_with_heartbeat`` runs
                    # the call on a worker thread and terminates the CLI
                    # process on cancel -- and the per-document ``ai_progress``
                    # events are emitted after the slice returns, so the
                    # renderer's consumer is unchanged. What a batch costs is
                    # granularity *during* a slice, which is why the slice also
                    # announces itself before it starts.
                    total_chars = 0
                    cancelled_mid_summary = False
                    total_docs = len(doc_texts)
                    batch_size = max(1, int(getattr(ai_lanes[0], "batch_size", 1) or 1))
                    completed = 0

                    for start in range(0, total_docs, batch_size):
                        if store.should_cancel(exec_id):
                            cancelled_mid_summary = True
                            task_log.log(
                                f"AI summarization cancelled after "
                                f"{completed}/{total_docs} documents."
                            )
                            break

                        slice_texts = doc_texts[start:start + batch_size]
                        slice_docs = report_docs[start:start + batch_size]
                        first, last = start + 1, start + len(slice_texts)
                        if len(slice_texts) > 1:
                            message = (
                                f"Summarizing papers {first}–{last} of "
                                f"{total_docs} in one call..."
                            )
                        else:
                            message = (
                                f"Summarizing document {first}/{total_docs}..."
                            )
                        task_log.log(message)
                        store.emit(exec_id, {
                            "type": "ai_progress",
                            "message": message,
                            "completed": completed,
                            "total": total_docs,
                            "timestamp": now_iso(),
                        })

                        try:
                            outcomes = self._summarize_with_heartbeat(
                                chain=chain,
                                texts=slice_texts,
                                exec_id=exec_id,
                                first=first,
                                last=last,
                                total=total_docs,
                            )
                        except _ExecutionCancelled:
                            cancelled_mid_summary = True
                            task_log.log(
                                f"AI summarization cancelled after "
                                f"{completed}/{total_docs} documents."
                            )
                            break

                        for offset, (doc, (summary, doc_error)) in enumerate(
                            zip(slice_docs, outcomes)
                        ):
                            idx = start + offset
                            if doc_error is not None:
                                # Every remaining lane failed on this paper. The
                                # others still get summaries -- one difficult
                                # abstract is not a reason to abandon the batch --
                                # and the runner has already classified and
                                # recorded why, so this only has to say so.
                                task_log.log(
                                    f"AI summary failed for document "
                                    f"{idx + 1}/{total_docs} "
                                    f"({str(doc.get('title') or '')[:60]}): "
                                    f"{doc_error.kind.value} — {doc_error.message}"
                                )
                                logger.warning(
                                    "AI summary error on document %d (%s): %s",
                                    idx + 1, doc_error.kind.value, doc_error.message,
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

                    # Close every lane's row with what it achieved (1.8b).
                    # 'partial' and 'failed' stay apart deliberately: partial
                    # is a normal day with one awkward abstract, failed is a
                    # lane that did not work at all.
                    chain.finish()
                    lane_rows = chain.lane_summaries()
                    for lane_row in lane_rows:
                        if lane_row["attempted"] or lane_row["reason"]:
                            task_log.log(
                                f"AI lane {lane_row['index'] + 1} "
                                f"({lane_row['label']}): {lane_row['outcome']} "
                                f"— {lane_row['succeeded']}/{lane_row['attempted']}"
                                + (f"; {lane_row['reason']}" if lane_row["reason"] else "")
                            )

                    # No lane got as far as one attempt: AI was on, and no
                    # summary was produced by anything. Say so in the live log
                    # with the reason the lane itself gave.
                    #
                    # Before 1.8.5 this warning was emitted *before* the run,
                    # guessed from ai_provider, and said "API key missing" for
                    # a subscription lane that has no key to miss. The reason
                    # is only knowable per lane and only after the lane has
                    # been built, so this is where it is said.
                    if not any(row["attempted"] for row in lane_rows):
                        reason = next(
                            (row["reason"] for row in lane_rows if row["reason"]),
                            "no lane could be used",
                        )
                        store.emit(exec_id, {
                            "type": "log_entry",
                            "level": "warn",
                            "message": f"AI skipped: {reason}",
                            "timestamp": now_iso(),
                        })

                    if cancelled_mid_summary:
                        return cancelled("summarizing", report_docs=report_docs,
                                         dedup=dedup_stats, linked=linked_ids,
                                         ai_model=chain.active_label or None)

                    # Provider/model label for the report header. With a
                    # chain the honest answer is the lane that actually
                    # produced these summaries, not the one configured first
                    # -- a report saying "anthropic" when Ollama did the work
                    # would be exactly the kind of quiet lie 1.7 was about.
                    ai_model_label = chain.active_label or None
                    # 1.8.5 — name the effort level in the header when the lane
                    # that did the work actually set one. Additive: no lane
                    # without an effort control gains an empty field implying
                    # it has one.
                    active_effort = chain.active_effort
                    if ai_model_label and active_effort:
                        ai_model_label = f"{ai_model_label} · effort {active_effort}"
                    if not ai_model_label:
                        provider = str(prompt_params.get("_audit_provider") or "").strip()
                        model = str(prompt_params.get("_audit_model") or "").strip()
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
                    # Close the lane rows before continuing. Leaving them at
                    # 'running' is the signal for a process that died; a run
                    # that caught its own error and finished normally must not
                    # send that signal.
                    try:
                        chain.finish()
                    except Exception:
                        logger.exception("Could not close execution_ai rows")
                    task_log.log(f"AI summarization failed: {exc}")
                    logger.warning("AI summarization error: %s", exc)
                    store.emit(exec_id, {
                        "type": "log_entry",
                        "message": f"AI summarization failed: {exc}",
                        "timestamp": now_iso(),
                    })

            watched = query_params.get("entity_profile") or None
            report_metadata = {
                "query": query_params.get("query", ""),
                # A watch run's header says who it followed. Left to the query
                # field it would read "Query: N/A", which is true of the words
                # and says nothing about what the run was for.
                "watch_profile": (watched or {}).get("display_name"),
                "watch_basis_warning": (watched or {}).get("basis_warning"),
                "keywords": query_params.get("keywords"),
                "repositories": list(repositories),
                "missing_key_repos": list(missing_key_repos),
                "zero_notes": list(zero_notes),
                # 1.9b. Links already stored for the papers this run touched --
                # this does not scan, because a corpus-wide scan is minutes of
                # work and a sweep must not silently grow one. A run before the
                # first scan carries no section, which is correct: resmon has not
                # looked, and an empty section would read as "none found".
                "duplicate_links": self._duplicate_links_for(linked_ids),
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

            # Two routes to ``failed``, and they overlap on purpose.
            #
            # The first is the original: every requested repository raised.
            # Surfacing that as ``failed`` rather than ``completed`` is what
            # makes the Monitor/Results pages and the cancel/cleanup paths
            # treat it as an error. When only a subset errored the execution
            # still ``completed``, with the per-repo messages in the task log
            # and as ``repo_error`` progress events.
            all_repos_errored = (
                len(repo_errors) > 0
                and len(repo_errors) == len(repositories)
            )

            # The second exists because almost no client raises. A source that
            # answers 4xx or 5xx is logged and broken out of, so it never
            # reaches ``repo_errors`` at all: a sweep in which *every* source
            # answered 503 had ``repo_errors == []`` and finished ``completed``
            # with ``result_count = 0``, which is the exact shape this app
            # exists to refuse. Whether any source answered is
            # ``source_coverage``'s question and is asked there rather than
            # recounted from exceptions here.
            unanswered_summary = self._nothing_answered(exec_id)

            failed = all_repos_errored or unanswered_summary is not None
            final_status = "failed" if failed else "completed"
            error_summary: Optional[str] = None
            if all_repos_errored:
                # Both routes can hold at once, and when they do the exception
                # text is kept: it names what went wrong for each source,
                # where the coverage summary only counts them. The verdict is
                # the same either way.
                error_summary = "; ".join(
                    f"{e['repository']}: {e['error']}" for e in repo_errors
                )
            elif unanswered_summary is not None:
                error_summary = unanswered_summary

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
                status="FAILED" if failed else "COMPLETED",
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

    def _embed_linked_documents(
        self, exec_id: int, store, task_log, linked_ids: list[int]
    ) -> None:
        """Embed this execution's documents, or record exactly why it did not (1.9).

        The lane is attached by ``resmon._apply_embedding_settings_to_engine``,
        the way ``ai_lanes`` is. ``None`` means the feature is off, which is the
        state most installs are in and is not a failure.

        **Three separate skip reasons, and each is recorded rather than
        summarised.** No lane configured, the extension will not load, and the
        lane refused are different conditions with different remedies, and a run
        that said only "embedding skipped" would leave the user to guess which.
        The extension case still writes vectors: they are in
        ``document_embeddings`` and a later rebuild picks them up, so a machine
        that cannot rank today is not a machine that has to re-embed tomorrow.

        Nothing here can fail the sweep. A sweep's job is to find papers; an
        embedding endpoint being down is a reason some of them are not yet
        searchable by meaning, not a reason to discard the run.
        """
        lane = getattr(self, "embedding_lane", None)
        if lane is None:
            return
        if not linked_ids:
            return

        try:
            todo = pending_ids(self.db, lane.model, within=linked_ids)
        except Exception as exc:  # pragma: no cover - defence around an optional step
            logger.warning("could not determine what to embed: %s", exc)
            return

        # ``pending_ids`` rather than "the new ones". A document this run
        # returned that is already in the corpus but has no vector -- because it
        # predates the lane, or a backfill was cancelled -- is embedded here, and
        # one that already has a vector is not re-embedded. The set is bounded by
        # this execution either way, and it is self-healing rather than merely
        # correct for new rows.
        if not todo:
            return

        store.emit(exec_id, {
            "type": "ai_progress",
            "stage": "embedding",
            "processed": 0,
            "total": len(todo),
            "model": lane.model,
            "message": f"Embedding {len(todo)} document(s) with {lane.model}...",
            "timestamp": now_iso(),
        })
        update_current_stage(self.db, exec_id, "embedding")

        def _progress(done: int, total: int) -> None:
            store.emit(exec_id, {
                "type": "ai_progress",
                "stage": "embedding",
                "processed": done,
                "total": total,
                "model": lane.model,
                "timestamp": now_iso(),
            })

        try:
            outcome = embed_documents(
                self.db, lane, todo,
                should_cancel=lambda: store.should_cancel(exec_id),
                on_batch=_progress,
            )
        except Exception as exc:  # pragma: no cover - embed_documents catches its own
            task_log.log(f"Embedding failed and the run continued: {exc}")
            store.emit(exec_id, {
                "type": "log_entry",
                "level": "warn",
                "message": f"Embedding skipped: {exc}",
                "timestamp": now_iso(),
            })
            return

        # The count goes in the task log as well as the event stream, because
        # the event stream is cleaned up after the run and the log is what a
        # user reads afterwards to find out what happened.
        task_log.log(
            f"Embedded {outcome['embedded']} of {len(todo)} document(s) with "
            f"{lane.model}"
            + (f"; {outcome['skipped_no_text']} had no text to embed"
               if outcome["skipped_no_text"] else "")
            + (f"; stopped: {outcome['reason']}" if outcome["reason"] else "")
        )
        store.emit(exec_id, {
            "type": "ai_progress",
            "stage": "embedding",
            "processed": outcome["embedded"],
            "total": len(todo),
            "model": lane.model,
            "skipped_no_text": outcome["skipped_no_text"],
            "reason": outcome["reason"],
            "message": (
                f"Embedded {outcome['embedded']} of {len(todo)} with {lane.model}."
                if outcome["reason"] is None
                else f"Embedding stopped after {outcome['embedded']} of "
                     f"{len(todo)}: {outcome['reason']}"
            ),
            "timestamp": now_iso(),
        })
        if outcome["reason"] and not outcome["cancelled"]:
            store.emit(exec_id, {
                "type": "log_entry",
                "level": "warn",
                "message": f"Embedding stopped: {outcome['reason']}",
                "timestamp": now_iso(),
            })

    def _duplicate_links_for(self, linked_ids: list[int]) -> list[dict]:
        """Near-duplicate pairs among this run's own documents, for the report.

        Reads what a previous scan stored; it never scans. A corpus-wide scan
        takes minutes on a real corpus and a sweep growing one silently would be
        the opposite of the "never inside a source call" rule the embedding step
        follows.

        Each pair is emitted once. Both sides of a link are usually in the same
        run, and a report listing "A also appears as B" and "B also appears as A"
        would double what the reader has to check.
        """
        if not linked_ids:
            return []
        try:
            mapped = links_map(self.db, linked_ids)
        except Exception as exc:  # pragma: no cover - a report must not fail on this
            logger.warning("could not read near-duplicate links for the report: %s", exc)
            return []
        if not mapped:
            return []

        titles = {
            int(r["id"]): (r["title"], r["source_repository"])
            for r in self.db.execute(
                f"SELECT id, title, source_repository FROM documents WHERE id IN "
                f"({','.join('?' for _ in linked_ids)})",
                linked_ids,
            )
        }
        seen: set[tuple[int, int]] = set()
        out: list[dict] = []
        for raw_id, entries in mapped.items():
            doc_id = int(raw_id)
            for entry in entries:
                other_id = int(entry["id"])
                pair = (min(doc_id, other_id), max(doc_id, other_id))
                if pair in seen:
                    continue
                seen.add(pair)
                title, source = titles.get(doc_id, (str(doc_id), "?"))
                out.append({
                    "title": title,
                    "source": source,
                    "other_title": entry.get("title") or str(other_id),
                    "other_source": entry.get("source_repository") or "?",
                    "method": entry.get("method"),
                })
        return out

    def _record_dedup(self, exec_id: int, stats: dict) -> None:
        """Persist the deduplication figures, and never let it break a sweep.

        Same reasoning as ``_record_source``: a run that returned papers has
        done its job, and a locked database while writing the reporting figures
        must not turn that into a failed execution.
        """
        try:
            self.db.execute(
                """
                UPDATE executions
                SET dedup_total = ?, dedup_new = ?, dedup_duplicates = ?,
                    dedup_invalid = ?, dedup_cross_source = ?
                WHERE id = ?
                """,
                (stats.get("total"), stats.get("new"), stats.get("duplicates"),
                 stats.get("invalid"), stats.get("cross_source"), int(exec_id)),
            )
            self.db.commit()
        except Exception as exc:  # pragma: no cover - defensive
            logger.warning(
                "Failed to record dedup figures for exec_id=%s: %s", exec_id, exc,
            )

    def _record_author_queries(self, exec_id: int, queries: Optional[dict]) -> None:
        """Store what a person watch's sources were sent, beside its request.

        A person watch has no query string: each source's client builds its own
        author query from the profile, by name or by an identifier, and notes
        what it put into the request. Those notes are kept in the execution's
        stored parameters under ``author_queries``, by source slug, so the
        search record can say what was asked rather than "not recorded".
        ``None`` removes the key. Like the other bookkeeping writes here, a
        failure is logged and never fails the run.
        """
        try:
            row = self.db.execute(
                "SELECT parameters FROM executions WHERE id = ?", (int(exec_id),),
            ).fetchone()
            params = json.loads(row[0]) if row and row[0] else {}
            if not isinstance(params, dict):
                return
            if queries is None:
                params.pop("author_queries", None)
            else:
                params["author_queries"] = dict(queries)
            self.db.execute(
                "UPDATE executions SET parameters = ? WHERE id = ?",
                (json.dumps(params, default=str), int(exec_id)),
            )
            self.db.commit()
        except Exception as exc:  # pragma: no cover - defensive
            logger.warning(
                "Failed to record author queries for exec_id=%s: %s", exec_id, exc,
            )

    def _nothing_answered(self, exec_id: int) -> Optional[str]:
        """Did every source this run asked fail to answer it?

        Returns ``source_coverage``'s own summary sentence when so, and
        ``None`` when not. The sentence is returned rather than composed here
        so there is one place that renders this vocabulary, the same rule the
        zero-reason sentences follow.

        The question is put to ``source_coverage.build`` rather than answered
        from ``repo_errors``, because an exception count is the wrong
        instrument: almost no client raises, and the audit's worst example is
        a run where every source answered 503 and nothing raised at all. What
        this function adds on top of ``build`` is only the narrowing the
        verdict needs:

        * **Every** selected source must have failed. One source answering
          makes this a graded question -- how much of the field was actually
          searched -- and grading it needs a status this schema cannot hold
          yet. 26 of 27 failing is still ``completed`` here.
        * A source whose outcome was never recorded is ``unknown``, and
          ``unknown`` is not evidence. ``zero_reason`` refuses to call an
          unexplained zero an answer and this refuses to call it a failure;
          turning "resmon did not observe this" into "your monitor is broken"
          is the same fabrication pointing the other way.
        * A source resmon never asked did not fail. See
          ``_ASKED_AND_DID_NOT_ANSWER``.
        * A run that selected no sources asked nothing and so failed at
          nothing. That is reachable and ordinary: a ``retractions`` watch
          routine reads the corpus and deliberately carries an empty
          repository list, so that the Monitor does not announce sources it
          never touches.

        Like ``_record_source``, a failure in here is logged and swallowed. A
        run that found papers must not be turned into a failed one by a
        bookkeeping read; the worst case is that this route stays quiet and
        the original one decides, which is the behavior that shipped before.
        """
        try:
            execution = get_execution_by_id(self.db, exec_id)
            if execution is None:
                return None
            coverage = source_coverage.build(
                execution, get_execution_sources(self.db, exec_id))
            if coverage["total"] == 0 or coverage["counts"]["answered"]:
                return None
            # A raised query counts: resmon asked and the call did not come
            # back. A *retired* source also lands on ``status == 'error'`` --
            # the engine catches the registry's ValueError and records the
            # withdrawal reason there (see the except branch in ``_run``) --
            # and that one is not a failure, it is a source resmon declined to
            # ask. Without this exclusion a dive on a retired source plus one
            # that answered 503 recorded ``failed``; the single-retired case
            # was hidden because ``all_repos_errored`` already fires on it.
            asked_and_failed = sum(
                source["category"] == "non_answer"
                and source["zero_reason"] != "retired"
                and (source["status"] == "error"
                     or source["zero_reason"] in _ASKED_AND_DID_NOT_ANSWER)
                for source in coverage["sources"]
            )
            if asked_and_failed != coverage["total"]:
                return None
            return str(coverage["summary"])
        except Exception as exc:  # pragma: no cover - defensive
            logger.warning(
                "Could not read coverage to decide the status of exec_id=%s: %s",
                exec_id, exc,
            )
            return None

    def _record_source(
        self,
        exec_id: int,
        repo_name: str,
        status: str,
        *,
        result_count: int = 0,
        error_message: Optional[str] = None,
        credential_name: Optional[str] = None,
        zero_reason: Optional[str] = None,
        zero_detail: Optional[dict] = None,
    ) -> None:
        """Persist one per-source outcome, and never let it break a sweep.

        The watchdog reads these rows, but a sweep that returned papers has
        already done its job -- a locked database or a full disk while writing
        the health record must not turn that into a failed execution. The
        failure is logged and the run continues; the missing row shows up as a
        gap in the record rather than as a false alarm, because the watchdog
        counts only the runs it can see (see watchdog.py).
        """
        try:
            record_execution_source(
                self.db, exec_id, repo_name, status,
                result_count=result_count,
                error_message=error_message,
                credential_name=credential_name,
                zero_reason=zero_reason,
                zero_detail=(
                    json.dumps(zero_detail, ensure_ascii=False)
                    if zero_detail else None
                ),
            )
        except Exception as exc:  # pragma: no cover - defensive
            logger.warning(
                "Failed to record source health for exec_id=%s repo=%s: %s",
                exec_id, repo_name, exc,
            )

    def _summarize_with_heartbeat(
        self,
        *,
        chain,
        texts: list,
        exec_id: int,
        first: int,
        last: int,
        total: int,
        heartbeat_interval: float = 2.0,
    ) -> list:
        """Run one summarization slice on a worker thread, cancellably.

        Same shape as :meth:`_search_with_heartbeat` and for the same reason,
        plus one that is specific to batching: a batched call is a **single
        CLI process holding ten documents**, so a cancel honored only between
        calls would leave the user waiting out the whole batch after pressing
        the button. ``chain.cancel()`` reaches into the lane and terminates the
        process that is actually running.

        The heartbeat matters more here than it does for a search. A ten-paper
        batch is one long silence where ten short ones used to be, and a live
        log that says nothing for four minutes is indistinguishable from one
        that has died.
        """
        store = progress_store
        holder: dict = {}

        def _worker() -> None:
            try:
                holder["results"] = chain.summarize_documents(texts)
            except BaseException as exc:  # re-raised in the caller
                holder["error"] = exc

        thread = threading.Thread(
            target=_worker, daemon=True, name=f"ai-summarize-{exec_id}",
        )
        start = time.monotonic()
        thread.start()

        cancelled = False
        while thread.is_alive():
            thread.join(timeout=heartbeat_interval)
            if not thread.is_alive():
                break
            if not cancelled and store.should_cancel(exec_id):
                # Terminate the CLI, then wait for the worker to unwind rather
                # than abandoning it: the temporary working directory holding
                # the constitution is cleaned up on the way out, and a thread
                # left holding it would leak one per cancelled batch.
                cancelled = True
                try:
                    chain.cancel()
                except Exception:  # pragma: no cover - defensive
                    logger.exception("Could not cancel the AI lane")
                continue
            elapsed = time.monotonic() - start
            store.emit(exec_id, {
                "type": "ai_progress",
                "message": (
                    f"still summarizing papers {first}–{last} of {total} "
                    f"({elapsed:.0f}s elapsed)"
                    if last > first else
                    f"still summarizing paper {first} of {total} "
                    f"({elapsed:.0f}s elapsed)"
                ),
                "completed": first - 1,
                "total": total,
                "elapsed": round(elapsed, 1),
                "timestamp": now_iso(),
            })

        if cancelled:
            raise _ExecutionCancelled()
        if "error" in holder:
            raise holder["error"]
        return holder.get("results", [("", None)] * len(texts))

    def _run_retractions(
        self,
        *,
        exec_id: int,
        execution_type: str,
        query_params: dict,
        task_log,
        log_path,
        ts_slug: str,
        start_time: str,
        wall_start: float,
    ) -> dict:
        """The ``retractions`` watch mode: a lifecycle check, then a join.

        **No new provider, and no new claim.** A watch routine in this mode does
        exactly two things a user could do by hand: it puts this profile's papers
        through the ordinary lifecycle check, and it reports the findings
        ``document_lifecycle`` already holds for them. Every finding keeps the
        notice link it was recorded from, and the *match* keeps its basis — so a
        retraction that arrived through a ``name_only`` match is visibly a
        finding on a paper that merely has this person's name on it. A false
        retraction attached to a named person is defamatory, which is why this
        path invents nothing.

        No source is queried and no document is stored, so the corpus is
        untouched: this is the one execution type that reads and never writes a
        paper.
        """
        from . import lifecycle as lifecycle_module
        from . import watch_profiles as watch_profiles_module
        from .report_generator import generate_cancelled_watch_report, generate_watch_report

        store = progress_store
        profile = query_params["entity_profile"]
        profile_id = int(profile["id"])
        name = profile.get("display_name") or "this profile"

        store.emit(exec_id, {
            "type": "stage", "stage": "querying",
            "message": f"Checking {name}'s papers for retractions...",
            "timestamp": now_iso(),
        })
        update_current_stage(self.db, exec_id, "querying")

        document_ids = watch_profiles_module.matched_document_ids(self.db, profile_id)
        task_log.log(
            f"Watch profile '{name}': {len(document_ids)} matched paper(s) in "
            f"the corpus")

        # The one cancellation checkpoint this branch has, and it is honestly
        # placed: everything above reads the local database, and everything below
        # is a single bounded lifecycle pass that makes batched HTTP calls and
        # cannot be interrupted part-way. `check_corpus` has the same shape.
        # Cancelling after this point takes effect at the end of the pass, and
        # the log says so rather than leaving a Cancel button that looks broken.
        if store.should_cancel(exec_id):
            report_path: Optional[Path] = None
            try:
                report_path = REPORTS_DIR / "markdowns" / f"report_{execution_type}_{exec_id}_{ts_slug}.md"
                save_report(generate_cancelled_watch_report(profile, len(document_ids)), report_path)
                task_log.log(f"Report of the cancelled run saved: {report_path}")
            except Exception as exc:
                logger.warning(
                    "Could not write the cancelled run's report (exec_id=%s): %s",
                    exec_id, exc,
                )
                report_path = None
            return self._handle_cancellation(
                exec_id, task_log, [], wall_start,
                report_path=report_path, log_path=log_path,
            )
        task_log.log(
            "Checking now. A cancel from here takes effect when this pass ends: "
            "the lifecycle check runs in one bounded batch and is not "
            "interruptible part-way.")

        # Bounded, and bounded by the routine's own `max_results` so the same
        # dial that limits a keyword sweep limits this. A daily routine over a
        # large back catalogue walks it: `documents_due` orders never-checked
        # first, so each run advances rather than re-reading the head.
        limit = int(query_params.get("max_results") or 100)
        check = lifecycle_module.check_documents(
            self.db, document_ids, limit=limit)
        task_log.log(
            f"Lifecycle check: {check['checked_now']} of {check['selected']} "
            f"due paper(s) checked ({check['eligible']} matched in total)")
        for err in check["errors"]:
            task_log.log(f"  could not check document {err['document_id']}: "
                         f"{err['error']}")

        store.emit(exec_id, {
            "type": "stage", "stage": "reporting",
            "message": "Collecting findings...",
            "timestamp": now_iso(),
        })
        update_current_stage(self.db, exec_id, "reporting")

        findings = watch_profiles_module.profile_lifecycle_findings(
            self.db, profile_id, limit=500)
        task_log.log(findings["coverage_note"])

        report_text = generate_watch_report(profile, findings, check)
        report_filename = f"report_{execution_type}_{exec_id}_{ts_slug}.md"
        report_path = REPORTS_DIR / "markdowns" / report_filename
        save_report(report_text, report_path)
        task_log.log(f"Report saved: {report_path}")
        store.emit(exec_id, {
            "type": "report_saved", "report_path": str(report_path),
            "timestamp": now_iso(),
        })

        # "New" is a finding this run was the first to record, read from the
        # lifecycle row's own `first_seen_at` rather than from the count moving.
        # A run that checked nothing and a run that found nothing new report the
        # same zero here, which is why the task log carries the coverage sentence
        # above and the report repeats it.
        new_count = sum(
            1 for f in findings["findings"]
            if str(f.get("first_seen_at") or "") >= start_time
        )

        end_time = now_iso()
        elapsed = time.monotonic() - wall_start
        update_execution_status(
            self.db, exec_id, "completed",
            end_time=end_time,
            result_count=len(findings["findings"]),
            new_result_count=new_count,
            log_path=str(log_path),
            result_path=str(report_path),
        )
        task_log.finalize(status="COMPLETED", stats={
            "findings": len(findings["findings"]),
            "new": new_count,
            "checked_now": check["checked_now"],
            "matched_documents": findings["matched_documents"],
        })
        store.emit(exec_id, {
            "type": "complete", "status": "completed",
            "result_count": len(findings["findings"]),
            "new_count": new_count,
            "elapsed": round(elapsed, 2),
            "timestamp": now_iso(),
        })
        store.mark_complete(exec_id)
        self._maybe_auto_backup(exec_id, task_log, report_path, log_path)

        return {
            "execution_id": exec_id,
            "result_count": len(findings["findings"]),
            "new_count": new_count,
            "report_path": str(report_path),
            "log_path": str(log_path),
        }

    def _record_entity_matches(self, matches: dict, profile) -> int:
        """Write one row per verified match, keyed to the stored document.

        ``INSERT OR REPLACE`` rather than ``OR IGNORE``: a paper first matched
        by name and later matched by identifier — because a source that carries
        the ORCID has now seen it — should say ``identifier``, and a row that
        never improved would leave the weaker claim on screen for ever.
        ``first_seen_at`` is preserved across the upgrade, so "when did this
        appear" stays true.
        """
        profile_id = (profile or {}).get("id")
        if not profile_id:
            return 0
        written = 0
        for (source, external_id), (_record, found) in matches.items():
            row = self.db.execute(
                "SELECT id FROM documents WHERE source_repository = ? AND "
                "external_id = ?", (source, external_id)).fetchone()
            if row is None:
                continue
            document_id = row["id"] if hasattr(row, "keys") else row[0]
            existing = self.db.execute(
                "SELECT first_seen_at FROM watch_profile_matches "
                "WHERE document_id = ? AND profile_id = ?",
                (document_id, profile_id)).fetchone()
            first_seen = (existing["first_seen_at"] if existing else None)
            self.db.execute(
                "INSERT OR REPLACE INTO watch_profile_matches "
                "(document_id, profile_id, basis, matched_author, evidence, "
                " first_seen_at) VALUES (?, ?, ?, ?, ?, COALESCE(?, datetime('now')))",
                (document_id, profile_id, found.basis, found.matched_author,
                 found.evidence, first_seen),
            )
            written += 1
        self.db.commit()
        return written

    @staticmethod
    def _verify_entity_candidates(results, profile) -> tuple[dict, int]:
        """Keep only the candidates that match the profile locally.

        Returns ``{(source, external_id): (record, Match)}`` and the number
        rejected. A paper returned by two sources is kept once with the
        strongest basis either supports, because the basis is a claim about
        evidence and the better evidence is still true.
        """
        kept: dict = {}
        rejected = 0
        for record in results:
            found = entity_matching.match(getattr(record, "authors", []), profile)
            if found is None:
                rejected += 1
                continue
            key = (record.source_repository, record.external_id)
            previous = kept.get(key)
            if previous is None or found.rank < previous[1].rank:
                kept[key] = (record, found)
        return kept, rejected

    @staticmethod
    def _entity_unsupported_detail(slug: str) -> str:
        """Which kind of "not asked" this is, from the catalog's own capability.

        `no_author_query` is a fact about the source; `unestablished` is a fact
        about resmon's knowledge of it. Conflating them would tell a user their
        source cannot do something when what is true is that resmon has not been
        able to find out.
        """
        for entry in REPOSITORY_CATALOG:
            if entry.slug == slug:
                return ("unestablished"
                        if entry.entity_search.author_query == "unknown"
                        else "no_author_query")
        return "no_author_query"

    def _query_sources(
        self,
        *,
        exec_id: int,
        repositories: list[str],
        query_params: dict,
        task_log: TaskLogger,
        all_results: list,
        entity_matches: dict,
        missing_key_repos: list[str],
        repo_errors: list[dict],
        zero_notes: list[dict],
        source_counts: dict[str, int],
        author_queries: dict[str, dict],
    ) -> bool:
        """Ask the selected sources, up to ``_SOURCE_CONCURRENCY`` at a time.

        Sources used to be asked one after another, so a sweep took the sum of
        its sources' times. Asking them together changes nothing an upstream
        sees: every request to a source still goes through ``safe_request`` and
        that source's module-level ``RateLimiter`` (biorxiv and medrxiv, one
        host, share one), and each source's operation deadline still starts
        inside its own ``search()``.

        Only ``client.search`` runs off this thread. Every event, task-log line
        and database write happens here, as each source finishes, on the
        connection that has always written them. What the rest of the run reads
        -- the results, the zero notes, the errors and the verified watch
        matches -- is put into the caller's collections in the order the
        sources were *selected*, once all of them have answered, so
        deduplication, the report and the search record come out as a
        one-at-a-time run wrote them whichever source happened to answer first.

        Returns True when the run was cancelled. The collections then hold what
        the sources that finished contributed, and ``zero_notes`` also names
        each search the cancel interrupted and each source it was never sent
        to, so the caller's report can account for every selected source.
        """
        store = progress_store
        total = len(repositories)
        waiting = list(enumerate(repositories))
        # Position in ``repositories`` -> the source's name, its search's
        # holder, when it started, and when its next heartbeat is due.
        in_flight: dict[int, dict] = {}
        finished: "queue.Queue[int]" = queue.Queue()
        # What each source contributed, by its position in ``repositories``.
        results_by: dict[int, list] = {}
        verified_by: dict[int, dict] = {}
        notes_by: dict[int, list[dict]] = {}
        errors_by: dict[int, list[dict]] = {}

        def assemble() -> None:
            for i in range(total):
                all_results.extend(results_by.get(i, []))
                entity_matches.update(verified_by.get(i, {}))
                zero_notes.extend(notes_by.get(i, []))
                repo_errors.extend(errors_by.get(i, []))
                if i in results_by:
                    source_counts[repositories[i]] = len(results_by[i])

        def fail(i: int, repo_name: str, exc: Exception) -> None:
            task_log.log(f"  {repo_name}: ERROR - {exc}")
            logger.warning("Query failed for %s: %s", repo_name, exc)
            errors_by.setdefault(i, []).append({"repository": repo_name, "error": str(exc)})
            # A routine saved before a source was retired still names
            # its slug and lands here. The row stays an error -- the
            # query genuinely did not run -- but it now carries the
            # reason too, so the search record can say "withdrawn on
            # its terms" rather than only quoting an exception.
            retired_reason = RETIRED_REPOSITORIES.get(repo_name)
            notes_by.setdefault(i, []).append({
                "source": _source_display_name(repo_name),
                "slug": repo_name,
                "reason": "retired" if retired_reason else "error",
                "sentence": (
                    retired_reason if retired_reason
                    else f"The query failed: {exc}. This is not a zero "
                         "— the source did not answer."
                ),
            })
            self._record_source(
                exec_id, repo_name,
                "skipped_missing_key" if repo_name in missing_key_repos else "error",
                error_message=str(exc),
                credential_name=required_credential_for_sweep(repo_name),
                zero_reason="retired" if retired_reason else None,
                zero_detail=(
                    {"detail": retired_reason} if retired_reason else None
                ),
            )
            store.emit(exec_id, {
                "type": "repo_error",
                "repository": repo_name,
                "index": i + 1,
                "total_repos": total,
                "error": str(exc),
                "timestamp": now_iso(),
            })

        def begin(i: int, repo_name: str) -> None:
            store.emit(exec_id, {
                "type": "repo_start",
                "repository": repo_name,
                "index": i + 1,
                "total_repos": total,
                "timestamp": now_iso(),
            })

            task_log.log(f"Querying repository: {repo_name}")
            # Detect missing API keys for repositories that require one.
            cred_name = required_credential_for_sweep(repo_name)
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
                    "total_repos": total,
                    "timestamp": now_iso(),
                })
                self._record_source(
                    exec_id, repo_name, "skipped_missing_key",
                    credential_name=cred_name,
                )
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
            except Exception as exc:
                fail(i, repo_name, exc)
                return

            holder: dict = {}

            def work() -> None:
                try:
                    holder.update(self._search_source(client, repo_name, query_params))
                finally:
                    finished.put(i)

            started = time.monotonic()
            in_flight[i] = {"repo": repo_name, "holder": holder, "started": started,
                            "beat": started + _HEARTBEAT_SECONDS}
            threading.Thread(
                target=work, daemon=True, name=f"search-{repo_name}-{exec_id}"
            ).start()

        def finish(i: int) -> None:
            flight = in_flight.pop(i)
            repo_name = flight["repo"]
            holder = flight["holder"]
            # What a person query put into the request, kept only when at least
            # one request was attempted: a client can note its query and then
            # stop before sending it, and that query was not sent.
            sent = holder.get("outcome") or {}
            if sent.get("author_query") and int(sent.get("attempts") or 0) >= 1:
                author_queries[repo_name] = dict(sent["author_query"])
            try:
                if "error" in holder:
                    raise holder["error"]
                results, outcome = holder.get("results", []), holder.get("outcome")
                store.emit(exec_id, {
                    "type": "query_progress",
                    "repository": repo_name,
                    "phase": "search_done",
                    "result_count": len(results),
                    "timestamp": now_iso(),
                })
                task_log.log(f"  {repo_name}: {len(results)} results")

                # 2.1 — **local verification, on every candidate.** A
                # source's author search is a generator, not a verdict:
                # arXiv's `au:` is a text match over a field and Crossref's
                # `query.author` is relevance-ranked, and neither is a claim
                # about identity. Every record is re-checked here against the
                # profile, so a routine's results contain only what resmon
                # can evidence itself — and the count that did not survive is
                # recorded rather than silently dropped.
                entity_profile = query_params.get("entity_profile")
                if entity_profile is not None and results:
                    verified, rejected = self._verify_entity_candidates(
                        results, entity_profile)
                    if rejected:
                        task_log.log(
                            f"    {rejected} of {len(results)} did not "
                            f"survive verification against the profile")
                    verified_by[i] = verified
                    results = [record for record, _m in verified.values()]

                results_by[i] = results

                # Preserve a terminal issue even when earlier pages yielded
                # usable records. The row stays ``ok`` and the records stay
                # available, but every consumer can see that the retained
                # set may be incomplete.
                zero_reason_value: str | None = None
                zero_detail_value: dict | None = None
                zero_message: str | None = None
                if not results:
                    if repo_name in missing_key_repos:
                        # The engine already knows this one, and it is a
                        # better answer than anything the channel holds.
                        zero_reason_value = "missing_key"
                        zero_detail_value = {
                            "credential_name":
                                required_credential_for_sweep(repo_name),
                        }
                    else:
                        zero_reason_value, zero_detail_value = (
                            zero_reason_module.derive(outcome))
                    zero_message = zero_reason_module.sentence(
                        _source_display_name(repo_name),
                        zero_reason_value, zero_detail_value,
                    )
                    task_log.log(f"    {zero_message}")
                    notes_by.setdefault(i, []).append({
                        "source": _source_display_name(repo_name),
                        "slug": repo_name,
                        "reason": zero_reason_value,
                        "sentence": zero_message,
                    })
                else:
                    issue = zero_reason_module.terminal_issue(outcome)
                    if issue:
                        zero_reason_value, issue_detail = issue
                        zero_detail_value = {
                            **issue_detail,
                            "partial": True,
                            "returned": len(results),
                        }
                        zero_message = zero_reason_module.partial_sentence(
                            _source_display_name(repo_name),
                            zero_reason_value,
                            zero_detail_value,
                            len(results),
                        )
                        # Persist the exact catalog-rendered sentence. The
                        # saved coverage/search-record path knows the stable
                        # source slug, while this engine owns display names;
                        # carrying the rendered sentence avoids a circular
                        # catalog import and keeps every surface identical.
                        zero_detail_value["message"] = zero_message
                        task_log.log(f"    {zero_message}")
                        notes_by.setdefault(i, []).append({
                            "source": _source_display_name(repo_name),
                            "slug": repo_name,
                            "reason": zero_reason_value,
                            "sentence": zero_message,
                            "partial": True,
                            "returned": len(results),
                        })

                store.emit(exec_id, {
                    "type": "repo_done",
                    "repository": repo_name,
                    "index": i + 1,
                    "total_repos": total,
                    "result_count": len(results),
                    "zero_reason": zero_reason_value,
                    "zero_detail": zero_detail_value,
                    # The rendered sentence travels with the event so the
                    # renderer displays what the backend wrote rather than
                    # keeping a second copy of this vocabulary in
                    # TypeScript for the two to drift apart.
                    "zero_message": zero_message,
                    "timestamp": now_iso(),
                })
                # A source that was flagged for a missing key keeps that
                # status -- it explains the zero better than "ok" does --
                # but the count it actually returned is still recorded.
                self._record_source(
                    exec_id, repo_name,
                    "skipped_missing_key" if repo_name in missing_key_repos else "ok",
                    result_count=len(results),
                    credential_name=required_credential_for_sweep(repo_name),
                    zero_reason=zero_reason_value,
                    zero_detail=zero_detail_value,
                )
            except Exception as exc:
                fail(i, repo_name, exc)

        def cancel() -> bool:
            # A source whose search has already returned is recorded as
            # answered, as a one-at-a-time run recorded the source it had just
            # finished before reaching its next checkpoint.
            while True:
                try:
                    finish(finished.get_nowait())
                except queue.Empty:
                    break
            for i in sorted(in_flight):
                repo_name = in_flight[i]["repo"]
                # Mark each in-flight repo as errored for UI clarity, then
                # short-circuit to the cancellation handler. Their worker
                # threads are daemons and are abandoned; each exits when its
                # request returns, and nothing it returns is read.
                store.emit(exec_id, {
                    "type": "repo_error",
                    "repository": repo_name,
                    "index": i + 1,
                    "total_repos": total,
                    "error": "cancelled by user",
                    "timestamp": now_iso(),
                })
                self._record_source(
                    exec_id, repo_name, "cancelled",
                    error_message="cancelled by user",
                )
                task_log.log(f"  {repo_name}: CANCELLED by user")
                name = _source_display_name(repo_name)
                notes_by.setdefault(i, []).append({
                    "source": name, "slug": repo_name, "reason": "cancelled",
                    "sentence": (
                        f"{name} was still being asked when the run was cancelled, "
                        "and nothing it sent was kept. This is not a zero — the "
                        "source did not finish answering."
                    ),
                })
            in_flight.clear()
            # A source the run never reached gets no execution_sources row:
            # there is no outcome to record. The report still names it, so the
            # reader can see every selected source accounted for.
            for i, repo_name in waiting:
                task_log.log(f"  {repo_name}: not asked; the run was cancelled first")
                name = _source_display_name(repo_name)
                notes_by.setdefault(i, []).append({
                    "source": name, "slug": repo_name, "reason": "not_reached",
                    "sentence": (
                        f"{name} was not asked: the run was cancelled before "
                        "resmon reached it."
                    ),
                })
            waiting.clear()
            assemble()
            return True

        while waiting or in_flight:
            while waiting and len(in_flight) < _SOURCE_CONCURRENCY:
                # Cancellation checkpoint
                if store.should_cancel(exec_id):
                    return cancel()
                begin(*waiting.pop(0))
            if not in_flight:
                continue
            due = min(flight["beat"] for flight in in_flight.values())
            try:
                done: Optional[int] = finished.get(timeout=max(0.0, due - time.monotonic()))
            except queue.Empty:
                done = None
            if done is not None:
                finish(done)
            now = time.monotonic()
            if not any(flight["beat"] <= now for flight in in_flight.values()):
                continue
            # Cooperative cancellation: if the user requested cancel while
            # searches are still in flight, stop waiting for them.
            if store.should_cancel(exec_id):
                return cancel()
            # A slow source (e.g. paginated bioRxiv fetches) still produces
            # visible live-log activity for the frontend poller, even though
            # the underlying HTTP calls are synchronous.
            for i in sorted(in_flight):
                flight = in_flight[i]
                if flight["beat"] > now:
                    continue
                elapsed = now - flight["started"]
                store.emit(exec_id, {
                    "type": "query_progress",
                    "repository": flight["repo"],
                    "phase": "searching",
                    "message": f"still querying {flight['repo']} ({elapsed:.0f}s elapsed)",
                    "elapsed": round(elapsed, 1),
                    "timestamp": now_iso(),
                })
                flight["beat"] = now + _HEARTBEAT_SECONDS

        assemble()
        return False

    def _search_source(self, client, repo_name: str, query_params: dict) -> dict:
        """One source's search, on whichever thread runs it. Never raises.

        Returns ``results`` or ``error``, and always ``outcome``: the snapshot
        of the search's outcome channel, taken here because the channel is
        thread-local and the caller cannot reach this thread's.
        """
        holder: dict = {}
        # The outcome channel is thread-local and this thread is fresh per
        # source, but it is reset explicitly rather than relied upon:
        # lifecycle.py also calls safe_request, outside any search, and a
        # thread that is ever reused would carry that value in as if it
        # were this source's answer.
        reset_search_outcome()
        try:
            # 2.1 — a watch routine asks the source about a *person*, and a
            # source that cannot be asked is not called at all. The zero
            # reason is recorded on this thread's own channel, where every
            # other reason is recorded, so it reaches the task log, the
            # monitor, the results row, the search record, the report and
            # the MCP surface with no per-caller edit.
            #
            # **What comes back is a candidate list, never a verdict.** Every
            # record is re-checked against the profile downstream; a source's
            # author search is a generator.
            profile = query_params.get("entity_profile")
            if profile is not None:
                try:
                    holder["results"] = client.search_entity(
                        profile,
                        date_from=query_params.get("date_from"),
                        date_to=query_params.get("date_to"),
                        max_results=query_params.get("max_results", 100),
                    )
                except EntityUnsupported:
                    note_entity_unsupported(self._entity_unsupported_detail(repo_name))
                    holder["results"] = []
            else:
                holder["results"] = client.search(
                    query=query_params.get("query", ""),
                    date_from=query_params.get("date_from"),
                    date_to=query_params.get("date_to"),
                    max_results=query_params.get("max_results", 100),
                )
        except BaseException as exc:  # re-raised by the caller
            holder["error"] = exc
        finally:
            # Snapshotted here, on the thread that owns the channel. The
            # caller cannot read it: by the time it runs, this thread's
            # thread-local is out of reach.
            holder["outcome"] = search_outcome().snapshot()
        return holder

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

        What happened is appended to the run's log, which ``finalize`` has
        already written by the time this runs: a skip, and the upload's start
        and its outcome. A run with this switched on and Google Drive not
        connected otherwise uploads nothing and says so nowhere, which looks
        exactly like an upload that worked.
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
                is_token_stored as _cloud_token_stored,
                probe_api as _cloud_probe_api,
                upload_paths as _upload_paths,
            )
        except Exception as exc:
            logger.warning("auto-backup import failed (exec_id=%d): %s", exec_id, exc)
            return

        # Two checks rather than ``check_connection``'s one boolean, so the
        # log can say which it was: nothing linked, or a link Google refused.
        try:
            if not _cloud_token_stored():
                task_log.append("Auto-backup skipped: Google Drive is not connected.")
                return
            ok, reason = _cloud_probe_api()
            if not ok:
                task_log.append(
                    f"Auto-backup skipped: Google Drive could not be used ({reason or 'no reason given'})."
                )
                return
        except Exception as exc:
            task_log.append(f"Auto-backup connection check failed: {exc}")
            return

        # Only this execution's artifacts. Missing files are filtered by
        # ``upload_paths`` itself.
        paths_to_upload = [p for p in (report_path, log_path) if p]
        folder_name = f"execution-{exec_id}-{time.strftime('%Y%m%d-%H%M%S')}"

        def _run() -> None:
            try:
                task_log.append(
                    f"Auto-backup: uploading execution #{exec_id} artifacts to Google Drive..."
                )
                result = _upload_paths(paths_to_upload, REPORTS_DIR, folder_name=folder_name)
                uploaded = len(result.get("uploaded_ids", []))
                total = result.get("total_files", 0)
                folder = result.get("folder_name") or ""
                task_log.append(
                    f"Auto-backup complete: uploaded {uploaded}/{total} files"
                    + (f" to '{folder}'." if folder else ".")
                )
            except Exception as exc:
                logger.warning("Auto-backup upload failed (exec_id=%d): %s", exec_id, exc)
                try:
                    task_log.append(f"Auto-backup failed: {exc}")
                except Exception:
                    pass

        threading.Thread(target=_run, name=f"resmon-autobackup-{exec_id}", daemon=True).start()

    def _handle_cancellation(
        self,
        exec_id: int,
        task_log: TaskLogger,
        partial_results: list,
        wall_start: float,
        *,
        report_path: Optional[Path] = None,
        log_path: Optional[Path] = None,
    ) -> dict:
        """Clean up and finalize after cooperative cancellation is detected.

        The cancelled run's report, when one was written, and its task log are
        stored where a finished run's are, so the run's Report and Log read
        them the same way.
        """
        store = progress_store
        end_time = now_iso()
        elapsed = time.monotonic() - wall_start

        update_execution_status(
            self.db, exec_id, "cancelled",
            end_time=end_time,
            log_path=str(log_path) if log_path else None,
            result_path=str(report_path) if report_path else None,
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
            "report_path": str(report_path) if report_path else None,
            "log_path": str(log_path) if log_path else None,
            "status": "cancelled",
        }

    # ------------------------------------------------------------------
    # Helpers
    # ------------------------------------------------------------------

    @staticmethod
    def _build_report_docs(results, entity_matches: dict | None = None) -> list[dict]:
        """Convert NormalizedResult list to dicts for report_generator.

        ``entity_matches`` carries the basis onto the page for a watch run. The
        report is saved to disk and can be mailed, and a badge cannot travel —
        so the sentence has to be in the document. A keyword run passes nothing
        and every entry is unchanged.
        """
        matches = entity_matches or {}
        docs = []
        for r in results:
            nr = normalize_result(r)
            if not validate_result(nr):
                continue
            docs.append({
                "title": nr.title,
                # Names for the report, which renders them; the structured
                # authors ride alongside for anything that needs the identity
                # the names cannot carry.
                "authors": nr.author_names,
                "structured_authors": nr.authors,
                "abstract": nr.abstract,
                "publication_date": nr.publication_date,
                "url": nr.url,
                "source_repository": nr.source_repository,
                "external_id": nr.external_id,
                "categories": nr.categories,
            })
            found = matches.get((nr.source_repository, nr.external_id))
            if found is not None:
                docs[-1]["match_basis"] = found[1].basis
                docs[-1]["matched_author"] = found[1].matched_author
        return docs
