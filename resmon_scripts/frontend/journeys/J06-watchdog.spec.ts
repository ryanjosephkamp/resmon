/**
 * J06 Watchdog — with no history it says what it cannot judge, three failures
 * in a row make a source Broken, and the mute goes when the reason goes.
 *
 * The whole point of this screen is that it is allowed to be quiet only when it
 * has grounds to be. So the first assertion is about an empty install: the
 * verdict must be "nothing to check yet", never "nothing looks wrong". Those
 * are two different sentences and only one of them is honest over no data.
 *
 * The failures are real ones. The authored source stops answering — the socket
 * closes without an HTTP response — so the shipped client records
 * `upstream_failure` three times through its own error path, which is what the
 * rule counts. A seeded database row would not exercise that path.
 *
 * The mute is the third property and the subtle one: muting is not a way to
 * make a finding permanently invisible. When the source answers again the
 * finding goes, and the mute goes with it, so a recurrence is reported afresh.
 */
import { expect, journey } from './driver';

journey.describe('J06 Watchdog', () => {
  journey('an empty install says what it cannot judge, three failures make a source Broken, and the mute clears with its reason', async ({ resmon }) => {
    const empty = await resmon.readWatchdog();
    console.log(`[J06] empty install verdict: ${JSON.stringify(empty.verdict)}`);
    // Compared without case throughout: the stylesheet upper-cases these
    // headings, so pinning the capitalisation would be pinning a stylesheet.
    expect(empty.verdict.toLowerCase(), 'an install with no history claimed a clean bill')
      .not.toContain('nothing looks wrong');
    expect(empty.verdict.toLowerCase()).toContain('nothing to check yet');
    expect(empty.findings, 'an install with no history found something').toEqual([]);

    // Three runs against a source that stops answering. Real requests, real
    // transport failures, recorded by the shipped client.
    resmon.theSourceGoesDown();
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      // The form's own default cap: the run has to reach the source and fail,
      // and how many results it would have asked for is not part of the rule.
      const failed = await resmon.runDive({ source: 'arxiv', keywords: ['perovskite'] });
      await resmon.waitForRunToSettle(failed);
    }
    const record = await resmon.backend.watchdogFindings();
    console.log(`[J06] thresholds: ${JSON.stringify(record.thresholds)}`);
    expect(
      Number(record.thresholds.consecutive_errors),
      'the rule this journey drives is no longer three consecutive failures',
    ).toBe(3);

    const broken = await resmon.readWatchdog();
    console.log(`[J06] findings: ${JSON.stringify(broken.findings)}`);
    const failure = broken.findings.find((finding) => finding.scope.includes('arxiv'));
    expect(failure, 'three failures in a row produced no finding about the source').toBeTruthy();
    expect(failure!.severity.toLowerCase(), 'a source that failed three times is not reported as broken')
      .toBe('broken');
    expect(failure!.title).toContain('arxiv');
    expect(broken.verdict.toLowerCase(), 'the verdict did not change when something broke').toContain('broken');

    // Mute it. It stays on screen — muting is not hiding — in its own section.
    await resmon.muteTheFinding(failure!.title);
    const muted = await resmon.readWatchdog();
    console.log(`[J06] after muting: ${JSON.stringify(muted.findings)}`);
    const stillThere = muted.findings.find((finding) => finding.title === failure!.title);
    expect(stillThere, 'muting a finding removed it from the page').toBeTruthy();
    expect(stillThere!.muted, 'the muted finding is not marked as muted').toBe(true);
    expect(muted.mutedHeading).toMatch(/^Muted/i);
    expect(muted.verdict.toLowerCase(), 'a muted finding still counts as an alarm').not.toContain('broken');

    // The source recovers. The finding has no grounds any more, so it goes —
    // and the mute goes with it, which is what makes a recurrence audible.
    resmon.theSourceComesBack();
    const recovered = await resmon.runDive({ source: 'arxiv', keywords: ['perovskite'] });
    expect((await resmon.waitForRunToSettle(recovered)).status).toBe('completed');
    const after = await resmon.readWatchdog();
    console.log(`[J06] after recovery: ${JSON.stringify(after.findings)}`);
    expect(
      after.findings.map((finding) => finding.title),
      'the broken finding survived the source answering again',
    ).not.toContain(failure!.title);
    expect(after.mutedHeading, 'the mute outlived the condition it was muting').toBe('');

    await resmon.takePicture('J06-watchdog');
    expect(resmon.refusedConnections()).toEqual([]);
  });
});
