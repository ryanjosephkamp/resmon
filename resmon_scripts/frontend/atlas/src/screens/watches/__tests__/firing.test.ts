import {
  firingNotice, firingOf, firingState, monthAheadLede, nextWords, type SchedulerStatus,
} from '../firing';
import { historyScale, watchWarnings } from '../model';
import type { CatalogEntry } from '../../runs/model';

function status(state: SchedulerStatus['state'], routines: SchedulerStatus['routines'], extra: Partial<SchedulerStatus> = {}): SchedulerStatus {
  return { state, app_version: '2.3.0', service_installed: false, service_version: null, routines, ...extra };
}

const nothing = (id: number) => ({ id, will_fire: false, reason: 'no_scheduler_running' as const });
const unsure = (id: number) => ({ id, will_fire: null, reason: 'unconfirmed' as const });
const fires = (id: number) => ({ id, will_fire: true, reason: 'scheduled' as const });

describe('a watching watch is said to run next only where something will run it', () => {
  test('the verdict on one watch, and what the markup says of it', () => {
    const read = status('service_elsewhere', [fires(1), nothing(2), unsure(3)]);
    expect([1, 2, 3, 4].map((id) => firingState(firingOf(read, id))))
      .toEqual(['will-run', 'will-not-run', 'unconfirmed', 'unread']);
    expect(firingOf(undefined, 1)).toBeUndefined();
  });

  test('"next" for a watch that will run; "due" with the reason for the rest', () => {
    expect(nextWords(true, 'tomorrow at 9:00 AM')).toBe('next tomorrow at 9:00 AM');
    expect(nextWords(false, 'tomorrow at 9:00 AM')).toBe('due tomorrow at 9:00 AM, but nothing will run it');
    expect(nextWords(null, 'tomorrow at 9:00 AM')).toBe('due tomorrow at 9:00 AM, not confirmed to run');
    expect(nextWords(undefined, 'tomorrow at 9:00 AM')).toBe('due tomorrow at 9:00 AM');
    expect(nextWords(false, null)).toBe('nothing will run it on schedule');
    expect(nextWords(true, null)).toBeNull();
  });
});

describe('the one sentence on why watches will not run', () => {
  test('nothing is said where every watching watch will run, or none is watching', () => {
    expect(firingNotice(status('fires_here', [fires(1), fires(2)]))).toBeNull();
    expect(firingNotice(status('no_service', []))).toBeNull();
  });

  test('no service: this window does not run watches, and the lever is In the background', () => {
    const notice = firingNotice(status('no_service', [nothing(1), nothing(2)]));
    expect(notice?.text).toBe('Nothing will run your watches on schedule. This window does not run watches itself, and no '
      + 'background service is set up. Turn on Run resmon in the background in Settings › In the background.');
    expect(notice?.background).toBe(true);
  });

  test('a stopped service is restarted by turning the switch off and on', () => {
    const notice = firingNotice(status('service_stopped', [nothing(4)], { service_installed: true }));
    expect(notice?.text).toMatch(/^Nothing will run your watch on schedule\. The background service is installed but not running\./);
    expect(notice?.text).toContain('off and on again to restart it');
  });

  test('one unconfirmed watch among them makes the sentence the weaker one', () => {
    const notice = firingNotice(status('service_other_version', [nothing(1), unsure(2)], { service_version: '2.1.0' }));
    expect(notice?.text).toMatch(/^resmon cannot confirm that anything will run your watches on schedule\./);
    expect(notice?.text).toContain('resmon 2.1.0, and this app is 2.3.0');
  });

  test('some of them, by count; and one watch on its own page', () => {
    const read = status('service_unreachable', [fires(1), unsure(2), unsure(3)]);
    expect(firingNotice(read)?.text).toMatch(/^resmon cannot confirm that anything will run 2 of your watches on schedule\./);
    expect(firingNotice(read, 1)).toBeNull();
    expect(firingNotice(read, 2)?.text).toMatch(/^resmon cannot confirm that anything will run this watch on schedule\./);
  });

  test('a scheduler here with no job: pausing and resuming is the lever, not the service', () => {
    const notice = firingNotice(status('fires_here', [fires(1), { id: 2, will_fire: false, reason: 'not_scheduled' }]));
    expect(notice).toEqual({
      text: 'A watch that is watching has no schedule registered with the scheduler, so nothing will run it on schedule. '
        + 'Pause and resume it to register it again.',
      background: false,
    });
  });
});

describe('the month ahead promises runs only where they will happen', () => {
  test('"will run" only when every watching watch will', () => {
    expect(monthAheadLede(status('fires_here', [fires(1)]), [1])).toMatch(/^When each watch will run,/);
    expect(monthAheadLede(undefined, [1])).toMatch(/^When each watch is due,/);
    expect(monthAheadLede(status('no_service', [nothing(1), nothing(2)]), [1, 2]))
      .toMatch(/^When each watch is due by its schedule, in this computer’s time\. As things stand nothing will run them;/);
    expect(monthAheadLede(status('service_elsewhere', [fires(1), unsure(2)]), [1, 2]))
      .toContain('A faint mark is a watch nothing is confirmed to run');
  });
});

