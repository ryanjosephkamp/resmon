import { NO_CHOICE, choiceOf } from '../../settings/summaryChoice';
import type { AiSettings } from '../../settings/summaryLanes';
import {
  blankForm, choiceFrom, clockValue, cronFor, formFrom, fromClock, scheduleWords, seededForm, summaryBody, watchBody, whatIsMissing,
  type ScheduleChoice,
} from '../editor';
import { scheduleText, type Routine } from '../model';

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
