import { archiveName, importedWords } from '../Saved';
import {
  editedParameters, savedAsks, savedForm, savedFormProblem, savedFromRun, savedKind, savedParameters,
} from '../savedSearches';

describe('a saved search, read back', () => {
  test('a Deep Sweep: its sources, terms, window and cap', () => {
    const asks = savedAsks({
      config_type: 'manual_sweep',
      parameters: { repositories: ['arxiv', 'biorxiv'], keywords: ['perovskite'], date_from: '2026-10-01', date_to: '2026-10-28', max_results: 100 },
    });
    expect(asks).toMatchObject({ sources: ['arxiv', 'biorxiv'], keywords: ['perovskite'], cap: 100, cron: null, watchId: null });
    // A stored calendar date is the date it names, in every time zone.
    expect(asks.window).toBe('October 1, 2026 to October 28, 2026');
  });

  test('a Deep Dive names one source; parameters stored as text are read too', () => {
    const asks = savedAsks({ config_type: 'manual_dive', parameters: JSON.stringify({ repository: 'arxiv', keywords: ['tandem'] }) });
    expect(asks.sources).toEqual(['arxiv']);
    expect(asks.window).toBeNull();
    expect(asks.cap).toBeNull();
  });

  test('a watch\'s copy is read through its wrapper: schedule and watch from outside, what it asks from inside', () => {
    const asks = savedAsks({
      config_type: 'routine',
      parameters: { linked_routine_id: 7, schedule_cron: '0 9 * * *', is_active: true,
        parameters: { repositories: ['arxiv'], keywords: ['perovskite'], max_results: 50 } },
    });
    expect(asks).toMatchObject({ sources: ['arxiv'], keywords: ['perovskite'], cap: 50, cron: '0 9 * * *', watchId: 7 });
  });

  test('a watch\'s window that moves is said as the window, since it stores no dates', () => {
    const copy = (window: unknown) => savedAsks({
      config_type: 'routine',
      parameters: { linked_routine_id: 7, parameters: { repositories: ['arxiv'], date_from: '', date_to: '', date_window: window } },
    }).window;
    expect(copy({ since: 'previous_run' })).toBe('published since the previous run');
    expect(copy({ last_days: 30 })).toBe('the last 30 days before each run');
  });

  test('kinds in Atlas\'s words; an unknown one as stored', () => {
    expect([savedKind('manual_dive'), savedKind('manual_sweep'), savedKind('routine'), savedKind('other')])
      .toEqual(['Deep Dive', 'Deep Sweep', 'Watch', 'other']);
  });
});

describe('what Save this search stores', () => {
  const form = { sources: ['arxiv', 'springer'], keywords: ['perovskite'], dateFrom: '', dateTo: '', cap: 100 };

  test('the classic pages\' shape, so a search saved in one interface opens in the other', () => {
    expect(savedParameters({ ...form, mode: 'sweep' })).toEqual({
      config_type: 'manual_sweep',
      parameters: { repositories: ['arxiv', 'springer'], date_from: '', date_to: '', keywords: ['perovskite'], max_results: 100, ai_enabled: false },
    });
    expect(savedParameters({ ...form, mode: 'dive' }).parameters).toMatchObject({ repository: 'arxiv' });
  });

  test('what is stored reads back as what was asked', () => {
    const { config_type, parameters } = savedParameters({ ...form, mode: 'sweep' });
    expect(savedAsks({ config_type, parameters })).toMatchObject({ sources: form.sources, keywords: form.keywords, cap: 100 });
  });
});

test('an exported archive is named for the moment it was made, in local time', () => {
  expect(archiveName(new Date(2026, 9, 29, 16, 4, 2))).toBe('resmon-saved-20261029T160402.zip');
});

describe('what an import says it did', () => {
  test.each([
    [1, 0, 'Imported 1 saved search.'],
    [3, 1, 'Imported 2 saved searches and 1 watch, which arrives paused.'],
    [2, 2, 'Imported 2 watches, which arrive paused.'],
    [0, 0, 'Nothing was imported.'],
  ])('%i imported, %i of them watches', (imported, watches, words) => {
    expect(importedWords(imported, watches)).toBe(words);
  });
});

