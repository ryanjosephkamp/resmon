/**
 * Another window changed the runs going now (`relayToOtherWindows`): this one
 * reads them again at once, with one listener however many screens show them,
 * and none once no screen does.
 */
import { act, render, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { engine } from '../../../api/client';
import { useActiveRuns, type ActiveRuns } from '../active';

jest.mock('../../../api/client', () => ({ ...jest.requireActual('../../../api/client'), engine: jest.fn() }));

const IDLE: ActiveRuns = {
  active_ids: [], running: [], waiting: [], max_concurrent: 3, queue_limit: 16, failed_unseen: [], seen_at: null,
  newest_run_id: null, last_ended_at: null,
};
const reply = (data: unknown) => Promise.resolve({ data, error: undefined, response: { url: 'http://127.0.0.1:1/x', status: 200 } as Response });

function Reader() {
  useActiveRuns();
  return null;
}

test('a message from another window reads the runs again now, through one listener that goes when the last reader does', async () => {
  const listeners = new Set<() => void>();
  const host = window as unknown as { resmonAPI?: unknown };
  const before = host.resmonAPI;
  host.resmonAPI = {
    getBackendPort: () => '51234',
    getApiToken: () => 'token',
    onRunsChanged: (callback: () => void) => { listeners.add(callback); return () => listeners.delete(callback); },
  };
  const GET = jest.fn(() => reply(IDLE));
  (engine as jest.Mock).mockReturnValue({ GET });
  try {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const view = render(<QueryClientProvider client={client}><Reader /><Reader /></QueryClientProvider>);
    await waitFor(() => expect(GET).toHaveBeenCalledTimes(1));
    expect(listeners.size).toBe(1);
    act(() => { for (const listener of listeners) listener(); });
    await waitFor(() => expect(GET).toHaveBeenCalledTimes(2));
    view.unmount();
    expect(listeners.size).toBe(0);
  } finally {
    host.resmonAPI = before;
  }
});
