/**
 * J17 AI summarization lanes — a lane that cannot work stands down, says so in
 * the run's own log, and the run finishes with no summary rather than with an
 * invented one.
 *
 * This is the row where "never overclaim" is the whole product. A summarizer
 * whose sign-in has lapsed is the ordinary case — the person set it up weeks
 * ago and the OAuth session expired — and the two failures that would matter
 * are the run dying with it, and a paper acquiring a summary that is really an
 * error message.
 *
 * **What is authored, and what is not.** The lane is pointed at a `claude` this
 * suite wrote, which answers with the envelope a real CLI sends when its OAuth
 * session has expired: `is_error` set, the reason in `result`, and exit zero —
 * which is why the app keys on the field and not on the status. Everything
 * downstream is the app's own: finding the command, building the argv, reading
 * the envelope, classifying the failure as fatal to the lane, standing it down,
 * finishing the run and writing the log. What no double can see is a real CLI's
 * own behaviour — a version change, a flag that stopped being accepted — and
 * the ledger says so.
 *
 * **A disagreement this row reports rather than decides.** The run's log is
 * careful: it names the lane, its outcome, the reason and `0 / 2 documents`.
 * The report's own header is not: it prints `AI Summarizer: <provider>/<model>`
 * whenever AI was asked for, including when that lane produced nothing at all.
 * A reader of the report alone would take it for a report that was summarized.
 * The row asserts what is true and prints the disagreement; whether the header
 * or the register is wrong is the lead's call, not this suite's.
 */
import { expect, journey } from './driver';

/** What the authored CLI says, and therefore what the app has to carry through. */
const LAPSED = 'Failed to authenticate: OAuth session expired and could not be refreshed';

journey.describe('J17 AI summarization lanes', () => {
  journey('a lane whose sign-in has lapsed stands down with its reason, and the run still finishes', async ({ resmon }) => {
    await resmon.useAnAuthoredSummarizerThatIsNotSignedIn();

    // Before the run: the app says it found the command and says, unprompted,
    // that finding it is not knowing whether anyone is signed into it. That
    // sentence is the reason this row can be honest later.
    const lane = await resmon.readAiLaneStatus();
    console.log(`[J17] Settings → AI says: ${JSON.stringify(lane)}`);
    expect(lane, 'Settings → AI does not say which command the lane would use')
      .toContain('authored-summarizer');
    expect(
      lane.toLowerCase(),
      'the page implies that finding the command establishes a sign-in',
    ).toContain('has not checked whether you are signed in');

    const run = await resmon.runDive({
      source: 'arxiv', keywords: ['perovskite'], cap: 10, summarize: true,
    });
    const facts = await resmon.waitForRunToSettle(run);
    console.log(`[J17] the run settled as "${facts.status}"`);

    // A lane that cannot work degrades the run; it does not fail it. The papers
    // are found and stored either way — that is the point of a lane.
    expect(facts.status, 'a summarizer that could not sign in took the whole run with it')
      .toBe('completed');

    const log = await resmon.readRunLog(run);
    console.log(`[J17] log:\n${log}`);

    // The lane is named, its outcome is named, and the reason is the CLI's own
    // words rather than a generic failure. All three, because a log that said
    // only "AI failed" would leave the person with nothing to act on.
    expect(log, 'the log does not name the lane that stood down').toContain('AI lane 1');
    expect(log, 'the log does not say what became of the lane').toMatch(/AI lane 1 \(.+\): failed/);
    expect(log, "the log does not carry the CLI's own reason").toContain(LAPSED);
    // And the denominator: how many of how many, counted by the app.
    expect(log, 'the log does not say how many documents were summarized')
      .toContain('AI summaries produced for 0 / 2 documents');

    const report = await resmon.readTheReport(run);
    console.log(`[J17] report head:\n${report.slice(0, 700)}`);

    // Nothing invented. No paper carries a summary, and in particular no paper
    // carries the error as though it were one — which is the failure mode a
    // lane that writes whatever it got back would produce.
    expect(report, 'a paper was given a summary by a lane that produced none')
      .not.toContain('AI Summary:');
    expect(report, "the CLI's error was rendered into the report as content")
      .not.toContain(LAPSED);
    // The papers are still there. A degraded lane must not cost the run its work.
    expect(report, 'the run lost its papers along with its summarizer')
      .toContain('Authored perovskite stability note for the journey fixture');

    const header = /\*\*AI Summarizer:\*\*\s*(.+)/.exec(report);
    if (header) {
      console.log(`[J17] the report header names a summarizer — "${header[1].trim()}" — over a run `
        + 'in which that lane produced 0 of 2 summaries. The run log is exact about this and the '
        + 'report header is not. Reported, not asserted either way: a journey observes.');
    }
    console.log('[J17] NOT VERIFIED: a real agent CLI\'s own behaviour. What this row replaces '
      + 'is the sign-in, by way of the envelope a lapsed CLI sends; a version change or a flag '
      + 'the real command stopped accepting is invisible here. That stays with the live suite.');

    await resmon.takePicture('J17-ai-summarization-lanes');
    expect(resmon.refusedConnections()).toEqual([]);
  });
});
