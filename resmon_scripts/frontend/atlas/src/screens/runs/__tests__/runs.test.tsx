/**
 * @jest-environment ./jest.easternZoneEnvironment.js
 */

/*
 * West of Greenwich on purpose: a time the engine stored in UTC and shown as
 * if it were local is visibly wrong here, by four or five hours.
 */
import * as fs from 'fs';
import * as path from 'path';
import { render } from '@testing-library/react';
import { duration, when } from '../../today/format';
import { Markdown } from '../markdown';
import {
  absentRecordWords, deletedSentence, deleteQuestion, eventTime, interruptedSentence, liveLabel, liveSources, localStamp,
  logForReading, outcomeOf, reportInLocalTime, restartFacts, runNumbers, runsFileStem, runTitle, stillRunning, ZERO_LABELS,
  type ProgressEvent,
} from '../model';
import { runsCountWords } from '../RunLog';

describe("a source's outcome from its count and reason", () => {
  test.each([
    [12, null, 'answered'],
    [0, 'answered_empty', 'answered'],
    [0, 'rights_filtered', 'answered'],
    [0, 'upstream_failure', 'non_answer'],
    [0, 'missing_key', 'non_answer'],
    [0, null, 'unknown'],
    [0, 'not_recorded', 'unknown'],
    // A count that is not a count, or a reason this build does not know, is
    // unknown rather than a guess either way.
    [null, null, 'unknown'],
    [-1, null, 'unknown'],
    [3, 'a_reason_from_the_future', 'unknown'],
    [0, '', 'unknown'],
  ] as const)('%p and %p read as %s', (count, reason, expected) => {
    expect(outcomeOf(count, reason)).toBe(expected);
  });
});

describe('the live panel, folded from the run\'s events', () => {
  const events: ProgressEvent[] = [
    { type: 'execution_start' },
    { type: 'repo_start', repository: 'arxiv' },
    { type: 'repo_done', repository: 'arxiv', result_count: 4, zero_reason: null },
    { type: 'repo_start', repository: 'dblp' },
    { type: 'repo_done', repository: 'dblp', result_count: 0, zero_reason: 'parse_failure', zero_message: 'DBLP answered and resmon could not read the reply.' },
    { type: 'repo_done', repository: 'springer', result_count: 0, zero_reason: 'missing_key', zero_message: 'No API key is configured for Springer Nature.' },
    { type: 'repo_start', repository: 'zenodo' },
  ];

  test('each selected source in its order, at the state its last event left it', () => {
    const live = liveSources(['arxiv', 'dblp', 'springer', 'zenodo', 'core'], events);
    expect(live.map((s) => [s.slug, s.state, s.count])).toEqual([
      ['arxiv', 'answered', 4],
      ['dblp', 'no_answer', 0],
      ['springer', 'not_queried', 0],
      ['zenodo', 'asking', null],
      ['core', 'pending', null],
    ]);
    expect(live[1]?.note).toBe('DBLP answered and resmon could not read the reply.');
    expect(live[2]?.note).toContain('API key');
    expect(live[0]?.note).toBe('');
  });

  test('a source the events name but the selection did not is kept, after the selection', () => {
    const live = liveSources(['arxiv'], [{ type: 'repo_start', repository: 'hal' }]);
    expect(live.map((s) => s.slug)).toEqual(['arxiv', 'hal']);
  });

  test('a stopped run: the source being asked was cancelled, not an error, and one never begun was not asked', () => {
    const stopped: ProgressEvent[] = [
      { type: 'repo_start', repository: 'biorxiv' },
      { type: 'repo_error', repository: 'biorxiv', error: 'cancelled by user' },
      { type: 'cancelled' },
      { type: 'complete', status: 'cancelled' },
    ];
    const live = liveSources(['biorxiv', 'zenodo'], stopped, true);
    expect(live.map((s) => [s.slug, s.state, liveLabel(s)])).toEqual([
      ['biorxiv', 'cancelled', 'cancelled'],
      ['zenodo', 'not_reached', 'not asked'],
    ]);
    expect(live[0]?.note).toBe('The run was cancelled while this source was being queried.');
    expect(live.map(liveLabel).join(' ')).not.toContain('error');
    // While the run is still going, the same events leave the unbegun source waiting.
    expect(liveSources(['biorxiv', 'zenodo'], stopped.slice(0, 2)).map((s) => s.state)).toEqual(['cancelled', 'pending']);
  });

  test('a run that ended with no events kept says nothing about its sources beyond that', () => {
    const live = liveSources(['arxiv'], [], true);
    expect(live.map((s) => [s.state, liveLabel(s)])).toEqual([['not_recorded', 'outcome not recorded']]);
  });

  test('a real query error is still an error', () => {
    const live = liveSources(['nasa_ads'], [{ type: 'repo_error', repository: 'nasa_ads', error: 'HTTP 503' }], true);
    expect([live[0]?.state, live[0]?.note]).toEqual(['error', 'HTTP 503']);
  });

  test.each([
    ['window_unanswerable', 0, 'could not answer this window'],
    ['upstream_failure', 0, 'did not answer'],
    ['parse_failure', 0, 'reply unreadable'],
    ['entity_unsupported', 0, 'entity unsupported'],
    ['missing_key', 0, 'no API key configured'],
    ['answered_empty', 0, 'answered, zero'],
    ['rights_filtered', 0, 'answered; nothing storable'],
    ['not_recorded', 0, 'zero, reason not recorded'],
    [null, 3, '3 found'],
  ] as const)('a zero for %p reads in that reason\'s own words', (reason, count, words) => {
    const [source] = liveSources(['dblp'], [{ type: 'repo_done', repository: 'dblp', result_count: count, zero_reason: reason }]);
    expect(liveLabel(source!)).toBe(words);
  });

  test('the live panel\'s words for a zero are the recorded coverage\'s words, so the two never drift apart', () => {
    // `zero_reason.label`, which the recorded coverage and the run's log both use.
    const words = fs.readFileSync(path.resolve(__dirname, '../../../../../../implementation_scripts/zero_reason.py'), 'utf8');
    for (const [reason, label] of Object.entries(ZERO_LABELS)) {
      expect(words).toContain(`"${reason}": "${label}"`);
    }
    expect(words).toContain('return "read part of the window"');
  });

  test('a search that read part of a window before it stopped is not said to have had no answer', () => {
    const [source] = liveSources(['biorxiv'], [{
      type: 'repo_done', repository: 'biorxiv', result_count: 0, zero_reason: 'upstream_failure',
      zero_detail: { detail: 'operation_deadline', attempts: 41, read: { records: 1200, total: 262104 } },
    }]);
    expect(liveLabel(source!)).toBe('read part of the window');
    const [nothing] = liveSources(['biorxiv'], [{
      type: 'repo_done', repository: 'biorxiv', result_count: 0, zero_reason: 'upstream_failure',
      zero_detail: { detail: 'operation_deadline', attempts: 1 },
    }]);
    expect(liveLabel(nothing!)).toBe('did not answer');
  });
});

