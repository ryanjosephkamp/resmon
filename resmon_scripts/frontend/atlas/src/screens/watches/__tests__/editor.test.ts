import { NO_CHOICE, choiceOf } from '../../settings/summaryChoice';
import type { AiSettings } from '../../settings/summaryLanes';
import type { CatalogEntry } from '../../runs/model';
import {
  blankForm, choiceFrom, clockValue, cronFor, formFrom, fromClock, retractionsAsks, scheduleWords, seededForm, startMissing,
  startMissingSentence, startOffer, summaryBody, watchBody, whatIsMissing,
  type ScheduleChoice,
} from '../editor';
import { scheduleText, type Routine } from '../model';
import type { StartNeeded } from '../window';

const ROUTINE: Routine = {
  id: 7, name: 'Perovskites', schedule_cron: '30 7 * * 1-5',
  parameters: JSON.stringify({
    repositories: ['arxiv', 'biorxiv'], keywords: ['perovskite', 'tandem'], query: 'perovskite tandem',
    date_from: '', date_to: '', max_results: 50, some_future_field: 'kept',
  }),
  is_active: false, email_enabled: true, email_ai_summary_enabled: true, ai_enabled: true,
  notify_on_complete: true, ai_settings: '{"tone":"plain"}', storage_settings: null, intent: 'cells that last',
  execution_location: 'local', created_at: '2026-10-01 08:00:00', updated_at: '2026-10-01 08:00:00',
  last_executed_at: null, missed_fires: { count: 0, overlap_skipped: 0 }, missed_fire_details: [],
} as unknown as Routine;

describe('each schedule offered stores a cron whose words are exact', () => {
  const at = (patch: Partial<ScheduleChoice>): ScheduleChoice => ({ ...blankForm().schedule, ...patch });
  test.each<[Partial<ScheduleChoice>, string, string]>([
    [{ cadence: 'daily', hour: 6, minute: 0 }, '0 6 * * *', 'Daily at 6:00 AM'],
    [{ cadence: 'weekdays', hour: 7, minute: 30 }, '30 7 * * 1-5', 'Weekdays at 7:30 AM'],
    [{ cadence: 'weekly', weekday: 1, hour: 9, minute: 0 }, '0 9 * * 1', 'Mondays at 9:00 AM'],
    [{ cadence: 'weekly', weekday: 0, hour: 18, minute: 15 }, '15 18 * * 0', 'Sundays at 6:15 PM'],
    [{ cadence: 'monthly', monthDay: 28, hour: 0, minute: 0 }, '0 0 28 * *', 'Monthly on day 28 at 12:00 AM'],
    [{ cadence: 'hours', everyHours: 6, minute: 0 }, '0 */6 * * *', 'Every 6 hours'],
    [{ cadence: 'hours', everyHours: 1, minute: 20 }, '20 * * * *', 'Every hour, at :20'],
  ])('%j', (choice, cron, words) => {
    expect(cronFor(at(choice))).toBe(cron);
    expect(scheduleText(cron)).toBe(words);
    // And it reads back as the choice it came from.
    expect(cronFor(choiceFrom(cron, {}))).toBe(cron);
  });

  test('a schedule kept as it is stores nothing new', () => {
    expect(cronFor(at({ cadence: 'kept' }))).toBeNull();
  });
});

describe('a stored schedule the choices cannot state is kept as it is', () => {
  test.each([
    '*/15 * * * *',     // every few minutes
    '0 */5 * * *',      // five hours does not divide the day
    '0 9 * * 1,3,5',    // several days
    '0 9 30 * *',       // a day some months do not have
    '0 9-17 * * *',     // a range of hours
    '0 9 1 */2 *',      // every other month
    'not a cron',
  ])('%s', (cron) => {
    expect(choiceFrom(cron, {}).cadence).toBe('kept');
  });

  test('a structured interval is the schedule that runs, whatever the cron beside it says', () => {
    expect(choiceFrom('0 8 * * *', { _schedule: { type: 'interval', unit: 'weeks', every: 2, hour: 8, minute: 0 } }).cadence)
      .toBe('kept');
  });

  test('day 7 of the week is Sunday', () => {
    expect(choiceFrom('0 9 * * 7', {})).toMatchObject({ cadence: 'weekly', weekday: 0 });
  });
});