describe('a saved search changed in place', () => {
  const sweep = {
    name: 'Perovskites',
    config_type: 'manual_sweep',
    parameters: {
      repositories: ['arxiv', 'biorxiv'], keywords: ['perovskite'], date_from: '2026-10-01', date_to: '',
      max_results: 50, ai_enabled: true, ai_settings: { provider: 'openai', model: 'gpt-4o-mini' },
    },
  };

  test('the editor opens on what the engine stores', () => {
    expect(savedForm(sweep)).toEqual({
      name: 'Perovskites', sources: ['arxiv', 'biorxiv'], keywords: ['perovskite'], dateFrom: '2026-10-01', dateTo: '', cap: 50,
    });
    // No cap stored is the cap Ask the sources starts from.
    expect(savedForm({ name: 'x', config_type: 'manual_dive', parameters: { repository: 'arxiv', keywords: ['a'] } }).cap).toBe(100);
  });

  test('what it stores is the editor\'s fields over what was there: summaries and a lane of its own are kept', () => {
    const next = editedParameters(sweep, {
      ...savedForm(sweep), sources: ['crossref'], keywords: ['tandem', 'cells'], dateFrom: '', dateTo: '2026-10-28', cap: 20,
    });
    expect(next).toEqual({
      repositories: ['crossref'], keywords: ['tandem', 'cells'], date_from: '', date_to: '2026-10-28', max_results: 20,
      ai_enabled: true, ai_settings: { provider: 'openai', model: 'gpt-4o-mini' },
    });
    // And it reads back as what the editor held.
    expect(savedAsks({ config_type: 'manual_sweep', parameters: next })).toMatchObject({
      sources: ['crossref'], keywords: ['tandem', 'cells'], dateTo: '2026-10-28', cap: 20, summarize: true,
    });
  });

  test('a Deep Dive keeps one source under its own key, and a query stored beside the terms follows them', () => {
    const dive = {
      config_type: 'manual_dive',
      parameters: JSON.stringify({ repository: 'arxiv', repositories: ['arxiv'], query: 'old words', keywords: ['old'] }),
    };
    const next = editedParameters(dive, { name: 'd', sources: ['biorxiv'], keywords: ['new', 'words'], dateFrom: '', dateTo: '', cap: 10 });
    expect(next.repository).toBe('biorxiv');
    expect(next).not.toHaveProperty('repositories');
    expect(next.query).toBe('new words');
    expect(savedAsks({ config_type: 'manual_dive', parameters: next }).sources).toEqual(['biorxiv']);
    // A sweep's single-source key goes, so the two cannot disagree.
    expect(editedParameters({ config_type: 'manual_sweep', parameters: { repository: 'arxiv' } }, savedForm(sweep)))
      .not.toHaveProperty('repository');
  });

  test('what stops a save, in the order a person would fix it', () => {
    const form = savedForm(sweep);
    expect(savedFormProblem('manual_sweep', form)).toBeNull();
    expect(savedFormProblem('manual_sweep', { ...form, name: '  ' })).toBe('Give it a name.');
    expect(savedFormProblem('manual_sweep', { ...form, keywords: [] })).toBe('Add at least one term.');
    expect(savedFormProblem('manual_sweep', { ...form, sources: [] })).toBe('Choose one or more sources.');
    expect(savedFormProblem('manual_dive', { ...form, sources: [] })).toBe('Choose a source.');
    expect(savedFormProblem('manual_sweep', { ...form, dateFrom: '2026-10-28', dateTo: '2026-10-01' }))
      .toBe('The From date is after the To date.');
  });
});

describe('a run saved as a search', () => {
  // What `prepare_execution` stores: the query, the terms, the window, the cap, and the sources, as text.
  const stored = JSON.stringify({
    query: 'perovskite tandem', keywords: ['perovskite', 'tandem'], date_from: '2026-09-28', date_to: '2026-10-28',
    max_results: 40, repositories: ['arxiv', 'biorxiv'],
  });

  test('a Deep Sweep\'s run: its sources, terms, dates, and cap, and whether it summarized', () => {
    expect(savedFromRun({ execution_type: 'deep_sweep', parameters: stored }, true)).toEqual({
      config_type: 'manual_sweep',
      parameters: {
        repositories: ['arxiv', 'biorxiv'], keywords: ['perovskite', 'tandem'], date_from: '2026-09-28', date_to: '2026-10-28',
        max_results: 40, ai_enabled: true,
      },
    });
  });

  test('a Deep Dive\'s run names its one source; a window not set is no dates', () => {
    const dive = JSON.stringify({ query: 'perovskite', keywords: ['perovskite'], date_from: null, date_to: null, max_results: 100, repositories: ['arxiv'] });
    expect(savedFromRun({ execution_type: 'deep_dive', parameters: dive }, false)).toEqual({
      config_type: 'manual_dive',
      parameters: { repository: 'arxiv', keywords: ['perovskite'], date_from: '', date_to: '', max_results: 100, ai_enabled: false },
    });
  });

  test('a run with only a query keeps it as its one term', () => {
    const saved = savedFromRun({ execution_type: 'deep_sweep', parameters: JSON.stringify({ query: ' solar ', repositories: ['arxiv'] }) }, false);
    expect(saved?.parameters.keywords).toEqual(['solar']);
  });

  test('a watch\'s run is not offered: its search is the watch\'s', () => {
    expect(savedFromRun({ execution_type: 'automated_sweep', parameters: stored }, false)).toBeNull();
  });
});