describe('times, in the reader\'s own time zone', () => {
  test('a progress event\'s UTC stamp is shown as local time, as the run\'s heading is', () => {
    expect(eventTime('2026-10-29T20:34:12Z')).toBe('4:34:12 PM');
    // The engine stores UTC; a stamp written without its offset is still UTC.
    expect(eventTime('2026-10-29T20:34:12')).toBe('4:34:12 PM');
    expect(eventTime(undefined)).toBe('');
  });

  test('a stored instant in the record reads as a local day and time; a plain date stays a date', () => {
    expect(localStamp('2026-10-30T15:38:27Z')).toBe('October 30, 2026 at 11:38 AM');
    expect(localStamp('2026-10-30 15:38:27')).toBe('October 30, 2026 at 11:38 AM');
    expect(localStamp('2026-10-31T00:47:00+00:00')).toBe('October 30, 2026 at 8:47 PM');
    expect(localStamp('2026-10-23')).toBeNull();
    expect(localStamp('graph neural networks')).toBeNull();
    expect(localStamp('2026-10-30T25:99:00Z')).toBeNull();
  });

  test('the report’s Generated line is local on screen; the rest of the report is as written', () => {
    const report = '# resmon Literature Report\n**Generated:** 2026-10-30T15:38:27Z  \n**Date Range:** 2026-10-23 to 2026-10-30  \n'
      + '## Paper\n- **Published:** 2026-10-29T00:00:00Z';
    expect(reportInLocalTime(report)).toBe('# resmon Literature Report\n**Generated:** October 30, 2026 at 11:38 AM  \n'
      + '**Date Range:** 2026-10-23 to 2026-10-30  \n## Paper\n- **Published:** 2026-10-29T00:00:00Z');
    expect(reportInLocalTime('**Generated:** not a time')).toBe('**Generated:** not a time');
  });

  test('a SQLite stamp with no zone is UTC wherever a time is worded, never the local clock', () => {
    const now = new Date('2026-10-30T18:00:00Z');
    expect(when('2026-10-30 15:38:27', now)).toBe('today at 11:38 AM');
    expect(when('2026-10-30T15:38:27Z', now)).toBe('today at 11:38 AM');
    expect(when('2026-10-30T08:00:00-04:00', now)).toBe('today at 8:00 AM');
    expect(duration('2026-10-30 15:38:27', '2026-10-30T15:39:08Z')).toBe('41 s');
  });
});

