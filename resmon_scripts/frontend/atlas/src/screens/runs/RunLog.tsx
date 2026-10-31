import { useMemo, useState } from 'react';
import { useInfiniteQuery, useMutation, useQuery } from '@tanstack/react-query';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { answer, engine, EngineError } from '../../api/client';
import { breakable } from '../../shell/breakable';
import { Icon } from '../../shell/Icon';
import { clock, count, dayWord, number } from '../today/format';
import { saveRunsBundle } from './downloads';
import {
  deletedSentence, deleteQuestion, interruptedSentence, RESTARTABLE, RUNS_KEY, runKind, runsFileStem, runTitle,
  stillRunning, type RunRow,
} from './model';
import { exportReferences, FORMATS, type ReferenceFormat } from './references';
import { useDeleteRuns } from './remove';
import { RestartFacts } from './RestartFacts';

export { RUNS_KEY };

/** How many runs the log reads at a time: the newest first, then older ones on request. */
const RUN_PAGE = 20;

/** What the count beside "Runs" counts: every run, or the most recent ones when older runs are still to read. */
export function runsCountWords(shown: number, more: boolean): string {
  return more ? `the latest ${number(shown)}` : number(shown);
}

/** What a run's own page hands the log when it deleted the run and came back here. */
export interface RunLogNotice { deleted?: string }

/** The routines' names, for a watch run's title. `/api/routines` declares no model. */
interface RoutineName { id: number; name: string }

/** A run's one line of what happened, from what the engine recorded. */
function summary(run: RunRow): string {
  const { answered, non_answer: nonAnswer } = run.coverage.counts;
  const total = run.coverage.total;
  const asked = total ? `${answered} of ${total} ${total === 1 ? 'source' : 'sources'} answered` : 'no source outcome recorded';
  switch (run.status) {
    case 'running':
      return 'running';
    case 'completed': {
      const found = run.total_results ?? run.result_count;
      const fresh = run.new_results ?? run.new_result_count;
      const papers = found === null || found === undefined ? 'papers not recorded'
        : `${number(found)} found${fresh === null || fresh === undefined ? '' : `, ${number(fresh)} new`}`;
      return `${asked} · ${papers}`;
    }
    case 'failed':
      return nonAnswer ? `failed · ${asked}` : `failed · ${run.error_message || asked}`;
    default:
      return `${run.status} · ${asked}`;
  }
}

/**
 * The runs, newest first and a page at a time, grouped by day: a manual
 * search by its terms, a watch's run by the watch's name. Selected runs export their papers
 * together, one entry per paper however many runs found it, or the runs
 * themselves as one bundle, or are deleted, after a question that says what
 * deleting removes and what it leaves. A run that stopped before it finished
 * can be started again from here, after the same account of what Restart does
 * that the run's own page gives.
 */
