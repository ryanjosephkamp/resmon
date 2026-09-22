/**
 * J16 Weekly live-network job — the gate that partitions the live suite still
 * passes, and the summary it publishes still carries its denominator.
 *
 * This row's journey is a CI job, not a screen, so the pattern is the one the
 * register's note sets out: run the *existing* gate as a subprocess and assert
 * what it returns. Re-implementing the gate here would produce a second thing
 * to keep in step, and the one that drifted would be this copy.
 *
 * Two subprocesses, because the gate and the denominator are two different
 * facts and `pytest -q` prints only the first.
 *
 * 1. `test_live_suite.py` is the gate. It fails when the scheduled half and the
 *    machine-bound half stop partitioning the live suite exactly — the property
 *    that stops a new live test from falling silently into neither.
 * 2. `live_suite.py --summary` is what the weekly job actually appends to its
 *    run summary, and it is where "N of M asserted; Q quarantined" comes from.
 *    M is a collection's size, taken by collecting the suite, so the sentence
 *    is a measurement rather than a number somebody typed.
 *
 * Neither reaches the network: the gate is a hermetic test and the summary is a
 * `--collect-only` over the same checkout.
 */
import { expect, journey } from './driver';

journey.describe('J16 Weekly live-network job', () => {
  journey('the gate passes and the summary carries its own denominator', async ({ resmon }) => {
    const gate = await resmon.runTheGate([
      '-m', 'pytest', '-q', 'verification_scripts/test_live_suite.py',
    ]);
    const tail = gate.output.trim().split('\n').slice(-6).join('\n');
    console.log(`[J16] ${gate.command}\n[J16] exit ${gate.exitCode}\n${tail}`);
    expect(gate.exitCode, `the live-suite gate did not pass:\n${tail}`).toBe(0);
    // The count it ran, from its own output rather than from this file.
    const counted = /(\d+) passed/.exec(gate.output);
    expect(counted, 'the gate reported no pass count').toBeTruthy();
    console.log(`[J16] the gate asserted ${counted![1]} cases.`);

    const summary = await resmon.runTheGate(['verification_scripts/live_suite.py', '--summary']);
    console.log(`[J16] exit ${summary.exitCode}`);
    expect(summary.exitCode, `the weekly summary could not be produced:\n${summary.output.slice(-600)}`).toBe(0);

    // The denominator. Read out of the summary the job publishes, so a case
    // added to or removed from the live suite moves it without an edit here.
    const asserted = /(\d+) of (\d+) asserted; (\d+) quarantined/.exec(summary.output);
    expect(
      asserted,
      `the weekly summary carries no "N of M asserted" line:\n${summary.output.slice(0, 800)}`,
    ).toBeTruthy();
    const [line, n, m, quarantined] = asserted!;
    console.log(`[J16] ${line}`);
    expect(Number(m), 'the live suite collected nothing to assert').toBeGreaterThan(0);
    expect(Number(n) + Number(quarantined), 'the asserted line does not add up').toBe(Number(m));

    // And the half it says it cannot run names why, which is the sentence the
    // whole row exists for: a green tick that covers two thirds of a suite is
    // the failure this job was built after.
    expect(summary.output).toContain('What it did not run, and why');
    console.log(
      '[J16] NOT VERIFIED: that the weekly job is green. This row asserts the gate '
      + 'and the denominator it publishes; whether the live suite passes against the '
      + 'real providers is the weekly run itself, and it is a health monitor rather '
      + 'than a merge gate.',
    );

    expect(resmon.refusedConnections()).toEqual([]);
  });
});
