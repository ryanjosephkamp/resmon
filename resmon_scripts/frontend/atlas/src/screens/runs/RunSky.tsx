import { forwardRef } from 'react';
import { Icon } from '../../shell/Icon';
import { count } from '../today/format';
import { PaperSky, type PaperSkyHandle, type SkyChoice, type SkyFacts } from '../sky/PaperSky';
import { useCollectionWords } from '../../collections/current';
import { YOUR_COLLECTION, type CollectionWords } from '../../collections/words';

/**
 * Where a run's papers sit in the whole collection. The caption says how many
 * of them the map has placed, and why the rest are not drawn, rather than
 * implying the marks are the run's whole result.
 */
export const RunSky = forwardRef<PaperSkyHandle, {
  paperIds: readonly number[];
  onOpenMap?: () => void;
  /** When the run ended: a map read before it lacks the run's papers. */
  endedAt?: string | null;
  /** The run is still going, so having no papers yet says nothing about its result. */
  running?: boolean;
  /** The paper open beside the map, and how one is opened there. */
  chosen?: number | null;
  onChoose?: (choice: SkyChoice | null) => void;
  sourceName?: (slug: string) => string;
}>(function RunSky({ paperIds, onOpenMap, endedAt = null, running = false, chosen = null, onChoose, sourceName }, ref) {
  const shown = useCollectionWords();
  return (
    <div className="run-sky">
      <PaperSky
        ref={ref}
        chosen={chosen}
        onChoose={onChoose}
        sourceName={sourceName}
        marked={paperIds}
        readAfter={endedAt}
        label="Where this run's papers sit in the collection"
        caption={(facts) => runSkyCaption(facts, running, shown)}
      />
      {onOpenMap && (
        <button type="button" className="btn sm run-sky-open" onClick={onOpenMap}>
          <Icon name="fit" size={14} />Open the Run&rsquo;s Own Map
        </button>
      )}
    </div>
  );
});

/**
 * The sentence under the collection map. A run still going can store another
 * source's papers after the map read, so a missing placement waits for a read.
 * The map is the shown collection's, and its papers are the run's papers in
 * it; where the collection is named, the sentence says so.
 */
export function runSkyCaption({ placed, total, ready, basis }: SkyFacts, running: boolean,
  shown: CollectionWords = YOUR_COLLECTION): string {
  const there = shown.named ? ` in ${shown.name}` : '';
  if (total === 0) {
    if (running) return 'Papers appear here once the run has stored them.';
    return shown.named ? `None of the papers this run stored is in ${shown.name}.` : 'This run stored no papers.';
  }
  if (placed === null || !ready) {
    return `The ${shown.named ? `map of ${shown.name}` : 'collection map'} is not ready yet; this run's ${count(total, 'paper')}${there} `
      + `${total === 1 ? 'is' : 'are'} drawn once it is.`;
  }
  if (placed === total) return `All ${count(total, 'paper')} from this run${there}, marked where they sit in ${shown.named ? 'it' : 'the collection'}.`;
  if (running) return `${placed.toLocaleString('en-US')} of ${count(total, 'paper')} from this run${there} are on the map. `
    + `${count(total - placed, 'paper')} ${total - placed === 1 ? 'is' : 'are'} waiting for the next map update.`;
  return `${placed.toLocaleString('en-US')} of ${count(total, 'paper')} from this run${there} are on the map. The rest are not: `
    + (basis === 'embeddings'
      ? 'your embedding model has not read them yet, or they have too little text to place.'
      : 'they have too little text in their titles and abstracts to place by wording.');
}