test('a step that does not divide the hour or the day is not put in words', () => {
  expect(scheduleText('0 */5 * * *')).toBeNull();
  expect(scheduleText('*/7 * * * *')).toBeNull();
  expect(scheduleText('*/20 * * * *')).toBe('Every 20 minutes');
  expect(scheduleText('0 */8 * * *')).toBe('Every 8 hours');
});

test('a time field\'s value, both ways', () => {
  expect(clockValue(7, 5)).toBe('07:05');
  expect(fromClock('07:05')).toEqual({ hour: 7, minute: 5 });
  expect(fromClock('')).toBeNull();
});

describe('a stored watch, read into the form and saved back', () => {
  test('the form shows what is stored', () => {
    expect(formFrom(ROUTINE)).toMatchObject({
      name: 'Perovskites', follows: 'words', keywords: ['perovskite', 'tandem'], sources: ['arxiv', 'biorxiv'],
      schedule: { cadence: 'weekdays', hour: 7, minute: 30 }, cap: 50, intent: 'cells that last',
      notify: true, email: true, attach: true, start: false,
    });
  });

  test('saving unchanged sends back what was stored, and nothing about pausing or AI', () => {
    const body = watchBody(formFrom(ROUTINE), ROUTINE);
    expect(body.schedule_cron).toBe('30 7 * * 1-5');
    expect(body.parameters).toEqual(JSON.parse(ROUTINE.parameters));
    expect(body).not.toHaveProperty('is_active');
    expect(body).not.toHaveProperty('ai_enabled');
    expect(body).not.toHaveProperty('ai_settings');
  });

  test('a field this editor does not show survives a save', () => {
    const form = { ...formFrom(ROUTINE), keywords: ['perovskite'] };
    expect(watchBody(form, ROUTINE).parameters).toMatchObject({ some_future_field: 'kept', query: 'perovskite' });
  });

  test('a structured schedule is kept until another is chosen, and then removed', () => {
    const structured = {
      ...ROUTINE, schedule_cron: '0 0 */14 * *',
      parameters: JSON.stringify({ ...JSON.parse(ROUTINE.parameters), _schedule: { type: 'interval', unit: 'weeks', every: 2, hour: 8, minute: 0 } }),
    } as Routine;
    const kept = watchBody(formFrom(structured), structured);
    expect(kept.schedule_cron).toBe('0 0 */14 * *');
    expect(kept.parameters._schedule).toEqual({ type: 'interval', unit: 'weeks', every: 2, hour: 8, minute: 0 });
    expect(scheduleWords(formFrom(structured), structured).words).toBe('Every 2 weeks at 8:00 AM');

    const form = formFrom(structured);
    const changed = watchBody({ ...form, schedule: { ...form.schedule, cadence: 'daily', hour: 6, minute: 0 } }, structured);
    expect(changed.schedule_cron).toBe('0 6 * * *');
    expect(changed.parameters).not.toHaveProperty('_schedule');
  });

  test('a watch on a person follows the person: its keywords are cleared, not sent and ignored', () => {
    const body = watchBody({ ...formFrom(ROUTINE), follows: 'new_papers', profileId: 3 }, ROUTINE);
    expect(body.parameters).toMatchObject({ entity: { profile_id: 3, mode: 'new_papers' }, keywords: [], query: '' });
    const back = watchBody({ ...formFrom({ ...ROUTINE, parameters: JSON.stringify(body.parameters) } as Routine), follows: 'words', keywords: ['x'] }, ROUTINE);
    expect(back.parameters).not.toHaveProperty('entity');
  });

  test('the attachment goes with the email, and not without it', () => {
    expect(watchBody({ ...formFrom(ROUTINE), email: false }, ROUTINE).email_ai_summary_enabled).toBe(false);
  });
});

