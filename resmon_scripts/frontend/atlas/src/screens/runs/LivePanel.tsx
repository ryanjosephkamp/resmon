import { SourceStop } from './SourceStops';
import { useChartTip } from '../../charts/ChartTip';
import { useNow } from '../../lib/useNow';
import { WallMark } from '../health/WallMark';
import { askingWords, liveMarkState } from './live';
import { liveLabel, type LiveSource } from './model';
import { liveTip } from './runTips';

/**
 * Each source's state as the run's own progress events report it, in the
 * Source wall's marks. A source being asked says how long, as the engine's
 * heartbeat measured it, and what its search has done: the requests sent,
 * the retries, and what it is waiting for. The panel keeps its own clock,
 * read twice a second while a source is being asked, so the time moves on
 * between heartbeats (`askingWords`) and a source the engine has said nothing
 * about for a while says so; `now` fixes it, for a test.
 */
export function LivePanel({ sources, names, now, runId, onStopSaid }: {
  runId?: number;
  onStopSaid?: (key: string, sentence: string) => void;
  sources: readonly LiveSource[];
  names: ReadonlyMap<string, string>;
  now?: number;
}) {
  const ticking = useNow(500, now === undefined && sources.some((source) => source.state === 'asking'));
  const at = now ?? ticking;
  const largest = Math.max(0, ...sources.map((source) => source.count ?? 0));
  const tip = useChartTip();
  return (
    <ol className="live-panel" aria-label="Each source as the run reports it">
      {tip.layer}
      {sources.map((source) => {
        const name = names.get(source.slug) ?? source.slug;
        const asking = askingWords(source, name, at);
        return (
          <li key={source.slug} className="live-row" data-source={source.slug} data-state={source.state}
            data-quiet={asking.quiet ? 'true' : undefined}>
            {/* The mark's tip names its state, for a pointer; the row says it in words beside it. It is this run's page already, so the mark opens nothing. */}
            <span className="live-mark" {...tip.mark(liveTip(source, name))}>
              <WallMark state={liveMarkState(source)} count={source.count} largest={largest} />
            </span>
            <span className="src-name">{name}</span>
            <span className="src-label">
              {liveLabel(source)}
              {asking.time && <span className="live-time num" data-live="elapsed"> · {asking.time}</span>}
            </span>
            {asking.detail && <p className="live-detail num" data-live="detail">{asking.detail}</p>}
            {asking.quiet && <p className="live-detail live-quiet" data-live="quiet">{asking.quiet}</p>}
            {runId !== undefined && <SourceStop key={`${runId}:${source.slug}`} runId={runId} slug={source.slug} name={name} available={source.stoppable === true} onSaid={onStopSaid} />}
            {source.note && <p className="src-note">{source.note}</p>}
          </li>
        );
      })}
    </ol>
  );
}
