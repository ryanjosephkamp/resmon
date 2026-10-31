import { useState, type ReactNode } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { answer, engine, EngineError } from '../../api/client';
import type { components } from '../../api/schema';
import { queueWords } from '../collection/Paper';
import { authors, number, publishedWords } from '../today/format';
import { saveReport, saveSearchRecord } from './downloads';
import { Markdown } from './markdown';
import {
  absentRecordWords, dayAndTime, eventTime, localStamp, reportInLocalTime, storedInstant, type LiveSource, type ProgressEvent,
  type Run,
} from './model';
import { LivePanel } from './LivePanel';

/** One of a run's papers, with its place in the reading queue. */
export type RunPaper = components['schemas']['RunPaper'];

const TABS = ['Papers', 'Report', 'Search record', 'Log', 'Metadata', 'Progress'] as const;
type Tab = typeof TABS[number];

interface Props {
  run: Run;
  live: LiveSource[];
  names: ReadonlyMap<string, string>;
  events: ProgressEvent[];
  papers: { papers: RunPaper[]; total: number } | null;
  running: boolean;
}

/** The run's own record, one tab at a time, each read only when it is opened. */
export function RunTabs({ run, live, names, events, papers, running }: Props) {
  const [tab, setTab] = useState<Tab>('Papers');
  return (
    <section className="run-record" aria-label="The run's record">
      <div className="run-tabs" role="tablist" aria-label="Record">
        {TABS.map((name) => (
          <button
            key={name}
            type="button"
            role="tab"
            id={`run-tab-${name}`}
            aria-selected={tab === name}
            aria-controls="run-tab-panel"
            onClick={() => setTab(name)}
          >
            {name}
            {name === 'Progress' && running && <i className="live-dot" aria-label="live" />}
          </button>
        ))}
      </div>
      <div className="run-panel" role="tabpanel" id="run-tab-panel" aria-labelledby={`run-tab-${tab}`}>
        {tab === 'Papers' && <Papers runId={run.id} papers={papers} running={running} names={names} />}
        {tab === 'Report' && <TextRecord run={run} kind="report" running={running} />}
        {tab === 'Log' && <TextRecord run={run} kind="log" running={running} />}
        {tab === 'Search record' && <SearchRecord id={run.id} settledAt={running ? null : run.end_time} />}
        {tab === 'Metadata' && <Metadata run={run} />}
        {tab === 'Progress' && <Progress live={live} names={names} events={events} />}
      </div>
    </section>
  );
}

function Papers({ runId, papers, running, names }: Pick<Props, 'papers' | 'running' | 'names'> & { runId: number }) {
  const client = useQueryClient();
  const save = useMutation({
    mutationFn: (documentId: number) => answer(engine().POST('/api/reading-queue', { body: { document_id: documentId } })),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: ['run-papers', runId] });
      void client.invalidateQueries({ queryKey: ['reading-queue'] });
    },
  });
  if (running) return <p className="record-cap">The run&rsquo;s papers are listed when it has finished storing them.</p>;
  if (!papers) return <p className="record-cap">Reading the run&rsquo;s papers.</p>;
  if (!papers.papers.length) return <p className="record-cap">This run stored no papers.</p>;
  return (
    <>
      <p className="record-cap">
        {papers.total > papers.papers.length
          ? `The first ${number(papers.papers.length)} of ${number(papers.total)} papers this run stored.`
          : `${number(papers.total)} ${papers.total === 1 ? 'paper' : 'papers'} this run stored.`}
      </p>
      <ol className="paper-list">
        {papers.papers.map((paper) => {
          const state = queueWords(paper.queue_status);
          return (
            <li key={paper.id} className="paper-row" data-document={paper.id} data-queue={paper.queue_status ?? 'none'}>
              <div className="paper-row-main">
                <Link to={`/papers/${paper.id}`} className="paper-title">{paper.title || 'Untitled'}</Link>
                <span className="meta">
                  <span className="who">{authors(paper.authors)}</span>
                  <span className="sep" /><span>{names.get(paper.source_repository) ?? paper.source_repository}</span>
                  {paper.publication_date && (<><span className="sep" /><span>{publishedWords(paper.publication_date)}</span></>)}
                  {paper.url && (<><span className="sep" /><a href={paper.url} target="_blank" rel="noreferrer">open</a></>)}
                </span>
              </div>
              {state
                ? <span className="queue-state saved" data-status={paper.queue_status}>Saved · {state}</span>
                : (
                  <button type="button" className="btn sm" disabled={save.isPending && save.variables === paper.id}
                    onClick={() => save.mutate(paper.id)}>Save to read</button>
                )}
            </li>
          );
        })}
      </ol>
      {save.error && <p className="field-error" role="alert">The paper could not be saved: {save.error.message}.</p>}
    </>
  );
}

