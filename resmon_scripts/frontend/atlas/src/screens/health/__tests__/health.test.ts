import * as fs from 'fs';
import * as path from 'path';
import {
  MARK, RETIRED_NAMES, SEVERITY_MEANING, SEVERITY_WORDS, findingWords, lastAsked, markOf, pointRadius, runDays, scopeWords, thresholdWords, watchdogVerdict,
  windowSentence, type WallRun, type WallSource, type WatchdogFinding, type WatchdogReport,
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
      skipped_fires_window_days: 7,
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
    // A withdrawn source is not in the catalog, and is still called by the name it had.
    expect(scopeWords({ type: 'source', id: 'ieee' }, names)).toBe('Source · IEEE Xplore');
  });

  test('a source finding names its source as the catalog does, never by its key', () => {
    const names = new Map([['semantic_scholar', 'Semantic Scholar'], ['arxiv', 'arXiv']]);
    const finding = (over: Partial<WatchdogFinding>): WatchdogFinding => ({
      key: 'k', severity: 'broken', kind: 'source_errors', scope: { type: 'source', id: 'semantic_scholar' },
      title: 'semantic_scholar has failed on its last 4 runs',
      detail: 'resmon got no answer from semantic_scholar on each of its last 4 runs. The most recent one: the source answered HTTP 429.',
      what_to_do: 'Check whether semantic_scholar is reachable and whether any key it needs is still valid.',
      evidence: { consecutive_errors: 4, last_zero_reason: 'upstream_failure' }, ...over,
    } as WatchdogFinding);
    const said = findingWords(finding({}), names);
    expect(said.title).toBe('Semantic Scholar has failed on its last 4 runs');
    expect(`${said.title} ${said.detail} ${said.what_to_do}`).not.toMatch(/semantic_scholar/);
    expect(said.withdrawn).toBe(false);
    // Only a whole word is the key: an address, or a longer name, is left as it was written.
    const arxiv = findingWords(finding({
      scope: { type: 'source', id: 'arxiv' }, title: 'arxiv has failed on its last 3 runs',
      detail: 'From export.arxiv.org, arxiv_id 7, and arxiv/2410.1; then arxiv.', what_to_do: 'Check arxiv.',
    }), names);
    expect(arxiv.title).toBe('arXiv has failed on its last 3 runs');
    expect(arxiv.detail).toBe('From export.arxiv.org, arxiv_id 7, and arxiv/2410.1; then arXiv.');
    expect(arxiv.what_to_do).toBe('Check arXiv.');
    // A withdrawn source, by the name it was withdrawn under; the engine's own paragraph stays whole.
    const ieee = findingWords(finding({
      scope: { type: 'source', id: 'ieee' }, title: 'ieee was withdrawn from resmon',
      detail: 'ieee has been withdrawn, and resmon got nothing from it on each of its last 4 runs. IEEE Xplore was withdrawn in v1.8.1.',
      what_to_do: 'No active routine selects ieee any more, so no future run will ask for it and nothing needs changing.',
      evidence: { consecutive_errors: 4, last_zero_reason: 'retired' },
    }), names);
    expect(ieee.title).toBe('IEEE Xplore was withdrawn from resmon');
    expect(ieee.detail).toBe('IEEE Xplore has been withdrawn, and resmon got nothing from it on each of its last 4 runs. '
      + 'IEEE Xplore was withdrawn in v1.8.1.');
    expect(ieee.what_to_do).toMatch(/^No active routine selects IEEE Xplore any more/);
    expect(ieee.withdrawn).toBe(true);
    // The engine labels it for what it is: not broken, and not an alarm.
    expect(findingWords(finding({ scope: { type: 'source', id: 'gone' }, severity: 'withdrawn',
      evidence: { consecutive_errors: 4 } }), names).withdrawn).toBe(true);
    expect(SEVERITY_WORDS.withdrawn).toBe('Withdrawn');
    expect(SEVERITY_MEANING.withdrawn).toMatch(/Not a fault, and not an alarm\.$/);
    // Advice says it is not an alarm, and claims no more than that: never that nothing is wrong.
    expect(SEVERITY_MEANING.advice).not.toMatch(/Nothing is wrong/);
    // A watch's finding is left as the engine wrote it.
    const watch = findingWords(finding({ kind: 'routine_overdue', scope: { type: 'routine', id: 3, name: 'arxiv' }, title: "'arxiv' has not run" }), names);
    expect(watch.title).toBe("'arxiv' has not run");
  });

  test('the names withdrawn sources are shown under are the engine’s own', () => {
    const registry = fs.readFileSync(path.join(__dirname, '..', '..', '..', '..', '..', '..', 'implementation_scripts', 'api_registry.py'), 'utf8');
    const block = registry.match(/^RETIRED_NAMES: dict\[str, str\] = \{([\s\S]*?)^\}/m)?.[1] ?? '';
    const served = Object.fromEntries([...block.matchAll(/"([^"]+)":\s*"([^"]+)"/g)].map((m) => [m[1], m[2]]));
    expect(Object.keys(served).length).toBeGreaterThan(0);
    expect(served).toEqual(RETIRED_NAMES);
  });

  test('the rules are stated with the numbers they were judged against', () => {
    const words = thresholdWords(base.thresholds);
    expect(words[0]).toBe('A source is broken after 3 failed runs in a row.');
    expect(words[3]).toContain('for at least 1 day,');
    expect(words[4]).toBe('A watch is broken when a scheduled run did not happen in the last 7 days because the run before it was still going.');
  });
});
