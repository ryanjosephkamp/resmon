import { liveLabel, type LiveSource } from './model';

/** Each source's state as the run's own progress events report it. */
export function LivePanel({ sources, names }: { sources: readonly LiveSource[]; names: ReadonlyMap<string, string> }) {
  return (
    <ol className="live-panel" aria-label="Each source as the run reports it">
      {sources.map((source) => (
        <li key={source.slug} className="live-row" data-source={source.slug} data-state={source.state}>
          <span className={`lmark is-${source.state}`} aria-hidden="true" />
          <span className="src-name">{names.get(source.slug) ?? source.slug}</span>
          <span className="src-label">{liveLabel(source)}</span>
          {source.note && <p className="src-note">{source.note}</p>}
        </li>
      ))}
    </ol>
  );
}
