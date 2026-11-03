/**
 * A Source wall cell, read: the engine's words for what happened, and never
 * the identifier a zero's reason is stored under.
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen } from '@testing-library/react';
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
