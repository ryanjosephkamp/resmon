/**
 * The journey driver for the candidate: the Atlas interface, which this
 * checkout's build serves when it is launched with `RESMON_UI=atlas`.
 *
 * Until the switch-over, Atlas carries some journeys and not others, and the
 * driver says which on every run rather than hiding it:
 *
 * - **What Atlas has** is driven in Atlas's own markup (`atlas.ts`).
 * - **What reads the backend** (`backend`), names a picture, or releases the
 *   authored source is the same for any interface, because it goes through the
 *   app's own API or the test's own fixtures: those come from the classic
 *   driver's renderer-free half unchanged.
 * - **Everything else** is skipped with the reason "Not in Atlas yet: …",
 *   which Playwright reports per row. Never a failure, which would say Atlas
 *   broke a journey it has not reached; never a pass, which would claim one.
 *
 * So a candidate run's skipped count is how much of the register Atlas has
 * still to carry, and the switch-over waits for it to reach zero.
 */
import type { TestInfo } from '@playwright/test';
import type { JourneyDriver } from '../driver';
import { createAtlasDriver } from './atlas';
import { createClassicDriver } from './classic';
import type { Session } from './session';

/** The classic driver's members that never touch the window's markup. */
const RENDERER_FREE = new Set<string>([
  'backend', 'takePicture', 'releaseTheSource', 'refusedConnections', 'waitForRunToSettle', 'reportExists',
  'killTheBackend', 'enableRankingByMeaning', 'scanForNearDuplicates',
  // Seeded or read over the API or on disk, as the classic driver says of
  // each: a routine made, fired and given destinations, and what a folder or
  // a feed received.
  'createRoutine', 'fireRoutineNow', 'addDeliveryTarget', 'readDeliveredFiles', 'readFeedFile',
  // A port bound and closed again on this machine: no screen at all.
  'anAddressThatRefusesConnections',
]);

export function createCandidateDriver(session: Session, testInfo: TestInfo): JourneyDriver {
  const classic = createClassicDriver(session, testInfo);
  const atlas = createAtlasDriver(session, testInfo, classic.backend) as Record<string, unknown>;
  const shared = classic as unknown as Record<string, unknown>;
  return new Proxy({} as JourneyDriver, {
    get(_target, property) {
      if (typeof property !== 'string') return undefined;
      if (property === 'name') return 'candidate (Atlas)';
      if (property in atlas) return atlas[property];
      if (RENDERER_FREE.has(property)) return shared[property];
      // Not a promise: `await driver` asks for `then`, and must get nothing.
      if (property === 'then') return undefined;
      return () => {
        testInfo.skip(true, `Not in Atlas yet: ${property}.`);
        throw new Error('unreachable: a skipped journey does not continue');
      };
    },
  });
}
