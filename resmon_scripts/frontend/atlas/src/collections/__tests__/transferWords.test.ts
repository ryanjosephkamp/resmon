import { changedWords, type PapersChanged } from '../papers';
const describeTransfer: (done: PapersChanged, target: string, source: string) => string = changedWords;
const base: PapersChanged = { mode: 'move', collection_id: 2, from_collection_id: 1,
  added: [], removed: [], already_there: 0, not_in_source: 0, missing: 0 };
const removed = (n: number) => Array.from({ length: n }, (_, i) => ({ document_id: i + 1, added_at: '', added_by: 'run', execution_id: null }));
test.each([
  [{ already_there: 1, removed: removed(1) }, 'Optics already held that paper. It left Main Collection.'],
  [{ already_there: 2, removed: removed(2) }, 'Optics already held those 2 papers. They left Main Collection.'],
  [{ added: [1], removed: removed(1) }, 'Moved 1 paper to Optics.'],
  [{ added: [1], already_there: 1, removed: removed(2) }, 'Moved 1 paper to Optics. 1 paper was there already; 2 papers left Main Collection.'],
  [{ missing: 1 }, 'No papers were moved. 1 paper is no longer stored.'],
  [{ not_in_source: 2 }, 'No papers were moved. 2 papers were not in Main Collection to move.'],
  [{}, 'No papers were moved.'],
  [{ mode: 'copy', already_there: 1 }, 'Optics already held that paper.'],
  [{ mode: 'copy', added: [1], already_there: 2 }, 'Copied 1 paper to Optics. 2 papers were there already.'],
  [{ mode: 'copy', missing: 2 }, 'No papers were copied. 2 papers are no longer stored.'],
] as [Partial<PapersChanged>, string][])('reports each actual transfer outcome (%j)', (change, expected) => {
  expect(describeTransfer({ ...base, ...change }, 'Optics', 'Main Collection')).toBe(expected);
});
