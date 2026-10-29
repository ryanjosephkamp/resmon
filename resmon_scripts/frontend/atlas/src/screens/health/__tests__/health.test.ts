import {
  MARK, lastAsked, markOf, pointRadius, runDays, scopeWords, thresholdWords, watchdogVerdict, windowSentence,
  type WallRun, type WallSource, type WatchdogReport,
} from '../model';

const STATES = ['answered', 'answered_empty', 'could_not_be_asked', 'failed', 'not_recorded', 'not_selected'];

describe('the Source wall\'s marks', () => {
  test('every state the engine serves has a mark of its own', () => {
    expect(STATES.map(markOf)).toEqual(STATES.map((s) => MARK[s]));
    expect(new Set(STATES.map(markOf)).size).toBe(STATES.length);
  });

  test('a state this build does not know is not drawn as one it does', () => {
    expect(markOf('something_new')).toBe('unknown');
    expect(Object.values(MARK)).not.toContain('unknown');
  });

  test('a point grows with its count, by area, and never past the cell', () => {
    expect(pointRadius(0, 100)).toBe(2.5);
    expect(pointRadius(100, 100)).toBe(6);
    expect(pointRadius(400, 100)).toBe(6);
    expect(pointRadius(25, 100)).toBeCloseTo(4.25);
  });
});

test('the window, in a sentence', () => {
  expect(windowSentence({ requested: 12, returned: 2, max: 50, runs_available: 2 })).toBe('Showing 2 of 2 recorded runs');
  expect(windowSentence({ requested: 12, returned: 1, max: 50, runs_available: 1 })).toBe('Showing 1 of 1 recorded run');
});

const run = (id: number, at: string): WallRun => ({
  execution_id: id, execution_type: 'deep_dive', status: 'completed', started_at: at, ended_at: at, label: 'Deep Dive',
});

test('runs are grouped by day for the header, each day once', () => {
  const days = runDays([run(1, '2026-10-27T14:00:00Z'), run(2, '2026-10-27T15:00:00Z'), run(3, '2026-10-29T14:00:00Z')]);
  expect(days.map((d) => d.span)).toEqual([2, 1]);
  expect(runDays([run(4, '')])).toEqual([{ day: 'Not recorded', span: 1 }]);
});

test('a source\'s condition is read from its newest cell that is not a silence', () => {
  const cell = (state: string, id: number) => ({
    execution_id: id, state, label: state, note: '', result_count: null, status: null, zero_reason: null,
    partial: false, outcome_recorded: true, in_selection: true,
  });
  const runs = [run(1, '2026-10-27T14:00:00Z'), run(2, '2026-10-28T14:00:00Z'), run(3, '2026-10-29T14:00:00Z')];
  const source = (states: string[]): WallSource => ({
    slug: 'arxiv', name: 'arXiv', in_catalog: true, cells: states.map((s, i) => cell(s, i + 1)),
    counts: {}, latest_known_state: null,
  });
  expect(lastAsked(source(['answered', 'failed', 'not_recorded']), runs)?.run.execution_id).toBe(2);
  expect(lastAsked(source(['not_selected', 'not_recorded', 'not_selected']), runs)).toBeNull();
});

describe('the watchdog', () => {
  const base: WatchdogReport = {
    checked_at: '2026-10-29T08:00:00Z', findings: [], not_enough_data: [], sufficient: true,
    counts: { broken: 0, unusual: 0, advice: 0, muted: 0, alarms: 0 },
    watching: { sources: 3, routines: 1 },
    thresholds: {
      consecutive_errors: 3, consecutive_zeros: 4, min_baseline_runs: 5, flatline_runs: 5,
      overdue_cadence_multiple: 3, overdue_floor_days: 1, cadence_lag_multiple: 2, min_runs_for_cadence: 3,
    },
  };

  test('with no history it says there is nothing to check yet, never that nothing is wrong', () => {
    const verdict = watchdogVerdict({ ...base, sufficient: false });
    expect(verdict.level).toBe('unknown');
    expect(verdict.headline.toLowerCase()).toContain('nothing to check yet');
    expect(verdict.headline.toLowerCase()).not.toContain('nothing looks wrong');
  });

  test('what is broken and what looks unusual, counted; muted ones are not alarms', () => {
    expect(watchdogVerdict({ ...base, counts: { ...base.counts, broken: 1 } }).headline).toBe('1 thing is broken.');
    expect(watchdogVerdict({ ...base, counts: { ...base.counts, broken: 2, unusual: 1 } }).headline)
      .toBe('2 things are broken, and 1 looks unusual.');
    const muted = watchdogVerdict({ ...base, counts: { ...base.counts, muted: 1 } });
    expect(muted.level).toBe('clear');
    expect(muted.headline).toBe('None of the watchdog’s checks found anything, over 3 sources and 1 active watch.');
  });

  test('a scope in words: a source by its catalog name, a routine as a watch', () => {
    const names = new Map([['arxiv', 'arXiv']]);
    expect(scopeWords({ type: 'source', id: 'arxiv' }, names)).toBe('Source · arXiv');
    expect(scopeWords({ type: 'routine', id: 4, name: 'Perovskites' }, names)).toBe('Watch · Perovskites');
  });

  test('the rules are stated with the numbers they were judged against', () => {
    const words = thresholdWords(base.thresholds);
    expect(words[0]).toBe('A source is broken after 3 failed runs in a row.');
    expect(words[3]).toContain('for at least 1 day,');
  });
});