/**
 * The report or the log, as resmon wrote it. Where there is none, the tab
 * says why in the run's own terms (still going, stopped, interrupted, or a
 * file that has gone from where it was written), never as a route and a
 * status code.
 */
function TextRecord({ run, kind, running }: { run: Run; kind: 'report' | 'log'; running: boolean }) {
  const id = run.id;
  const text = useQuery({
    queryKey: ['run-text', id, kind, running],
    queryFn: async () => (kind === 'report'
      ? (await answer(engine().GET('/api/executions/{exec_id}/report', { params: { path: { exec_id: id } } }))).report_text
      : (await answer(engine().GET('/api/executions/{exec_id}/log', { params: { path: { exec_id: id } } }))).log_text),
    retry: false,
  });
  if (text.isPending) return <p className="record-cap">Reading the {kind}.</p>;
  if (text.isError) {
    const status = text.error instanceof EngineError ? text.error.status : 0;
    const detail = text.error instanceof EngineError ? text.error.detail : null;
    return <p className="record-cap" data-record="absent">{absentRecordWords(run, kind, running, status, detail)}</p>;
  }
  if (kind === 'log') return <pre className="record-text is-log">{text.data}</pre>;
  return (
    <>
      <div className="record-bar">
        <button type="button" className="btn sm" data-record="save-report" onClick={() => saveReport(id, text.data)}>
          Save as Markdown
        </button>
      </div>
      <div className="record-text is-report"><Markdown text={reportInLocalTime(text.data)} /></div>
    </>
  );
}

/** The search record, as the engine dates and accounts for it. `/search-record` declares no model. */
interface SearchRecordData {
  generated_at?: string;
  search?: Record<string, unknown>;
  identification?: Record<string, unknown>;
  deduplication?: Record<string, unknown>;
  caveats?: string[];
}

