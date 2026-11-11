/**
 * Settings › Links: each choice goes to the engine whole, at once; the
 * default browser is named when the system names it; window or tab is a
 * choice only on macOS, and only for resmon's browser; and the address
 * field's search is chosen from the engine's list.
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { engine } from '../../../api/client';
import { bridge, isMac } from '../../../bridge';
import { DEFAULT_WEB_LINKS, SEARCH_NAMES, WEB_LINKS_KEY, type WebLinkSettings } from '../../../shell/webLinks';
import { Links } from '../Links';

jest.mock('../../../api/client', () => ({ ...jest.requireActual('../../../api/client'), engine: jest.fn() }));
jest.mock('../../../bridge', () => ({ bridge: jest.fn(), isMac: jest.fn() }));

const reply = (data: unknown) => Promise.resolve({ data, error: undefined, response: {} as Response });

describe('Settings › Links', () => {
  let PUT: jest.Mock;
  const sent = () => PUT.mock.calls.filter((c) => c[0] === '/api/web-links').map((c) => c[1].body as WebLinkSettings);

  function mount(stored: WebLinkSettings = DEFAULT_WEB_LINKS, { mac = true, browser = 'Firefox' as string | null } = {}) {
    PUT = jest.fn((_path: string, init: { body: unknown }) => reply(init.body));
    (engine as jest.Mock).mockReturnValue({ GET: jest.fn(() => new Promise(() => {})), PUT });
    (bridge as jest.Mock).mockReturnValue({ getBackendPort: () => '51000', defaultBrowser: () => Promise.resolve(browser) });
    (isMac as jest.Mock).mockReturnValue(mac);
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    client.setQueryData(WEB_LINKS_KEY, stored);
    return render(<QueryClientProvider client={client}><Links /></QueryClientProvider>);
  }
  afterEach(() => { jest.resetAllMocks(); });

  test("opens links in resmon's browser, in a window, searching with DuckDuckGo, by default", async () => {
    mount();
    expect(screen.getByRole('radio', { name: 'resmon’s Browser' })).toBeChecked();
    expect(screen.getByRole('radio', { name: 'A New Window' })).toBeChecked();
    expect(screen.getByRole('combobox', { name: /^Search from the address field with/ })).toHaveValue('duckduckgo');
    expect(await screen.findByRole('radio', { name: 'Your Default Browser (Firefox)' })).not.toBeChecked();
  });

  test('your own browser is chosen, sent whole, and said; window or tab then has nothing to choose', async () => {
    mount();
    fireEvent.click(await screen.findByRole('radio', { name: 'Your Default Browser (Firefox)' }));
    await waitFor(() => expect(sent()).toEqual([{ open_in: 'browser', new: 'window', search: 'duckduckgo' }]));
    expect(screen.getByRole('status')).toHaveTextContent('Web links open in Firefox.');
    expect(screen.getByRole('radio', { name: 'A New Tab' })).toBeDisabled();
  });

  test('a tab of resmon’s browser is a choice on macOS', async () => {
    mount();
    fireEvent.click(screen.getByRole('radio', { name: 'A New Tab' }));
    await waitFor(() => expect(sent()).toEqual([{ open_in: 'resmon', new: 'tab', search: 'duckduckgo' }]));
    expect(screen.getByRole('status')).toHaveTextContent('Each link opens in a new tab of resmon’s browser.');
  });

  test('elsewhere there are no window tabs, so there is nothing to choose', () => {
    mount(DEFAULT_WEB_LINKS, { mac: false });
    expect(screen.queryByRole('radio', { name: 'A New Tab' })).toBeNull();
    expect(screen.getByRole('radio', { name: 'resmon’s Browser' })).toBeChecked();
  });

  test('a system that names no default browser is still offered it', async () => {
    mount(DEFAULT_WEB_LINKS, { browser: null });
    expect(await screen.findByRole('radio', { name: 'Your Default Browser' })).not.toBeChecked();
  });

  test('the search is chosen from every search the engine offers', async () => {
    mount();
    const select = screen.getByRole('combobox', { name: /^Search from the address field with/ });
    expect([...(select as HTMLSelectElement).options].map((o) => o.textContent)).toEqual(Object.values(SEARCH_NAMES));
    fireEvent.change(select, { target: { value: 'google_scholar' } });
    await waitFor(() => expect(sent()).toEqual([{ open_in: 'resmon', new: 'window', search: 'google_scholar' }]));
    expect(screen.getByRole('status')).toHaveTextContent('The address field searches with Google Scholar.');
  });
});
