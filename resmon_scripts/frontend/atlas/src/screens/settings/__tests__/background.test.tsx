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

describe('In the Background', () => {
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
    expect(screen.getByRole('button', { name: 'Install It Again' })).toBeInTheDocument();
  });

  test('installing it again is one install, registered: never a removal first, which stopped the service under the window', async () => {
    jest.spyOn(window, 'confirm').mockReturnValue(true);
    mount({ ...STATUS, runs: 'engine', app_available: true });
    fireEvent.click(await screen.findByRole('button', { name: 'Install It Again' }));
    await waitFor(() => expect(POST).toHaveBeenCalledTimes(1));
    expect(POST.mock.calls.map((c) => c[0])).toEqual(['/api/service/install']);
    expect(POST.mock.calls[0][1].body.register).toBe(true);
    expect(await screen.findByText(/Installed again/)).toBeInTheDocument();
  });

  test('from the service\'s own engine, says the window closes and opens again on the new service', async () => {
    jest.spyOn(window, 'confirm').mockReturnValue(true);
    mount({ ...STATUS, runs: 'engine', app_available: true });
    POST.mockImplementation(() => reply({ installed: true, unit_path: STATUS.unit_path, restarting: true }));
    fireEvent.click(await screen.findByRole('button', { name: 'Install It Again' }));
    expect(await screen.findByText(/This window closes, and resmon opens again on it/)).toBeInTheDocument();
  });

  test('says when macOS has turned resmon off in the background, and where to turn it on', async () => {
    mount({ ...STATUS, runs: 'app', app_available: true, loaded: false, blocked: true });
    expect(await screen.findByText(/macOS has turned resmon off in the background/)).toBeInTheDocument();
    expect(screen.getByText(/Login Items & Extensions, under Allow in the Background/)).toBeInTheDocument();
    // Not a Start button: launchd would refuse it until the person turns it on.
    expect(screen.queryByRole('button', { name: 'Start It' })).toBeNull();
  });

  test('installed and not running: says so, and Start It starts it, with no Terminal', async () => {
    jest.spyOn(window, 'confirm').mockReturnValue(true);
    mount({ ...STATUS, runs: 'app', app_available: true, loaded: false, blocked: false });
    expect(await screen.findByText(/installed, and macOS is not running it/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Start It' }));
    await waitFor(() => expect(POST).toHaveBeenCalledWith('/api/service/install', { body: { register: true } }));
  });

  test.each([
    ['a unit that already runs the app', { runs: 'app', app_available: true }],
    ['a unit that runs the app, loaded', { runs: 'app', app_available: true, loaded: true, blocked: false }],
    ['an engine the packaged app did not start (a checkout)', { runs: 'engine', app_available: false }],
    ['no unit at all', { installed: false, runs: null, app_available: true }],
  ])('says nothing about %s', async (_name, extra) => {
    mount({ ...STATUS, ...extra });
    await screen.findByText('In the Background');
    await waitFor(() => expect(GET).toHaveBeenCalledWith('/api/service/status'));
    await screen.findByText('Service');
    expect(screen.queryByText(/not the resmon app/)).toBeNull();
  });
});
