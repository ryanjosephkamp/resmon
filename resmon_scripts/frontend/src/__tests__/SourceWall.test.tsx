/**
 * The source wall renders what the backend classified, and nothing else.
 *
 * Every state on this screen is decided in `source_wall.py`. The renderer's
 * whole job is to draw the state it was handed and to keep the five apart for
 * a person looking at them — which is why the assertions below are about
 * marks and labels rather than about classification. A renderer that
 * classifies is the defect this feature was told not to repeat.
 *
 * The one property worth more than the rest: a cell whose outcome resmon did
 * not observe must not be drawn as either a tick or a cross, and must not be
 * counted into either tally.
 *
 * What these cases cannot see: whether the five marks are actually
 * distinguishable to a person. They assert that each state carries a mark and
 * a word that no other state carries, which is a necessary condition for that
 * and not the thing itself.
 */

import React from 'react';
import { fireEvent, render, screen, within } from '@testing-library/react';
import SourceWall from '../components/SourceWall/SourceWall';
import {
  SourceWallGrid, STATE_MARKS, WALL_STATE_ORDER, WallCell, WallState,
} from '../api/sourceWall';

/** The legend the backend serves. The renderer holds no copy of these words. */
const LEGEND = [
  { state: 'answered', label: 'answered', meaning: 'Replied with records.' },
  { state: 'answered_empty', label: 'answered, zero', meaning: 'A quiet field.' },
  { state: 'could_not_be_asked', label: 'could not be asked', meaning: 'Never asked.' },
  { state: 'failed', label: 'failed', meaning: 'The exchange broke.' },
  { state: 'not_recorded', label: 'outcome not recorded', meaning: 'A hole in the record.' },
  { state: 'not_selected', label: 'not asked on this run', meaning: 'A choice on the run.' },
];

function cell(executionId: number, state: string, extra: Record<string, unknown> = {}): WallCell {
  return {
    execution_id: executionId,
    // The served value, cast at the boundary exactly as it arrives over HTTP:
    // the point of several of these cases is a state the union does not hold.
    state: state as WallState,
    label: `${state} label`,
    note: `${state} note for run ${executionId}`,
    result_count: state === 'answered' ? 4 : 0,
    status: 'ok',
    zero_reason: null,
    partial: false,
    outcome_recorded: state !== 'not_recorded',
    in_selection: true,
    ...extra,
  };
}

function grid(overrides: Partial<SourceWallGrid> = {}): SourceWallGrid {
  return {
    runs: [
      { execution_id: 1, execution_type: 'deep_sweep', status: 'completed',
        started_at: '2026-10-01T09:00:00', ended_at: null, label: 'Deep Sweep' },
      { execution_id: 2, execution_type: 'deep_sweep', status: 'completed',
        started_at: '2026-10-02T09:00:00', ended_at: null, label: 'Deep Sweep' },
    ],
    sources: [
      { slug: 'arxiv', name: 'arXiv', in_catalog: true, latest_known_state: 'failed',
        counts: { answered: 1, answered_empty: 0, answered_in_part: 0, could_not_be_asked: 0, failed: 1, not_recorded: 0, not_selected: 0 },
        cells: [cell(1, 'answered'), cell(2, 'failed')] },
      { slug: 'doaj', name: 'DOAJ', in_catalog: true, latest_known_state: 'answered_empty',
        counts: { answered: 0, answered_empty: 1, answered_in_part: 0, could_not_be_asked: 0, failed: 0, not_recorded: 1, not_selected: 0 },
        cells: [cell(1, 'not_recorded'), cell(2, 'answered_empty')] },
      { slug: 'ieee', name: 'IEEE Xplore', in_catalog: true, latest_known_state: 'could_not_be_asked',
        counts: { answered: 0, answered_empty: 0, answered_in_part: 0, could_not_be_asked: 2, failed: 0, not_recorded: 0, not_selected: 0 },
        cells: [cell(1, 'could_not_be_asked'), cell(2, 'could_not_be_asked')] },
    ],
    states: [...WALL_STATE_ORDER],
    state_legend: LEGEND,
    totals: {
      answered: 1, answered_empty: 1, answered_in_part: 0, could_not_be_asked: 2,
      failed: 1, not_recorded: 1, not_selected: 0,
    },
    verdict: { level: 'attention', headline: 'arXiv has stopped answering.', detail: ['Because it did.'] },
    window: { requested: 12, returned: 2, max: 50, runs_available: 2 },
    notes: ['Every cell is one source’s recorded answer to one run.'],
    ...overrides,
  };
}

