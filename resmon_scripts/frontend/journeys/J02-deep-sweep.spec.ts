/**
 * J02 Deep Sweep — the coverage sentence keeps its denominators, and a source
 * that could not be asked is named rather than counted as a quiet zero.
 *
 * Two sources, chosen for what they do rather than for what they are: the
 * authored one answers over real HTTP, and `springer` is key-required and has
 * no key on this machine, so the app must say *that* about it instead of
 * reporting it as having found nothing. "N answered of M selected" is the
 * sentence the register asks for and it is read off the report, while the same
 * two facts are read back out of the search record, so a report that agreed
 * with nothing would fail here.
 */
import { expect, journey } from './driver';

journey.describe('J02 Deep Sweep', () => {
  journey('the report says how many answered of how many were selected, and names the one that could not', async ({ resmon }) => {
    const run = await resmon.runSweep({
      sources: ['arxiv', 'springer'],
      query: 'perovskite',
      cap: 10,
    });
    const facts = await resmon.waitForRunToSettle(run);
    expect(facts.status).toBe('completed');

    const sentence = await resmon.readCoverageSentence(run);
    // The denominator is the selection the run saved, not a number this spec
    // chose: two sources were ticked, so two must be accounted for.
    expect(sentence, 'the sentence dropped its denominator').toContain('2 selected sources');
    expect(sentence).toContain('1 answered');
    expect(sentence).toContain('1 recorded non-answer');
    expect(sentence).toContain('could not answer');

    const outcomes = await resmon.readReportOutcomes(run);
    expect(outcomes.map((o) => o.source).sort()).toEqual(['arxiv', 'springer']);

    const keyless = outcomes.find((o) => o.source === 'springer')!;
    expect(keyless.label, 'an unconfigured key-required source was not a non-answer').toContain('non answer');
    expect(keyless.note.length, 'the unconfigured source was given a blank reason').toBeGreaterThan(0);
    expect(keyless.note.toLowerCase()).toContain('key');

    const answered = outcomes.find((o) => o.source === 'arxiv')!;
    expect(answered.label).toContain('answered');

    // The same two facts, from the record rather than from the screen.
    const record = await resmon.backend.searchRecord(run);
    const bySource: Record<string, any> = {};
    for (const s of record.sources ?? []) bySource[s.source] = s;
    expect(bySource.springer.zero_reason).toBe('missing_key');
    expect(bySource.arxiv.zero_reason ?? null).toBeNull();

    await resmon.takePicture('J02-deep-sweep-coverage-sentence');
    expect(resmon.refusedConnections()).toEqual([]);
  });
});
