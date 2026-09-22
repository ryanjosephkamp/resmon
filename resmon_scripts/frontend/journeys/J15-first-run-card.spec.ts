/**
 * J15 First-run card — a fresh state directory is offered three optional steps
 * in wording that never says a lane is ready, Skip survives a relaunch, and the
 * card retires itself on the first run.
 *
 * The card is the first thing a new install sees, which makes its wording the
 * app's first chance to overclaim. It cannot know whether a command is signed
 * in or a key accepted, and it says so rather than drawing a tick that means
 * "found" and reads as "working". That sentence is asserted here literally.
 *
 * The other two halves are about the card being a one-time thing in two
 * different ways: Skip is a decision that has to survive the window closing,
 * and doing any work at all retires it without being asked.
 */
import { expect, journey } from './driver';

journey.describe('J15 First-run card', () => {
  journey('the card offers three optional steps, never claims a lane is ready, and retires on the first run', async ({ resmon }) => {
    const card = await resmon.readTheFirstRunCard();
    expect(card.present, 'a fresh state directory did not show the first-run card').toBe(true);
    console.log(`[J15] steps: ${JSON.stringify(card.steps.map((s) => `${s.id}:${s.mark}`))}`);

    // Three steps, and the denominator is the card's own list rather than the
    // number three typed here — a fourth step appearing should be noticed.
    expect(card.steps.map((step) => step.id)).toEqual(['agent_cli', 'ai_key', 'repository_key']);

    // The wording. Optional, and explicitly not a claim that anything works.
    expect(card.text, 'the card does not say the steps are optional').toMatch(/optional/i);
    expect(
      card.text,
      'the card no longer says that found and configured are not the same as working',
    ).toMatch(/not the same as working/i);
    // Every mark carries a meaning a screen reader can read, and none of them
    // is a claim of readiness: "done" here means found, and the foot says so.
    for (const step of card.steps) {
      expect(['done', 'not done', 'could not check'],
        `${step.id} is marked "${step.mark}"`).toContain(step.mark);
    }
    expect(card.text, 'the card claims a lane is ready').not.toMatch(/\bready\b/i);

    const onboarding = await resmon.backend.onboarding();
    expect(onboarding.show, 'the record disagrees with the screen about showing the card').toBe(true);
    expect(onboarding.dismissed).toBe(false);
    expect(onboarding.counts, 'a fresh state has work in it already')
      .toEqual({ documents: 0, executions: 0, routines: 0 });

    await resmon.takePicture('J15-first-run-card');

    // Skip, and then close the window and open it again. A dismissal kept only
    // in the renderer would pass everything above and fail here.
    await resmon.skipTheFirstRunCard();
    await resmon.reopenTheApp();
    const afterSkip = await resmon.readTheFirstRunCard();
    expect(afterSkip.present, 'Skip did not survive the window closing').toBe(false);
    expect((await resmon.backend.onboarding()).dismissed).toBe(true);

    // And the other retirement: doing any work retires it, whether or not it
    // was skipped. Asserted through the record, because the card is already
    // gone by the first route and an absent card cannot show which reason
    // retired it.
    const run = await resmon.runDive({ source: 'arxiv', keywords: ['perovskite'], cap: 10 });
    expect((await resmon.waitForRunToSettle(run)).status).toBe('completed');
    const afterRun = await resmon.backend.onboarding();
    console.log(`[J15] after one run: ${JSON.stringify(afterRun.counts)}`);
    expect(afterRun.counts.executions, 'the run left no execution').toBeGreaterThan(0);
    expect(afterRun.show, 'the card would come back after a run').toBe(false);

    expect(resmon.refusedConnections()).toEqual([]);
  });
});