describe('the run\'s log, as the Log tab shows it', () => {
  // A sweep's log as the engine wrote it before a zero was logged in its
  // reason's words: UTC, every source by its id, and DBLP's non-answer as a count.
  const written = [
    '=== resmon Task Log ===',
    'Operation Type: deep_sweep',
    'Execution ID: 153',
    'Start Time: 2026-10-31T23:59:58Z',
    "Parameters: query=agent, keywords=['agent'], date_from=2026-10-01, date_to=2026-10-31, max_results=2, repositories=['crossref', 'dblp', 'hal']",
    '[23:59:58] Querying repository: crossref',
    '[23:59:58] Querying repository: dblp',
    '[23:59:59]   dblp: 0 results',
    '[23:59:59]     DBLP filters by publication year only, so a window shorter than one whole calendar year cannot be answered.',
    '[00:00:01]   crossref: 2 results',
    "[00:00:01]   core: WARNING — no API key configured (credential 'core_api_key'); this repository will return 0 results",
    '[00:00:01]   ieee: ERROR - ieee is no longer available.',
    '[00:00:02] Total raw results: 2',
    '',
    'End Time: 2026-11-01T00:00:02Z',
    'Status: COMPLETED',
  ].join('\n');
  const names = new Map([['crossref', 'CrossRef'], ['dblp', 'DBLP'], ['hal', 'HAL'], ['core', 'CORE'], ['ieee', 'IEEE Xplore']]);
  const coverage = [
    { source: 'crossref', label: 'answered' },
    { source: 'dblp', label: 'could not answer this window' },
    { source: 'hal', label: 'answered' },
  ];
  const read = logForReading(written, (slug) => names.get(slug) ?? slug, coverage);
  const lines = read.text.split('\n');

  test('every time is local, the date carried over midnight UTC from the log\'s own start', () => {
    expect(lines[3]).toBe('Start Time: October 31, 2026 at 7:59:58 PM');
    expect(lines[5]).toBe('[7:59:58 PM] Querying repository: CrossRef');
    expect(lines[9]).toBe('[8:00:01 PM]   CrossRef: 2 results');
    expect(lines[14]).toBe('End Time: October 31, 2026 at 8:00:02 PM');
    expect(read.text).not.toMatch(/\d{4}-\d\d-\d\dT/);
    expect(read.note).toContain('The log file keeps its times in UTC');
  });

  test('sources by name, and a source that did not answer never with a count', () => {
    expect(lines[1]).toBe('Operation Type: Deep Sweep');
    expect(lines[4]).toContain("repositories=['CrossRef', 'DBLP', 'HAL']");
    expect(lines[7]).toBe('[7:59:59 PM]   DBLP: could not answer this window');
    expect(lines[8]).toBe('[7:59:59 PM]     DBLP filters by publication year only, so a window shorter than one whole calendar year cannot be answered.');
    expect(lines[10]).toBe("[8:00:01 PM]   CORE: WARNING — no API key configured (credential 'core_api_key'); it is recorded as not asked");
    expect(lines[11]).toBe('[8:00:01 PM]   IEEE Xplore: ERROR - ieee is no longer available.');
    expect(read.text).not.toContain('0 results');
  });

  test('a log with no start time keeps its times, and says they are UTC', () => {
    const bare = logForReading('[18:40:46] Querying repository: hal', (slug) => names.get(slug) ?? slug, []);
    expect(bare.text).toBe('[18:40:46] Querying repository: HAL');
    expect(bare.note).toBe('Times in brackets are in UTC, as the log file keeps them.');
  });
});

describe('the run log\'s count', () => {
  test('says the latest 60 when the log holds as many as it reads, and the number when it holds them all', () => {
    expect(runsCountWords(60)).toBe('the latest 60');
    expect(runsCountWords(23)).toBe('23');
  });
});