describe('what a watch keeps itself from finding', () => {
  const now = new Date(2026, 9, 29, 17, 0);

  test('a watch on words with no words', () => {
    expect(watchWarnings(JSON.stringify({ repositories: ['arxiv'], keywords: [], query: '' }), now).map((w) => w.kind))
      .toEqual(['no_terms']);
    expect(watchWarnings(JSON.stringify({ keywords: ['  '], query: ' ' }), now)[0]?.text)
      .toBe('It has no words to look for, so every run sends its sources an empty query. Add the words it should look for under Change.');
  });

  test('a watch on a person has no words by design', () => {
    expect(watchWarnings(JSON.stringify({ keywords: [], query: '', entity: { profile_id: 3, mode: 'new_papers' } }), now)).toEqual([]);
  });

  test('fixed dates whose end has passed', () => {
    const [warning] = watchWarnings(JSON.stringify({ keywords: ['agents'], date_from: '2026-05-03', date_to: '2026-05-04' }), now);
    expect(warning).toEqual({
      kind: 'window_ended',
      text: 'Every run asks for papers published from May 3, 2026 to May 4, 2026, the same dates each time, and that '
        + 'window ended on May 4, 2026. To ask for new papers on every run, choose “Papers published since the previous '
        + 'run” under Change.',
    });
    // Clearing the dates is not the cure it once was said to be.
    expect(warning?.text).not.toContain('clear both dates');
    expect(watchWarnings(JSON.stringify({ keywords: ['agents'], date_to: '2026-05-04' }), now)[0]?.text)
      .toMatch(/^Every run asks for papers published up to May 4, 2026,/);
  });

  test('a window still open, or one that ends today or later, is not warned about', () => {
    for (const dates of [{ date_from: '2026-05-03', date_to: '' }, { date_to: '2026-10-29' }, { date_to: '2027-01-01' }, {}]) {
      expect(watchWarnings(JSON.stringify({ keywords: ['agents'], ...dates }), now)).toEqual([]);
    }
  });

  describe('no dates on a source that ranks by relevance', () => {
    const entry = (slug: string, name: string, order: CatalogEntry['result_order']) => ({ slug, name, result_order: order }) as CatalogEntry;
    const catalog = [
      entry('arxiv', 'arXiv', 'newest_first'), entry('crossref', 'Crossref', 'relevance'),
      entry('openalex', 'OpenAlex', 'relevance'), entry('dryad', 'Dryad', 'unstated'),
    ];
    const undated = (sources: string[], extra: Record<string, unknown> = {}) =>
      watchWarnings(JSON.stringify({ keywords: ['agents'], repositories: sources, ...extra }), now, catalog);

    test('names the relevance-ranked sources it asks, and the cure', () => {
      expect(undated(['arxiv', 'crossref', 'openalex'])).toEqual([{
        kind: 'undated_relevance',
        text: 'Every run asks Crossref and OpenAlex with no date limit, and they rank by relevance, so each run gets the '
          + 'most relevant papers of all years, mostly the same ones, and finds little that is new. To ask for new papers '
          + 'on every run, choose “Papers published since the previous run” under Change.',
      }]);
      expect(undated(['crossref'])[0]?.text).toMatch(/^Every run asks Crossref with no date limit, and it ranks by relevance,/);
    });

    test('a newest-first or unstated source, a window, dates, or a watch on retractions is not warned about', () => {
      expect(undated(['arxiv', 'dryad'])).toEqual([]);
      expect(undated(['crossref'], { date_window: { since: 'previous_run' } })).toEqual([]);
      expect(undated(['crossref'], { date_window: { last_days: 30 } })).toEqual([]);
      expect(undated(['crossref'], { date_from: '2026-10-01' })).toEqual([]);
      expect(undated(['crossref'], { keywords: [], entity: { profile_id: 1, mode: 'retractions' } })).toEqual([]);
      // Without the catalog read, nothing is said about an order resmon has not looked up.
      expect(watchWarnings(JSON.stringify({ keywords: ['a'], repositories: ['crossref'] }), now)).toEqual([]);
    });
  });

  test('both at once, and nothing from what cannot be read', () => {
    expect(watchWarnings(JSON.stringify({ keywords: [], query: '', date_to: '2026-05-04' }), now).map((w) => w.kind))
      .toEqual(['no_terms', 'window_ended']);
    expect(watchWarnings(JSON.stringify({ keywords: ['a'], date_to: 'last May' }), now)).toEqual([]);
    expect(watchWarnings('not json', now)).toEqual([]);
  });
});

describe('the run history draws to an honest scale', () => {
  test('the tallest bar is the largest run, or the next largest where the first dwarfs it', () => {
    expect(historyScale([3, 5, 2])).toBe(5);
    expect(historyScale([400, 6, 2])).toBe(6);
    expect(historyScale([7, null, 4])).toBe(7);
  });

  test('a history of zeros, or of no counts, has no tallest bar', () => {
    expect(historyScale([0, 0, 0])).toBeNull();
    expect(historyScale([null, 0])).toBeNull();
    expect(historyScale([])).toBeNull();
  });
});
