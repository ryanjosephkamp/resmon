import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { answer, engine } from '../api/client';
import { Icon } from '../shell/Icon';
import { duration, when } from './today/format';
import {
  FINAL_EVENTS, interruptedSentence, liveSources, RESTARTABLE, runKind, runTitle, selectedSources,
  type CoverageSource, type ProgressEvent, type Run as RunData,
} from './runs/model';
import { exportReferences, FORMATS, type ReferenceFormat } from './runs/references';
import { RUNS_KEY } from './runs/RunLog';
import { RunSky } from './runs/RunSky';
import { LivePanel } from './runs/LivePanel';
import { RunTabs, type RunPaper } from './runs/RunTabs';

/** How many of a run's papers are read for the sky; a sweep can store thousands. */
const SKY_LIMIT = 2_000;

/** A recorded outcome's mark: filled for an answer, a ring for unknown, the fault mark for a non-answer. */
function OutcomeMark({ category }: { category: string }) {
  if (category === 'non_answer') return <span className="omark fault" aria-hidden="true"><Icon name="fault" size={14} /></span>;
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
export function Run() {
  const { id: raw } = useParams();
  const id = Number(raw);
  const navigate = useNavigate();
  const client = useQueryClient();
  const [now] = useState(() => new Date());

  const run = useQuery({
    queryKey: ['run', id],
    enabled: Number.isInteger(id) && id > 0,
    queryFn: () => answer(engine().GET('/api/executions/{exec_id}', { params: { path: { exec_id: id } } })),
    refetchInterval: (query) => (query.state.data?.status === 'running' ? 1_000 : false),
  });
  const running = run.data?.status === 'running';
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

  const stop = useMutation({
    mutationFn: () => answer(engine().POST('/api/executions/{exec_id}/cancel', { params: { path: { exec_id: id } } })),
    onSettled: () => client.invalidateQueries({ queryKey: ['run', id] }),
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

  const live = useMemo(
    () => (run.data ? liveSources(selectedSources(run.data), events.data ?? []) : []),
    [run.data, events.data],
  );

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
  const took = duration(data.start_time, data.end_time);
  const recorded: CoverageSource[] = [...data.coverage.sources, ...data.coverage.additional_sources];

  return (
    <div className="run" data-run={data.id} data-status={data.status}>
      <header className="run-head">
        <Link to="/search/ask" className="back"><Icon name="back" size={14} />Runs</Link>
        <div className="run-headline">
          <h1 className={watch ? 'run-name it' : 'run-name'}>{runTitle(data, watch)}</h1>
          <div className="run-actions">
            {running && (
              <button type="button" className="btn" onClick={() => stop.mutate()} disabled={stop.isPending}>
                <Icon name="stop" size={14} />{stop.isPending ? 'Stopping' : 'Stop'}
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
        </div>
        {data.status === 'interrupted' && <p className="run-note">{interruptedSentence(data)}</p>}
        {data.status === 'failed' && data.error_message && <p className="run-note">{data.error_message}</p>}
        {(stop.error || restart.error || exporting.error) && (
          <p className="field-error" role="alert">{(stop.error ?? restart.error ?? exporting.error)?.message}</p>
        )}
      </header>

      <div className="run-main">
        <section className="run-sources" aria-label="Sources">
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
                  <li key={source.source} className="recorded-row" data-source={source.source} data-category={source.category}>
                    <OutcomeMark category={source.category} />
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
        <RunSky paperIds={(papers.data?.papers ?? []).map((paper) => paper.id)} />
      </div>

      <RunTabs run={data} live={live} names={names} events={events.data ?? []} papers={papers.data ?? null} running={running} />
    </div>
  );
}
