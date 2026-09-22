/**
 * J26 Danger Zone — the wrong word is refused by the backend, and the right one
 * erases exactly what it names.
 *
 * B4 says only the user's Danger Zone deletes from a corpus, which makes two
 * things load-bearing and neither of them is the screen. The first is that the
 * refusal is the *backend's*: a disabled button is a courtesy, and a journey
 * that only checked the button would pass against an app whose endpoint erased
 * a corpus for anybody who asked. The second is the scope: "erase the paper
 * corpus" must take the papers and leave the run that found them, and the only
 * way to know that is to count both before and after.
 *
 * Both counts come over the app's own API, because a count of rows in a file is
 * not something a user ever sees and because this has to stay checkable against
 * an installed app.
 */
import { expect, journey } from './driver';

journey.describe('J26 Danger Zone', () => {
  journey('the wrong word is refused by the backend, and the right one erases only what it names', async ({ resmon }) => {
    // Something to erase, and something that must survive the erasing.
    const run = await resmon.runDive({ source: 'arxiv', keywords: ['perovskite'], cap: 10 });
    expect((await resmon.waitForRunToSettle(run)).status).toBe('completed');
    const before = await resmon.backend.corpusCounts();
    console.log(`[J26] before: ${JSON.stringify(before)}`);
    expect(before.documents, 'nothing was collected, so nothing would be erased').toBeGreaterThan(0);
    expect(before.executions).toBeGreaterThan(0);

    // The wrong word, through the screen. The screen refuses first — which is
    // correct — so the HTTP refusal is asserted directly underneath, against
    // the same endpoint the button would have called.
    const typed = await resmon.eraseWith('Erase the paper corpus', 'DELETE');
    console.log(`[J26] the wrong word on screen: ${typed.body}`);
    let refusal: { status: number; detail: string } = { status: 0, detail: '' };
    try {
      await resmon.backend.eraseCorpus('DELETE');
    } catch (error) {
      const message = String((error as Error).message);
      refusal = {
        status: Number(/HTTP (\d+)/.exec(message)?.[1] ?? 0),
        detail: message,
      };
    }
    console.log(`[J26] the wrong word over HTTP: ${refusal.status}`);
    expect(refusal.status, 'the backend accepted an erase with the wrong word').toBe(400);
    expect(refusal.detail).toContain('CONFIRM');
    // And it really did refuse: nothing moved.
    expect(await resmon.backend.corpusCounts()).toEqual(before);

    // The right word, through the screen a person uses.
    const erased = await resmon.eraseWith('Erase the paper corpus', 'CONFIRM');
    console.log(`[J26] the right word: HTTP ${erased.status}`);
    expect(erased.status).toBe(200);

    const after = await resmon.backend.corpusCounts();
    console.log(`[J26] after: ${JSON.stringify(after)}`);
    expect(after.documents, 'the corpus erase left papers behind').toBe(0);
    // Exactly what it named, and nothing else. The run that found the papers is
    // a different Danger Zone action and must still be there.
    expect(after.executions, 'erasing the corpus also took the run history').toBe(before.executions);
    expect(after.routines).toBe(before.routines);

    await resmon.takePicture('J26-danger-zone');
    expect(resmon.refusedConnections()).toEqual([]);
  });
});
