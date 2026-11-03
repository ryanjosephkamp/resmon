import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { engine } from '../../../api/client';
import { Background } from '../Background';

jest.mock('../../../api/client', () => ({ ...jest.requireActual('../../../api/client'), engine: jest.fn() }));
jest.mock('../../../bridge', () => ({ bridge: () => ({ getBackendPort: () => '51000' }) }));

// jsdom has no `Response`; `answer` reads only `data` and `error` on success.
const reply = (data: unknown) => Promise.resolve({ data, error: undefined, response: {} as Response });

const STATUS = { installed: true, unit_path: '/Users/ada/Library/LaunchAgents/com.resmon.daemon.plist', platform: 'darwin' };
const DAEMON = {
  lock_present: true, running: true, pid: 4, port: 8742, version: '1.0.0', started_at: '2026-11-03T12:00:00+00:00',
  lock_pid: 4, lock_port: 8742, lock_version: '1.0.0', error: null,
};
const HEALTH = { status: 'ok', pid: 9, version: '1.0.0', started_at: '2026-11-03T12:00:00+00:00' };
const LIMITS = { max_concurrent_executions: 2, routine_fire_queue_limit: 10 };

describe('In the background', () => {
  let GET: jest.Mock;
  let POST: jest.Mock;

  function mount(status: Record<string, unknown>) {
    GET = jest.fn((path: string) => reply(
      path === '/api/service/status' ? status
        : path === '/api/service/daemon-status' ? DAEMON
          : path === '/api/health' ? HEALTH : LIMITS));
    POST = jest.fn(() => reply({ installed: true, unit_path: STATUS.unit_path }));
    (engine as jest.Mock).mockReturnValue({ GET, POST, PUT: jest.fn() });
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    return render(<QueryClientProvider client={client}><Background /></QueryClientProvider>);
  }
  afterEach(() => { jest.resetAllMocks(); });

  test('says so, in one line, when the installed unit starts the bare engine and the app could run it', async () => {
    mount({ ...STATUS, runs: 'engine', app_available: true });
    expect(await screen.findByText(/starts the engine on its own, not the resmon app/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Install it again' })).toBeInTheDocument();
  });

  test('installing it again removes the unit and writes it anew, registered', async () => {
    jest.spyOn(window, 'confirm').mockReturnValue(true);
    mount({ ...STATUS, runs: 'engine', app_available: true });
    fireEvent.click(await screen.findByRole('button', { name: 'Install it again' }));
    await waitFor(() => expect(POST).toHaveBeenCalledTimes(2));
    expect(POST.mock.calls.map((c) => c[0])).toEqual(['/api/service/uninstall', '/api/service/install']);
    expect(POST.mock.calls.every((c) => c[1].body.register === true)).toBe(true);
  });

  test.each([
    ['a unit that already runs the app', { runs: 'app', app_available: true }],
    ['an engine the packaged app did not start (a checkout)', { runs: 'engine', app_available: false }],
    ['no unit at all', { installed: false, runs: null, app_available: true }],
  ])('says nothing about %s', async (_name, extra) => {
    mount({ ...STATUS, ...extra });
    await screen.findByText('In the background');
    await waitFor(() => expect(GET).toHaveBeenCalledWith('/api/service/status'));
    await screen.findByText('Service');
    expect(screen.queryByText(/not the resmon app/)).toBeNull();
  });
});