describe('which papers each run asks for', () => {
  const stored = (parameters: Record<string, unknown>) =>
    ({ ...ROUTINE, parameters: JSON.stringify({ ...JSON.parse(ROUTINE.parameters), ...parameters }) }) as Routine;

  test('a new watch asks since its previous run, and stores that as a window with no dates', () => {
    const form = { ...blankForm(), name: 'x', keywords: ['y'], sources: ['arxiv'] };
    expect(form.window).toBe('previous_run');
    expect(watchBody(form, null).parameters).toMatchObject({
      date_window: { since: 'previous_run' }, date_from: '', date_to: '',
    });
  });

  test('in the last N days', () => {
    const body = watchBody({ ...blankForm(), name: 'x', keywords: ['y'], window: 'last_days', lastDays: 14 }, null);
    expect(body.parameters).toMatchObject({ date_window: { last_days: 14 }, date_from: '', date_to: '' });
    expect(formFrom(stored({ date_window: { last_days: 14 } }))).toMatchObject({ window: 'last_days', lastDays: 14 });
  });

  test('between two dates stores the dates and no window; no date limit stores neither', () => {
    const between = watchBody({ ...formFrom(ROUTINE), window: 'between', dateFrom: '2026-01-01', dateTo: '2026-06-30' }, ROUTINE);
    expect(between.parameters).toMatchObject({ date_from: '2026-01-01', date_to: '2026-06-30' });
    expect(between.parameters).not.toHaveProperty('date_window');
    const none = watchBody({ ...formFrom(stored({ date_window: { since: 'previous_run' } })), window: 'none' }, ROUTINE);
    expect(none.parameters).toMatchObject({ date_from: '', date_to: '' });
    expect(none.parameters).not.toHaveProperty('date_window');
  });

  test('a choice changed to a window clears the fixed dates, which the engine would refuse beside it', () => {
    const dated = stored({ date_from: '2026-05-03', date_to: '2026-05-04' });
    const body = watchBody({ ...formFrom(dated), window: 'previous_run' }, dated);
    expect(body.parameters).toMatchObject({ date_window: { since: 'previous_run' }, date_from: '', date_to: '' });
  });

  test('an existing watch opens as what it asks: dates as dates, none as none, and saving changes neither', () => {
    const dated = stored({ date_from: '2026-05-03', date_to: '2026-05-04' });
    expect(formFrom(dated)).toMatchObject({ window: 'between', dateFrom: '2026-05-03', dateTo: '2026-05-04' });
    expect(watchBody(formFrom(dated), dated).parameters).toEqual(JSON.parse(dated.parameters));
    expect(formFrom(ROUTINE).window).toBe('none');
    expect(watchBody(formFrom(ROUTINE), ROUTINE).parameters).not.toHaveProperty('date_window');
    const moving = stored({ date_window: { since: 'previous_run' } });
    expect(formFrom(moving).window).toBe('previous_run');
    expect(watchBody(formFrom(moving), moving).parameters).toEqual(JSON.parse(moving.parameters));
  });

  test('a watch on retractions says what each run sends, and to whom', () => {
    // The lifecycle check it runs sends DOIs to Crossref and arXiv and bioRxiv ids
    // to those two; "it asks no source" was false.
    expect(retractionsAsks('Ada Fixture')).toBe(
      'Each run sends the DOIs of the papers already matched to Ada Fixture to Crossref, and the ids of those from arXiv '
      + 'and bioRxiv to arXiv and bioRxiv, for retraction, correction, and newer-version notices. It searches no source '
      + 'for new papers.');
    expect(retractionsAsks('Ada Fixture')).not.toMatch(/asks no source/);
  });

  test('a watch on retractions searches no source for papers, so it stores no dates and no window', () => {
    const body = watchBody({ ...blankForm(), name: 'x', follows: 'retractions', profileId: 2 }, null);
    expect(body.parameters).not.toHaveProperty('date_window');
    expect(body.parameters).toMatchObject({ date_from: '', date_to: '' });
  });

  test('handed dates from a search, a new watch asks between them', () => {
    expect(seededForm({ dateFrom: '2026-09-01', dateTo: '2026-10-01' })).toMatchObject({ window: 'between' });
    expect(seededForm({ name: 'x' }).window).toBe('previous_run');
  });

  test('a watch on words needs a term that is not blank', () => {
    const ready = { ...blankForm(), name: 'x', keywords: ['y'] };
    expect(whatIsMissing(ready, 1)).toEqual([]);
    expect(whatIsMissing({ ...ready, keywords: [] }, 1)).toEqual(['Add at least one term.']);
    expect(whatIsMissing({ ...ready, keywords: ['  '] }, 1)).toEqual(['Add at least one term.']);
    // A watch on a person uses no terms.
    expect(whatIsMissing({ ...ready, keywords: [], follows: 'new_papers', profileId: 2 }, 1)).toEqual([]);
  });

  test('a watch that stored only the query it runs opens with that query as its one term', () => {
    const queryOnly = { ...ROUTINE, parameters: JSON.stringify({ repositories: ['arxiv'], query: 'machine learning' }) } as Routine;
    expect(formFrom(queryOnly).keywords).toEqual(['machine learning']);
    const none = { ...ROUTINE, parameters: JSON.stringify({ repositories: ['arxiv'], query: ' ', keywords: [''] }) } as Routine;
    expect(formFrom(none).keywords).toEqual([]);
  });

  test('what stops a window saving', () => {
    const ready = { ...blankForm(), name: 'x', keywords: ['y'] };
    expect(whatIsMissing({ ...ready, window: 'between' }, 1)).toEqual(['Set a start date, an end date, or both.']);
    expect(whatIsMissing({ ...ready, window: 'between', dateFrom: '2026-02-01', dateTo: '2026-01-01' }, 1))
      .toEqual(['The start date is after the end date.']);
    expect(whatIsMissing({ ...ready, window: 'between', dateTo: '2026-01-01' }, 1)).toEqual([]);
    expect(whatIsMissing({ ...ready, window: 'last_days', lastDays: 0 }, 1)).toEqual(['Choose a number of days from 1 to 3,650.']);
    expect(whatIsMissing({ ...ready, window: 'none' }, 1)).toEqual([]);
  });

  test('a source that needs a start date is not asked with none, and the days it would get are offered', () => {
    const biorxiv = { slug: 'biorxiv', name: 'bioRxiv', constraints: { default_start_days: 3 } } as unknown as CatalogEntry;
    const needs: StartNeeded = { entries: [biorxiv], days: 3 };
    const ready = { ...blankForm(), name: 'x', keywords: ['y'], sources: ['biorxiv'] };
    const said = 'bioRxiv needs a start date, and this window gives none: resmon reads every preprint in its range '
      + 'itself, and its whole archive is far more than a search can read in 45 seconds.';
    // No date limit, or fixed dates with no start.
    expect(whatIsMissing({ ...ready, window: 'none' }, 1, needs)).toEqual([said]);
    expect(whatIsMissing({ ...ready, window: 'between' }, 1, needs)).toEqual([said]);
    expect(whatIsMissing({ ...ready, window: 'between', dateTo: '2026-01-01' }, 1, needs)).toEqual([said]);
    // A start, or a window that moves, gives it one.
    expect(whatIsMissing({ ...ready, window: 'between', dateFrom: '2026-01-01' }, 1, needs)).toEqual([]);
    expect(whatIsMissing({ ...ready, window: 'previous_run' }, 1, needs)).toEqual([]);
    expect(whatIsMissing({ ...ready, window: 'last_days', lastDays: 30 }, 1, needs)).toEqual([]);
    // A watch on a person never asks its sources for a date range.
    expect(startMissing({ ...ready, window: 'none', follows: 'new_papers', profileId: 2 }, needs)).toBeNull();
    expect(startMissing({ ...ready, window: 'none' }, null)).toBeNull();
    expect(startMissingSentence(needs)).toBe(said);
    expect(startOffer(needs)).toEqual({ window: 'last_days', lastDays: 3, label: 'Ask for the last 3 days' });
    // What the offer saves is a window that moves, with no fixed dates beside it.
    const offered = { ...ready, window: 'last_days' as const, lastDays: startOffer(needs).lastDays };
    expect(watchBody(offered, null).parameters).toMatchObject({ date_window: { last_days: 3 }, date_from: '', date_to: '' });
  });
});

