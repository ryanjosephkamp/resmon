/**
 * A running run's page: the heartbeat folded into each source, the words it
 * is said in, the stage, and the marks.
 */
import { render } from '@testing-library/react';
import { askingWords, elapsedWords, liveMarkState, liveStage, sourcesFinished, waitWords } from '../live';
import { LivePanel } from '../LivePanel';
import { liveSources, type ProgressEvent } from '../model';

const at = (second: number) => new Date(Date.UTC(2026, 10, 4, 18, 0, second)).toISOString();

describe('the run’s clock', () => {
  test.each([
    [0, '0 s'], [42.7, '42 s'], [60, '1 min 00 s'], [247, '4 min 07 s'], [3_599, '59 min 59 s'], [3_720, '1 h 02 min'],
    [-3, '0 s'],
  ])('%p seconds read as %s', (seconds, words) => {
    expect(elapsedWords(seconds)).toBe(words);
  });
});

describe('a source being asked, from its heartbeat', () => {
  const events: ProgressEvent[] = [
    { type: 'repo_start', repository: 'arxiv', timestamp: at(0) },
    { type: 'query_progress', repository: 'arxiv', phase: 'search_start', timestamp: at(0) },
    { type: 'query_progress', repository: 'arxiv', phase: 'searching', elapsed: 2.0, requests: 1, retries: 0, timestamp: at(2) },
    {
      type: 'query_progress', repository: 'arxiv', phase: 'searching', elapsed: 42.4, requests: 3, retries: 1,
      waiting: { kind: 'pace', seconds: 2.2 }, timestamp: at(42),
    },
  ];

  test('takes the latest heartbeat: its time, requests, retries, and wait', () => {
    const [arxiv] = liveSources(['arxiv'], events);
    expect(arxiv?.state).toBe('asking');
    expect(arxiv?.activity).toEqual({
      elapsed: 42.4, requests: 3, retries: 1, waiting: { kind: 'pace', seconds: 2.2 }, at: at(42), received: null,
    });
    const words = askingWords(arxiv!, 'arXiv', Date.parse(at(43)));
    expect(words).toEqual({ time: '42 s', detail: '3 requests, 1 retry · waiting 3 s for arXiv’s pace', quiet: null });
  });

  test('between heartbeats the time and the wait move on from when the latest arrived, by one interval at most', () => {
    const received = Date.parse(at(42));
    const [arxiv] = liveSources(['arxiv'], events.map((event) => ({ ...event, received })));
    expect(askingWords(arxiv!, 'arXiv', received + 1_000)).toMatchObject({ time: '43 s', detail: '3 requests, 1 retry · waiting 2 s for arXiv’s pace' });
    // No heartbeat for longer than one interval: the time stops where the engine's word allows, and waits.
    expect(askingWords(arxiv!, 'arXiv', received + 2_000).time).toBe('44 s');
    expect(askingWords(arxiv!, 'arXiv', received + 9_000).time).toBe('44 s');
  });

  test('says nothing it was not told: before the first heartbeat there is no time and no count', () => {
    const [arxiv] = liveSources(['arxiv'], events.slice(0, 2));
    expect(askingWords(arxiv!, 'arXiv', Date.parse(at(1)))).toEqual({ time: null, detail: null, quiet: null });
  });

  test('once the source has answered, its heartbeat is gone from it', () => {
    const [arxiv] = liveSources(['arxiv'], [...events, { type: 'repo_done', repository: 'arxiv', result_count: 3 }]);
    expect(arxiv?.state).toBe('answered');
    expect(arxiv?.activity).toBeUndefined();
    expect(askingWords(arxiv!, 'arXiv', Date.now())).toEqual({ time: null, detail: null, quiet: null });
  });

  test('a source the engine has said nothing about for fifteen seconds says so, rather than look busy', () => {
    const [arxiv] = liveSources(['arxiv'], events);
    expect(askingWords(arxiv!, 'arXiv', Date.parse(at(56))).quiet).toBeNull();
    expect(askingWords(arxiv!, 'arXiv', Date.parse(at(60))).quiet).toBe('No word from the engine about it for 18 s.');
  });

  test.each([
    [{ kind: 'pace', seconds: 0.2 }, 'waiting 1 s for bioRxiv’s pace'],
    [{ kind: 'cooldown', seconds: 29.5 }, 'waiting 30 s, as bioRxiv asked'],
    [{ kind: 'retry', seconds: 4 }, 'waiting 4 s before asking again'],
    [{ kind: 'retry', seconds: 299.6 }, 'waiting 5 min 00 s before asking again'],
    [{ kind: 'cooldown', seconds: 90 }, 'waiting 1 min 30 s, as bioRxiv asked'],
    [{ kind: 'something new', seconds: 4 }, 'waiting 4 s'],
  ])('a wait of %p reads as %s', (waiting, words) => {
    expect(waitWords(waiting, 'bioRxiv')).toBe(words);
  });

  test('a heartbeat with plural counts', () => {
    const [arxiv] = liveSources(['arxiv'], [
      { type: 'repo_start', repository: 'arxiv', timestamp: at(0) },
      { type: 'query_progress', repository: 'arxiv', phase: 'searching', elapsed: 9, requests: 1, retries: 2, timestamp: at(9) },
    ]);
    expect(askingWords(arxiv!, 'arXiv', Date.parse(at(9))).detail).toBe('1 request, 2 retries');
  });
});