describe('the source wall', () => {
  test('the verdict is the first thing on the screen, in the backend’s words', () => {
    render(<SourceWall grid={grid()} />);

    const verdict = screen.getByTestId('source-wall-verdict');
    expect(verdict).toHaveTextContent('arXiv has stopped answering.');
    expect(verdict).toHaveTextContent('Because it did.');
    // A count is not a verdict. The headline says what happened.
    expect(verdict.textContent).not.toMatch(/^\d/);
  });

  test('one cell per source per run, each naming its source, run and outcome', () => {
    render(<SourceWall grid={grid()} />);

    const cells = screen.getAllByTestId('source-wall-cell');
    expect(cells).toHaveLength(6);

    const first = screen.getByRole('button', {
      name: /arXiv.*Deep Sweep.*answered label/s,
    });
    expect(first).toHaveAttribute('data-state', 'answered');
    expect(first).toHaveAttribute('title', 'answered note for run 1');
  });

  test('each of the seven states carries a mark no other state carries', () => {
    render(<SourceWall grid={grid()} />);

    const marks = WALL_STATE_ORDER.map((state) => STATE_MARKS[state]);
    expect(new Set(marks).size).toBe(WALL_STATE_ORDER.length);
    expect(WALL_STATE_ORDER).toHaveLength(7);

    // The legend is drawn from the list the backend served, so a state the
    // backend adds cannot reach the grid without reaching the key beside it.
    const legend = screen.getByTestId('source-wall-legend');
    for (const entry of LEGEND) {
      expect(within(legend).getByText(entry.label)).toBeInTheDocument();
      expect(within(legend).getAllByText(STATE_MARKS[entry.state as WallState]).length)
        .toBeGreaterThan(0);
    }
  });

  test('the legend words are the backend\u2019s, not the renderer\u2019s', () => {
    // The whole fix direction: the backend owns this vocabulary. A renderer
    // that kept its own copy of it is what put a tick on sources that had
    // never been asked, and a legend is that copy wearing a different hat.
    const renamed = grid({
      state_legend: LEGEND.map((e) => (
        e.state === 'answered_empty' ? { ...e, label: 'renamed by the backend' } : e
      )),
    });
    render(<SourceWall grid={renamed} />);

    const legend = screen.getByTestId('source-wall-legend');
    expect(within(legend).getByText('renamed by the backend')).toBeInTheDocument();
    expect(within(legend).queryByText('answered, zero')).toBeNull();
    expect(within(legend).queryByText('answered, nothing new')).toBeNull();
  });

  test('a source that was never asked on a run is a different mark from one with no outcome', () => {
    const silences = grid();
    silences.sources[1].cells[0] = cell(1, 'not_selected', {
      outcome_recorded: false, in_selection: false, label: 'not asked on this run',
      note: 'This source is not in this run\u2019s saved selection, so it was not asked.',
    });
    render(<SourceWall grid={silences} />);

    const notAsked = screen.getByRole('button', { name: /DOAJ.*not asked on this run/s });
    const noOutcome = screen.getByRole('button', { name: /DOAJ.*answered_empty label/s });
    expect(notAsked).toHaveAttribute('data-state', 'not_selected');
    expect(notAsked.textContent).not.toBe(noOutcome.textContent);
    expect(notAsked.textContent).not.toBe(STATE_MARKS.not_recorded);
  });

  test('an unobserved cell is drawn as neither a tick nor a cross', () => {
    render(<SourceWall grid={grid()} />);

    const unobserved = screen.getByRole('button', { name: /DOAJ.*not_recorded label/s });
    expect(unobserved).toHaveAttribute('data-state', 'not_recorded');
    expect(unobserved).toHaveAttribute('data-recorded', 'false');
    // The two marks that mean a verdict.
    expect(unobserved.textContent).not.toContain(STATE_MARKS.answered);
    expect(unobserved.textContent).not.toContain(STATE_MARKS.failed);
  });

  test('clicking a cell reads out the backend’s own sentence for it', () => {
    render(<SourceWall grid={grid()} />);

    fireEvent.click(screen.getByRole('button', { name: /arXiv.*failed label/s }));

    const detail = screen.getByTestId('source-wall-detail');
    expect(detail).toHaveTextContent('failed note for run 2');
    expect(detail).toHaveTextContent('arXiv');
  });

  test('a window shorter than the corpus says how much it is showing', () => {
    render(<SourceWall grid={grid({
      window: { requested: 12, returned: 2, max: 50, runs_available: 137 },
    })} />);

    expect(screen.getByTestId('source-wall-window'))
      .toHaveTextContent('2 of 137');
  });

  test('an empty corpus says so and draws no grid', () => {
    render(<SourceWall grid={grid({
      runs: [], sources: [],
      totals: {
        answered: 0, answered_empty: 0, answered_in_part: 0, could_not_be_asked: 0,
        failed: 0, not_recorded: 0, not_selected: 0,
      },
      verdict: { level: 'empty', headline: 'No runs are recorded yet, so there is nothing to check.', detail: [] },
      window: { requested: 12, returned: 0, max: 50, runs_available: 0 },
    })} />);

    expect(screen.getByTestId('source-wall-verdict'))
      .toHaveTextContent('No runs are recorded yet');
    expect(screen.queryByTestId('source-wall-cell')).toBeNull();
  });

  test('a state the renderer has never heard of is drawn as not recorded', () => {
    // The backend adds a sixth state and an older renderer receives it. It
    // must not fall through to a tick: an unknown verdict is no verdict.
    const unknown = grid();
    unknown.sources[0].cells[0] = cell(1, 'teleported');
    render(<SourceWall grid={unknown} />);

    const drawn = screen.getAllByTestId('source-wall-cell')[0];
    expect(drawn).toHaveAttribute('data-state', 'not_recorded');
  });

  test('hostile text from a source slug renders as text', () => {
    const hostile = grid();
    hostile.sources[0].name = '<img src=x onerror=bad()>';
    const { container } = render(<SourceWall grid={hostile} />);

    expect(container.querySelector('img, script')).toBeNull();
    expect(screen.getAllByText('<img src=x onerror=bad()>').length).toBeGreaterThan(0);
  });
});
