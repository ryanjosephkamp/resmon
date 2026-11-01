/**
 * The journey driver: the Atlas interface, and what it borrows from the
 * screenless driver.
 *
 * - **What Atlas has** is driven in Atlas's own markup (`atlas.ts`), and that
 *   includes the setup a person does on a screen: a watch made in the watch
 *   editor, run with Run now, given destinations on its own tab; Settings ›
 *   AI pointed at an authored command, endpoint or key; a backup restored from
 *   the Storage group.
 * - **What has no screen** (`SCREENLESS` in `borrowed.ts`): the engine's own
 *   record, pictures, the authored fixtures, a raw socket, a gate, a file on
 *   disk. These come from `screenless.ts`.
 * - **Setup Atlas has no screen for** (`API_SETUP` in `borrowed.ts`) also
 *   comes from `screenless.ts`, which takes it over the app's API, and only
 *   with a reason that says which screen is missing. Without that rule a
 *   journey passes while Atlas has no screen for one of its steps, which is
 *   how Atlas shipped without Settings › AI › Embeddings while J09 and J11
 *   passed. `register.spec.ts` holds the lists to it.
 * - **Everything else** is skipped with the reason "Not in Atlas yet: …",
 *   which Playwright reports per row. Never a failure, which would say Atlas
 *   broke a journey it has not reached; never a pass, which would claim one.
 */
import type { TestInfo } from '@playwright/test';
import type { JourneyDriver } from '../driver';
import { createAtlasDriver } from './atlas';
import { borrowed } from './borrowed';
import { createScreenlessDriver } from './screenless';
import type { Session } from './session';

export function createCandidateDriver(session: Session, testInfo: TestInfo): JourneyDriver {
  const screenless = createScreenlessDriver(session, testInfo);
  const atlas = createAtlasDriver(session, testInfo, screenless.backend) as Record<string, unknown>;
  const shared = screenless as unknown as Record<string, unknown>;
  return new Proxy({} as JourneyDriver, {
    get(_target, property) {
      if (typeof property !== 'string') return undefined;
      if (property === 'name') return 'candidate (Atlas)';
      if (property in atlas) return atlas[property];
      if (borrowed(property)) return shared[property];
      // Not a promise: `await driver` asks for `then`, and must get nothing.
      if (property === 'then') return undefined;
      return () => {
        testInfo.skip(true, `Not in Atlas yet: ${property}.`);
        throw new Error('unreachable: a skipped journey does not continue');
      };
    },
  });
}