describe('words for a run', () => {
  test('a watch run is called by its watch, a search by its terms', () => {
    expect(runTitle({ query: 'a b', keywords: ['a', 'b'] }, 'Protein structure')).toBe('Protein structure');
    expect(runTitle({ query: 'a b', keywords: ['a', 'b'] })).toBe('a, b');
    expect(runTitle({ query: null, keywords: null })).toBe('A search with no terms recorded');
  });

  test('an interrupted run says why in words, never the stored token, and when in local time', () => {
    const sentence = interruptedSentence({ interrupted_reason: 'owner_dead', last_seen_at_utc: '2026-10-28T09:14:03Z' });
    expect(sentence).toBe('Interrupted: the process running it stopped; last seen working October 28, 2026 at 5:14 AM.');
    expect(interruptedSentence({ interrupted_reason: null, last_seen_at_utc: null }))
      .toBe('Interrupted: the reason was not recorded.');
  });
});

describe('a report or log that cannot be shown', () => {
  const run = (status: string, result_path: string | null = null) => ({ status, result_path, log_path: null });

  test('says why in the run\'s own terms, never as a route and a status code', () => {
    const cases = [
      absentRecordWords(run('cancelled'), 'report', false, 404, 'Report not found'),
      absentRecordWords(run('interrupted'), 'report', false, 404, null),
      absentRecordWords(run('failed'), 'log', false, 404, null),
      absentRecordWords(run('completed'), 'report', false, 404, null),
      absentRecordWords(run('running'), 'report', true, 404, null),
      absentRecordWords(run('completed', '/reports/run-149.md'), 'report', false, 404, null),
      absentRecordWords(run('completed'), 'report', false, 500, null),
    ];
    for (const words of cases) {
      expect(words).not.toMatch(/\/api\/|HTTP|404|500/);
    }
    expect(cases[0]).toBe('resmon recorded no report for this run: it was stopped before it finished. '
      + 'What each source did is above, and in the Search record tab.');
    expect(cases[1]).toContain('interrupted before it finished');
    expect(cases[2]).toBe('resmon recorded no log for this run: it failed before it finished.');
    expect(cases[3]).toBe('This run finished, and resmon recorded no report for it.');
    expect(cases[4]).toBe('The report is written when the run finishes.');
    expect(cases[5]).toBe('resmon wrote a report for this run, but the file is no longer at /reports/run-149.md.');
    expect(cases[6]).toMatch(/^The report could not be read\. The engine did not answer/);
  });
});

describe('what Restart does, said before it is pressed', () => {
  test('a search asked by hand: AI not recorded, and never emailed or delivered', () => {
    const facts = restartFacts({ parameters: JSON.stringify({ repositories: ['arxiv'], keywords: ['graph'] }), execution_type: 'deep_sweep', routine_id: null });
    expect(facts.ai).toMatch(/^Not recorded with this run\. Restart summarizes only if this run recorded an attempt to/);
    expect(facts.delivery).toMatch(/^None\./);
    expect(facts.watchId).toBeNull();
  });

  test('a watch\'s run is sent as its watch is set, and names the watch', () => {
    const facts = restartFacts({ parameters: '{}', execution_type: 'automated_sweep', routine_id: 7 });
    expect(facts.delivery).toContain('as its watch is set when the run finishes');
    expect(facts.watchId).toBe(7);
  });

  test('a watch\'s run whose watch was deleted is not called a search asked by hand', () => {
    const facts = restartFacts({ parameters: '{}', execution_type: 'automated_sweep', routine_id: null, ai_lanes: [] });
    expect(facts.delivery).toBe('None. The watch this run belonged to no longer exists, so a restarted run is not emailed or delivered.');
    expect(facts.delivery).not.toContain('by hand');
    expect(facts.watchId).toBeNull();
    expect(restartFacts({ parameters: '{}', execution_type: 'automated_sweep', routine_id: null }).delivery)
      .toMatch(/^None\. The watch this run belonged to no longer exists/);
  });

  test('a setting the parameters do record is read from them', () => {
    const facts = restartFacts({ parameters: JSON.stringify({ ai_enabled: true }), execution_type: 'deep_dive', routine_id: null });
    expect(facts.ai).toMatch(/^On when this run started, as its parameters record\./);
    expect(restartFacts({ parameters: 'not json', execution_type: 'deep_dive', routine_id: null }).ai).toMatch(/^Not recorded/);
  });
});

