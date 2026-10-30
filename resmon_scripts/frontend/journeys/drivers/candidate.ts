/**
 * The journey driver for the candidate: the Atlas interface, which this
 * checkout's build serves when it is launched with `RESMON_UI=atlas`.
 *
 * Until the switch-over, Atlas carries some journeys and not others, and the
 * driver says which on every run rather than hiding it:
 *
 * - **What Atlas has** is driven in Atlas's own markup (`atlas.ts`), and that
 *   includes the setup a person does on a screen: a watch made in the watch
 *   editor, run with Run now, given destinations on its own tab; Settings ›
 *   AI pointed at an authored command, endpoint or key; a backup restored from
 *   the Storage group.
 * - **What has no screen in any interface** (`SCREENLESS` in `borrowed.ts`) —
 *   the engine's own record, pictures, the authored fixtures, a raw socket, a
 *   gate, a file on disk — comes from the classic driver unchanged.
 * - **Setup Atlas has no screen for yet** (`API_SETUP` in `borrowed.ts`) also
 *   comes from the classic driver, which takes it over the app's API, and
 *   only with a reason that says which screen is missing. Without that rule a
 *   journey passes while Atlas has no screen for one of its steps, which is
 *   how Atlas shipped without Settings › AI › Embeddings while J09 and J11
 *   passed. `register.spec.ts` holds the lists to it.
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
import { borrowedFromClassic } from './borrowed';
import { createClassicDriver } from './classic';
import type { Session } from './session';

export function createCandidateDriver(session: Session, testInfo: TestInfo): JourneyDriver {
  const classic = createClassicDriver(session, testInfo);
  const atlas = createAtlasDriver(session, testInfo, classic.backend) as Record<string, unknown>;
  const shared = classic as unknown as Record<string, unknown>;
  return new Proxy({} as JourneyDriver, {
    get(_target, property) {
      if (typeof property !== 'string') return undefined;
      if (property === 'name') return 'candidate (Atlas)';
      if (property in atlas) return atlas[property];
      if (borrowedFromClassic(property)) return shared[property];
      // Not a promise: `await driver` asks for `then`, and must get nothing.
      if (property === 'then') return undefined;
      return () => {
        testInfo.skip(true, `Not in Atlas yet: ${property}.`);
        throw new Error('unreachable: a skipped journey does not continue');
      };
    },
  });
}
