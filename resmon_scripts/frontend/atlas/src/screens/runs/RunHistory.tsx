import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useMutation } from '@tanstack/react-query';
import { Link, useNavigate } from 'react-router-dom';
import { answer, engine, EngineError } from '../../api/client';
import { breakable } from '../../shell/breakable';
import { Icon } from '../../shell/Icon';
import { useMinute } from '../../lib/useMinute';
import { clock, count, number } from '../today/format';
import { Confirm } from './Confirm';
import { saveRunsBundle } from './downloads';
import { byDay, listedRuns, runSummary, totalWords, useRunHistory, type RunFilter } from './history';
import {
  deletedSentence, deleteQuestion, interruptedSentence, RESTARTABLE, runKind, runsFileStem, runTitle, stillRunning,
  type RunRow,
} from './model';
import { exportReferences, FORMATS, type ReferenceFormat } from './references';
import { useDeleteRuns } from './remove';
import { RestartFacts } from './RestartFacts';

/** One run's row: its title (a link to its page), when it started, its kind, and what happened. */
export function RunLine({ run, watch, children }: { run: RunRow; watch: string | null; children?: ReactNode }) {
  return (
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
          {runSummary(run)}
        </span>
      </div>
      {run.status === 'interrupted' && <p className="run-note">{interruptedSentence(run)}</p>}
      {children}
    </div>
  );
}

interface Props {
  filter: RunFilter;
  words: string;
  watchName: (id: number) => string | null;
  /** A sentence handed in from elsewhere: a run deleted from its own page. */
  notice: string | null;
  /** The controls that narrow it, drawn beside its heading. */
  tools?: ReactNode;
}

/**
 * The history: every run newest first, by day, a page at a time, read on as
 * the list nears its end. Ticked runs export their papers together, are
 * bundled, or are deleted after the question says what deleting removes and
 * what it leaves. A run that stopped before it finished can be restarted
 * from its row, after the same account of what Restart does that its page
 * gives.
 */