function words(key: string): string {
  const text = key.replace(/_/g, ' ');
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function Value({ value }: { value: unknown }): ReactNode {
  if (value === null || value === undefined || value === '') return <span className="nr">not recorded</span>;
  if (Array.isArray(value)) return value.length ? value.map(String).join(', ') : <span className="nr">none</span>;
  if (typeof value === 'object') {
    return (
      <dl className="record-dl nested">
        {Object.entries(value as Record<string, unknown>).map(([k, v]) => (
          <div key={k}><dt>{words(k)}</dt><dd><Value value={v} /></dd></div>
        ))}
      </dl>
    );
  }
  if (typeof value === 'boolean') return value ? 'yes' : 'no';
  // A stored instant reads as a local day and time, as the run's heading does; a plain date stays a date.
  if (typeof value === 'string') return localStamp(value) ?? value;
  return String(value);
}

function SearchRecord({ id, settledAt }: { id: number; settledAt: string | null | undefined }) {
  const record = useQuery({
    queryKey: ['run-record', id, settledAt],
    queryFn: async () => (await answer(engine().GET('/api/executions/{exec_id}/search-record', {
      params: { path: { exec_id: id } },
    }))) as unknown as SearchRecordData,
  });
  const save = useMutation({ mutationFn: () => saveSearchRecord(id) });
  if (record.isPending) return <p className="record-cap">Reading the search record.</p>;
  if (record.isError) {
    const detail = record.error instanceof EngineError ? record.error.detail : null;
    return <p className="record-cap">The search record could not be read{detail ? `: ${detail}` : '. The engine did not answer.'}</p>;
  }
  const data = record.data;
  const generated = storedInstant(data.generated_at);
  return (
    <div className="search-record">
      <div className="record-bar">
        <button type="button" className="btn sm" data-record="save-search-record" disabled={save.isPending} onClick={() => save.mutate()}>
          Save as Markdown
        </button>
        {save.error && (
          <span className="field-error" role="alert">
            {save.error instanceof EngineError && save.error.detail ? save.error.detail : save.error.message}
          </span>
        )}
      </div>
      {data.generated_at && <p className="record-cap">Generated {generated ? dayAndTime(generated) : data.generated_at} from what resmon saved.</p>}
      {(['search', 'identification', 'deduplication'] as const).map((block) => data[block] && (
        <section key={block}>
          <h3>{words(block)}</h3>
          <dl className="record-dl">
            {Object.entries(data[block] as Record<string, unknown>).map(([k, v]) => (
              <div key={k}><dt>{words(k)}</dt><dd><Value value={v} /></dd></div>
            ))}
          </dl>
        </section>
      ))}
      {data.caveats && data.caveats.length > 0 && (
        <section>
          <h3>Caveats</h3>
          <ul className="record-caveats">{data.caveats.map((c) => <li key={c}>{c}</li>)}</ul>
        </section>
      )}
    </div>
  );
}

function Metadata({ run }: { run: Run }) {
  // `ai_lanes` is said in words under the run's head.
  const skip = new Set(['coverage', 'identity', 'progress_events', 'source_outcomes', 'ai_lanes']);
  return (
    <dl className="record-dl">
      {Object.entries(run).filter(([k]) => !skip.has(k)).map(([k, v]) => (
        <div key={k}><dt>{words(k)}</dt><dd><Value value={v} /></dd></div>
      ))}
    </dl>
  );
}

/**
 * Progress updates the engine emits many times a stage ("still querying",
 * one per paper linked). The live panel and the stage lines already say what
 * they say, so the timeline leaves them out rather than listing hundreds.
 */
const TICKS: ReadonlySet<string> = new Set(['query_progress', 'link_progress', 'dedup_progress']);

/**
 * The timeline's lines, with a run of identical consecutive lines folded into
 * one. A stopped run's trailing `complete` repeats its `cancelled` line, so it
 * is left out, as the classic activity log leaves it out.
 */
function timelineOf(events: readonly ProgressEvent[], names: ReadonlyMap<string, string>): { at: string; words: string; times: number }[] {
  const out: { at: string; words: string; times: number }[] = [];
  for (const event of events) {
    if (TICKS.has(event.type)) continue;
    if (event.type === 'complete' && event.status === 'cancelled') continue;
    const words = eventWords(event, names);
    const last = out[out.length - 1];
    if (last && last.words === words) last.times += 1;
    else out.push({ at: eventTime(event.timestamp), words, times: 1 });
  }
  return out;
}

function Progress({ live, names, events }: { live: LiveSource[]; names: ReadonlyMap<string, string>; events: ProgressEvent[] }) {
  const timeline = timelineOf(events, names);
  return (
    <div className="progress">
      <LivePanel sources={live} names={names} />
      <h3>Events</h3>
      {timeline.length === 0
        ? <p className="record-cap">No progress events were recorded for this run.</p>
        : (
          <ol className="events">
            {timeline.map((line, index) => (
              // Events carry no id; their order is their identity.
              <li key={index}>
                <span className="num">{line.at}</span>
                <span>{line.words}{line.times > 1 && <span className="times"> ({line.times} times)</span>}</span>
              </li>
            ))}
          </ol>
        )}
    </div>
  );
}

function eventWords(event: ProgressEvent, names: ReadonlyMap<string, string>): string {
  const source = event.repository ? names.get(event.repository) ?? event.repository : 'A source';
  switch (event.type) {
    case 'execution_start': return 'The run started.';
    case 'stage': return event.message || `Stage: ${event.stage ?? ''}`;
    case 'repo_start': return `Asking ${source}.`;
    case 'repo_done': return event.zero_message
      ? `${source}: ${event.zero_message}`
      : `${source} answered with ${event.result_count ?? 'an unrecorded number of'} records.`;
    case 'repo_skipped_missing_key': return `${source} not queried: no API key.`;
    case 'repo_error': return event.error === 'cancelled by user'
      ? `${source}: cancelled while it was being asked.`
      : `${source}: ${event.error ?? 'error'}`;
    case 'complete': return `The run finished: ${event.status ?? 'status not recorded'}.`;
    case 'cancelled': return 'The run was cancelled.';
    case 'error': return `The run failed: ${event.error ?? 'reason not recorded'}.`;
    default: return event.message || event.type.replace(/_/g, ' ');
  }
}
