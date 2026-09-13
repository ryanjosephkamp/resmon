"""One bounded selected-evidence lane, with consent and terminal ownership.

No ordinary assistant session, durable scheduler or automatic resume is created.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
import os
import queue
import sqlite3
import threading
import time
import uuid
from typing import Callable, Iterator

from . import assistant_choices, assistant_runtime, database, evidence as ev
from . import selected_evidence as se, selected_evidence_context as context

PREVIEW_SECONDS = 600
SUBSCRIBER_SECONDS = 30
MAX_PREVIEWS = 4
MAX_PREVIEW_BYTES = 524288


@dataclass
class Preview:
    preview_id: str
    project_id: str
    expires: float
    expires_at: str
    request: dict
    binding: dict
    selection: dict

    def size(self) -> int:
        return len(se.canonical([self.request,self.binding,self.selection]).encode())


@dataclass
class Job:
    id: int
    answer_id: str
    project_id: str
    vault_id: str
    request_sha256: str
    owner: str
    runtime: object
    native_id: str
    request: dict
    cancelled: threading.Event = field(default_factory=threading.Event)
    completed: threading.Event = field(default_factory=threading.Event)
    events: queue.Queue = field(default_factory=lambda: queue.Queue(maxsize=16))
    lock: threading.RLock = field(default_factory=threading.RLock)
    partial: str = ''
    reports: list = field(default_factory=list)
    sequence: int = 0
    queued_bytes: int = 0
    subscriber: bool = False
    thread: threading.Thread | None = None
    timer: threading.Timer | None = None


class Lane:
    def __init__(self, db_path: str, runtime_id: str, port: int,
                 settings: Callable[[sqlite3.Connection], dict]) -> None:
        ev.identity(runtime_id); ev.integer(port, 1, 65535)
        if port == 8742:
            se.fail('Selected evidence requires an explicit isolated serving port.', 'invalid_port', 409)
        self.db_path = db_path
        self.runtime_id = runtime_id
        self.port = port
        self.settings = settings
        self.lock = threading.RLock()
        self.assembly = threading.Lock()
        self.previews: dict[str, Preview] = {}
        self.job: Job | None = None
        self.blocked = False
        self._startup()

    def _startup(self) -> None:
        conn = database.get_connection(self.db_path)
        try:
            conn.execute('BEGIN IMMEDIATE')
            rows = conn.execute("SELECT * FROM evidence_answers WHERE state IN ('admitted','running') OR cleanup_state IN ('pending','unknown')").fetchall()
            for raw in rows:
                row = dict(raw)
                if row['owner_runtime_id'] == self.runtime_id:
                    self.blocked = True
                    continue
                binding = se.loads(row['private_binding_json'], 4096)
                pid = binding.get('serving_pid')
                # PID reuse is a conservative refusal, never proof of death.
                alive = True
                if type(pid) is int and pid > 0:
                    try:
                        os.kill(pid, 0)
                    except ProcessLookupError:
                        alive = False
                    except OSError:
                        pass
                if alive:
                    self.blocked = True
                    continue
                if row['state'] not in se.TERMINAL:
                    conn.execute("UPDATE evidence_answers SET state='interrupted',finished_at_utc=?,cleanup_state='unknown',"
                                 "error_code='interrupted',error_message=? WHERE id=? AND state IN ('admitted','running')",
                                 (ev.utc_now(),'Backend restarted; last durable prefix retained. Remote completion and previous transport cleanup are unknown.',row['id']))
                # A dead backend does not prove its child/provider stopped.
                self.blocked = True
            conn.commit()
        except BaseException:
            conn.rollback(); raise
        finally:
            conn.close()

    def preview(self, conn: sqlite3.Connection, project_id: str, body: dict, cancel: threading.Event) -> dict:
        if not self.assembly.acquire(blocking=False):
            se.fail('Another preview is being assembled.', 'preview_busy', 409)
        try:
            with self.lock:
                self.previews = {k:p for k,p in self.previews.items() if p.expires > time.monotonic()}
                if len(self.previews) >= MAX_PREVIEWS:
                    se.fail('Four previews are still live. Wait for expiry or use an existing preview.', 'preview_limit', 413)
            snapshot, binding, selection = context.assemble(conn, project_id, body, self.settings(conn), self.runtime_id, cancel=cancel)
            p = Preview(str(uuid.uuid4()), project_id, time.monotonic()+PREVIEW_SECONDS,
                        (datetime.now(timezone.utc)+timedelta(seconds=PREVIEW_SECONDS)).isoformat(), snapshot, binding, selection)
            with self.lock:
                if sum(x.size() for x in self.previews.values())+p.size() > MAX_PREVIEW_BYTES:
                    se.fail('Live previews exceed 512 KiB. Wait for expiry.', 'preview_limit', 413)
                self.previews[p.preview_id] = p
            return {'contract_version':1,'preview_id':p.preview_id,'vault_id':body['expected_vault_id'],
                    'project_id':project_id,'owner_runtime_id':self.runtime_id,'expires_at_utc':p.expires_at,
                    'request_sha256':snapshot['request_sha256'],'request':snapshot}
        finally:
            self.assembly.release()

    def send(self, conn: sqlite3.Connection, project_id: str, body: dict, cancel: threading.Event) -> dict:
        se.keys(body, {'expected_vault_id','expected_runtime_id','preview_id','request_sha256','confirmed'})
        for k in ('expected_vault_id','expected_runtime_id','preview_id'):
            ev.identity(body[k])
        se.digest(body['request_sha256'])
        if body['confirmed'] is not True or body['expected_runtime_id'] != self.runtime_id:
            se.fail('Confirm the exact preview in the same serving runtime.', 'consent_conflict', 409)
        ev.project(conn, body['expected_vault_id'], project_id)
        if not self.assembly.acquire(blocking=False):
            se.fail('Another selection is being assembled or admitted.', 'preview_busy', 409)
        try:
            with self.lock:
                existing = conn.execute('SELECT answer_id,project_id,vault_id,request_sha256,owner_runtime_id FROM evidence_answers WHERE preview_id=?', (body['preview_id'],)).fetchone()
                if existing is not None:
                    old = dict(existing)
                    if (old['project_id']!=project_id or old['vault_id']!=body['expected_vault_id'] or
                            old['request_sha256']!=body['request_sha256'] or old['owner_runtime_id']!=self.runtime_id):
                        se.fail('This consent belongs to another answer.', 'consent_conflict', 409)
                    return se.detail(conn, old['vault_id'], project_id, old['answer_id'])
                preview = self.previews.get(body['preview_id'])
                if (preview is None or preview.project_id!=project_id or preview.expires <= time.monotonic() or
                        preview.request['request_sha256']!=body['request_sha256'] or
                        preview.selection['expected_vault_id']!=body['expected_vault_id']):
                    se.fail('This preview is missing, expired or mismatched. Prepare a new preview.', 'preview_conflict', 409)
                if self.blocked or self.job is not None and not self.job.completed.is_set():
                    se.fail('Selected evidence is busy or prior cleanup is unresolved.', 'lane_busy', 409)
            settings = self.settings(conn)
            snapshot, binding, selection = context.assemble(conn, project_id, preview.selection, settings, self.runtime_id,
                                                             cancel=cancel, frozen_binding=preview.binding)
            if snapshot != preview.request:
                se.fail('Preview content changed. Inspect a new preview before Send.', 'changed_preview', 409)
            runtime = assistant_runtime.get_bound_runtime(binding, settings, backend_port=self.port, profile=se.PROFILE)
            runtime.selected_system_sha256 = snapshot['system_sha256']
            # Freeze system bytes only through the fixed, trusted profile. A
            # changed asset between preview and process construction refuses.
            if context.system_rules() != snapshot['system_text']:
                se.fail('Selected system rules changed.', 'changed_preview', 409)
            with self.lock:
                conn.execute('BEGIN IMMEDIATE')
                try:
                    context.recheck_sql(conn, project_id, selection, snapshot)
                    if assistant_choices.route_digest(self.settings(conn),binding['runtime'],binding['provider']) != binding['route_digest']:
                        se.fail('The selected route changed during admission.', 'changed_route', 409)
                    if cancel.is_set() or preview.expires <= time.monotonic():
                        se.fail('Preview admission was cancelled or expired.', 'preview_conflict', 409)
                    if conn.execute("SELECT 1 FROM evidence_answers WHERE state IN ('admitted','running') OR cleanup_state IN ('pending','unknown') LIMIT 1").fetchone():
                        se.fail('Another selected operation or unresolved cleanup owns this state.', 'lane_busy', 409)
                    if conn.execute('SELECT count(*) FROM evidence_answers WHERE project_id=?', (project_id,)).fetchone()[0] >= 1000:
                        se.fail('This project has 1,000 saved answers; no answer was deleted.', 'history_limit', 413)
                    answer_id, native_id = str(uuid.uuid4()), str(uuid.uuid4())
                    private = {**binding,'serving_pid':os.getpid()}
                    cursor = conn.execute("INSERT INTO evidence_answers(answer_id,preview_id,vault_id,project_id,project_revision,mode,state,"
                                          "request_json,request_sha256,private_binding_json,private_native_session_id,owner_runtime_id,cleanup_state,created_at_utc) "
                                          "VALUES (?,?,?,?,?,?,'admitted',?,?,?,?,?,'not_started',?)",
                                          (answer_id,preview.preview_id,body['expected_vault_id'],project_id,selection['expected_revision'],selection['mode'],
                                           se.canonical(snapshot),snapshot['request_sha256'],se.canonical(private),native_id,self.runtime_id,ev.utc_now()))
                    conn.commit()
                except BaseException:
                    conn.rollback(); raise
                del self.previews[preview.preview_id]
                job = Job(cursor.lastrowid,answer_id,project_id,body['expected_vault_id'],snapshot['request_sha256'],self.runtime_id,runtime,native_id,snapshot)
                self.job = job
                runtime._selected_owned_job = -job.id
                job.thread = threading.Thread(target=self._run, args=(job,), name='selected-evidence-answer', daemon=True)
                job.timer = threading.Timer(SUBSCRIBER_SECONDS, lambda: self.cancel(job.answer_id,job.vault_id,job.project_id,self.runtime_id))
                job.timer.daemon = True
                worker_started = False
                try:
                    job.thread.start(); worker_started = True
                    job.timer.start()
                except Exception:
                    job.cancelled.set()
                    se.finish(conn,answer_id,self.runtime_id,'failed',partial=job.partial,reports=job.reports,
                              code='startup_failed',message='The selected worker or subscriber lease could not start.',
                              cleanup='pending' if worker_started else 'confirmed')
                    if worker_started:
                        # The already-started worker owns its final cleanup.
                        # Never free admission while that transport is alive.
                        runtime.cancel(-job.id)
                    else:
                        job.completed.set()
                return se.detail(conn, job.vault_id,project_id,answer_id)
        finally:
            self.assembly.release()

    def _publish(self, job: Job, kind: str, **values: object) -> None:
        with job.lock:
            job.sequence += 1
            event = {'type':kind,'sequence':job.sequence,'answer_id':job.answer_id,'request_sha256':job.request_sha256,
                     'project_id':job.project_id,'vault_id':job.vault_id,'owner_runtime_id':job.owner,**values}
            size = len(se.canonical(event).encode())
            try:
                if job.queued_bytes+size > 262144:
                    raise queue.Full
                job.events.put_nowait((event,size)); job.queued_bytes += size
            except queue.Full:
                self.cancel(job.answer_id,job.vault_id,job.project_id,job.owner)

    def _run(self, job: Job) -> None:
        conn = database.get_connection(self.db_path)
        iterator = None
        usage = None; normal_done = False; fault = None; last_checkpoint = 0.0
        deadline = time.monotonic()+300
        try:
            cursor = conn.execute("UPDATE evidence_answers SET state='running',started_at_utc=?,cleanup_state='pending' WHERE id=? AND state='admitted' AND owner_runtime_id=?",
                                  (ev.utc_now(),job.id,job.owner)); conn.commit()
            if cursor.rowcount != 1 or job.cancelled.is_set():
                return
            self._publish(job,'progress',state='running',cleanup_state='pending')
            iterator = job.runtime.run_turn(-job.id,job.request['user_prompt'],cli_session_id=job.native_id,resume=False,history=None)
            for event in iterator:
                if job.cancelled.is_set():
                    break
                if time.monotonic() >= deadline:
                    raise TimeoutError('selected operation deadline')
                kind = event.get('type')
                if kind == 'error' or kind in ('tool_call','tool_result'):
                    fault = 'runtime_failure'
                    break
                with job.lock:
                    observation = event.get('model_report')
                    if observation is not None:
                        se.validate_report(observation)
                        candidate = [*job.reports,observation]
                        if len(candidate)>64 or len(se.canonical(candidate).encode())>16384:
                            raise ValueError('model report limit')
                        job.reports = candidate
                        self._publish(job,'report',model_report=observation)
                    if kind == 'text_delta':
                        part = se.text(event['text'],65536)
                        if len((job.partial+part).encode())>65536:
                            raise ValueError('output limit')
                        job.partial += part
                        self._publish(job,'partial',partial_text=job.partial,validation='unvalidated')
                    if kind == 'done':
                        if normal_done or event.get('is_error') or event.get('subtype') != 'success':
                            raise ValueError('unsuccessful completion')
                        normal_done = True
                        usage = {k:event[k] for k in ('input_tokens','output_tokens','cache_read_tokens','cache_creation_tokens')
                                 if type(event.get(k)) is int and event[k]>=0}
                        usage = {'reported':usage,'provenance':'runtime_report','billing':'unknown'} if usage else None
                    if time.monotonic()-last_checkpoint >= 1:
                        conn.execute("UPDATE evidence_answers SET partial_text=?,reports_json=? WHERE id=? AND owner_runtime_id=? AND state='running'",
                                     (job.partial,se.canonical(job.reports),job.id,job.owner)); conn.commit()
                        last_checkpoint = time.monotonic()
            with job.lock:
                if not job.cancelled.is_set():
                    if fault or not normal_done:
                        raise ValueError('missing normal completion')
                    result = se.validate_result(job.partial,job.request)
                    state = 'succeeded' if result['status']=='answer' else 'refused'
                    se.finish(conn,job.answer_id,job.owner,state,partial=job.partial,reports=job.reports,result=result,usage=usage)
        except Exception:
            with job.lock:
                se.finish(conn,job.answer_id,job.owner,'failed',partial=job.partial,reports=job.reports,usage=usage,
                          code='invalid_or_incomplete_output',message='The selected response failed runtime or exact structured-citation validation. Saved text is unvalidated; no repair request was sent.')
        finally:
            if job.timer:
                job.timer.cancel()
            # Closing an interrupted iterator invokes the runtime's owned finally.
            cleanup = 'confirmed'
            try:
                if iterator is not None:
                    iterator.close()
                job.runtime.cancel(-job.id)
                if assistant_runtime.is_running(-job.id):
                    cleanup = 'unknown'
            except Exception:
                cleanup = 'unknown'
            conn.execute("UPDATE evidence_answers SET cleanup_state=? WHERE id=? AND owner_runtime_id=? AND state IN ('succeeded','refused','failed','cancelled','interrupted')",
                         (cleanup,job.id,job.owner)); conn.commit()
            if cleanup == 'unknown':
                self.blocked = True
            saved = se.row(conn,job.vault_id,job.project_id,job.answer_id)
            self._publish(job,'terminal',state=saved['state'],cleanup_state=saved['cleanup_state'])
            job.completed.set()
            conn.close()

    def cancel(self, answer_id: str, vault_id: str, project_id: str, runtime_id: str) -> dict:
        if runtime_id != self.runtime_id:
            se.fail('The serving runtime changed.', 'wrong_runtime', 409)
        conn = database.get_connection(self.db_path)
        try:
            saved = se.row(conn,vault_id,project_id,answer_id)
            job = self.job
            if saved['state'] not in se.TERMINAL:
                if job is None or job.answer_id != answer_id or saved['owner_runtime_id']!=self.runtime_id:
                    se.fail('This process does not own that active answer.', 'wrong_owner', 409)
                with job.lock:
                    job.cancelled.set()
                    se.finish(conn,answer_id,self.runtime_id,'cancelled',partial=job.partial,reports=job.reports,
                              code='cancelled',message='Cancelled locally. Remote completion and billing remain unknown.')
                job.runtime.cancel(-job.id)
            return se.detail(conn,vault_id,project_id,answer_id)
        finally:
            conn.close()

    def subscribe(self, answer_id: str, vault_id: str, project_id: str, runtime_id: str) -> Job:
        if runtime_id != self.runtime_id:
            se.fail('The serving runtime changed.', 'wrong_runtime', 409)
        job = self.job
        if job is None or (job.answer_id,job.vault_id,job.project_id)!=(answer_id,vault_id,project_id):
            se.fail('This answer has no current owned event stream. Reopen its saved state.', 'no_active_stream', 409)
        with job.lock:
            if job.subscriber:
                se.fail('This answer already has a live subscriber.', 'subscriber_busy', 409)
            job.subscriber = True
            if job.timer:
                job.timer.cancel()
        return job

    def next_event(self, job: Job) -> dict | None:
        try:
            event,size = job.events.get(timeout=0.2)
            with job.lock:
                job.queued_bytes -= size
            return event
        except queue.Empty:
            return None

    def shutdown(self) -> None:
        job = self.job
        if job is not None and not job.completed.is_set():
            self.cancel(job.answer_id,job.vault_id,job.project_id,self.runtime_id)
            if job.thread:
                job.thread.join(timeout=65)
            if not job.completed.is_set():
                self.blocked = True
        self.previews.clear()
