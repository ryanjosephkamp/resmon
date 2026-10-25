/**
 * Which driver a run uses, and the one place a session is wired to it.
 *
 * `RESMON_JOURNEY_DRIVER` is one of two words and nothing else: an unknown
 * value stops the run rather than falling back, because a typo that silently
 * ran the classic driver against a 3.0 build would report green for the wrong
 * reason.
 */
import * as fs from 'fs';
import * as path from 'path';
import type { TestInfo } from '@playwright/test';
import type { JourneyDriver } from '../driver';
import type { SourceReply } from '../fixtures/source-endpoint';
import { startSession, targetAppRoot } from './session';
import { THIS_CHECKOUT } from '../../e2e/fixtures/resmon-app';
import { createClassicDriver } from './classic';
import { createCandidateDriver } from './candidate';

export type DriverName = 'classic' | 'candidate';

/** The renderer under test. Defaults to the candidate — this checkout's build. */
export function driverName(): DriverName {
  const configured = (process.env.RESMON_JOURNEY_DRIVER || 'candidate').trim();
  if (configured !== 'classic' && configured !== 'candidate') {
    throw new Error(
      `RESMON_JOURNEY_DRIVER is "${configured}"; it is "classic" or "candidate". ` +
      'There is no default for a value that is neither, because a typo that quietly ' +
      'fell back would report a green run against the wrong renderer.',
    );
  }
  return configured;
}

/**
 * The build this run launches, and whether it is the checkout this suite lives in.
 *
 * Both CI legs run this directory's specs, and only one of them runs them
 * against this directory's own app: the candidate leg builds this checkout, and
 * the classic leg points `RESMON_JOURNEY_APP` at the frozen `classic` branch. A
 * spec needs to tell the two apart only where the frozen build is *known* to
 * fail a journey this checkout has since fixed, and then only to report that
 * build's failure by name rather than to excuse this one — see J21.
 *
 * Compared by resolved path, because the two roots are spelled by different
 * code: one from this file's own location, one from the environment.
 */
export function buildUnderTest(): { frontend: string; thisCheckout: boolean } {
  const root = targetAppRoot();
  const real = (dir: string): string => {
    try { return fs.realpathSync(dir); } catch { return path.resolve(dir); }
  };
  return { frontend: root.frontend, thisCheckout: real(root.frontend) === real(THIS_CHECKOUT.frontend) };
}

export async function createDriver(options: {
  sourceReply: SourceReply;
  testInfo: TestInfo;
}): Promise<{ api: JourneyDriver; close: () => Promise<void> }> {
  const session = await startSession({ sourceReply: options.sourceReply });
  const make = driverName() === 'classic' ? createClassicDriver : createCandidateDriver;
  const api = make(session, options.testInfo);
  return { api, close: () => session.close() };
}
