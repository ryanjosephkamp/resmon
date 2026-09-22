/**
 * J20 Calendar — the upcoming fire matches the routine's cron, in the machine's
 * own timezone.
 *
 * This row had no behavioural test of any kind at the base commit: the calendar
 * was covered by the route smoke test, which establishes that the screen loads
 * and nothing more. The register's invariant is "times are in the user's
 * timezone and schedule status is truthful", and a calendar that drew a daily
 * nine-in-the-morning routine at nine UTC would load perfectly and be wrong
 * everywhere but London in winter.
 *
 * So the assertion is on the hour, not on the presence of an event: a cron of
 * `0 9 * * *` must produce fires at 09:00 *local*, and it must produce them for
 * an active routine and only for an active routine.
 */
import { expect, journey } from './driver';

const NAME = 'journey routine J20';
const HOUR = 9;

journey.describe('J20 Calendar', () => {
  journey('an active routine draws upcoming fires at its cron hour in local time', async ({ resmon }) => {
    await resmon.createRoutine({
      name: NAME,
      cron: `0 ${HOUR} * * *`,
      sources: ['arxiv'],
      keywords: ['perovskite'],
    });

    // Inactive: nothing is scheduled, so nothing may be promised.
    expect(
      (await resmon.readUpcomingFires()).filter((f) => f.routine === NAME),
      'an inactive routine was drawn as having upcoming fires',
    ).toEqual([]);

    await resmon.activateRoutine(NAME);

    const fires = (await resmon.readUpcomingFires()).filter((f) => f.routine === NAME);
    expect(fires.length, 'an active daily routine has no upcoming fire on the calendar').toBeGreaterThan(0);

    // Every one of them, not just the first: a timezone mistake that shifted
    // only the fires across a DST boundary would survive a check of one.
    const wrong = fires.filter((f) => f.when.getHours() !== HOUR || f.when.getMinutes() !== 0);
    expect(
      wrong.map((f) => f.when.toString()),
      `of ${fires.length} upcoming fires, ${wrong.length} are not at ${HOUR}:00 in this machine's timezone`,
    ).toEqual([]);
    console.log(`[J20] ${fires.length} upcoming fires, all at ${HOUR}:00 local; `
      + `first ${fires[0].when.toString()}`);

    // And the month on screen actually shows the routine, rather than the
    // payload carrying fires nothing draws.
    expect(
      fires.some((f) => f.drawn),
      'the calendar holds fires for this routine but draws none of them',
    ).toBe(true);

    await resmon.takePicture('J20-calendar-upcoming-fire');
    expect(resmon.refusedConnections()).toEqual([]);
  });
});