export function RunHistory({ filter, words, watchName, notice, tools }: Props) {
  const navigate = useNavigate();
  const now = useMinute();
  const history = useRunHistory(filter, words);
  const listed = useMemo(() => listedRuns(history.data?.pages), [history.data]);
  const total = history.data?.pages[history.data.pages.length - 1]?.total ?? null;
  const groups = useMemo(() => byDay(listed, now), [listed, now]);

  const [selected, setSelected] = useState<number[]>([]);
  // The chosen runs as the log now holds them: a run deleted elsewhere, or no
  // longer among the runs listed, is not counted, exported, or asked about.
  const chosen = useMemo(() => listed.filter((run) => selected.includes(run.id)), [listed, selected]);
  const ids = chosen.map((run) => run.id);
  const going = chosen.filter((run) => run.status === 'running');
  const toggle = (id: number) => setSelected((current) => (current.includes(id) ? current.filter((x) => x !== id) : [...current, id]));
  const titleOf = (run: RunRow) => runTitle(run, run.routine_id ? watchName(run.routine_id) : null);

  /** The run whose Restart is being weighed: its facts are shown before anything starts. */
  const [weighing, setWeighing] = useState<number | null>(null);
  /** What a restart that waits for a free slot was told. */
  const [queuedSaid, setQueuedSaid] = useState<string | null>(null);
  const restart = useMutation({
    mutationFn: (id: number) => answer(engine().POST('/api/executions/{exec_id}/restart', {
      params: { path: { exec_id: id } }, body: { request_id: crypto.randomUUID(), again: false },
    })),
    onSuccess: (started) => {
      setWeighing(null);
      // Waiting for a free slot, it is listed under Waiting above, and says so here.
      if (started.execution_id !== null) navigate(`/runs/${started.execution_id}`);
      else setQueuedSaid(started.detail ?? 'The run waits for a free slot.');
    },
  });
  const exporting = useMutation({
    mutationFn: (format: ReferenceFormat) => exportReferences({ execution_ids: ids }, format, runsFileStem('resmon-references', ids)),
  });
  const bundling = useMutation({ mutationFn: (runIds: number[]) => saveRunsBundle(runIds) });
  const remove = useDeleteRuns();
  const [asking, setAsking] = useState<'delete' | null>(null);
  const question = asking === 'delete'
    ? deleteQuestion(chosen.map((run) => ({ id: run.id, status: run.status, title: titleOf(run) }))) : null;
  const doomed = ids.filter((id) => !going.some((run) => run.id === id));
  const confirmDelete = () => {
    remove.mutate(doomed, {
      onSuccess: (outcome) => {
        const gone = new Set([...outcome.deleted, ...outcome.gone]);
        setSelected((current) => current.filter((id) => !gone.has(id)));
        setAsking(null);
      },
    });
  };
  const said = (remove.data ? deletedSentence(remove.data) : null) ?? queuedSaid ?? notice;
  const failure = exporting.error ?? bundling.error;

  // Read on as the list nears its end, a page at a time.
  const end = useRef<HTMLDivElement>(null);
  const { hasNextPage, isFetchingNextPage, fetchNextPage } = history;
  useEffect(() => {
    const target = end.current;
    if (!target || !hasNextPage) return undefined;
    const seen = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting) && !isFetchingNextPage) void fetchNextPage();
    }, { rootMargin: '600px 0px' });
    seen.observe(target);
    return () => seen.disconnect();
  }, [hasNextPage, isFetchingNextPage, fetchNextPage]);

  return (
    <section className="run-history runlog" aria-label="History" aria-busy={history.isFetching} data-runs="history">
      <div className="history-head">
        <h2 className="runs-h">History<span className="num" data-runs="count">{totalWords(total)}</span></h2>
        {tools}
      </div>
      {chosen.length > 0 && (
        <div className="export-bar runs-bar" role="group" aria-label="The selected runs">
          <span data-runs="chosen">{count(chosen.length, 'run')}: export their papers as</span>
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
            <button type="button" className="btn sm" data-runs="delete" disabled={remove.isPending || !doomed.length}
              onClick={() => { remove.reset(); setAsking('delete'); }}>
              {remove.isPending ? 'Deleting' : 'Delete'}
            </button>
            <button type="button" className="btn quiet sm" onClick={() => { setSelected([]); setAsking(null); }}>Clear</button>
          </div>
          <p id="runs-bundle-what" className="sr-only">
            The runs&rsquo; bundle: each run&rsquo;s report, with a PDF and LaTeX where they could be made, its log, its
            metadata, and its search record, in one archive.
          </p>
          {going.length > 0 && (
            <p className="export-note" data-runs="still-running">{stillRunning(going.map((run) => run.id))}</p>
          )}
          {question && (
            <Confirm name="delete-runs" question={question}
              act={doomed.length === 1 ? 'Delete 1 run' : `Delete ${number(doomed.length)} runs`}
              busy={remove.isPending} onAct={confirmDelete} onCancel={() => setAsking(null)} />
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
      <div className="history-list">
        {history.isPending && <p className="index-cap">Reading the runs.</p>}
        {history.isError && <p className="index-cap">The runs could not be read ({history.error.message}).</p>}
        {history.data && !listed.length && (
          <p className="index-empty">
            {words ? `No run matches “${words}”.`
              : filter === 'failed' ? 'No run has failed.'
                : filter === 'watches' ? 'No watch has run yet.'
                  : filter === 'searches' ? 'No search has been asked yet.'
                    : 'No runs yet. A search you ask, or a watch that fires, appears here.'}
          </p>
        )}
        {groups.map((group) => (
          <section key={group.day} className="group" aria-label={group.day}>
            <div className="ghead"><h3 className="rg">{group.day[0]?.toUpperCase()}{group.day.slice(1)}</h3></div>
            {group.runs.map((run) => {
              const watch = run.routine_id ? watchName(run.routine_id) : null;
              return (
                <article key={run.id} className={`run-row is-${run.status}`} data-run={run.id}>
                  <input type="checkbox" checked={selected.includes(run.id)} onChange={() => toggle(run.id)}
                    aria-label={`Select run ${run.id}`} />
                  <RunLine run={run} watch={watch}>
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
                        <button type="button" className="btn sm run-restart" onClick={() => setWeighing(run.id)}>
                          <Icon name="reset" size={14} />
                          Restart…
                        </button>
                      ))}
                  </RunLine>
                </article>
              );
            })}
          </section>
        ))}
        <div ref={end} className="history-end">
          {history.hasNextPage && (
            <button type="button" className="btn quiet sm runlog-older" disabled={history.isFetchingNextPage}
              onClick={() => void history.fetchNextPage()}>
              {history.isFetchingNextPage ? 'Reading older runs'
                : total !== null ? `Older runs (${number(total - listed.length)} more)` : 'Older runs'}
            </button>
          )}
        </div>
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
