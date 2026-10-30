import { Icon } from '../../shell/Icon';
import { count } from '../today/format';
import { PaperSky } from '../sky/PaperSky';

/**
 * Where a run's papers sit in the whole collection. The caption says how many
 * of them the map has placed, and why the rest are not drawn, rather than
 * implying the marks are the run's whole result.
 */
export function RunSky({ paperIds, onOpenMap, endedAt = null }: {
  paperIds: readonly number[];
  onOpenMap?: () => void;
  /** When the run ended: a map read before it lacks the run's papers. */
  endedAt?: string | null;
}) {
  return (
    <div className="run-sky">
      <PaperSky
        marked={paperIds}
        readAfter={endedAt}
        label="Where this run's papers sit in the collection"
        caption={({ placed, total, ready, basis }) => {
          if (total === 0) return 'This run stored no papers.';
          if (placed === null || !ready) {
            return `The collection map is not ready yet; this run's ${count(total, 'paper')} ${total === 1 ? 'is' : 'are'} drawn once it is.`;
          }
          if (placed === total) return `All ${count(total, 'paper')} from this run, marked where they sit in the collection.`;
          return `${placed.toLocaleString('en-US')} of ${count(total, 'paper')} from this run are on the map. The rest are not: `
            + (basis === 'embeddings'
              ? 'your embedding model has not read them yet, or they have too little text to place.'
              : 'they have too little text in their titles and abstracts to place by wording.');
        }}
      />
      {onOpenMap && (
        <button type="button" className="btn sm run-sky-open" onClick={onOpenMap}>
          <Icon name="fit" size={14} />Open the run&rsquo;s own map
        </button>
      )}
    </div>
  );
}
