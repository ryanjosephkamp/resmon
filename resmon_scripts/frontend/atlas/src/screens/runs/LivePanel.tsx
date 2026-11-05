import { useNow } from '../../lib/useNow';
import { WallMark } from '../health/WallMark';
import { askingWords, liveMarkState } from './live';
import { liveLabel, type LiveSource } from './model';

/**
 * Each source's state as the run's own progress events report it, in the
 * Source wall's marks. A source being asked says how long, as the engine's
 * heartbeat measured it, and what its search has done: the requests sent,
 * the retries, and what it is waiting for. The panel keeps its own clock,
 * read twice a second while a source is being asked, so the time moves on
 * between heartbeats (`askingWords`) and a source the engine has said nothing
 * about for a while says so; `now` fixes it, for a test.
 */
export function LivePanel({ sources, names, now }: {
  sources: readonly LiveSource[];
  names: ReadonlyMap<string, string>;
  now?: number;
}) {
  const ticking = useNow(500, now === undefined && sources.some((source) => source.state === 'asking'));
  const at = now ?? ticking;
  const largest = Math.max(0, ...sources.map((source) => source.count ?? 0));
  return (
    <ol className="live-panel" aria-label="Each source as the run reports it">
      {sources.map((source) => {
        const name = names.get(source.slug) ?? source.slug;
        const asking = askingWords(source, name, at);
        return (
          <li key={source.slug} className="live-row" data-source={source.slug} data-state={source.state}
            data-quiet={asking.quiet ? 'true' : undefined}>
            <WallMark state={liveMarkState(source)} count={source.count} largest={largest} />
            <span className="src-name">{name}</span>
            <span className="src-label">
              {liveLabel(source)}
              {asking.time && <span className="live-time num" data-live="elapsed"> · {asking.time}</span>}
            </span>
            {asking.detail && <p className="live-detail num" data-live="detail">{asking.detail}</p>}
            {asking.quiet && <p className="live-detail live-quiet" data-live="quiet">{asking.quiet}</p>}
            {source.note && <p className="src-note">{source.note}</p>}
          </li>
        );
      })}
    </ol>
  );
}
