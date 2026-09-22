/**
 * Which driver a run uses, and the one place a session is wired to it.
 *
 * `RESMON_JOURNEY_DRIVER` is one of two words and nothing else: an unknown
 * value stops the run rather than falling back, because a typo that silently
 * ran the classic driver against a 3.0 build would report green for the wrong
 * reason.
 */
import type { TestInfo } from '@playwright/test';
import type { JourneyDriver } from '../driver';
import type { SourceReply } from '../fixtures/source-endpoint';
import { startSession } from './session';
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

export async function createDriver(options: {
  sourceReply: SourceReply;
  testInfo: TestInfo;
}): Promise<{ api: JourneyDriver; close: () => Promise<void> }> {
  const session = await startSession({ sourceReply: options.sourceReply });
  const make = driverName() === 'classic' ? createClassicDriver : createCandidateDriver;
  const api = make(session, options.testInfo);
  return { api, close: () => session.close() };
}
