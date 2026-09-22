/**
 * J12 Explorer — the why-panel names the field each keyword matched in, and
 * says what resmon cannot see.
 *
 * The register's invariant is that upstream reasoning is never claimed. The
 * panel is therefore two things at once and both are asserted: a specific,
 * checkable statement about resmon's own stored fields, and an explicit
 * statement of the limit around it. A panel that said only the first would be
 * the overclaim the whole product is built against.
 *
 * The corpus is seeded by running a dive against the authored source, so the
 * paper the panel explains was stored by the app from a real HTTP reply rather
 * than written into a database by this suite.
 */
import { expect, journey } from './driver';

journey.describe('J12 Explorer', () => {
  journey('the why-panel names the field a keyword matched, and states the limit around it', async ({ resmon }) => {
    const run = await resmon.runDive({ source: 'arxiv', keywords: ['perovskite'], days: 30, cap: 20 });
    expect((await resmon.waitForRunToSettle(run)).status).toBe('completed');
    expect((await resmon.backend.corpusCounts()).documents).toBeGreaterThan(0);

    const title = await resmon.openFirstPaper();
    expect(title.length).toBeGreaterThan(0);

    const why = await resmon.readWhyPanel();

    // A keyword is reported with the field it was found in — not merely that
    // it matched.
    expect(why.matches.length, 'the panel explained no keyword at all').toBeGreaterThan(0);
    const matched = why.matches.find((m) => m.keyword.toLowerCase().includes('perovskite'));
    expect(matched, 'the keyword the run used is not in the panel').toBeTruthy();
    expect(matched!.field.length, 'the panel matched a keyword nowhere in particular').toBeGreaterThan(0);
    expect(
      ['the title', 'the abstract', 'the subject categories', 'the author list']
        .some((field) => matched!.field.includes(field)),
      `the panel named no stored field; it said "${matched!.field}"`,
    ).toBe(true);

    // And the limit is stated, in the panel, not in documentation somewhere.
    expect(why.cannotSee.length, 'the panel claimed a match with no stated limit').toBeGreaterThan(0);
    expect(why.cannotSee.join(' ')).toContain('not its full text');
    // Case-insensitively: the heading is upper-cased by the stylesheet, and
    // what is under test is that the limits block is on screen, not its casing.
    expect(why.text.toLowerCase()).toContain('what resmon cannot see');

    await resmon.takePicture('J12-explorer-why-panel');
    expect(resmon.refusedConnections()).toEqual([]);
  });
});
