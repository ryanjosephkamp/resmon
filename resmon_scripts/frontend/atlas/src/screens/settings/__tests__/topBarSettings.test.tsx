/**
 * Settings › Top Bar: each change goes to the engine whole, at once; the
 * arrows move a section and keep the focus; a switch hides one in its place;
 * the start page and the resmon name's page are chosen from the pages the
 * engine accepts; and Reset puts the default back.
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { engine } from '../../../api/client';
import { DEFAULT_TOP_BAR, START_PAGES, type TopBar } from '../../../shell/topBar';
import { TOP_BAR_KEY } from '../../../shell/useTopBar';
import { AppearanceProvider, APPEARANCE_KEY } from '../../../theme/appearance';
import { TopBarSettings } from '../TopBar';

jest.mock('../../../api/client', () => ({ ...jest.requireActual('../../../api/client'), engine: jest.fn() }));
jest.mock('../../../bridge', () => ({
  bridge: () => ({ getBackendPort: () => '51000', platform: 'darwin' }),
  isMac: () => true,
  systemName: () => 'macOS',
}));

const reply = (data: unknown) => Promise.resolve({ data, error: undefined, response: {} as Response });

beforeAll(() => {
  // jsdom has no PointerEvent; a mouse event carries the same button and position.
  if (!('PointerEvent' in window)) {
    class PointerEvent extends MouseEvent {
      readonly pointerId: number;
      constructor(type: string, init: PointerEventInit = {}) { super(type, init); this.pointerId = init.pointerId ?? 0; }
    }
    Object.defineProperty(window, 'PointerEvent', { configurable: true, value: PointerEvent });
  }
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    value: (query: string) => ({
      matches: false, media: query, onchange: null,
      addEventListener: () => {}, removeEventListener: () => {},
      addListener: () => {}, removeListener: () => {}, dispatchEvent: () => false,
    }),
  });
});

describe('Settings › Top Bar', () => {
  let PUT: jest.Mock;
  let client: QueryClient;
  /** The bodies sent to /api/top-bar, in order. */
  const sent = () => PUT.mock.calls.filter((c) => c[0] === '/api/top-bar').map((c) => c[1].body as TopBar);

  function mount(stored: TopBar = DEFAULT_TOP_BAR) {
    PUT = jest.fn((_path: string, init: { body: unknown }) => reply(init.body));
    (engine as jest.Mock).mockReturnValue({ GET: jest.fn(() => new Promise(() => {})), PUT });
    client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    client.setQueryData(TOP_BAR_KEY, stored);
    client.setQueryData(APPEARANCE_KEY, { theme: 'light', accent: null, run_monitor: true });
    return render(
      <QueryClientProvider client={client}><AppearanceProvider><TopBarSettings /></AppearanceProvider></QueryClientProvider>,
    );
  }
  const rows = () => screen.getAllByRole('listitem').map((row) => row.getAttribute('data-section'));
  const keyOf = (section: string) => within(document.querySelector(`[data-section="${section}"]`) as HTMLElement).getByText(/^⌘\d$/).textContent;
  afterEach(() => { jest.resetAllMocks(); });

  test('lists the sections in the bar\'s order, each with the key that opens it', () => {
    mount();
    expect(rows()).toEqual(['today', 'watches', 'search', 'runs', 'library', 'ask', 'health']);
    expect(keyOf('runs')).toBe('⌘4');
    expect(keyOf('health')).toBe('⌘7');
    expect(screen.getByRole('button', { name: 'Reset the Top Bar' })).toBeDisabled();
  });

  test('an arrow moves a section one place, sends the whole arrangement, and keeps the focus on that arrow', async () => {
    mount();
    const down = screen.getByRole('button', { name: 'Move Watches Down' });
    down.focus();
    fireEvent.click(down);
    expect(rows()).toEqual(['today', 'search', 'watches', 'runs', 'library', 'ask', 'health']);
    expect(screen.getByRole('button', { name: 'Move Watches Down' })).toHaveFocus();
    expect(keyOf('watches')).toBe('⌘3');
    expect(screen.getByRole('status')).toHaveTextContent('Watches is now 3 of 7, on ⌘3.');
    await waitFor(() => expect(sent()).toHaveLength(1));
    expect(sent()[0]).toEqual({ ...DEFAULT_TOP_BAR, order: ['today', 'search', 'watches', 'runs', 'library', 'ask', 'health'] });

    // At the top, Up does nothing and says it cannot.
    const up = screen.getByRole('button', { name: 'Move Today Up' });
    expect(up).toHaveAttribute('aria-disabled', 'true');
    fireEvent.click(up);
    expect(sent()).toHaveLength(1);
    expect(screen.getByRole('button', { name: 'Reset the Top Bar' })).toBeEnabled();
  });

  test('a switch hides a section in its place, its key moves past the shown ones, and Settings says so', async () => {
    mount();
    const watches = screen.getByRole('switch', { name: 'Show Watches in the top bar' });
    expect(watches).toHaveAttribute('aria-checked', 'true');
    fireEvent.click(watches);
    expect(screen.getByRole('switch', { name: 'Show Watches in the top bar' })).toHaveAttribute('aria-checked', 'false');
    expect(rows()[1]).toBe('watches');
    expect(keyOf('watches')).toBe('⌘7');
    expect(keyOf('search')).toBe('⌘2');
    expect(screen.getByRole('status')).toHaveTextContent('Watches is out of the top bar. Its shortcut and the command palette still open it.');
    await waitFor(() => expect(sent()).toHaveLength(1));
    expect(sent()[0]).toEqual({ ...DEFAULT_TOP_BAR, hidden: ['watches'] });
    expect(screen.getByText(/Hiding a section only takes it out of the bar/)).toBeInTheDocument();
  });

  test('every section can be hidden, and Settings stays reachable', async () => {
    mount();
    for (const name of ['Today', 'Watches', 'Search', 'Runs', 'Library', 'Ask', 'Health']) {
      fireEvent.click(screen.getByRole('switch', { name: `Show ${name} in the top bar` }));
    }
    await waitFor(() => expect(sent()).toHaveLength(7));
    expect(sent()[6]!.hidden).toEqual(['today', 'watches', 'search', 'runs', 'library', 'ask', 'health']);
    expect(screen.getByText(/The collection the window shows stays beside the\s+resmon name, Settings keeps its place at the bar’s right end, and ⌘, opens\s+Settings from anywhere/)).toBeInTheDocument();
  });

  test('the start page and the resmon name offer every page the engine accepts, under their sections', async () => {
    mount({ ...DEFAULT_TOP_BAR, hidden: ['health'] });
    const start = screen.getByRole('combobox', { name: /Start page/ });
    const values = [...start.querySelectorAll('option')].map((o) => o.getAttribute('value'));
    expect(values).toEqual(START_PAGES.map((p) => p.path));
    expect([...start.querySelectorAll('optgroup')].map((g) => g.getAttribute('label')))
      .toEqual(['Today', 'Watches', 'Search', 'Runs', 'Library', 'Ask', 'Health (not in the top bar)']);
    fireEvent.change(start, { target: { value: '/search/saved' } });
    // Drawn at once, not put back for a tick and then changed.
    expect(start).toHaveValue('/search/saved');
    expect(screen.getByRole('status')).toHaveTextContent('A launch, a new window, and the resmon name open Search › Saved.');
    const name = screen.getByRole('combobox', { name: /The resmon name/ });
    expect(within(name).getByRole('option', { name: 'The start page (Search › Saved)' })).toBeInTheDocument();
    fireEvent.change(name, { target: { value: '/health/watchdog' } });
    await waitFor(() => expect(sent()).toHaveLength(2));
    expect(sent()[1]).toEqual({ ...DEFAULT_TOP_BAR, hidden: ['health'], start: '/search/saved', lockup: '/health/watchdog' });
    fireEvent.change(name, { target: { value: '' } });
    await waitFor(() => expect(sent()).toHaveLength(3));
    expect(sent()[2]!.lockup).toBeNull();
  });

  test('Reset puts the default arrangement back', async () => {
    mount({ order: ['health', 'ask', 'library', 'runs', 'search', 'watches', 'today'], hidden: ['runs'], start: '/ask', lockup: '/health' });
    fireEvent.click(screen.getByRole('button', { name: 'Reset the Top Bar' }));
    await waitFor(() => expect(sent()).toHaveLength(1));
    expect(sent()[0]).toEqual(DEFAULT_TOP_BAR);
    expect(rows()).toEqual(['today', 'watches', 'search', 'runs', 'library', 'ask', 'health']);
    expect(screen.getByRole('button', { name: 'Reset the Top Bar' })).toBeDisabled();
  });

  test('a refusal reads the engine\'s own arrangement back and says so', async () => {
    mount();
    const GET = jest.fn(() => reply(DEFAULT_TOP_BAR));
    PUT.mockImplementation(() => Promise.resolve({ data: undefined, error: { detail: 'no' }, response: { status: 422, statusText: 'Unprocessable' } as Response }));
    (engine as jest.Mock).mockReturnValue({ GET, PUT });
    fireEvent.click(screen.getByRole('button', { name: 'Move Today Down' }));
    expect(rows()[0]).toBe('watches');
    expect(await screen.findByRole('alert')).toHaveTextContent(/The engine did not store that/);
    await waitFor(() => expect(rows()[0]).toBe('today'));
    await act(async () => { await Promise.resolve(); });
  });

  test('dragging a row by its handle moves it to where it is let go', async () => {
    mount();
    const list = screen.getByRole('list');
    // jsdom lays nothing out: give each row a 46-pixel place, as the stylesheet does.
    list.querySelectorAll('li').forEach((row, index) => {
      row.getBoundingClientRect = () => ({ top: index * 46, height: 46, bottom: index * 46 + 46, left: 0, right: 500, width: 500, x: 0, y: index * 46, toJSON: () => ({}) });
    });
    const handle = list.querySelector('[data-section="today"] .bar-order-handle') as HTMLElement;
    handle.setPointerCapture = () => {};
    fireEvent.pointerDown(handle, { button: 0, pointerId: 1, clientY: 20 });
    expect(list).toHaveAttribute('data-dragging');
    fireEvent.pointerMove(handle, { pointerId: 1, clientY: 20 + 46 * 2 + 10 });
    // The rows it passed open its place, before anything is stored.
    expect((list.querySelector('[data-section="search"]') as HTMLElement).style.transform).toBe('translateY(-46px)');
    // Each row's key is the one it will have once the row is let go there.
    expect(keyOf('today')).toBe('⌘3');
    expect(keyOf('search')).toBe('⌘2');
    expect(sent()).toHaveLength(0);
    fireEvent.pointerUp(handle, { pointerId: 1, clientY: 20 + 46 * 2 + 10 });
    expect(list).not.toHaveAttribute('data-dragging');
    expect(rows()).toEqual(['watches', 'search', 'today', 'runs', 'library', 'ask', 'health']);
    await waitFor(() => expect(sent()).toHaveLength(1));

    // Escape during a drag puts the row back.
    const runs = list.querySelector('[data-section="runs"] .bar-order-handle') as HTMLElement;
    runs.setPointerCapture = () => {};
    list.querySelectorAll('li').forEach((row, index) => {
      row.getBoundingClientRect = () => ({ top: index * 46, height: 46, bottom: index * 46 + 46, left: 0, right: 500, width: 500, x: 0, y: index * 46, toJSON: () => ({}) });
    });
    fireEvent.pointerDown(runs, { button: 0, pointerId: 2, clientY: 160 });
    fireEvent.pointerMove(runs, { pointerId: 2, clientY: 20 });
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(list).not.toHaveAttribute('data-dragging');
    fireEvent.pointerUp(runs, { pointerId: 2, clientY: 20 });
    expect(rows()).toEqual(['watches', 'search', 'today', 'runs', 'library', 'ask', 'health']);
    expect(sent()).toHaveLength(1);
  });
});
