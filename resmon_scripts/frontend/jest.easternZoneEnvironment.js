/**
 * A jsdom environment pinned to America/New_York.
 *
 * A test about timezone rendering is worthless on a machine that happens to
 * agree with it, and this one nearly shipped that way. `CalendarEventTime`
 * originally set `process.env.TZ` at the top of the test module, which passed
 * on a laptop already in Eastern time and reported `UTC` on CI — the
 * assignment does nothing there. Jest builds the test environment, and with it
 * the V8 context whose date cache the zone is read into, **before** the test
 * module is required, so by the time any line of the test runs the zone is
 * already fixed. Setting it in this constructor, before `super()`, is early
 * enough; verified by the environment's own guard assertion in the specs that
 * use it.
 *
 * It lives beside `jest.config.js` and `jest.setup.js`, as CommonJS, because
 * that is where this project's Jest infrastructure lives and what the lint
 * config already covers for a root-level `.js`.
 *
 * Pinning the zone here rather than in `jest.config.js` keeps it to the files
 * that ask for it. A global pin would quietly move all seventy-odd suites off
 * the zone they run in today, which is a decision about the whole suite and
 * not one this needed.
 *
 * `teardown` puts the old value back. Jest reuses a worker process across test
 * files, so a `TZ` left behind here would be inherited by whatever file ran
 * next in that worker and make the run order-dependent — a slow, confusing
 * class of failure that is much easier to prevent than to find.
 *
 * `exportConditions` is the second reason this file exists, unrelated to the
 * first. Under the default `browser` condition, `@fullcalendar/*` resolves
 * preact to an ESM build that Jest cannot parse, so `CalendarPage` could not
 * be rendered in a test at all — which is why there was no renderer test for
 * the calendar before this one. `node` picks preact's CommonJS entry.
 *
 * Usage, in the test file's first docblock:
 *
 *     /** @jest-environment ./jest.easternZoneEnvironment.js *\/
 */

const JSDOMEnvironment = require('jest-environment-jsdom').default;

/** Chosen because it is not UTC and it observes daylight saving. */
const ZONE = 'America/New_York';

class EasternJSDOMEnvironment extends JSDOMEnvironment {
  constructor(config, context) {
    const previousTZ = process.env.TZ;
    process.env.TZ = ZONE;
    super(config, context);
    this.previousTZ = previousTZ;
  }

  async teardown() {
    if (this.previousTZ === undefined) {
      delete process.env.TZ;
    } else {
      process.env.TZ = this.previousTZ;
    }
    await super.teardown();
  }

  exportConditions() {
    return ['node'];
  }
}

module.exports = EasternJSDOMEnvironment;
