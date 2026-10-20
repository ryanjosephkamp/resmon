/**
 * A jsdom environment pinned to UTC.
 *
 * The control for `jest.easternZoneEnvironment.js`. A date or time fix that
 * only holds in New York — one that subtracts four hours, say — passes there
 * and is wrong here, so every zoned test runs in both. This is also the zone
 * CI's runners use by default, pinned anyway so that a laptop in another zone
 * runs the same test CI does. Why the zone has to be pinned in an environment
 * at all is in `jest.zonedEnvironment.js`.
 *
 * Usage, in the test file's first docblock:
 *
 *     /** @jest-environment ./jest.utcZoneEnvironment.js *\/
 */

const { zonedEnvironment } = require('./jest.zonedEnvironment');

module.exports = zonedEnvironment('UTC');
