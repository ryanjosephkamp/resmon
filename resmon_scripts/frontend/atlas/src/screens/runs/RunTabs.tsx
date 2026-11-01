import type { ReactNode } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { answer, engine, EngineError } from '../../api/client';
import type { components } from '../../api/schema';
import { queueWords } from '../collection/Paper';
import { authors, number, publishedWords } from '../today/format';
import { invalidateFor } from '../today/freshness';
import { sourceName } from '../health/model';
import { scheduleText } from '../watches/model';
import { runWindowSentence } from '../watches/window';
import { saveReport, saveSearchRecord } from './downloads';
import { Markdown } from './markdown';
import {
  absentRecordWords, dayAndTime, eventTime, localStamp, logForReading, reportInLocalTime, runKind, storedInstant,
  type LiveSource, type ProgressEvent, type Run,
} from './model';
import { LivePanel } from './LivePanel';
import { RunMap } from './RunMap';

/** One of a run's papers, with its place in the reading queue. */
export type RunPaper = components['schemas']['RunPaper'];

export const TABS = ['Papers', 'Map', 'Report', 'Search record', 'Log', 'Metadata', 'Progress'] as const;
export type Tab = typeof TABS[number];

interface Props {
  run: Run;
  live: LiveSource[];
  names: ReadonlyMap<string, string>;
  events: ProgressEvent[];
  papers: { papers: RunPaper[]; total: number } | null;
  running: boolean;
  /** The open tab, held by the page so its sky can open the map. */
  tab: Tab;
  onTab: (tab: Tab) => void;
}

/**
 * The run's own record, one tab at a time, each read only when it is opened.
 *
 * The run's map is a tab rather than a section of the page: exploring a map
 * needs a fixed frame (the wheel zooms it, so it cannot sit in a page the
 * wheel scrolls past) and a column beside it for the paper chosen, which the
 * page's own side column, under 400 pixels, cannot hold. As a tab it has the
 * record's full width, and nothing of it is drawn until it is opened.
 */
