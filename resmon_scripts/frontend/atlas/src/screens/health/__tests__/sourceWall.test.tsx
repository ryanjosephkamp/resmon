/**
 * A Source Wall cell, read: the engine's words for what happened, and never
 * the identifier a zero's reason is stored under.
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { engine } from '../../../api/client';
import { ZERO_REASONS } from '../../../api/zeroReasonVocabulary';
import { ZERO_LABELS } from '../../runs/model';
import type { Wall } from '../model';
import { SourceWall } from '../SourceWall';

jest.mock('../../../api/client', () => ({ ...jest.requireActual('../../../api/client'), engine: jest.fn() }));

// jsdom has no `Response`; `answer` reads only `data` and `error` on success.
const reply = (data: unknown) => Promise.resolve({ data, error: undefined, response: {} as Response });

/** One run, and one source for each reason the engine can record, labeled in the engine's words. */
function wall(): Wall {
  return {
    notes: [], states: [], totals: {},
    verdict: { level: 'attention', headline: 'Something did not answer.', detail: [] },
    window: { requested: 12, returned: 1, max: 50, runs_available: 1 },
    state_legend: [],
    runs: [{ execution_id: 145, execution_type: 'automated_sweep', label: 'Watch — daily', status: 'completed',
      started_at: '2026-10-29T16:00:00Z', ended_at: '2026-10-29T16:01:00Z' }],
    sources: ZERO_REASONS.map((reason) => ({
      slug: reason, name: `Source ${reason.length}`, in_catalog: true, latest_known_state: null, counts: {},
      cells: [{
        execution_id: 145, state: 'could_not_be_asked', label: ZERO_LABELS[reason] ?? 'zero, reason not recorded',
        note: 'The engine’s sentence about what happened.', result_count: 0, status: 'ok', zero_reason: reason,
        partial: false, outcome_recorded: true, in_selection: true,
      }],
    })),
  };
}

test.each(ZERO_REASONS.map((reason, row) => [reason, row]))('a cell recorded with %s is read in words, never by its code', async (reason, row) => {
  const GET = jest.fn((route: string) => reply(route === '/api/coverage/source-wall' ? wall() : { counts: { alarms: 0 } }));
  (engine as jest.Mock).mockReturnValue({ GET });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(<QueryClientProvider client={client}><MemoryRouter><SourceWall /></MemoryRouter></QueryClientProvider>);
  const cells = await screen.findAllByRole('button', { name: /Watch — daily/ });
  fireEvent.click(cells[row]!);
  const reading = await screen.findByRole('heading', { level: 2 });
  const section = reading.closest('section')!;
  expect(section.textContent).toContain(ZERO_LABELS[reason] ?? 'zero, reason not recorded');
  expect(section.textContent).not.toContain(reason);
  expect(section.textContent).not.toContain('Recorded reason');
});

if (!('PointerEvent' in window)) {
  class PointerEventShim extends MouseEvent {}
  Object.defineProperty(window, 'PointerEvent', { value: PointerEventShim, configurable: true });
}

/** Two sources over two runs: one answered with papers, one failed then answered with none. */
function small(): Wall {
  const run = (id: number, at: string) => ({ execution_id: id, execution_type: 'automated_sweep', label: 'Perovskite films',
    status: 'completed', started_at: at, ended_at: at });
  const cell = (id: number, state: string, label: string, count: number | null, note: string) => ({
    execution_id: id, state, label, note, result_count: count, status: 'ok', zero_reason: null, partial: false,
    outcome_recorded: true, in_selection: true,
  });
  return {
    notes: [], states: [], totals: {}, state_legend: [],
    verdict: { level: 'attention', headline: 'Crossref failed.', detail: [] },
    window: { requested: 12, returned: 2, max: 50, runs_available: 2 },
    runs: [run(145, '2026-10-29T16:00:00Z'), run(146, '2026-10-30T16:00:00Z')],
    sources: [
      { slug: 'arxiv', name: 'arXiv', in_catalog: true, latest_known_state: null, counts: {},
        cells: [cell(145, 'answered', 'Answered', 1204, 'arXiv returned 1,204 records.'), cell(146, 'answered', 'Answered', 3, 'arXiv returned 3 records.')] },
      { slug: 'crossref', name: 'Crossref', in_catalog: true, latest_known_state: null, counts: {},
        cells: [cell(145, 'failed', 'Failed', 0, 'Crossref answered HTTP 500.'), cell(146, 'answered_empty', 'Answered, zero', 0, 'Crossref had nothing new.')] },
    ],
  } as unknown as Wall;
}

