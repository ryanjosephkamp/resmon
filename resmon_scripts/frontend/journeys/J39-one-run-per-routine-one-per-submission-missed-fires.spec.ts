/**
 * J39 One run per routine, one per submission, missed fires — asking a routine
 * to run while it is already running starts nothing, and the refusal names the
 * run that is already going.
 *
 * The authored source holds its reply, so the first run is genuinely in flight
 * when the second request arrives. That matters: the app's guard is a claim
 * taken before the execution row exists and released when the run ends, so a
 * second ask that arrived after the first had finished would be admitted — and
 * a spec that did not hold the first run would be measuring how fast this
 * machine is rather than what the app does.
 *
 * **Two halves, both asserted.** The person's half is the refusal: a sentence
 * that names the run already going, rather than a silent no-op. The backend's
 * half is that exactly one execution exists for the routine afterwards. Either
 * one alone passes over a real failure — an app that refuses on screen and runs
 * twice underneath looks identical from the renderer.
 *
 * **What this row does not establish, and why.**
 *
 * *The button.* `Run now` is on a routine's row only once that routine has
 * missed a fire while resmon was closed, and nothing in this suite can miss
 * one: the app spawns its backend with `RESMON_DISABLE_SCHEDULER=1`, so the
 * app's own backend owns no scheduler at all. The row asks whether the control
 * is there, reports the answer, and asks over the app's own transport instead —
 * the same seam the renderer's own button posts to. It does not claim a click.
 *
 * *Missed fires.* The other half of this register row — that a fire nobody was
 * up for is recorded and later marked as having run late — has no API that
 * writes `routine_missed_fires`. The only ways to produce one are a real
 * scheduler gap or a write straight into the database file, and a journey that
 * opened the database would stop being runnable against an installed app. It
 * is a register limit, printed below, and its evidence stays
 * `verification_scripts/test_duplicate_protection.py`.
 */
import { expect, journey } from './driver';

journey.use({ sourceReply: 'held' });

const ROUTINE = {
  name: 'Journey duplicate-run routine',
  cron: '0 6 * * 1',
  sources: ['arxiv'],
  keywords: ['perovskite'],
};

journey.describe('J39 One run per routine, one per submission, missed fires', () => {
  journey('asking twice while the first run is still going starts one run, and says which', async ({ resmon }) => {
    const routineId = await resmon.createRoutine(ROUTINE);

    // Is there a button at all? Asked before anything else, so the answer is
    // about the app rather than about what this journey has already done to it.
    const control = await resmon.runNowControlIsOnTheRow(ROUTINE.name);
    console.log(`[J39] the Run now control is on the routine's row: ${control}`);

    const first = await resmon.askForThisRoutineToRunNow(ROUTINE.name);
    expect(first.refusal, `the first ask was refused: ${first.refusal}`).toBe('');
    expect(first.run, 'the first ask started no run').not.toBeNull();

    // The second ask, with the first still held at the source. No wait between
    // them beyond the round trip: this is the press a person makes when the
    // first press looked like it did nothing.
    const second = await resmon.askForThisRoutineToRunNow(ROUTINE.name);
    console.log(`[J39] the second ask was answered: ${JSON.stringify(second)}`);
    expect(second.run, 'a second run was started while the first was still going').toBeNull();
    // The refusal is readable and specific: it names the run that is already
    // going, which is the difference between "no" and "no, because of this".
    // This route has two different refusals — already running, and resmon is
    // already running as many executions as it allows — and the sentence is
    // what tells a person which one they got.
    expect(second.refusal.toLowerCase(), 'the refusal does not say the routine is already running')
      .toContain('already running');
    expect(second.refusal, 'the refusal does not name the run that is already going')
      .toContain(String(first.run!.id));

    // Let the held request through and let the run finish, so the backend's
    // half is read over a settled state rather than a moving one.
    resmon.releaseTheSource();
    const facts = await resmon.waitForRunToSettle(first.run!);
    console.log(`[J39] the one run settled as "${facts.status}"`);

    // The backend's half. One routine, one run — counted from the executions
    // the app itself reports, not from anything this spec remembers.
    const executions = await resmon.backend.executions();
    const mine = executions.filter((row) => Number(row.routine_id) === routineId);
    console.log(`[J39] ${mine.length} of ${executions.length} recorded executions belong to this routine`);
    expect(
      mine.map((row) => Number(row.id)),
      'the routine ended up with more than one run',
    ).toEqual([first.run!.id]);

    if (!control) {
      console.log('[J39] NOT VERIFIED: the refusal was not read off the screen. `Run now` is '
        + 'rendered only on a routine that has missed a fire, and the app spawns its backend '
        + 'with the scheduler disabled, so no routine in this suite can miss one. The ask went '
        + 'to the same endpoint the button posts to.');
    }
    if (!second.refusalKind) {
      console.log('[J39] NOT VERIFIED: the machine-readable kind of the refusal. The backend '
        + 'names it in a response header, and a renderer reading its own backend cross-origin '
        + 'is given only the safelisted headers, so the app cannot see it either. The sentence '
        + 'a person reads is asserted above; the header stays `test_duplicate_protection.py`.');
    }
    console.log('[J39] NOT VERIFIED: the missed-fire half of this row — a fire nobody was up '
      + 'for is recorded and later marked as having run late. No route writes '
      + '`routine_missed_fires`, and a journey does not open the database file. Its evidence '
      + 'stays `verification_scripts/test_duplicate_protection.py`.');

    await resmon.takePicture('J39-one-run-per-routine');
    expect(resmon.refusedConnections()).toEqual([]);
  });
});
