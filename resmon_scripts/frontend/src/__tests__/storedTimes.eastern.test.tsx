/**
 * @jest-environment ./jest.easternZoneEnvironment.js
 */

/**
 * Stored times, read west of Greenwich in the evening — where a UTC date or
 * clock passed off as local is visibly wrong. The cases and the reasoning are
 * in ``storedTimes.cases.tsx``; this file only chooses the zone, because Jest
 * allows one environment per file.
 */

import { describeStoredTimes } from './storedTimes.cases';

describeStoredTimes('America/New_York');
