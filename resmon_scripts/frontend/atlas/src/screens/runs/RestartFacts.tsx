import { Link } from 'react-router-dom';
import { restartFacts, type RunRow } from './model';

/**
 * What Restart will and will not do, shown wherever Restart is offered: a
 * person deciding whether to start a run again needs to know whether it
 * summarizes with AI and whether it is emailed or delivered before pressing
 * it, not after.
 */
export function RestartFacts({ run }: {
  run: Pick<RunRow, 'parameters' | 'execution_type' | 'routine_id'> & { ai_lanes?: readonly unknown[] };
}) {
  const facts = restartFacts(run);
  return (
    <dl className="run-restart-facts" aria-label="What Restart does" data-run="restart-facts">
      <div><dt>Restart asks</dt><dd>The same sources, terms, dates, and cap this run recorded, as a new run.</dd></div>
      <div><dt>AI summaries</dt><dd>{facts.ai}</dd></div>
      <div>
        <dt>Email and delivery</dt>
        <dd>
          {facts.delivery}
          {facts.watchId !== null && <>{' '}<Link to={`/watches/${facts.watchId}`}>Open the watch</Link></>}
        </dd>
      </div>
    </dl>
  );
}
