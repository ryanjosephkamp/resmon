/**
 * J49 Shared wording across papers — the scan is started from its screen, every
 * abstract it read is accounted for, and a pair's numbers and marked passages
 * are the engine's own, stated without a verdict.
 *
 * The papers are collected over the API (J01 is the journey for the dive form
 * itself) from an authored source: two records by different authors that share
 * one 30-word passage, a third by the first author that shares 24 words with
 * her first, and a fourth too short to compare. The row's invariants: what the
 * screen says was compared and not compared adds up to every paper collected;
 * the pair lands in "no author in common" and the reuse by one author in its
 * own group; and the pair view's sentences, numbers and marked text are the
 * engine's, with what resmon cannot see stated beside them.
 */
import { expect, journey } from './driver';

journey.use({ sourceReply: 'shared_wording' });

/** A span of a text by Unicode codepoints, as the engine counts them. */
function codepoints(text: string, [start, end]: number[]): string {
  return Array.from(text).slice(start, end).join('');
}

journey.describe('J49 Shared wording across papers', () => {
  journey('the scan accounts for every paper, and a pair is measured, marked, and not judged', async ({ resmon }) => {
    const run = await resmon.backend.collectPapers({ source: 'arxiv', keywords: ['Authored'], days: 60, cap: 10 });
    expect((await resmon.backend.execution(run)).status).toBe('completed');
    const documents = (await resmon.backend.corpusCounts()).documents;
    expect(documents, 'the setup collected the four authored records').toBe(4);

    const reading = await resmon.scanForSharedWording();
    const stored = await resmon.backend.sharedWording();
    expect(stored.scan, 'the scan stored nothing').not.toBeNull();
    const scan = stored.scan!;
    expect(scan.compared + scan.not_compared.no_abstract + scan.not_compared.too_short,
      'a collected paper is neither compared nor counted as not compared').toBe(documents);
    expect([scan.compared, scan.not_compared.too_short]).toEqual([3, 1]);
    expect(reading.compared).toBe('3 abstracts were compared. 1 paper has an abstract under 40 words, so it was not compared.');
    expect(reading.groups).toEqual(Object.fromEntries(stored.groups.map((g) => [g.category, g.count])));
    expect(reading.groups).toEqual({ different_authors: 1, same_authors: 1, authors_unknown: 0, same_work: 0, notice: 0 });

    const pair = stored.groups.find((g) => g.category === 'different_authors')!.pairs[0]!;
    const view = await resmon.openTheSharedWordingPair(pair.a, pair.b);
    const engine = await resmon.backend.sharedWordingPair(pair.a, pair.b);
    expect(engine.longest).toBe(30);
    expect(view.summary).toEqual(engine.summary);
    expect(view.summary[1]).toBe('They list no author in common.');
    expect(view.summary.join(' '), 'the pair view must not judge').not.toMatch(/plagiar|copied|stolen|original/i);
    expect(view.longest).toBe('30 words');
    expect(view.share).toBe(`${Math.floor(engine.share * 100 + 1e-9)}%`);
    expect([view.left, view.right]).toEqual([engine.left.id, engine.right.id]);
    expect(view.marked.left).toEqual(engine.passages.map((p) => codepoints(engine.left.text, p.left)));
    expect(view.marked.right).toEqual(engine.passages.map((p) => codepoints(engine.right.text, p.right)));
    expect(view.limits).toEqual(engine.limits);
    expect(resmon.refusedConnections()).toEqual([]);
  });
});
