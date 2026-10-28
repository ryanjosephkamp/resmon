/**
 * J48 Today: the papers since you last looked — what arrived is listed and
 * numbered, looking records nothing, and Mark all read starts the next window.
 *
 * Opening Today must not count as having read it: an accidental open would
 * otherwise empty tomorrow's list. So the journey opens Today, reopens the
 * whole app, and finds the same papers still listed and the engine still on
 * its first window, before it presses Mark all read.
 */
import { expect, journey } from './driver';

journey.describe('J48 Today: the papers since you last looked', () => {
  journey('new papers are listed and numbered, opening Today marks nothing, and Mark all read empties the list', async ({ resmon }) => {
    const run = await resmon.backend.collectPapers({ source: 'arxiv', keywords: ['perovskite'], days: 30, cap: 20 });
    expect((await resmon.backend.execution(run)).status).toBe('completed');
    const documents = (await resmon.backend.corpusCounts()).documents;
    expect(documents, 'the setup collected nothing to list').toBeGreaterThan(0);

    // No look recorded yet: the window is the last week, and says so.
    const first = await resmon.readToday();
    expect(first.heading).toBe('New this week');
    expect(first.total).toBe(documents);
    expect([...first.numbers].sort((a, b) => a - b), 'the numbers are not 1 to N')
      .toEqual(Array.from({ length: documents }, (_, i) => i + 1));
    // A dive is the person's own search, not a watch.
    expect(first.groups).toEqual([{ name: 'From your own searches', count: documents }]);

    // Looking is not marking.
    await resmon.reopenTheApp();
    expect((await resmon.readToday()).total, 'opening Today emptied it').toBe(documents);
    expect((await resmon.backend.today()).window).toBe('first_look');

    await resmon.markAllRead();
    const after = await resmon.readToday();
    expect(after.total).toBe(0);
    expect(after.heading).toBe('New since today');
    expect(after.empty).toMatch(/^Nothing new since then\./);
    expect(await resmon.backend.today()).toMatchObject({ window: 'since_last_look', total: 0 });
  });
});