describe('the stage, and what it counts', () => {
  test('before the first stage, the run is starting', () => {
    expect(liveStage([{ type: 'execution_start' }])).toEqual({ stage: null, words: 'Starting', count: null });
  });

  test('each stage in words, with the papers it has done where the engine counts them', () => {
    const events: ProgressEvent[] = [
      { type: 'stage', stage: 'querying', message: 'Querying repositories...' },
    ];
    expect(liveStage(events).words).toBe('Asking the sources');
    events.push({ type: 'stage', stage: 'dedup', message: 'Deduplicating 40 results...' });
    expect(liveStage(events)).toEqual({ stage: 'dedup', words: 'Storing the papers in your collection', count: null });
    events.push({ type: 'stage', stage: 'linking' }, { type: 'link_progress', processed: 10, total: 40 });
    expect(liveStage(events)).toEqual({ stage: 'linking', words: 'Linking the papers to this run', count: '10 of 40 papers' });
    events.push({ type: 'ai_progress', stage: 'embedding', processed: 0, total: 40 });
    expect(liveStage(events).words).toBe('Embedding the papers, so they can be found by meaning');
    events.push({ type: 'stage', stage: 'reporting' }, { type: 'stage', stage: 'summarizing' },
      { type: 'ai_progress', completed: 3, total: 20, message: 'Summarizing document 3/20...' });
    expect(liveStage(events)).toEqual({ stage: 'summarizing', words: 'Summarizing the papers', count: '3 of 20 papers' });
    events.push({ type: 'stage', stage: 'finalizing' });
    expect(liveStage(events)).toEqual({ stage: 'finalizing', words: 'Finishing', count: null });
  });

  test('a person watch checking retractions says what it does, in the engine’s words', () => {
    expect(liveStage([{ type: 'stage', stage: 'querying', message: "Checking Ada Fixture's papers for retractions..." }]).words)
      .toBe("Checking Ada Fixture's papers for retractions");
  });

  test('a stage this build has no words for is said as the engine said it', () => {
    expect(liveStage([{ type: 'stage', stage: 'weaving', message: 'Weaving the papers...' }]).words).toBe('Weaving the papers');
  });

  test('the bar counts the sources that have finished, whatever each answered', () => {
    const live = liveSources(['arxiv', 'dblp', 'zenodo', 'hal'], [
      { type: 'repo_start', repository: 'arxiv' },
      { type: 'repo_done', repository: 'arxiv', result_count: 4 },
      { type: 'repo_start', repository: 'dblp' },
      { type: 'repo_error', repository: 'dblp', error: 'HTTP 500' },
      { type: 'repo_start', repository: 'zenodo' },
    ]);
    expect(sourcesFinished(live)).toBe(2);
  });
});

describe('the Source wall’s marks, for a run still going', () => {
  test.each([
    ['pending', null, null, 'not_yet_asked'],
    ['asking', null, null, 'asking'],
    ['answered', 4, null, 'answered'],
    ['answered', 0, 'answered_empty', 'answered_empty'],
    ['answered', 0, 'rights_filtered', 'answered'],
    ['in_part', 3, 'answered_in_part', 'answered_in_part'],
    ['no_answer', 0, 'upstream_failure', 'failed'],
    ['no_answer', 0, 'window_unanswerable', 'could_not_be_asked'],
    ['not_queried', 0, 'missing_key', 'could_not_be_asked'],
    ['error', null, null, 'failed'],
    ['cancelled', null, null, 'not_recorded'],
    ['not_reached', null, null, 'not_recorded'],
    ['not_recorded', null, null, 'not_recorded'],
  ] as const)('%s (%p, %p) is drawn as %s', (state, count, reason, mark) => {
    expect(liveMarkState({ slug: 'x', state, count, reason, note: '' })).toBe(mark);
  });

  test('the panel draws each source in its mark, and the time and the wait beside one being asked', () => {
    const live = liveSources(['arxiv', 'zenodo'], [
      { type: 'repo_start', repository: 'arxiv', timestamp: at(0) },
      { type: 'query_progress', repository: 'arxiv', phase: 'searching', elapsed: 4, requests: 2, retries: 0, waiting: { kind: 'retry', seconds: 3.6 }, timestamp: at(4) },
    ]);
    const { container } = render(<LivePanel sources={live} names={new Map([['arxiv', 'arXiv'], ['zenodo', 'Zenodo']])} now={Date.parse(at(5))} />);
    const rows = [...container.querySelectorAll('.live-row')];
    expect(rows.map((row) => row.querySelector('.wall-mark')?.getAttribute('data-mark'))).toEqual(['asking', 'waiting']);
    expect(rows[0]?.querySelector('.src-label')?.textContent).toBe('asking · 4 s');
    expect(rows[0]?.querySelector('[data-live="detail"]')?.textContent).toBe('2 requests · waiting 4 s before asking again');
    expect(rows[1]?.querySelector('.src-label')?.textContent).toBe('waiting');
  });
});
