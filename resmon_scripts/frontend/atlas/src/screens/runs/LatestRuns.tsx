import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { answer, engine } from '../../api/client';
import { Icon } from '../../shell/Icon';
import { useMinute } from '../../lib/useMinute';
import { useReadAgainWhenRunsChange } from './active';
import { byDay, readHistory } from './history';
import { RunLine } from './RunHistory';

/** How many runs the column beside Ask the sources lists. */
export const LATEST = 5;

/** Under the runs key, so whatever invalidates the runs reads these again too. */
const LATEST_KEY = ['runs', 'latest'] as const;

interface RoutineName { id: number; name: string }

/**
 * The newest runs, beside Ask the sources: the five a search just asked is
 * likely among, by day, each a link to its page, and a link to every run on
 * the Runs tab. Read again when a run starts or ends, as the Runs tab is.
 */
export function LatestRuns() {
  const now = useMinute();
  const latest = useQuery({
    queryKey: LATEST_KEY,
    queryFn: () => readHistory({}, 0, LATEST),
    refetchOnWindowFocus: true,
  });
  useReadAgainWhenRunsChange('latest', LATEST_KEY);
  const routines = useQuery({
    queryKey: ['routine-names'],
    queryFn: () => answer(engine().GET('/api/routines')) as Promise<RoutineName[]>,
  });
  const watches = useMemo(() => new Map((routines.data ?? []).map((r) => [r.id, r.name])), [routines.data]);
  const groups = useMemo(() => byDay(latest.data?.runs ?? [], now), [latest.data, now]);
  const runs = latest.data?.runs ?? [];
  const total = latest.data?.total ?? null;

  return (
    <section className="index runlog latest-runs" aria-label="Runs" aria-busy={latest.isFetching}>
      <div className="index-bar">
        <h2>Runs<span data-runs="count">{total !== null && total > LATEST ? 'the latest five' : ''}</span></h2>
        <Link to="/runs" className="btn sm quiet" data-runs="all">All Runs<Icon name="arrow" size={14} /></Link>
      </div>
      <div className="index-scroll">
        {latest.isPending && <p className="index-cap">Reading the runs.</p>}
        {latest.isError && <p className="index-cap">The runs could not be read.</p>}
        {latest.data && !runs.length && (
          <p className="index-empty">No runs yet. A search you ask, or a watch that fires, appears here and on the Runs tab.</p>
        )}
        {groups.map((group) => (
          <section key={group.day} className="group" aria-label={group.day}>
            <div className="ghead"><h3 className="rg">{group.day[0]?.toUpperCase()}{group.day.slice(1)}</h3></div>
            {group.runs.map((run) => (
              <article key={run.id} className={`run-row is-${run.status} no-tick`} data-run={run.id}>
                <RunLine run={run} watch={run.routine_id ? watches.get(run.routine_id) ?? null : null} />
              </article>
            ))}
          </section>
        ))}
        {total !== null && total > runs.length && (
          <p className="index-cap latest-more">
            <Link to="/runs">{(total - runs.length).toLocaleString('en-US')} more on the Runs tab</Link>
          </p>
        )}
      </div>
    </section>
  );
}