export function RunTabs({ run, live, names, events, papers, running, tab, onTab }: Props) {
  return (
    <section className="run-record" id="run-record" aria-label="The run's record">
      <div className="run-tabs" role="tablist" aria-label="Record">
        {TABS.map((name) => (
          <button
            key={name}
            type="button"
            role="tab"
            id={`run-tab-${name}`}
            aria-selected={tab === name}
            aria-controls="run-tab-panel"
            onClick={() => onTab(name)}
          >
            {name}
            {name === 'Progress' && running && <i className="live-dot" aria-label="live" />}
          </button>
        ))}
      </div>
      <div className="run-panel" role="tabpanel" id="run-tab-panel" aria-labelledby={`run-tab-${tab}`}>
        {tab === 'Papers' && <Papers runId={run.id} papers={papers} running={running} names={names} />}
        {tab === 'Map' && <RunMap runId={run.id} running={running} settledAt={running ? null : run.end_time ?? run.status}
          endedAt={running ? null : run.end_time ?? null} names={names} />}
        {tab === 'Report' && <TextRecord run={run} kind="report" running={running} names={names} />}
        {tab === 'Log' && <TextRecord run={run} kind="log" running={running} names={names} />}
        {tab === 'Search record' && <SearchRecord run={run} settledAt={running ? null : run.end_time} />}
        {tab === 'Metadata' && <Metadata run={run} names={names} />}
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
      void invalidateFor(client, 'paper-changed');
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
function TextRecord({ run, kind, running, names }: {
  run: Run; kind: 'report' | 'log'; running: boolean; names: ReadonlyMap<string, string>;
}) {
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
  if (kind === 'log') {
    const log = logForReading(text.data, (slug) => sourceName(slug, names), run.coverage.sources);
    return (
      <>
        <p className="record-cap" data-record="log-note">{log.note}</p>
        <pre className="record-text is-log">{log.text}</pre>
      </>
    );
  }
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

/** One source's query, as the search record lists what its requests carried. */
interface QuerySent {
  source: string;
  name: string;
  sent: string[];
  omitted: number;
  note: string | null;
}

/** The search record, as the engine dates and accounts for it. `/search-record` declares no model. */
interface SearchRecordData {
  generated_at?: string;
  search?: Record<string, unknown>;
  identification?: Record<string, unknown>;
  deduplication?: Record<string, unknown>;
  caveats?: string[];
}

/** Labels a person reads, where a record's own key would not do. */
const LABELS: Readonly<Record<string, string>> = {
  prisma: 'PRISMA box',
  sources_searched: 'Sources selected',
  last_seen_at_utc: 'Last seen working at',
  execution_type: 'Kind',
  routine_id: 'Watch id',
  saved_configuration_id: 'Saved search id',
  saved_configuration_name: 'Saved search',
  repositories: 'Sources',
  max_results: 'Most papers per source',
  date_window_computed: 'How the dates were set',
  query: 'Query, as typed',
  keywords: 'Search terms, as typed',
  queries_sent: 'Query as sent',
  author_queries: 'Person query as sent',
};

function words(key: string): string {
  const label = LABELS[key];
  if (label) return label;
  const text = key.replace(/_/g, ' ');
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/**
 * Fields whose empty value is not a gap in the record. A figure's
 * `not_recorded_reason` is empty because the figure was recorded, and is left
 * out; a `prisma` box that is empty is one PRISMA does not have.
 */
const EMPTY_MEANS: Readonly<Record<string, string | null>> = {
  not_recorded_reason: null,
  prisma: 'none: PRISMA has no box for it',
};

function Value({ value }: { value: unknown }): ReactNode {
  if (value === null || value === undefined || value === '') return <span className="nr">not recorded</span>;
  if (Array.isArray(value)) return value.length ? value.map(String).join(', ') : <span className="nr">none</span>;
  if (typeof value === 'object') {
    const empty = (v: unknown) => v === null || v === undefined || v === '';
    return (
      <dl className="record-dl nested">
        {Object.entries(value as Record<string, unknown>)
          .filter(([k, v]) => !(empty(v) && k in EMPTY_MEANS && EMPTY_MEANS[k] === null))
          .map(([k, v]) => (
            <div key={k}><dt>{words(k)}</dt><dd>{empty(v) && EMPTY_MEANS[k] ? EMPTY_MEANS[k] : <Value value={v} />}</dd></div>
          ))}
      </dl>
    );
  }
  if (typeof value === 'boolean') return value ? 'yes' : 'no';
  // A stored instant reads as a local day and time, as the run's heading does; a plain date stays a date.
  if (typeof value === 'string') return localStamp(value) ?? value;
  return String(value);
}

/**
 * What each source's requests carried, one source a line: arXiv's `all:`
 * terms and its date clause, Crossref's query and filter. A source asked
 * nothing, or whose client does not say what it sends, says so in the
 * engine's words; the words typed are never shown here as if they were sent.
 */
function QueriesSent({ queries }: { queries: QuerySent[] | null | undefined }) {
  if (!queries) {
    return <span className="nr">Not recorded for this run. The words it was given are above, as typed.</span>;
  }
  if (!queries.length) return <span className="nr">none</span>;
  return (
    <ul className="queries-sent">
      {queries.map((query) => (
        <li key={query.source} data-source={query.source}>
          <span className="queries-sent-source">{query.name}</span>
          {query.sent.length > 0
            ? query.sent.map((sent) => <code key={sent} className="queries-sent-query">{sent}</code>)
            : <span className="nr">{query.note}</span>}
          {query.omitted > 0 && <span className="nr">and {query.omitted} more like these</span>}
        </li>
      ))}
      <li className="nr">Each request as resmon sent it, without its paging, contact address, or key.</li>
    </ul>
  );
}

/** A record field as a string, or null. */
function text(value: unknown): string | null {
  return typeof value === 'string' && value ? value : typeof value === 'number' ? String(value) : null;
}

/**
 * The search, in the words the run's own page uses: its kind, its times in
 * the reader's zone, its dates as the heading says them, and each source's
 * query as sent. A field that does not apply to the run (a watch for a search
 * asked by hand) is left out rather than called not recorded.
 */
function SearchFacts({ search, run }: { search: Record<string, unknown>; run: Run }) {
  const keywords = Array.isArray(search.keywords) ? search.keywords.map(String) : [];
  const watch = text(search.routine_name);
  const schedule = text(search.routine_schedule);
  const saved = text(search.configuration_name);
  const rows: [string, ReactNode][] = [
    ['Run', text(search.execution_id) ?? <span className="nr">not recorded</span>],
    ['Kind', text(search.execution_type) ? runKind(String(search.execution_type)) : <span className="nr">not recorded</span>],
    ['Run at', <Value value={search.run_at} />],
    ['Completed at', <Value value={search.completed_at} />],
    ['Status', <Value value={search.status} />],
    // The words typed; what each source was sent is the next row.
    ['Search terms, as typed', keywords.length ? keywords.join(', ') : <span className="nr">none</span>],
    ['Query as sent', <QueriesSent queries={search.queries_as_sent as QuerySent[] | null | undefined} />],
    ['Dates', runWindowSentence(run.parameters) ?? <span className="nr">not recorded</span>],
    ['Most papers per source', <Value value={search.max_results_per_source} />],
  ];
  if (watch) rows.push(['Watch', watch]);
  if (schedule) rows.push(['Schedule', scheduleText(schedule) ?? <code className="cron">{schedule}</code>]);
  if (saved) rows.push(['Saved search', saved]);
  return (
    <dl className="record-dl" data-record="search">
      {rows.map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}
    </dl>
  );
}

function SearchRecord({ run, settledAt }: { run: Run; settledAt: string | null | undefined }) {
  const id = run.id;
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
      {data.generated_at && (
        <p className="record-cap">
          Generated {generated ? dayAndTime(generated) : data.generated_at} from what resmon saved. Times here are in this
          computer’s time zone; the Markdown file gives them in UTC.
        </p>
      )}
      {data.search && (
        <section>
          <h3>Search</h3>
          <SearchFacts search={data.search} run={run} />
        </section>
      )}
      {(['identification', 'deduplication'] as const).map((block) => data[block] && (
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

/**
 * Fields of a run where empty is a fact rather than a gap: a search asked by
 * hand belongs to no watch, a run that did not fail has no error, and a run
 * asked with no start date has none. Said as "none", never as not recorded.
 */
const EMPTY_IS_NONE: ReadonlySet<string> = new Set([
  'routine_id', 'saved_configuration_id', 'saved_configuration_name', 'error_message', 'cancel_reason',
  'interrupted_reason', 'restarted_from', 'date_from', 'date_to',
]);

function OrNone({ field, value }: { field: string; value: unknown }): ReactNode {
  if ((value === null || value === undefined || value === '') && EMPTY_IS_NONE.has(field)) return <span className="nr">none</span>;
  return <Value value={value} />;
}

/** A source's query, as a run's stored parameters keep it: `{ sent: [...] }`, or null for a client that does not say. */
function sentWords(entry: unknown): string {
  if (entry === null) return 'not recorded: its client does not say what it sends';
  if (!entry || typeof entry !== 'object') return 'not recorded';
  const record = entry as Record<string, unknown>;
  if (Array.isArray(record.sent)) return record.sent.length ? record.sent.map(String).join(' | ') : 'nothing sent';
  // A person watch's author query: `{ kind, value }`.
  if (typeof record.value === 'string') return record.kind === 'query' ? record.value : `${String(record.kind)} ${record.value}`;
  return JSON.stringify(entry);
}

/** The run's stored parameters, each under a label a person reads and each source by name. */
function Parameters({ raw, nameOf }: { raw: string | null; nameOf: (slug: string) => string }) {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw ?? '');
  } catch {
    return <Value value={raw} />;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return <Value value={raw} />;
  const value = (key: string, v: unknown): ReactNode => {
    if (key === 'repositories' && Array.isArray(v)) return v.map((slug) => nameOf(String(slug))).join(', ') || <span className="nr">none</span>;
    if ((key === 'queries_sent' || key === 'author_queries') && v && typeof v === 'object') {
      // In the order the run selected its sources, as the search record lists them.
      const selected = (parsed as Record<string, unknown>).repositories;
      const order = Array.isArray(selected) ? selected.map(String) : [];
      const at = (slug: string) => (order.includes(slug) ? order.indexOf(slug) : order.length);
      return (
        <dl className="record-dl nested">
          {Object.entries(v as Record<string, unknown>).sort(([a], [b]) => at(a) - at(b)).map(([slug, entry]) => (
            <div key={slug}><dt>{nameOf(slug)}</dt><dd>{sentWords(entry)}</dd></div>
          ))}
        </dl>
      );
    }
    if (key === 'date_window_computed' && v && typeof v === 'object' && typeof (v as { sentence?: unknown }).sentence === 'string') {
      return (v as { sentence: string }).sentence;
    }
    return <OrNone field={key} value={v} />;
  };
  return (
    <dl className="record-dl nested">
      {Object.entries(parsed as Record<string, unknown>).map(([k, v]) => (
        <div key={k}><dt>{words(k)}</dt><dd>{value(k, v)}</dd></div>
      ))}
    </dl>
  );
}

/**
 * Everything the engine keeps about the run, every field, each under a label
 * a person reads: its kind in words, each source by name, and each instant
 * in the reader's own time zone, whatever the field is called in the engine.
 */
function Metadata({ run, names }: { run: Run; names: ReadonlyMap<string, string> }) {
  // `ai_lanes` is said in words under the run's head.
  const skip = new Set(['coverage', 'identity', 'progress_events', 'source_outcomes', 'ai_lanes']);
  const nameOf = (slug: string) => sourceName(slug, names);
  const value = (key: string, v: unknown): ReactNode => {
    if (key === 'execution_type' && typeof v === 'string') return runKind(v);
    if (key === 'repositories' && Array.isArray(v)) return v.map((slug) => nameOf(String(slug))).join(', ') || <span className="nr">none</span>;
    if (key === 'parameters') return <Parameters raw={typeof v === 'string' ? v : null} nameOf={nameOf} />;
    return <OrNone field={key} value={v} />;
  };
  return (
    <dl className="record-dl">
      {Object.entries(run).filter(([k]) => !skip.has(k)).map(([k, v]) => (
        <div key={k}><dt>{words(k)}</dt><dd>{value(k, v)}</dd></div>
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
