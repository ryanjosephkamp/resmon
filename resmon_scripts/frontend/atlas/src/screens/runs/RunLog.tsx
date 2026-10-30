import { useMemo, useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { Link, useNavigate } from 'react-router-dom';
import { answer, engine } from '../../api/client';
import { Icon } from '../../shell/Icon';
import { clock, count, dayWord, number } from '../today/format';
import { interruptedSentence, RESTARTABLE, runKind, runTitle, type RunRow } from './model';
import { exportReferences, FORMATS, type ReferenceFormat } from './references';
import { RestartFacts } from './RestartFacts';

export const RUNS_KEY = ['runs'] as const;

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
 * Every run so far, newest first, grouped by day: a manual search by its
 * terms, a watch's run by the watch's name. Selected runs export their papers
 * together, one entry per paper however many runs found it. A run that
 * stopped before it finished can be started again from here, after the same
 * account of what Restart does that the run's own page gives.
 */
export function RunLog() {
  const navigate = useNavigate();
  const [now] = useState(() => new Date());
  const runs = useQuery({
    queryKey: RUNS_KEY,
    queryFn: () => answer(engine().GET('/api/executions', { params: { query: { limit: 60 } } })),
    // Read again every two seconds while anything runs, so a run's line
    // changes when it finishes; every half minute otherwise, for watch runs.
    refetchInterval: (query) => (query.state.data?.some((run) => run.status === 'running') ? 2_000 : 30_000),
    refetchOnWindowFocus: true,
  });
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
  const exporting = useMutation({
    mutationFn: (format: ReferenceFormat) => exportReferences({ execution_ids: selected }, format,
      `resmon-references-${[...selected].sort((a, b) => a - b).join('-')}`),
  });

  const groups = useMemo(() => {
    const out: { day: string; runs: RunRow[] }[] = [];
    for (const run of runs.data ?? []) {
      const day = run.start_time ? dayWord(new Date(run.start_time), now) : 'Date not recorded';
      const last = out[out.length - 1];
      if (last && last.day === day) last.runs.push(run);
      else out.push({ day, runs: [run] });
    }
    return out;
  }, [runs.data, now]);

  const toggle = (id: number) => setSelected((current) => (
    current.includes(id) ? current.filter((x) => x !== id) : [...current, id]));

  return (
    <section className="index runlog" aria-label="Runs" aria-busy={runs.isFetching}>
      <div className="index-bar">
        <h2>Runs<span>{runs.data ? number(runs.data.length) : ''}</span></h2>
      </div>
      {selected.length > 0 && (
        <div className="export-bar" role="group" aria-label="Export the selected runs">
          <span>{count(selected.length, 'run')}: export their papers as</span>
          {FORMATS.map((format) => (
            <button key={format.id} type="button" className="btn sm" disabled={exporting.isPending}
              onClick={() => exporting.mutate(format.id)}>
              {format.label}
            </button>
          ))}
          <button type="button" className="btn quiet sm" onClick={() => setSelected([])}>Clear</button>
          {exporting.error && <p className="field-error" role="alert">{exporting.error.message}</p>}
        </div>
      )}
      <div className="index-scroll">
        {runs.isPending && <p className="index-cap">Reading the runs.</p>}
        {runs.isError && <p className="index-cap">The runs could not be read.</p>}
        {runs.data && !runs.data.length && (
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
                    aria-label={`Select run ${run.id} for export`}
                  />
                  <div className="run-body">
                    <Link to={`/runs/${run.id}`} className={watch ? 'run-title it' : 'run-title'}>
                      {runTitle(run, watch)}
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
        {restart.error && <p className="field-error" role="alert">Restart failed: {restart.error.message}.</p>}
      </div>
    </section>
  );
}
