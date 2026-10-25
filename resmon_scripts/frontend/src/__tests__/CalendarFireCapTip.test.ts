/**
 * The Calendar tutorial states the backend's fire cap, and the number it
 * states is the backend's.
 *
 * The tip said scheduled-fire expansion was "capped at 200 fires per routine
 * per request". The code says ``MAX_PER_ROUTINE = 2000``, and has since the
 * expansion window grew from 90 days to twelve months and the cap was raised
 * with it; the sentence was not. A reader planning an hourly routine would
 * have expected about eight days of fires on the calendar and seen
 * eighty-three.
 *
 * The renderer cannot read the number at runtime: it is a local inside the
 * ``/api/calendar/events`` handler, and the endpoint returns the events, not
 * the limit it applied. So this test reads it from where it is defined —
 * ``resmon.py``, beside this frontend — and fails when the two disagree,
 * whichever of them moved.
 */

import fs from 'fs';
import path from 'path';
import { sections } from '../components/AboutResmon/TutorialsTab';

const RESMON_PY = path.resolve(__dirname, '../../../resmon.py');

function backendCap(): number {
  const source = fs.readFileSync(RESMON_PY, 'utf8');
  const definitions = [...source.matchAll(/^\s*MAX_PER_ROUTINE\s*=\s*(\d+)\s*$/gm)];
  // One definition, or "the backend's number" is not one number.
  expect(definitions).toHaveLength(1);
  return Number(definitions[0][1]);
}

function calendarTips(): string[] {
  const calendar = sections.find((s) => s.anchor === 'calendar');
  if (!calendar) throw new Error('The Tutorials tab has no Calendar section');
  return calendar.tips;
}

describe('Calendar tutorial: the fire cap', () => {
  test('the backend still defines the cap this test reads', () => {
    expect(backendCap()).toBeGreaterThan(0);
  });

  test('every fire count the Calendar tips state is the backend’s cap', () => {
    const cap = backendCap();
    const stated = calendarTips()
      .flatMap((tip) => [...tip.matchAll(/(\d[\d,]*)[\s-]fires?\b/g)])
      .map((m) => Number(m[1].replace(/,/g, '')));

    // A guard on the guard: if the sentence stopped naming a number at all,
    // "every number matches" would pass against nothing.
    expect(stated.length).toBeGreaterThan(0);
    for (const n of stated) {
      expect(n).toBe(cap);
    }
  });

  test('the tips do not claim a notice for the cap that the page never shows', () => {
    // The Calendar's only notice is the 12-month one, shown when the visible
    // range starts past a year from today (``CalendarPage`` ``datesSet``).
    // Nothing tells the reader a routine was cut short by the cap; the old
    // tip said a notice appeared "when upcoming fires would be clipped".
    const text = calendarTips().join(' ');
    expect(text).not.toMatch(/notice appears when upcoming fires would be clipped/);
  });
});