describe('a new watch', () => {
  test('starts watching unless it is saved paused', () => {
    expect(watchBody({ ...blankForm(), name: 'x', keywords: ['y'], sources: ['arxiv'] }, null).is_active).toBe(true);
    expect(watchBody({ ...blankForm(), name: 'x', start: false }, null).is_active).toBe(false);
  });

  test('begun from a search, it asks what the search asked', () => {
    expect(seededForm({ name: 'Tandem cells', sources: ['arxiv'], keywords: ['tandem'], cap: 25 }))
      .toMatchObject({ name: 'Tandem cells', sources: ['arxiv'], keywords: ['tandem'], cap: 25, follows: 'words' });
    expect(seededForm({ profileId: 4 })).toMatchObject({ follows: 'new_papers', profileId: 4 });
  });

  test('says what stops it saving', () => {
    expect(whatIsMissing(blankForm(), 0)).toEqual(['Give it a name.', 'Add at least one term.', 'Choose at least one source.']);
    expect(whatIsMissing({ ...blankForm(), name: 'x', follows: 'retractions' }, 0)).toEqual(['Choose the person it watches for.']);
    expect(whatIsMissing({ ...blankForm(), name: 'x', keywords: ['y'] }, 2)).toEqual([]);
  });
});

describe('whether a watch’s runs summarize, as the routine stores it', () => {
  const AI = {
    ai_chain: '', ai_cli_path: '', ai_custom_base_url: 'https://llm.example/v1', ai_custom_header_prefix: '', ai_default_models: '',
    ai_effort: '', ai_extraction_goals: '', ai_local_endpoint: '', ai_local_model: '', ai_model: 'gpt-4o', ai_provider: 'openai',
    ai_show_audit_prefix: '', ai_subscription_doc_cap: '', ai_summary_length: '', ai_temperature: '', ai_tone: '',
  } as AiSettings;
  const stored = choiceOf(true, ROUTINE.ai_settings);

  test('a choice left alone leaves what is stored exactly as it was', () => {
    expect(stored).toMatchObject({ on: true, lane: 'settings', tone: 'plain' });
    expect(summaryBody(stored, stored, AI, ROUTINE)).toEqual({ ai_enabled: true });
  });

  test('a lane of its own, turned on in the editor, is written with the rest of what is stored', () => {
    const own = { ...stored, lane: 'own' as const, provider: 'custom', model: 'authored-model' };
    expect(summaryBody(own, stored, AI, ROUTINE)).toEqual({
      ai_enabled: true,
      ai_settings: {
        tone: 'plain', provider: 'custom', model: 'authored-model',
        chain: JSON.stringify([{ kind: 'api_key', provider: 'custom', model: 'authored-model', credential_alias: 'custom_llm_api_key', base_url: 'https://llm.example/v1' }]),
      },
    });
  });

  test('turned off, the choice is kept for when it is turned on again; cleared, it is sent empty', () => {
    expect(summaryBody({ ...stored, on: false }, stored, AI, ROUTINE)).toEqual({ ai_enabled: false, ai_settings: { tone: 'plain' } });
    expect(summaryBody({ ...stored, tone: '' }, stored, AI, ROUTINE)).toEqual({ ai_enabled: true, ai_settings: {} });
  });

  test('a new watch sends nothing it does not set', () => {
    expect(summaryBody(NO_CHOICE, NO_CHOICE, AI, null)).toEqual({ ai_enabled: false });
    expect(summaryBody({ ...NO_CHOICE, on: true }, NO_CHOICE, AI, null)).toEqual({ ai_enabled: true });
    expect(summaryBody({ ...NO_CHOICE, on: true, length: 'brief' }, NO_CHOICE, AI, null)).toEqual({ ai_enabled: true, ai_settings: { length: 'brief' } });
  });
});
