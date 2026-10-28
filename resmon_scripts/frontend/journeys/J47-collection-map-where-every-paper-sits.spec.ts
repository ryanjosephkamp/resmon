/**
 * J47 Collection map: where every paper sits — the plate shows the whole
 * collection, and says what placed it.
 *
 * The papers are collected over the API (J01 is the journey for the dive form
 * itself), and what is read is the plate's own title block. The count it
 * claims must be the count the map serves, and with what it leaves out
 * account for every paper collected. No embedding model is set, so the map is
 * placed by shared wording, and the plate must say so and never call it
 * meaning: the row's whole invariant is that the placement's basis is stated.
 */
import { expect, journey } from './driver';

journey.describe('J47 Collection map: where every paper sits', () => {
  journey('every collected paper is accounted for on the plate, which says it was placed by wording', async ({ resmon }) => {
    const run = await resmon.backend.collectPapers({ source: 'arxiv', keywords: ['perovskite'], days: 30, cap: 20 });
    expect((await resmon.backend.execution(run)).status).toBe('completed');
    const documents = (await resmon.backend.corpusCounts()).documents;
    expect(documents, 'the setup collected nothing to place').toBeGreaterThan(0);

    const plate = await resmon.readThePlate();
    const map = await resmon.backend.collectionMap();
    expect(map.state).toBe('ready');
    expect(plate.papers, 'the plate claims a different count than the map it draws').toBe(map.points.id.length);
    expect(plate.papers + map.unplaced.no_text + map.unplaced.not_embedded, 'a collected paper is unaccounted for')
      .toBe(documents);

    expect(map.basis).toBe('words');
    expect(plate.basis).toMatch(/wording/);
    expect(plate.basis, 'a map placed by words must not claim to place by meaning').not.toMatch(/meaning/);
  });
});