function wallPage() {
  const GET = jest.fn((route: string) => reply(route === '/api/coverage/source-wall' ? small() : { counts: { alarms: 0 } }));
  (engine as jest.Mock).mockReturnValue({ GET });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(<QueryClientProvider client={client}><MemoryRouter><SourceWall /></MemoryRouter></QueryClientProvider>);
}

test('a cell\'s tip is the engine\'s label, its count in full, and its sentence; a failure carries no count', async () => {
  wallPage();
  const answered = await screen.findByRole('button', { name: /^arXiv · Perovskite films, .*: Answered, 1,204 papers\. arXiv returned/ });
  fireEvent.pointerEnter(answered, { clientX: 300, clientY: 200 });
  const tip = screen.getByRole('tooltip');
  expect(tip.querySelector('.chart-tip-value')?.textContent).toBe('Answered');
  expect(tip.querySelector('.chart-tip-lines')?.textContent).toBe('1,204 papers');
  expect(tip).toHaveTextContent('arXiv returned 1,204 records.');
  expect(tip.querySelector('.chart-tip-opens')?.textContent).toBe('Opens its reading below the wall');
  fireEvent.pointerLeave(answered);
  const failed = screen.getByRole('button', { name: /^Crossref .*: Failed\./ });
  fireEvent.pointerEnter(failed, { clientX: 300, clientY: 240 });
  expect(screen.getByRole('tooltip').querySelector('.chart-tip-lines')).toBeNull();
  // The click opens the cell's reading, which is what the tip said it would.
  fireEvent.click(failed);
  expect((await screen.findByRole('heading', { level: 2 })).closest('section')).toHaveTextContent('Crossref answered HTTP 500.');
});

test('the wall is one stop for the keyboard: Tab reaches the first source\'s newest run, and the arrow keys move a cell', async () => {
  wallPage();
  const cells = await screen.findAllByRole('button', { name: /Perovskite films/ });
  const stops = cells.filter((c) => c.tabIndex === 0);
  expect(stops).toHaveLength(1);
  expect(stops[0]).toHaveAccessibleName(/^arXiv .*Answered, 3 papers/);
  act(() => stops[0]!.focus());
  expect(screen.getByRole('tooltip')).toHaveTextContent('3 papers');
  fireEvent.keyDown(stops[0]!, { key: 'ArrowDown' });
  expect(document.activeElement).toHaveAccessibleName(/^Crossref .*Answered, zero/);
  fireEvent.keyDown(document.activeElement!, { key: 'ArrowLeft' });
  expect(document.activeElement).toHaveAccessibleName(/^Crossref .*Failed/);
  expect(screen.getByRole('tooltip')).toHaveTextContent('Crossref answered HTTP 500.');
  expect(cells.filter((c) => c.tabIndex === 0)).toEqual([document.activeElement]);
});

test('a run\'s head opens the run, and its tip says so', async () => {
  wallPage();
  const head = await screen.findByRole('link', { name: /^Perovskite films: Run 146/ });
  expect(head).toHaveAttribute('href', '/runs/146');
  fireEvent.pointerEnter(head, { clientX: 400, clientY: 120 });
  expect(screen.getByRole('tooltip').querySelector('.chart-tip-opens')?.textContent).toBe('Opens run 146');
});

test('the wall links the guide\'s page on what each source outcome means', async () => {
  wallPage();
  const link = await screen.findByRole('link', { name: 'What a Source’s Answer Means' });
  expect(link).toHaveAttribute('href', 'https://ryanjosephkamp.github.io/resmon/guide/source-answers/');
  expect(link).toHaveAttribute('target', '_blank');
});
