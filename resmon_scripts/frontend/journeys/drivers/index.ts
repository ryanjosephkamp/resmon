/**
 * The one place a journey session is wired to its driver.
 */
import type { TestInfo } from '@playwright/test';
import type { JourneyDriver } from '../driver';
import type { SourceReply } from '../fixtures/source-endpoint';
import { startSession } from './session';
import { createCandidateDriver } from './candidate';

/** The driver every journey runs on: Atlas, with what it borrows from the screenless driver. */
export const DRIVER_NAME = 'candidate (Atlas)';

export async function createDriver(options: {
  sourceReply: SourceReply;
  testInfo: TestInfo;
}): Promise<{ api: JourneyDriver; close: () => Promise<void> }> {
  const session = await startSession({ sourceReply: options.sourceReply });
  const api = createCandidateDriver(session, options.testInfo);
  return { api, close: () => session.close() };
}
