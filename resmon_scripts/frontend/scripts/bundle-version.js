/**
 * The macOS bundle version (CFBundleVersion) for an app version.
 *
 * macOS's LaunchServices keeps every copy of a bundle id it has seen and
 * prefers the one with the highest bundle version, and Notification Center,
 * the Dock, and the icon cache follow it. Earlier builds of com.resmon.app
 * reached 2.3.0, with Electron's own icon, so a 1.0.0 bundle lost to any of
 * them still on the disk: its notifications and Dock tile showed that icon.
 * The bundle version is therefore the app version with ten added to its
 * major number: 1.0.0 is 11.0.0, above every 2.x, and it rises with the app
 * version. The version people see (CFBundleShortVersionString) stays the app
 * version.
 *
 * `package.json`'s `build.mac.bundleVersion` holds the value, because
 * electron-builder reads it there; `tests/bundleVersion.test.ts` holds it to
 * this function, and the packaged launch check reads it back out of the built
 * app's Info.plist.
 */
function bundleVersionFor(version) {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(String(version));
  if (!match) throw new Error(`not a plain major.minor.patch version: ${version}`);
  return `${Number(match[1]) + 10}.${Number(match[2])}.${Number(match[3])}`;
}

module.exports = { bundleVersionFor };