describe('deleting runs: the question first, then what came of it', () => {
  test('one run is named with its title, and the question says what goes and what stays', () => {
    expect(deleteQuestion([{ id: 12, status: 'completed', title: 'graph learning' }])).toBe(
      'Delete run 12, “graph learning”? resmon deletes its record, with its line in the run log, what each source answered, '
      + 'which papers it found, and where its report was sent. The papers stay in your collection, and its report and log '
      + 'files stay in the reports folder. This cannot be undone.',
    );
  });

  test('several are counted and numbered, and a run still running is named and left out', () => {
    const asked = deleteQuestion([
      { id: 3, status: 'completed', title: 'a' },
      { id: 5, status: 'running', title: 'b' },
      { id: 9, status: 'failed', title: 'c' },
    ]);
    expect(asked).toMatch(/^Delete 2 runs \(runs 3 and 9\)\? resmon deletes their records, with/);
    expect(asked).toContain('their report and log files stay in the reports folder.');
    expect(asked).toContain(' Run 5 is still running, and is not deleted. This cannot be undone.');
  });

  test('many runs are counted without every number', () => {
    const many = Array.from({ length: 7 }, (_, i) => ({ id: i + 1, status: 'completed', title: 't' }));
    expect(deleteQuestion(many)).toMatch(/^Delete 7 runs\? /);
  });

  test('nothing is asked when every chosen run is still running', () => {
    expect(deleteQuestion([{ id: 5, status: 'running', title: 'b' }, { id: 6, status: 'running', title: 'c' }])).toBeNull();
    expect(stillRunning([5, 6])).toBe('Runs 5 and 6 are still running. A run can be deleted once it has stopped.');
    expect(stillRunning([5])).toBe('Run 5 is still running. A run can be deleted once it has stopped.');
  });

  test('the sentence after says what went, and what was already gone', () => {
    expect(deletedSentence({ deleted: [12], gone: [], refused: [] })).toBe('Deleted run 12.');
    expect(deletedSentence({ deleted: [3, 9], gone: [4], refused: [] })).toBe('Deleted 2 runs. Run 4 was already gone.');
    expect(deletedSentence({ deleted: [], gone: [4, 7], refused: [] })).toBe('Runs 4 and 7 were already gone.');
    // A refusal alone is said in the engine's words beside this, never as a deletion.
    expect(deletedSentence({ deleted: [], gone: [], refused: [{ id: 5, reason: 'Run 5 is still running.' }] })).toBeNull();
  });

  test('run numbers read as a list, with the serial comma', () => {
    expect(runNumbers([4])).toBe('run 4');
    expect(runNumbers([4, 9])).toBe('runs 4 and 9');
    expect(runNumbers([4, 9, 12])).toBe('runs 4, 9, and 12');
  });
});

describe('a file name for several runs', () => {
  test('their numbers, in order and once each, while they fit', () => {
    expect(runsFileStem('resmon-bundle', [9, 3, 5, 3])).toBe('resmon-bundle-3-5-9');
  });

  test('past eight, how many and the first and last, so the name stays a name the system can save', () => {
    const ids = Array.from({ length: 60 }, (_, i) => 10_000 + i);
    const stem = runsFileStem('resmon-references', ids);
    expect(stem).toBe('resmon-references-60-runs-10000-to-10059');
    expect(new TextEncoder().encode(`${stem}.bib`).length).toBeLessThan(255);
  });
});

describe('the report, as Markdown', () => {
  test('headings, bold, lists, rules and line breaks become elements', () => {
    const { container } = render(<Markdown text={'# resmon Literature Report\n**Generated:** today  \n**Query:** graph\n\n---\n## 2026-10-28\n- **Authors:** Ada\n- **Abstract:** text'} />);
    expect(container.querySelector('h2')?.textContent).toBe('resmon Literature Report');
    expect(container.querySelector('h3')?.textContent).toBe('2026-10-28');
    expect([...container.querySelectorAll('strong')].map((s) => s.textContent)).toEqual(['Generated:', 'Query:', 'Authors:', 'Abstract:']);
    expect(container.querySelectorAll('br')).toHaveLength(1);
    expect(container.querySelectorAll('li')).toHaveLength(2);
    expect(container.querySelector('hr')).not.toBeNull();
  });

  test('markup in a title is shown as the characters it is, and only http(s) links are links', () => {
    const { container } = render(<Markdown text={'### <img src=x onerror=alert(1)> [click](javascript:alert(1)) [paper](https://example.org/p)'} />);
    expect(container.querySelector('img')).toBeNull();
    expect(container.textContent).toContain('<img src=x onerror=alert(1)>');
    const links = [...container.querySelectorAll('a')];
    expect(links.map((a) => a.getAttribute('href'))).toEqual(['https://example.org/p']);
    expect(container.textContent).toContain('[click](javascript:alert(1))');
  });
});
