/**
 * The Runs tab's selection, beyond export, bundle, and delete: what Save as
 * searches and Run again say, before and after.
 */
import { quotedList, ranAgainSentence, runAgainQuestion, savable, savedSentence } from '../selection';
import type { RunRow } from '../model';

const run = (id: number, extra: Partial<RunRow> = {}): RunRow => ({
  id, status: 'completed', execution_type: 'deep_dive', routine_id: null, keywords: [`terms ${id}`], query: `terms ${id}`,
  parameters: JSON.stringify({ query: `terms ${id}`, keywords: [`terms ${id}`], repositories: ['arxiv'], max_results: 20 }),
  ...extra,
}) as RunRow;

describe('Save as searches', () => {
  test('saves a Deep Dive or a Deep Sweep, never a watch’s run', () => {
    const runs = [run(1), run(2, { execution_type: 'deep_sweep' }), run(3, { execution_type: 'automated_sweep', routine_id: 7 })];
    expect(savable(runs).map((r) => r.id)).toEqual([1, 2]);
  });

  test('says what it saved, by name, and why a watch’s run was not', () => {
    expect(savedSentence({ saved: [{ id: 1, name: 'graphs' }], watches: [], failed: [] })).toBe('Saved a search: “graphs”.');
    expect(savedSentence({ saved: [{ id: 1, name: 'graphs' }, { id: 2, name: 'nerf, splat' }], watches: [9], failed: [] }))
      .toBe('Saved 2 searches: “graphs” and “nerf, splat”. Run 9 is a watch’s run, not saved: its search is its '
        + 'watch’s, and Saved keeps a copy of every watch.');
    expect(savedSentence({ saved: [], watches: [9, 10], failed: [] }))
      .toBe('Runs 9 and 10 are watches’ runs, not saved: their searches are their watches’, and Saved keeps a copy of every watch.');
  });

  test('names three or more with the serial comma', () => {
    expect(quotedList(['a', 'b', 'c'])).toBe('“a”, “b”, and “c”');
  });
});

describe('Run again', () => {
  test('asks first, saying what it starts and how it summarizes', () => {
    expect(runAgainQuestion([run(4)], { free: 3, cap: 3 })).toBe(
      'Run 4, “terms 4”, again, with its own terms, dates, limit, and sources, as a new run linked back to it? It '
      + 'summarizes only if its run tried to, with what Settings › AI holds now.');
  });

  test('says how many would wait for a free slot, that a watch’s run is sent as its watch is set, and leaves a running run alone', () => {
    const chosen = [run(4), run(5), run(6, { execution_type: 'automated_sweep', routine_id: 2 }), run(7, { status: 'running' })];
    expect(runAgainQuestion(chosen, { free: 1, cap: 3 })).toBe(
      'Run 3 runs again, each with its own terms, dates, limit, and sources, as new runs linked back to them? Each '
      + 'summarizes only if its run tried to, with what Settings › AI holds now. Run 6 is a watch’s run: it is emailed and '
      + 'delivered as its watch is set when it finishes. resmon runs 3 at once, so 2 wait for a free slot, under Waiting '
      + 'above, and start on their own. Run 7 is still running, and is not run again.');
    expect(runAgainQuestion([run(4)], { free: 0, cap: 1 })).toContain('resmon runs 1 at once, so it waits for a free slot');
  });

  test('asks nothing when every chosen run is still running', () => {
    expect(runAgainQuestion([run(7, { status: 'running' })], { free: 3, cap: 3 })).toBeNull();
  });

  test('says what started and what waits', () => {
    expect(ranAgainSentence({ started: [41, 42], queued: 0, refused: [] })).toBe('Started runs 41 and 42.');
    expect(ranAgainSentence({ started: [41], queued: 2, refused: [] }))
      .toBe('Started run 41. 2 wait for a free slot, under Waiting, and start on their own.');
    expect(ranAgainSentence({ started: [], queued: 1, refused: [] }))
      .toBe('1 waits for a free slot, under Waiting, and starts on its own.');
    expect(ranAgainSentence({ started: [], queued: 0, refused: [{ id: 3, reason: 'no' }] })).toBeNull();
  });
});
