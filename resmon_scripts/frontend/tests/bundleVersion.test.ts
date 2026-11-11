/**
 * The macOS bundle version stays above every earlier build of com.resmon.app,
 * and rises with the app version (`scripts/bundle-version.js` says why: macOS
 * shows the icon of the highest bundle version it knows). The packaged launch
 * check reads the same value back out of a built app's Info.plist.
 */
import * as fs from 'fs';
import * as path from 'path';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { bundleVersionFor } = require('../scripts/bundle-version.js') as { bundleVersionFor: (v: string) => string };

const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));

/** Numeric, part by part, as LaunchServices compares bundle versions. */
function above(a: string, b: string): boolean {
  const x = a.split('.').map(Number);
  const y = b.split('.').map(Number);
  for (let i = 0; i < Math.max(x.length, y.length); i += 1) {
    if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) > (y[i] ?? 0);
  }
  return false;
}

test('the build sets the bundle version the app version calls for', () => {
  expect(pkg.build.mac.bundleVersion).toBe(bundleVersionFor(pkg.version));
});

test('the bundle version is above every 2.x build, and rises with the version', () => {
  const now = bundleVersionFor(pkg.version);
  for (const earlier of ['2.3.0', '2.9.99', '2.99.99']) expect(above(now, earlier)).toBe(true);
  expect(above(bundleVersionFor('1.0.1'), bundleVersionFor('1.0.0'))).toBe(true);
  expect(above(bundleVersionFor('1.1.0'), bundleVersionFor('1.0.9'))).toBe(true);
  expect(above(bundleVersionFor('2.0.0'), bundleVersionFor('1.9.9'))).toBe(true);
  expect(() => bundleVersionFor('1.0.0-beta.1')).toThrow();
});
