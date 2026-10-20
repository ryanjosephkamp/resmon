/**
 * @jest-environment ./jest.utcZoneEnvironment.js
 */

/**
 * Stored times, read in UTC — the control for the Eastern run. A fix that only
 * works by knowing New York's offset fails here. The cases and the reasoning
 * are in ``storedTimes.cases.tsx``; this file only chooses the zone, because
 * Jest allows one environment per file.
 */

import { describeStoredTimes } from './storedTimes.cases';

describeStoredTimes('UTC');
