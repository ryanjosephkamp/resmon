import { Link } from 'react-router-dom';
import type { components } from '../../api/schema';
import { count, number, when } from '../today/format';
import { historyScale, instant } from './model';

type RunRow = components['schemas']['RunRow'];

/**
 * The strip's line where no finished run brought in a new paper, so there is
 * no tallest bar to state. A run still going is not counted: its count so far
 * is not what it brought in, and is said when it ends.
 */
function flatLine(runs: number, recorded: number, going: number): string {
  if (runs === 0) return 'This run is still going: what it brought in is said when it ends.';
  const later = going ? ' The run still going is counted when it ends.' : '';
  if (recorded === 0) {
    return (runs === 1 ? `The ${going ? 'finished ' : ''}run did not record how many papers were new.`
      : `None of ${going ? 'the' : 'these'} ${number(runs)} ${going ? 'finished ' : ''}runs recorded how many papers were new.`) + later;
  }
  if (recorded < runs) {
    return (recorded === 1 ? 'The one run that recorded a count brought in no new paper.'
      : `None of the ${number(recorded)} runs that recorded a count brought in a new paper.`) + later;
  }
  if (going) {
    return (runs === 1 ? 'The finished run brought in no new paper.' : `None of the ${number(runs)} finished runs brought in a new paper.`) + later;
  }
  return runs === 1 ? 'This run brought in no new paper.' : `None of these ${number(runs)} runs brought in a new paper.`;
}

/** A run still going: its counts so far are not what it brought in. */
function going(run: RunRow): boolean {
  return run.status === 'running';
}

/** Runs drawn in the strip; the list below names every one read. */
const STRIP = 30;

/**
 * A watch's runs: each one it made, on its schedule or because someone asked,
 * the latest first, with how many papers were new to the collection and which
 * sources did not answer.
 *
 * The strip draws the last thirty in order, oldest at the left: a bar's height
 * is the papers new in that run, and a fault mark under a bar is a run in which
 * a source did not answer. A watch's first run usually brings in everything
 * already published and dwarfs the rest, so a run more than twice the next
 * largest is drawn cut off at that one's height, with a line under the strip
 * saying which and how many it found. Where no run brought in a new paper the
 * strip has no tallest bar to state, and the line says that instead. "Not
 * recorded" where the run stored no count, never a zero.
 */
export function RunHistory({ runs, now, names }: {
  runs: readonly RunRow[] | null; now: Date; names: ReadonlyMap<string, string>;
}) {
  const strip = (runs ?? []).slice(0, STRIP).reverse();
  const finished = strip.filter((run) => !going(run));
  const scale = historyScale(finished.map((run) => run.new_result_count));
  const cut = scale === null ? [] : finished.filter((run) => (run.new_result_count ?? 0) > scale);
  const recorded = finished.filter((run) => run.new_result_count !== null).length;
  return (
    <section className="nights" aria-label="Runs">
      <h2 className="nights-title">Runs</h2>
      {runs === null && <p className="record-cap">Reading this watch&rsquo;s runs.</p>}
      {runs && !runs.length && <p className="record-cap">This watch has not run yet.</p>}
      {strip.length > 0 && (
        <div className="night-strip" aria-hidden="true">
          {strip.map((run) => {
            const missing = run.source_outcomes?.could_not_answer ?? 0;
            const found = going(run) ? null : run.new_result_count;
            return (
              <span key={run.id} className="night-bar" data-status={run.status}
                data-cut={scale !== null && found !== null && found > scale ? 'true' : undefined}
                title={`Run ${run.id}: ${going(run) ? 'still going' : found === null ? 'count not recorded' : `${number(found)} new`}`}>
                <span className="night-amount"
                  style={{ height: `${found === null ? 0 : Math.max(4, scale === null ? 0 : Math.min(1, found / scale) * 100)}%` }} />
                <span className={missing ? 'night-fault' : 'night-ok'} />
              </span>
            );
          })}
        </div>
      )}
      {strip.length > 0 && (
        <p className="night-scale" data-scale={scale ?? 'none'}>
          {scale !== null
            ? <>
              Papers new in each run, oldest at the left; the tallest bar is {count(scale, 'paper')}.
              {finished.length < strip.length && ' The run still going is counted when it ends.'}
            </>
            : flatLine(finished.length, recorded, strip.length - finished.length)}
          {cut.length > 0 && ` ${cut.map((run) => `${when(instant(run.start_time)?.toISOString(), now)} (${number(run.new_result_count ?? 0)})`).join(', ')} ${cut.length === 1 ? 'is' : 'are'} drawn cut off.`}
        </p>
      )}
      <ol className="night-list">
        {(runs ?? []).map((run) => {
          const silent = run.source_outcomes?.sources_that_could_not_answer ?? [];
          return (
            <li key={run.id} className="night" data-run={run.id} data-status={run.status}>
              <Link to={`/runs/${run.id}`} className="night-when">{when(instant(run.start_time)?.toISOString(), now)}</Link>
              <span className="night-status" data-status={run.status}>
                {run.status === 'running' && <i className="live-dot" aria-hidden="true" />}
                {run.status}
              </span>
              <span className="night-count num">
                {going(run) ? 'counted when it ends' : (
                  <>
                    {run.new_result_count === null ? 'not recorded' : `${number(run.new_result_count)} new`}
                    {run.result_count !== null && ` of ${number(run.result_count)}`}
                  </>
                )}
              </span>
              {silent.length > 0 && (
                <span className="night-silent">
                  {silent.map((s) => names.get(s) ?? s).join(', ')} did not answer
                </span>
              )}
            </li>
          );
        })}
      </ol>
    </section>
  );
}
