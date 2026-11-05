import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { answer, engine } from '../../api/client';
import { restartFacts, type ProgressEvent, type RunRow } from './model';
import { aiChoiceOf } from './summaries';

type Restartable = Pick<RunRow, 'id' | 'execution_type' | 'routine_id'> & { ai_lanes?: readonly unknown[] };

/**
 * What Restart will and will not do, shown wherever Restart is offered: a
 * person deciding whether to start a run again needs to know what it asks,
 * whether it summarizes with AI, and whether it is emailed or delivered
 * before pressing it, not after. `setTo` is what the run was set to do with
 * summaries, from its `ai_choice` event (see `restartFacts`).
 */
export function RestartFacts({ run, setTo }: { run: Restartable; setTo: boolean | null | undefined }) {
  const facts = restartFacts(run, setTo);
  return (
    <dl className="run-restart-facts" aria-label="What Restart does" data-run="restart-facts">
      <div><dt>Restart asks</dt><dd>{facts.asks}</dd></div>
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

/**
 * The same facts for a run whose events are not on screen (a row of the
 * history): its events are read once, for its `ai_choice`. A watch's run is
 * restarted as its watch, so its events are not needed.
 */
export function ReadRestartFacts({ run }: { run: Restartable }) {
  const ofItsWatch = run.execution_type === 'automated_sweep' && run.routine_id !== null;
  const choice = useQuery({
    queryKey: ['runs', 'set-to-summarize', run.id],
    enabled: !ofItsWatch,
    queryFn: async () => {
      const events = (await answer(engine().GET('/api/executions/{exec_id}/progress/events', {
        params: { path: { exec_id: run.id } },
      }))) as unknown as ProgressEvent[];
      return aiChoiceOf(events)?.enabled ?? null;
    },
  });
  return <RestartFacts run={run} setTo={choice.data} />;
}
