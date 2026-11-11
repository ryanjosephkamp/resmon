/**
 * The run monitor's mark and words: which state it draws, what it says
 * beside the mark, a quiet run's orbit, and today's lines in its panel.
 */
import { render } from '@testing-library/react';
import { markState, monitorWords, orbitsOf, todayWords } from '../RunMonitor';
import { RunMark } from '../RunMark';
import type { ActiveRun } from '../active';
import type { RunRow } from '../model';

const at = (second: number) => new Date(Date.UTC(2026, 10, 4, 18, 0, second)).toISOString().replace('.000', '');

const running = (id: number, beat: number, extra: Partial<ActiveRun> = {}): ActiveRun => ({
  id, execution_type: 'deep_sweep', routine_id: null, saved_configuration_id: null, query: 'q', keywords: ['q'],
  repositories: ['arxiv', 'crossref'], start_time: at(0), current_stage: 'querying', restarted_from: null, request_id: null,
  events: [
    { type: 'stage', stage: 'querying', timestamp: at(0) },
    { type: 'repo_start', repository: 'arxiv', timestamp: at(0) },
    { type: 'repo_done', repository: 'arxiv', result_count: 3, timestamp: at(1) },
    { type: 'repo_start', repository: 'crossref', timestamp: at(1) },
    { type: 'query_progress', repository: 'crossref', phase: 'searching', elapsed: 2, timestamp: at(beat) },
  ],
  ...extra,
});

describe('which mark the bar draws', () => {
  test.each([
    [0, 0, false, 'idle'], [2, 0, false, 'running'], [0, 1, false, 'failed'], [2, 1, false, 'runfail'],
    // Open, the panel shows the failure, and the red leaves the bar.
    [0, 1, true, 'idle'], [2, 1, true, 'running'],
  ] as const)('%i running, %i unseen failures, open %p: %s', (runs, failed, open, state) => {
    expect(markState(runs, failed, open)).toBe(state);
  });

  test('says how many, in full in a wide window and as a count in a narrow one', () => {
    expect(monitorWords(0, 0)).toBeNull();
    expect(monitorWords(2, 0)).toEqual({ full: '2 running', lead: '2 running', failed: '', count: '2' });
    expect(monitorWords(0, 1)).toEqual({ full: '1 failed', lead: '1 failed', failed: '', count: '1' });
    expect(monitorWords(2, 1)).toEqual({ full: '2 running · 1 failed', lead: '2 running', failed: ' · 1 failed', count: '2' });
  });
});

describe('an orbit for each running run', () => {
  test('its arc is the share of sources finished, and it stops when the run has said nothing for fifteen seconds', () => {
    const now = Date.parse(at(20));
    expect(orbitsOf([running(1, 18), running(2, 4)], now)).toEqual([
      { share: 0.5, stalled: false },
      { share: 0.5, stalled: true },
    ]);
  });

  test('a run past its sources is never stalled: storing the papers sends no heartbeat, however long it takes', () => {
    const storing = running(3, 4);
    storing.events = [...storing.events,
      { type: 'repo_done', repository: 'crossref', result_count: 5, timestamp: at(5) },
      { type: 'stage', stage: 'dedup', message: 'Deduplicating 5000 results...', timestamp: at(5) }];
    expect(orbitsOf([storing], Date.parse(at(59)))).toEqual([{ share: 1, stalled: false }]);
  });

  test('three at most', () => {
    expect(orbitsOf([1, 2, 3, 4].map((id) => running(id, 19)), Date.parse(at(20)))).toHaveLength(3);
  });

  test('the mark draws one orbit a run, a gray one when stalled, and the ring that spreads once a run ends', () => {
    const { container, rerender } = render(<RunMark state="running" orbits={[{ share: 0.5, stalled: false }, { share: 0.2, stalled: true }]} />);
    expect(container.querySelectorAll('.rm-arc')).toHaveLength(2);
    expect(container.querySelectorAll('.rm-spin.stalled')).toHaveLength(1);
    expect(container.querySelector('.rm-pulse')).toBeNull();
    rerender(<RunMark state="idle" pulse={1} />);
    expect(container.querySelector('.rm-pulse')).not.toBeNull();
    rerender(<RunMark state="failed" />);
    expect(container.querySelectorAll('.rm-fault')).toHaveLength(2);
  });
});

describe('today’s runs, in the panel', () => {
  const row = (status: string, found: number | null, fresh: number | null) => ({
    status, total_results: found, new_results: fresh, result_count: found, new_result_count: fresh,
    coverage: { counts: { answered: status === 'failed' ? 0 : 2, non_answer: 0, in_part: 0 }, total: 2 },
  }) as unknown as RunRow;

  test.each([
    [row('completed', 118, 9), 'ok', '118 found, 9 new · 2 of 2 sources answered'],
    [row('completed', 4, 0), 'zero', 'Nothing new · 2 of 2 sources answered'],
    [row('failed', 0, 0), 'fail', 'Failed · 0 of 2 sources answered'],
    [row('cancelled', null, null), 'other', 'Stopped · 2 of 2 sources answered'],
  ] as const)('%#: %s', (run, outcome, said) => {
    expect(todayWords(run)).toEqual({ outcome, said });
  });

  test('a failed run says which source rate-limited it, so a limit does not read as an outage', () => {
    const failed = {
      status: 'failed', total_results: 0, new_results: 0, result_count: 0, new_result_count: 0,
      coverage: { counts: { answered: 0, non_answer: 1, in_part: 0 }, total: 1,
        sources: [{ source: 'arxiv', category: 'non_answer', rate_limited: true, cooldown_until_utc: null }] },
    } as unknown as RunRow;
    expect(todayWords(failed)).toEqual({ outcome: 'fail', said: 'Failed · 0 of 1 source answered, 1 rate-limited' });
  });
});
