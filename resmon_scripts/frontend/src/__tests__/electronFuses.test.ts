/**
 * The build must not turn off the two fuses packaged verification runs on.
 *
 * `e2e/packaged.spec.ts` reads the fuses out of a built app — which is the real
 * check, and which only runs **locally, on demand**, because building an
 * installer downloads a Python runtime and takes minutes. So a pull request
 * that hardened the build would go green in CI and the packaged leg of the
 * verification layer would stop working, silently, with nothing linking the two
 * facts. This test runs in the frontend job on every pull request and is what
 * makes that impossible.
 *
 * **Why these two.** Playwright drives a packaged app's main process over the
 * Node inspector, so `EnableNodeCliInspectArguments` must be on, and
 * `RunAsNode` with it. They are on today only because electron-builder does not
 * flip fuses unless asked and resmon's `build` block asks for nothing — an
 * absence, not a decision, which is exactly the kind of thing that changes
 * without anyone noticing what it was holding up.
 *
 * **This is not an argument against hardening.** Turning those fuses off is a
 * reasonable security change and the message below says so. It says that the
 * change has to come with a replacement for packaged verification rather than
 * quietly removing it.
 */

import * as fs from 'fs';
import * as path from 'path';

const PACKAGE_JSON = path.join(__dirname, '..', '..', 'package.json');

/** electron-builder's key, and the two entries that matter under it. */
const REQUIRED_ENABLED = ['runAsNode', 'enableNodeCliInspectArguments'];

describe('electron-builder fuse configuration', () => {
  const pkg = JSON.parse(fs.readFileSync(PACKAGE_JSON, 'utf8'));

  test('the build block does not disable a fuse packaged verification needs', () => {
    const fuses = pkg.build?.electronFuses;
    if (!fuses) {
      // The status quo: no fuse configuration at all, so Electron's defaults
      // stand and both are on. Asserting the absence would forbid ever
      // configuring fuses, which is not the property — the property is that
      // these two stay enabled.
      expect(fuses).toBeUndefined();
      return;
    }
    for (const key of REQUIRED_ENABLED) {
      expect(
        `${key}=${fuses[key]}`,
      ).not.toBe(`${key}=false`);
    }
  });

  test('the two fuse names this depends on are spelled the way the reader spells them', () => {
    // `e2e/fixtures/electron-fuses.ts` reads the wire by name. If the two
    // lists drift, this file guards a key nothing sets and the e2e check reads
    // a fuse nothing here protects.
    const source = fs.readFileSync(
      path.join(__dirname, '..', '..', 'e2e', 'fixtures', 'electron-fuses.ts'), 'utf8',
    );
    const block = source.match(
      /FUSES_VERIFICATION_DEPENDS_ON = \[([\s\S]*?)\] as const;/,
    );
    expect(block).toBeTruthy();
    const names = [...(block as RegExpMatchArray)[1].matchAll(/'([^']+)'/g)].map((m) => m[1]);
    // electron-builder's keys are the same names, lower-camel.
    const asBuilderKeys = names.map((n) => n[0].toLowerCase() + n.slice(1));
    expect(asBuilderKeys.sort()).toEqual([...REQUIRED_ENABLED].sort());
  });
});
