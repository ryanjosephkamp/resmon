import { count } from '../today/format';
import { PaperSky } from '../sky/PaperSky';

/**
 * Where a run's papers sit in the whole collection. The caption says how many
 * of them the map has placed, and why the rest are not drawn, rather than
 * implying the marks are the run's whole result.
 */
export function RunSky({ paperIds }: { paperIds: readonly number[] }) {
  return (
    <PaperSky
      marked={paperIds}
      label="Where this run's papers sit in the collection"
      caption={({ placed, total, ready }) => {
        if (total === 0) return 'This run stored no papers.';
        if (placed === null || !ready) {
          return `The collection map is not ready yet; this run's ${count(total, 'paper')} ${total === 1 ? 'is' : 'are'} drawn once it is.`;
        }
        if (placed === total) return `All ${count(total, 'paper')} from this run, marked where they sit in the collection.`;
        return `${placed.toLocaleString('en-US')} of ${count(total, 'paper')} from this run are on the map. `
          + 'The rest are not placed yet: they arrived after its last fit, or have too little text to place.';
      }}
    />
  );
}
