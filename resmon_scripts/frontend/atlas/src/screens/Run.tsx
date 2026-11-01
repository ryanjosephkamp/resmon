import { useMemo, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { answer, engine, EngineError } from '../api/client';
import { Icon } from '../shell/Icon';
import { breakable } from '../shell/breakable';
import { SAVED_KEY, savedFromRun } from './collection/savedSearches';
import { duration, when } from './today/format';
import { useRunEnding } from './today/freshness';
import {
  deletedSentence, deleteQuestion, FINAL_EVENTS, interruptedSentence, liveSources, RESTARTABLE, runKind, runTitle,
  selectedSources, type CoverageSource, type ProgressEvent, type Run as RunData,
} from './runs/model';
import { saveBundle } from './runs/downloads';
import { useDeleteRuns } from './runs/remove';
import { RestartFacts } from './runs/RestartFacts';
import { exportReferences, FORMATS, type ReferenceFormat } from './runs/references';
import { RUNS_KEY, type RunLogNotice } from './runs/RunLog';
import { RunSky } from './runs/RunSky';
import { MapPaper } from './sky/MapPaper';
import type { PaperSkyHandle, SkyChoice } from './sky/PaperSky';
import { LivePanel } from './runs/LivePanel';
import { RunTabs, type RunPaper, type Tab } from './runs/RunTabs';
import { aiChoiceOf, needsSignIn, runSummaries } from './runs/summaries';
import { CliSignIn } from './settings/CliSignIn';
import { runWindowSentence } from './watches/window';
import { commandEnter } from '../shell/shortcuts';

/** How many of a run's papers are read for the sky; a sweep can store thousands. */
const SKY_LIMIT = 2_000;

/** The engine's own sentence for a refusal where it gave one, otherwise what failed. */
function refusal(error: Error): string {
  return error instanceof EngineError && error.detail ? error.detail : error.message;
}

/**
 * A recorded outcome's mark: filled for an answer, half filled for an answer
 * in part, a ring for unknown, the fault mark for a non-answer.
 */
function OutcomeMark({ category, inPart }: { category: string; inPart: boolean }) {
  if (category === 'non_answer') return <span className="omark fault" aria-hidden="true"><Icon name="fault" size={14} /></span>;
  if (category === 'answered' && inPart) return <span className="omark part" aria-hidden="true" />;
  return <span className={category === 'answered' ? 'omark on' : 'omark'} aria-hidden="true" />;
}

/**
 * One run's account: what it asked, what each source did, where its papers
 * sit in the collection, and the run's own record (report, search record,
 * log, metadata, progress).
 *
 * While the run is running the sources are the live panel, read from the
 * run's progress events every second. Once it has settled they are the
 * recorded coverage the engine builds from the saved per-source rows, led by
 * its one-sentence summary; the live panel stays in the Progress tab, so the
 * two accounts can be compared rather than one drawn from the other.
 */
/** Whether the run summarized its papers, with what, and what each connection it tried did. */
function RunSummaryNote({ run, events }: { run: RunData; events: ProgressEvent[] | null }) {
  if (!events) return null;
  const said = runSummaries(run, events);
  return (
    <div className="run-ai" data-run="summaries" data-on={said.on === null ? 'unknown' : String(said.on)}>
      <p><span className="run-ai-label">Summaries</span> {said.head}</p>
      {said.lanes.length > 0 && (
        <ul className="run-ai-lanes">
          {said.lanes.map((line, i) => {
            const lane = run.ai_lanes[i];
            return (
              <li key={i} data-outcome={lane?.outcome}>
                {line}
                {/* The command said it is not signed in: the way to sign it in, right here. */}
                {lane && needsSignIn(lane) && <CliSignIn provider={lane.provider} purpose="summaries" checkOnOpen={false} />}
              </li>
            );
          })}
        </ul>
      )}
      {said.note && <p className="run-ai-note">{said.note}</p>}
    </div>
  );
}

export function Run() {
  const { id: raw } = useParams();
  const id = Number(raw);
  const navigate = useNavigate();
  const client = useQueryClient();
  const [now] = useState(() => new Date());
  const [tab, setTab] = useState<Tab>('Papers');
  // The map is opened and then scrolled to, once the tab has drawn it and the page is its full height.
  const openMap = () => {
    setTab('Map');
    requestAnimationFrame(() => document.getElementById('run-record')?.scrollIntoView({
      block: 'start', behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth',
    }));
  };

  const run = useQuery({
    queryKey: ['run', id],
    enabled: Number.isInteger(id) && id > 0,
    queryFn: () => answer(engine().GET('/api/executions/{exec_id}', { params: { path: { exec_id: id } } })),
    refetchInterval: (query) => (query.state.data?.status === 'running' ? 1_000 : false),
  });
  const running = run.data?.status === 'running';
  useRunEnding(running ? id : null);
  // Keyed on how the run ended, so the events are read once more when it
  // settles: the last poll while running can land before the final events.
  const settledAt = running ? null : run.data?.end_time ?? run.data?.status;
  const events = useQuery({
    queryKey: ['run-events', id, settledAt],
    enabled: run.isSuccess,
    queryFn: async () => (await answer(engine().GET('/api/executions/{exec_id}/progress/events', {
      params: { path: { exec_id: id } },
    }))) as unknown as ProgressEvent[],
    refetchInterval: (query) => {
      const list = query.state.data;
      return running && !(list ?? []).some((event) => FINAL_EVENTS.has(event.type)) ? 1_000 : false;
    },
  });
  const papers = useQuery({
    queryKey: ['run-papers', id, settledAt],
    enabled: run.isSuccess && !running,
    queryFn: async () => {
      const first = await answer(engine().GET('/api/executions/{exec_id}/documents', {
        params: { path: { exec_id: id }, query: { limit: 200, offset: 0 } },
      }));
      const all: RunPaper[] = [...first.papers];
      while (all.length < Math.min(first.total, SKY_LIMIT)) {
        const next = await answer(engine().GET('/api/executions/{exec_id}/documents', {
          params: { path: { exec_id: id }, query: { limit: 200, offset: all.length } },
        }));
        if (!next.papers.length) break;
        all.push(...next.papers);
      }
      return { papers: all, total: first.total };
    },
  });
  const catalog = useQuery({
    queryKey: ['catalog'], staleTime: Infinity,
    queryFn: () => answer(engine().GET('/api/repositories/catalog')),
  });
  const names = useMemo(() => new Map((catalog.data ?? []).map((entry) => [entry.slug, entry.name])), [catalog.data]);
  const routines = useQuery({
    queryKey: ['routine-names'],
    queryFn: () => answer(engine().GET('/api/routines')) as Promise<{ id: number; name: string }[]>,
  });

  // Each takes the run's id as its variable, so a mutation's state is read
  // only for the run it was asked about when this screen moves to another.
  const stop = useMutation({
    mutationFn: (runId: number) => answer(engine().POST('/api/executions/{exec_id}/cancel', { params: { path: { exec_id: runId } } })),
    onSettled: (_done, _error, runId) => client.invalidateQueries({ queryKey: ['run', runId] }),
  });
  const restart = useMutation({
    mutationFn: () => answer(engine().POST('/api/executions/{exec_id}/restart', {
      params: { path: { exec_id: id } }, body: { request_id: crypto.randomUUID() },
    })),
    onSuccess: (started) => {
      void client.invalidateQueries({ queryKey: RUNS_KEY });
      navigate(`/runs/${started.execution_id}`);
    },
  });
  const exporting = useMutation({
    mutationFn: (format: ReferenceFormat) => exportReferences({ execution_ids: [id] }, format, `resmon-references-${id}`),
  });
  const bundle = useMutation({ mutationFn: (runId: number) => saveBundle(runId) });
  // Save as a search: the run's own sources, terms, dates, and cap as a saved
  // search, linked back to this run by the engine (`link_to_execution_id`).
  /** The name being typed, and for which run; the field is open only on that run's page. */
  const [typed, setTyped] = useState<{ runId: number; name: string } | null>(null);
  const naming = typed?.runId === id ? typed.name : null;
  const setNaming = (name: string | null) => setTyped(name === null ? null : { runId: id, name });
  const keep = useMutation({
    mutationFn: ({ runId, name, search }: {
      runId: number; name: string; search: NonNullable<ReturnType<typeof savedFromRun>>;
    }) => answer(engine().POST('/api/configurations', {
      body: { name, config_type: search.config_type, parameters: search.parameters, link_to_execution_id: runId },
    })),
    onSuccess: (_saved, { runId }) => {
      setNaming(null);
      void client.invalidateQueries({ queryKey: SAVED_KEY });
      void client.invalidateQueries({ queryKey: ['run', runId] });
      void client.invalidateQueries({ queryKey: RUNS_KEY });
    },
  });
  // Deleted, the run has no page: back to the log, which no longer lists it,
  // in place of this page in the history so Back does not return to it.
  const remove = useDeleteRuns();
  const askToDelete = (data: RunData, title: string) => {
    const question = deleteQuestion([{ id: data.id, status: data.status, title }]);
    if (!question || !window.confirm(question)) return;
    remove.mutate([data.id], {
      onSuccess: (outcome) => {
        const said = deletedSentence(outcome);
        if (said) navigate('/search/ask', { replace: true, state: { deleted: said } satisfies RunLogNotice });
      },
    });
  };
  const refused = remove.variables?.[0] === id ? remove.data?.refused[0]?.reason ?? null : null;

  const live = useMemo(
    () => (run.data ? liveSources(selectedSources(run.data), events.data ?? [], run.data.status !== 'running') : []),
    [run.data, events.data],
  );
  const paperIds = useMemo(() => (papers.data?.papers ?? []).map((paper) => paper.id), [papers.data]);
  // A paper chosen on the run's small map opens in the sources' place, beside it, for this run only.
  const [opened, setOpened] = useState<{ runId: number; choice: SkyChoice } | null>(null);
  const onMap = opened?.runId === id ? opened.choice : null;
  const sky = useRef<PaperSkyHandle>(null);

  if (run.isPending) return <div className="page"><p className="page-lede">Reading run {raw}.</p></div>;
  if (run.isError || !run.data) {
    return (
      <div className="page">
        <h1 className="page-title">Run {raw} could not be read</h1>
        <p className="page-lede">{run.error?.message ?? 'The engine has no such run.'}</p>
        <p><Link to="/search/ask" className="btn">Back to the runs</Link></p>
      </div>
    );
  }

  const data: RunData = run.data;
  const watch = data.routine_id ? routines.data?.find((r) => r.id === data.routine_id)?.name ?? null : null;
  // An interrupted run's end is when resmon noticed it had stopped, which can
  // be days later; the time between is not time it worked, so none is shown.
  const took = data.status === 'interrupted' ? null : duration(data.start_time, data.end_time);
  const recorded: CoverageSource[] = [...data.coverage.sources, ...data.coverage.additional_sources];
  // A stop is cooperative: the run ends at its next checkpoint, so the screen
  // says a stop was asked for until the run says it has ended.
  const stopping = running && stop.variables === id && (stop.isPending || stop.isSuccess);
  const failure = (stop.variables === id ? stop.error : null) ?? restart.error ?? exporting.error
    ?? (bundle.variables === id ? bundle.error : null) ?? (keep.variables?.runId === id ? keep.error : null);
  const title = runTitle(data, watch);
  // The dates this run asked for, as its own parameters record them: for a
  // watch whose window moves, the dates the engine computed when it fired.
  const dates = runWindowSentence(data.parameters);
  // A watch's run is not offered: its search is the watch's, and Saved already keeps a copy of it.
  // Whether it summarized is read from the run's `ai_choice` event, so a save waits for the events.
  const choice = aiChoiceOf(events.data ?? []);
  const search = savedFromRun(data, choice?.enabled === true);
  const kept = keep.isSuccess && keep.variables.runId === id ? keep.variables.name : null;
  const saveSearch = (name: string) => {
    if (search && name.trim() && !keep.isPending && !events.isPending) keep.mutate({ runId: id, name: name.trim(), search });
  };

  return (
    <div className="run" data-run={data.id} data-status={data.status}>
      <header className="run-head">
        <Link to="/search/ask" className="back"><Icon name="back" size={14} />Runs</Link>
        <div className="run-headline">
          <h1 className={watch ? 'run-name it' : 'run-name'}>{breakable(title)}</h1>
          <div className="run-actions">
            {running && (
              <button type="button" className="btn" onClick={() => stop.mutate(id)} disabled={stopping}>
                <Icon name="stop" size={14} />{stopping ? 'Stopping…' : 'Stop'}
              </button>
            )}
            {RESTARTABLE.has(data.status) && (
              <button type="button" className="btn" onClick={() => restart.mutate()} disabled={restart.isPending}>
                <Icon name="reset" size={14} />Restart
              </button>
            )}
            {!running && (
              <div className="seg export" role="group" aria-label="Export this run's papers">
                <span className="seg-label"><Icon name="download" size={14} /></span>
                {FORMATS.map((format) => (
                  <button key={format.id} type="button" disabled={exporting.isPending}
                    onClick={() => exporting.mutate(format.id)}>{format.label}</button>
                ))}
              </div>
            )}
            {!running && (
              <button type="button" className="btn" data-run="bundle" disabled={bundle.isPending}
                aria-describedby="run-bundle-what" onClick={() => bundle.mutate(id)}>
                <Icon name="download" size={14} />{bundle.isPending && bundle.variables === id ? 'Building the bundle' : 'Bundle'}
              </button>
            )}
            {search && naming === null && (
              <button type="button" className="btn" data-run="save-search" disabled={keep.isPending}
                onClick={() => { keep.reset(); setNaming(''); }}>
                Save as a search
              </button>
            )}
            {/* A run still running is not offered: the engine refuses to delete it. */}
            {!running && (
              <button type="button" className="btn quiet" data-run="delete" disabled={remove.isPending}
                onClick={() => askToDelete(data, title)}>
                {remove.isPending && remove.variables?.[0] === id ? 'Deleting' : 'Delete this run'}
              </button>
            )}
          </div>
        </div>
        <div className="meta run-meta">
          <span>{runKind(data.execution_type)}</span>
          <span className="sep" />
          <span>Started {when(data.start_time, now)}</span>
          {took && (<><span className="sep" /><span>took {took}</span></>)}
          <span className="sep" />
          <span className="run-status" data-status={data.status}>
            {running && <i className="live-dot" aria-hidden="true" />}
            {data.status}
          </span>
          {data.restarted_from && (
            <><span className="sep" /><Link to={`/runs/${data.restarted_from}`}>restarted from run {data.restarted_from}</Link></>
          )}
          {data.restarted_into.map((next) => (
            <span key={next}><span className="sep" /> <Link to={`/runs/${next}`}>restarted as run {next}</Link></span>
          ))}
          {/* Either the search it was started from or the one it was saved as: the engine keeps one link and does not say which. */}
          {data.saved_configuration_name && (
            <><span className="sep" /><Link to="/search/saved" data-run="saved-search">linked to the saved search “{data.saved_configuration_name}”</Link></>
          )}
        </div>
        {dates && (
          <p className="run-dates" data-run="window">
            <span className="run-dates-label">Dates</span> {dates}
          </p>
        )}
        <RunSummaryNote run={data} events={events.data ?? null} />
        {search && naming !== null && (
          <div className="run-keep">
            <p className="form-hint">
              Saves this run’s {search.config_type === 'manual_dive' ? 'source' : 'sources'}, terms, dates, and cap as a
              search under Saved, and links this run to it.
              {choice?.enabled === true && ' The search is saved to summarize each paper, as this run was set to.'}
              {events.isSuccess && !choice && ' This run did not record whether it summarized, so the search is saved not to.'}
            </p>
            <span className="keep-row">
              <label className="sr-only" htmlFor="run-keep-name">A name for this saved search</label>
              <input
                id="run-keep-name"
                value={naming}
                placeholder="A name for this search"
                autoFocus
                {...commandEnter('run-keep-save')}
                onChange={(event) => setNaming(event.target.value)}
                onKeyDown={(event) => {
                  // Plain Enter saves here; ⌘Enter presses Save too, through the shell.
                  if (event.key === 'Enter' && !event.metaKey && !event.ctrlKey) { event.preventDefault(); saveSearch(naming); }
                  else if (event.key === 'Escape') setNaming(null);
                }}
              />
              <button type="button" id="run-keep-save" className="btn" disabled={!naming.trim() || keep.isPending || events.isPending}
                onClick={() => saveSearch(naming)}>
                {keep.isPending ? 'Saving' : 'Save'}
              </button>
              <button type="button" className="btn quiet" onClick={() => setNaming(null)}>Cancel</button>
            </span>
          </div>
        )}
        {kept && naming === null && (
          <p className="settings-said" role="status" data-run="kept">
            Saved as “{kept}”, under <Link to="/search/saved">Saved</Link>.
          </p>
        )}
        {stopping && (
          <p className="run-note" role="status" data-run="stopping">
            Stopping. resmon has asked this run to stop, and it stops at its next checkpoint; until then it is still running.
          </p>
        )}
        {data.status === 'interrupted' && <p className="run-note">{interruptedSentence(data)}</p>}
        {data.status === 'failed' && data.error_message && <p className="run-note">{data.error_message}</p>}
        {RESTARTABLE.has(data.status) && <RestartFacts run={data} />}
        {!running && (
          <p id="run-bundle-what" className="sr-only">
            The run&rsquo;s bundle: its report, with a PDF and LaTeX where they could be made, the log, the metadata, and the
            search record, in one archive.
          </p>
        )}
        {failure && <p className="field-error" role="alert">{refusal(failure)}</p>}
        {refused && <p className="field-error" role="alert" data-run="delete-refused">{refused}</p>}
      </header>

      <div className="run-main">
        {onMap && (
          <MapPaper
            key={onMap.id}
            id={onMap.id}
            cell={onMap.cell}
            region={onMap.region}
            sourceName={(slug) => names.get(slug) ?? slug}
            backLabel="Back to the sources"
            inline
            onBack={() => { setOpened(null); sky.current?.focus(); }}
            onShow={() => sky.current?.show(onMap.id)}
          />
        )}
        <section className="run-sources" aria-label="Sources" hidden={onMap !== null}>
          {running ? (
            <>
              <p className="coverage-sentence">
                Asking {live.length} {live.length === 1 ? 'source' : 'sources'}; each line changes as its answer arrives.
              </p>
              <LivePanel sources={live} names={names} />
            </>
          ) : (
            <>
              <p className="coverage-sentence" data-coverage-summary>{data.coverage.summary}</p>
              <ol className="recorded" aria-label="Recorded outcome of each source">
                {recorded.map((source) => (
                  <li key={source.source} className="recorded-row" data-source={source.source} data-category={source.category}
                    data-in-part={source.in_part ? 'true' : undefined}>
                    <OutcomeMark category={source.category} inPart={source.in_part} />
                    <span className="src-name">{names.get(source.source) ?? source.source}</span>
                    <span className="src-label">{source.label}</span>
                    <span className="src-count num">
                      {source.result_count === null ? 'count not recorded' : source.result_count.toLocaleString('en-US')}
                    </span>
                    <p className="src-note">{source.note}</p>
                  </li>
                ))}
              </ol>
              {data.coverage.notes[0] && <p className="recorded-basis">{data.coverage.notes[0]}</p>}
            </>
          )}
        </section>
        <RunSky ref={sky} paperIds={paperIds} endedAt={running ? null : data.end_time ?? null}
          onOpenMap={!running && (papers.data?.total ?? 0) > 0 ? openMap : undefined}
          chosen={onMap?.id ?? null} onChoose={(next) => setOpened(next ? { runId: id, choice: next } : null)}
          sourceName={(slug) => names.get(slug) ?? slug} />
      </div>

      <RunTabs run={data} live={live} names={names} events={events.data ?? []} papers={papers.data ?? null} running={running}
        tab={tab} onTab={setTab} />
    </div>
  );
}