export function RunLog() {
  const navigate = useNavigate();
  const notice = (useLocation().state as RunLogNotice | null)?.deleted ?? null;
  const [now] = useState(() => new Date());
  // The newest page of runs, and older pages on request: each run on a page
  // carries its coverage, which the engine works out per run.
  const pages = useInfiniteQuery({
    queryKey: RUNS_KEY,
    initialPageParam: 0,
    queryFn: ({ pageParam }) => answer(engine().GET('/api/executions', { params: { query: { limit: RUN_PAGE, offset: pageParam } } })),
    getNextPageParam: (last, all) => (last.length === RUN_PAGE ? all.length * RUN_PAGE : undefined),
    // Read again every two seconds while anything runs, so a run's line
    // changes when it finishes; every half minute otherwise, for watch runs.
    refetchInterval: (query) => (query.state.data?.pages.some((page) => page.some((run) => run.status === 'running'))
      ? 2_000 : 30_000),
    refetchOnWindowFocus: true,
  });
  // A run that started while the pages were read again can sit at the edge of
  // two pages; it is listed once.
  const listed = useMemo(() => {
    const seen = new Set<number>();
    return (pages.data?.pages ?? []).flat().filter((run) => !seen.has(run.id) && seen.add(run.id) !== undefined);
  }, [pages.data]);
  const routines = useQuery({
    queryKey: ['routine-names'],
    queryFn: () => answer(engine().GET('/api/routines')) as Promise<RoutineName[]>,
  });
  const names = useMemo(() => new Map((routines.data ?? []).map((r) => [r.id, r.name])), [routines.data]);
  const [selected, setSelected] = useState<number[]>([]);
  /** The run whose Restart is being weighed: its facts are shown before anything starts. */
  const [weighing, setWeighing] = useState<number | null>(null);

  const restart = useMutation({
    mutationFn: (id: number) => answer(engine().POST('/api/executions/{exec_id}/restart', {
      params: { path: { exec_id: id } }, body: { request_id: crypto.randomUUID() },
    })),
    onSuccess: (started) => navigate(`/runs/${started.execution_id}`),
  });
  // The chosen runs as the log now holds them: a run deleted elsewhere, or no
  // longer among the runs read, is not counted, exported, or asked about.
  const chosen = useMemo(() => listed.filter((run) => selected.includes(run.id)), [listed, selected]);
  const ids = chosen.map((run) => run.id);
  const exporting = useMutation({
    mutationFn: (format: ReferenceFormat) => exportReferences({ execution_ids: ids }, format, runsFileStem('resmon-references', ids)),
  });
  const bundling = useMutation({ mutationFn: (runIds: number[]) => saveRunsBundle(runIds) });
  const remove = useDeleteRuns();
  const going = chosen.filter((run) => run.status === 'running');
  const askToDelete = () => {
    const question = deleteQuestion(chosen.map((run) => ({
      id: run.id, status: run.status, title: runTitle(run, run.routine_id ? names.get(run.routine_id) ?? null : null),
    })));
    if (!question || !window.confirm(question)) return;
    remove.mutate(ids.filter((id) => !going.some((run) => run.id === id)), {
      onSuccess: (outcome) => {
        const gone = new Set([...outcome.deleted, ...outcome.gone]);
        setSelected((current) => current.filter((id) => !gone.has(id)));
      },
    });
  };
  const said = remove.data ? deletedSentence(remove.data) : notice;
  const failure = exporting.error ?? bundling.error;

  const groups = useMemo(() => {
    const out: { day: string; runs: RunRow[] }[] = [];
    for (const run of listed) {
      const day = run.start_time ? dayWord(new Date(run.start_time), now) : 'Date not recorded';
      const last = out[out.length - 1];
      if (last && last.day === day) last.runs.push(run);
      else out.push({ day, runs: [run] });
    }
    return out;
  }, [listed, now]);

  const toggle = (id: number) => setSelected((current) => (
    current.includes(id) ? current.filter((x) => x !== id) : [...current, id]));

  return (
    <section className="index runlog" aria-label="Runs" aria-busy={pages.isFetching}>
      <div className="index-bar">
        <h2>Runs<span data-runs="count">{pages.data ? runsCountWords(listed.length, Boolean(pages.hasNextPage)) : ''}</span></h2>
      </div>
      {chosen.length > 0 && (
        <div className="export-bar" role="group" aria-label="The selected runs">
          <span>{count(chosen.length, 'run')}: export their papers as</span>
          {FORMATS.map((format) => (
            <button key={format.id} type="button" className="btn sm" disabled={exporting.isPending}
              onClick={() => exporting.mutate(format.id)}>
              {format.label}
            </button>
          ))}
          <div className="export-runs">
            <span>The runs themselves:</span>
            <button type="button" className="btn sm" data-runs="bundle" aria-describedby="runs-bundle-what"
              disabled={bundling.isPending} onClick={() => bundling.mutate(ids)}>
              <Icon name="download" size={14} />{bundling.isPending ? 'Building the bundle' : 'Bundle'}
            </button>
            <button type="button" className="btn sm" data-runs="delete" disabled={remove.isPending || going.length === chosen.length}
              onClick={askToDelete}>
              {remove.isPending ? 'Deleting' : 'Delete'}
            </button>
            <button type="button" className="btn quiet sm" onClick={() => setSelected([])}>Clear</button>
          </div>
          <p id="runs-bundle-what" className="sr-only">
            The runs&rsquo; bundle: each run&rsquo;s report, with a PDF and LaTeX where they could be made, its log, its
            metadata, and its search record, in one archive.
          </p>
          {going.length > 0 && (
            <p className="export-note" data-runs="still-running">{stillRunning(going.map((run) => run.id))}</p>
          )}
          {failure && (
            <p className="field-error" role="alert">
              {failure instanceof EngineError && failure.detail ? failure.detail : failure.message}
            </p>
          )}
        </div>
      )}
      {(said || (remove.data && remove.data.refused.length > 0)) && (
        <div className="runlog-said" data-runs="deleted">
          {said && <p className="settings-said" role="status">{said}</p>}
          {remove.data?.refused.map((refused) => (
            <p key={refused.id} className="field-error" role="alert">{refused.reason}</p>
          ))}
        </div>
      )}
      <div className="index-scroll">
        {pages.isPending && <p className="index-cap">Reading the runs.</p>}
        {pages.isError && <p className="index-cap">The runs could not be read.</p>}
        {pages.data && !listed.length && (
          <p className="index-empty">No runs yet. A search you ask, or a watch that fires, appears here.</p>
        )}
        {groups.map((group) => (
          <section key={group.day} className="group" aria-label={group.day}>
            <div className="ghead"><h3 className="rg">{group.day[0]?.toUpperCase()}{group.day.slice(1)}</h3></div>
            {group.runs.map((run) => {
              const watch = run.routine_id ? names.get(run.routine_id) ?? null : null;
              return (
                <article key={run.id} className={`run-row is-${run.status}`} data-run={run.id}>
                  <input
                    type="checkbox"
                    checked={selected.includes(run.id)}
                    onChange={() => toggle(run.id)}
                    aria-label={`Select run ${run.id}`}
                  />
                  <div className="run-body">
                    <Link to={`/runs/${run.id}`} className={watch ? 'run-title it' : 'run-title'}>
                      {breakable(runTitle(run, watch))}
                    </Link>
                    <div className="meta">
                      <span>{run.start_time ? clock(run.start_time) : 'time not recorded'}</span>
                      <span className="sep" />
                      <span>{runKind(run.execution_type)}</span>
                      <span className="sep" />
                      <span className="run-status" data-status={run.status}>
                        {run.status === 'running' && <i className="live-dot" aria-hidden="true" />}
                        {summary(run)}
                      </span>
                    </div>
                    {run.status === 'interrupted' && (
                      <p className="run-note">{interruptedSentence(run)}</p>
                    )}
                    {RESTARTABLE.has(run.status) && (weighing === run.id
                      ? (
                        <div className="run-restart-confirm" role="group" aria-label={`Restart run ${run.id}`}>
                          <RestartFacts run={run} />
                          <div className="form-actions">
                            <button type="button" className="btn sm primary" disabled={restart.isPending}
                              onClick={() => restart.mutate(run.id)}>
                              Restart this run
                            </button>
                            <button type="button" className="btn sm quiet" onClick={() => setWeighing(null)}>Not now</button>
                          </div>
                        </div>
                      )
                      : (
                        <button type="button" className="btn sm run-restart"
                          onClick={() => setWeighing(run.id)}>
                          <Icon name="reset" size={14} />
                          Restart…
                        </button>
                      ))}
                  </div>
                </article>
              );
            })}
          </section>
        ))}
        {pages.hasNextPage && (
          <button type="button" className="btn quiet sm runlog-older" disabled={pages.isFetchingNextPage}
            onClick={() => void pages.fetchNextPage()}>
            Older runs
          </button>
        )}
        {restart.error && (
          <p className="field-error" role="alert">
            {restart.error instanceof EngineError && restart.error.detail
              ? restart.error.detail : `Restart failed: ${restart.error.message}.`}
          </p>
        )}
      </div>
    </section>
  );
}
