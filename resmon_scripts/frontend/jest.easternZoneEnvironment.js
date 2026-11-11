/**
 * A jsdom environment pinned to America/New_York.
 *
 * Chosen because it is west of Greenwich and observes daylight saving: an
 * instant stored at `00:47Z` is 8:47 PM the previous day here, which is where
 * a UTC date or clock passed off as local is visibly wrong. Why the zone has
 * to be pinned in an environment at all, rather than in the test module, is
 * in `jest.zonedEnvironment.js`.
 *
 * Usage, in the test file's first docblock:
 *
 *     /** @jest-environment ./jest.easternZoneEnvironment.js *\/
 */

const { zonedEnvironment } = require('./jest.zonedEnvironment');

module.exports = zonedEnvironment('America/New_York');
