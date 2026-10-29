import { importedWords } from '../Saved';
import { savedAsks, savedKind, savedParameters } from '../savedSearches';

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
