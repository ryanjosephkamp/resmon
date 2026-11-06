/** A second collection kept beside the first, without losing either paper. */
import { expect, journey } from './driver';

const NAME = 'J51 second collection';
const RENAMED = 'J51 renamed collection';

journey.describe('J51 Collections', () => {
  journey('make, switch, copy, rename, reopen, and confirm removal while the first collection stays intact', async ({ resmon }) => {
    const run = await resmon.runDive({ source: 'arxiv', keywords: ['perovskite'] });
    expect((await resmon.waitForRunToSettle(run)).status).toBe('completed');
    const before = await resmon.backend.collections();
    const first = before.collections.find((c) => c.id === before.default_id)!;
    const original = await resmon.backend.papersInCollection(first.id);
    expect(original).toHaveLength(2);
    expect(await resmon.readPapersInThisCollection()).toEqual(original);

    const second = await resmon.makeCollection(NAME);
    expect((await resmon.readCollections()).map((c) => c.name)).toContain(NAME);
    expect((await resmon.backend.collections()).collections.find((c) => c.id === second))
      .toMatchObject({ name: NAME, papers: 0, is_default: false });
    await resmon.switchCollection(NAME);
    expect(await resmon.readShownCollection()).toBe(NAME);
    expect(await resmon.readPapersInThisCollection()).toEqual([]);
    expect(await resmon.backend.papersInCollection(second)).toEqual([]);

    await resmon.switchCollection(first.name);
    const paper = original[0]!;
    await resmon.copyPaperToCollection(paper.id, NAME);
    expect((await resmon.backend.paper(paper.id)).collections.map((c) => c.id).sort((a, b) => a - b))
      .toEqual([first.id, second].sort((a, b) => a - b));
    expect(await resmon.backend.papersInCollection(first.id)).toEqual(original);
    expect(await resmon.backend.papersInCollection(second)).toEqual([paper]);
    await resmon.switchCollection(NAME);
    expect(await resmon.readPapersInThisCollection()).toEqual([paper]);
    await resmon.renameCollection(NAME, RENAMED);
    expect(await resmon.readShownCollection()).toBe(RENAMED);
    await resmon.reopenTheApp();
    expect(await resmon.readShownCollection()).toBe(RENAMED);
    const reopened = await resmon.backend.collections();
    expect(reopened.current_id).toBe(second);
    expect(reopened.collections.map((c) => c.name)).toEqual([first.name, RENAMED]);
    expect((await resmon.readCollections()).map((c) => c.name)).toEqual([first.name, RENAMED]);
    expect(await resmon.readPapersInThisCollection()).toEqual([paper]);

    await resmon.readCollections();
    await resmon.takePicture('J51-renamed-collection-after-reopening');
    const question = await resmon.askToDeleteCollection(RENAMED);
    expect(question).toContain('No paper leaves resmon');
    expect(question).toContain('1 paper is also in another collection, and will stay there');
    expect((await resmon.backend.collections()).collections.map((c) => c.id)).toContain(second);
    const removed = await resmon.confirmDeleteCollection(RENAMED);
    expect(removed).toContain(`Deleted ${RENAMED}.`);
    const after = await resmon.backend.collections();
    expect(after.collections).toEqual([first]);
    expect(after.current_id).toBe(first.id);
    expect(await resmon.readShownCollection()).toBe(first.name);
    expect(await resmon.backend.papersInCollection(first.id)).toEqual(original);
    expect(await resmon.readPapersInThisCollection()).toEqual(original);
    console.log(`[J51] collection ${second} created, copied into, renamed, remembered after reopening, and removed; ${original.length} original papers kept.`);
    console.log('[J51] NOT VERIFIED: moving or undoing a move, reassignment of watches, papers held only in the deleted collection, or independent windows. This row copies a paper; reopening checks the engine’s remembered collection for a new window.');
    await resmon.takePicture('J51-first-collection-after-removal');
    expect(resmon.refusedConnections()).toEqual([]);
  });
});
