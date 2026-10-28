import { Link } from 'react-router-dom';
import type { components } from '../../api/schema';
import { count, number, when } from '../today/format';
import { instant } from './model';

type RunRow = components['schemas']['RunRow'];

/** Nights drawn in the strip; the list below names every one read. */
const STRIP = 30;

/**
 * A watch's nights: each run it made, the latest first, with how many papers
 * were new to the collection and which sources did not answer.
 *
 * The strip draws the last thirty in order, oldest at the left: a bar's height
 * is the papers new that night, and a fault mark under a bar is a night a
 * source did not answer. A watch's first night usually brings in everything
 * already published and dwarfs the rest, so a night more than twice the next
 * largest is drawn cut off at that one's height, with a line under the strip
 * saying which and how many it found. "Not recorded" where the run
 * stored no count, never a zero.
 */
export function Nights({ runs, now, names }: {
  runs: readonly RunRow[] | null; now: Date; names: ReadonlyMap<string, string>;
}) {
  const strip = (runs ?? []).slice(0, STRIP).reverse();
  const counts = strip.map((run) => run.new_result_count ?? 0).sort((a, b) => b - a);
  const [most = 0, next = 0] = counts;
  const scale = Math.max(1, next > 0 && most > 2 * next ? next : most);
  const cut = strip.filter((run) => (run.new_result_count ?? 0) > scale);
  return (
    <section className="nights" aria-label="Nights">
      <h2 className="nights-title">Nights</h2>
      {runs === null && <p className="record-cap">Reading this watch&rsquo;s runs.</p>}
      {runs && !runs.length && <p className="record-cap">This watch has not run yet.</p>}
      {strip.length > 0 && (
        <div className="night-strip" aria-hidden="true">
          {strip.map((run) => {
            const missing = run.source_outcomes?.could_not_answer ?? 0;
            const found = run.new_result_count;
            return (
              <span key={run.id} className="night-bar" data-status={run.status} data-cut={found !== null && found > scale ? 'true' : undefined}
                title={`Run ${run.id}: ${found === null ? 'count not recorded' : `${number(found)} new`}`}>
                <span className="night-amount" style={{ height: `${found === null ? 0 : Math.max(4, Math.min(1, found / scale) * 100)}%` }} />
                <span className={missing ? 'night-fault' : 'night-ok'} />
              </span>
            );
          })}
        </div>
      )}
      {strip.length > 0 && (
        <p className="night-scale">
          Papers new each night, oldest at the left; the tallest bar is {count(scale, 'paper')}.
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
                {run.new_result_count === null ? 'not recorded' : `${number(run.new_result_count)} new`}
                {run.result_count !== null && ` of ${number(run.result_count)}`}
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
