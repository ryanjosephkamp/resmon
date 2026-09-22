/**
 * J43 Upgrade in place — the corpus a person already has walks every migration
 * on the first launch of a newer resmon.
 *
 * This row has no screen. What the user does is install a build over an older
 * one and open it; what has to stay true is that the database a *released*
 * resmon wrote comes out the other side with its rows, its sequences and its
 * full-text index intact. The thing that establishes it is
 * `test_cumulative_upgrade.py`, which opens the committed v2.1.0 fixture at
 * schema 13 and takes it to today's schema in one `init_db`, then compares the
 * result object for object against a fresh install.
 *
 * So this journey **runs that gate** rather than re-enacting it. The register
 * and `journeys/README.md` both name this pattern and the reason is worth
 * restating: a migration walk written a second time in TypeScript is a second
 * thing to keep in step with `database.py`, and the second one is always the
 * one that goes stale. The row's evidence stays the real gate; what this adds
 * is that the gate is part of the parity denominator, runs against **the build
 * under test** rather than against this checkout, and that a green run is
 * quoted with the schema range it actually walked.
 *
 * The range is the assertion that matters. Exit zero says the gate passed; it
 * does not say what the gate did. `-v` puts the node ids in the output, and the
 * cumulative case carries the range in its own name — so a build that quietly
 * started walking a shorter journey would be green and would still fail here.
 */
import { expect, journey, runGate } from './driver';

journey.describe('J43 Upgrade in place', () => {
  journey('the release gate walks a released corpus through every migration, and says which', async () => {
    // Real work over a real SQLite file, and it is compared object for object
    // against a fresh install. Minutes on a loaded runner, not seconds.
    journey.setTimeout(900_000);

    const gate = runGate('test_cumulative_upgrade.py');
    console.log(`[J43] ${gate.python} -m pytest ${gate.gate} in ${gate.repo}`);
    console.log(`[J43] ${gate.summary}`);

    expect(
      gate.status,
      `the upgrade gate failed:\n${gate.output.slice(-4_000)}`,
    ).toBe(0);

    // The walked range, from the gate's own node id. Not a literal pair of
    // numbers typed here: the assertion is that *a* whole walk was made and
    // that the output names its endpoints, so the release after this one moves
    // the number in one place — the gate — and this row reports the new range.
    const walked = /test_one_init_db_takes_a_v\d+_database_from_(\d+)_to_(\d+)\b/.exec(gate.output);
    expect(
      walked,
      'the gate passed without naming the schema range it walked, so "every migration" is unmeasured',
    ).toBeTruthy();
    const [node, from, to] = walked!;
    expect(Number(to), 'the walk ends where it starts, so nothing was migrated').toBeGreaterThan(Number(from));
    // The outcome is not always on the node id's own line: the gate prints its
    // own denominators under `-s`, and pytest writes PASSED after whatever the
    // case wrote. So the verdict is looked for in the slice between this node
    // id and the next one rather than immediately after it.
    const fromHere = gate.output.slice(gate.output.indexOf(node));
    const nextCase = fromHere.slice(node.length).indexOf('verification_scripts/');
    const verdict = nextCase === -1 ? fromHere : fromHere.slice(0, node.length + nextCase);
    expect(verdict, 'the cumulative case did not pass').toContain('PASSED');

    // Every case of the gate, so "the gate passed" carries its own denominator
    // rather than being a word. Skips are reported, not swallowed: CI clones at
    // depth 1 and the fixture-regeneration case skips where the tag is absent,
    // which is a real hole in a run and has to be visible in the count.
    const passed = gate.counts.passed ?? 0;
    const skipped = gate.counts.skipped ?? 0;
    expect(passed, 'the gate reported no passing case').toBeGreaterThan(0);
    expect(gate.counts.failed ?? 0).toBe(0);
    expect(gate.counts.error ?? gate.counts.errors ?? 0).toBe(0);
    console.log(
      `[J43] schema ${from} → ${to} walked by one init_db; `
      + `${passed} of ${passed + skipped} cases asserted, ${skipped} skipped.`,
    );
    if (skipped > 0) {
      console.log(
        '[J43] NOT VERIFIED: the gate skipped a case. The usual reason is the v2.3.0 tag '
        + 'being absent from a depth-1 clone, which leaves the fixture regeneration unchecked here.',
      );
    }
  });
});
