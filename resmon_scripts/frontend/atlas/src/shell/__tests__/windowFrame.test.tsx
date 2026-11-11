import { act, render } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, useNavigate } from 'react-router-dom';
import type { WindowState } from '../../bridge';
import { WindowFrame, applyWindowState, windowTitle } from '../WindowFrame';

// The theme the app shows, as the appearance provider would give it.
let shownTheme = 'dark';
jest.mock('../../theme/appearance', () => ({
  ...jest.requireActual('../../theme/appearance'),
  useAppearance: () => ({ shown: { theme: shownTheme, accent: null } }),
}));

describe('a window is named by the screen it shows', () => {
  test('the screens at a fixed address, by their own names', () => {
    expect(windowTitle('/today', true)).toBe('Today');
    expect(windowTitle('/search', true)).toBe('Search › Collection');
    expect(windowTitle('/settings/ai', true)).toBe('Settings › AI');
  });

  test('a screen with an id, by what it shows; anything else, by the app', () => {
    expect(windowTitle('/runs', true)).toBe('Runs');
    expect(windowTitle('/runs/162', true)).toBe('Run 162');
    expect(windowTitle('/papers/88', true)).toBe('Paper');
    expect(windowTitle('/watches/4', true)).toBe('Watch');
    expect(windowTitle('/watches/4/edit', true)).toBe('Edit Watch');
    expect(windowTitle('/watches/people/9', true)).toBe('Watches › Person');
    expect(windowTitle('/nowhere', true)).toBe('resmon');
  });

  test('off macOS the system frame shows the title alone, so the app\'s name follows', () => {
    expect(windowTitle('/today', false)).toBe('Today — resmon');
    expect(windowTitle('/nowhere', false)).toBe('resmon');
  });
});

test('off macOS the window\'s title carries the app\'s name, as the platform the preload names says', () => {
  const host = window as unknown as { resmonAPI?: unknown };
  const before = host.resmonAPI;
  host.resmonAPI = { getBackendPort: () => '51234', getApiToken: () => 'token', platform: 'linux' };
  try {
    const view = render(
      <QueryClientProvider client={new QueryClient()}><MemoryRouter initialEntries={['/runs']}><WindowFrame /></MemoryRouter></QueryClientProvider>,
    );
    expect(document.title).toBe('Runs — resmon');
    view.unmount();
  } finally {
    host.resmonAPI = before;
  }
});

test('the theme and accent are read again when the window comes to the front', () => {
  const client = new QueryClient();
  const invalidate = jest.spyOn(client, 'invalidateQueries').mockResolvedValue(undefined);
  const view = render(
    <QueryClientProvider client={client}><MemoryRouter><WindowFrame /></MemoryRouter></QueryClientProvider>,
  );
  act(() => { window.dispatchEvent(new Event('focus')); });
  expect(invalidate).toHaveBeenCalledWith({ queryKey: ['appearance'] });
  expect(invalidate).toHaveBeenCalledWith({ queryKey: ['top-bar'] });
  view.unmount();
  invalidate.mockClear();
  act(() => { window.dispatchEvent(new Event('focus')); });
  expect(invalidate).not.toHaveBeenCalled();
});

test('the look is read again at once when another window changes it, and not while this one\'s own change is on its way', () => {
  const host = window as unknown as { resmonAPI?: unknown };
  const before = host.resmonAPI;
  const told = new Set<() => void>();
  host.resmonAPI = {
    getBackendPort: () => '51234',
    getApiToken: () => 'token',
    onAppearanceChanged: (callback: () => void) => { told.add(callback); return () => told.delete(callback); },
  };
  try {
    const client = new QueryClient();
    const invalidate = jest.spyOn(client, 'invalidateQueries').mockResolvedValue(undefined);
    const mutating = jest.spyOn(client, 'isMutating').mockReturnValue(0);
    const view = render(
      <QueryClientProvider client={client}><MemoryRouter><WindowFrame /></MemoryRouter></QueryClientProvider>,
    );
    expect(told.size).toBe(1);
    act(() => { for (const callback of told) callback(); });
    expect(invalidate.mock.calls.map(([filters]) => filters)).toEqual([{ queryKey: ['appearance'] }, { queryKey: ['top-bar'] }, { queryKey: ['web-links'] }]);
    invalidate.mockClear();
    mutating.mockReturnValue(1);
    act(() => { for (const callback of told) callback(); });
    expect(invalidate).not.toHaveBeenCalled();
    view.unmount();
    expect(told.size).toBe(0);
  } finally {
    host.resmonAPI = before;
  }
});

describe('room for macOS\'s tab bar', () => {
  test('set on the root while the windows are in tabs, and taken away after', () => {
    const root = document.createElement('html');
    applyWindowState({ collection: null, tabStrip: 28 }, root);
    expect(root.dataset.tabStrip).toBe('28');
    expect(root.style.getPropertyValue('--tab-strip')).toBe('28px');
    applyWindowState({ collection: null, tabStrip: 0 }, root);
    expect(root.dataset.tabStrip).toBeUndefined();
    expect(root.style.getPropertyValue('--tab-strip')).toBe('');
    applyWindowState(undefined, root);
    expect(root.dataset.tabStrip).toBeUndefined();
  });

  test('read from the main process before the first paint, and kept current as the windows change', () => {
    const host = window as unknown as { resmonAPI?: unknown };
    const before = host.resmonAPI;
    let listener: ((state: WindowState) => void) | null = null;
    const themes: string[] = [];
    host.resmonAPI = {
      getBackendPort: () => '51234',
      getApiToken: () => 'token',
      platform: 'darwin',
      setThemeSource: (theme: string) => themes.push(theme),
      windowState: () => ({ collection: null, tabStrip: 28 }),
      onWindowState: (callback: (state: WindowState) => void) => {
        listener = callback;
        return () => { listener = null; };
      },
    };
    let go: ((to: string) => void) | null = null;
    function Navigator() {
      const navigate = useNavigate();
      go = (to) => { void navigate(to); };
      return null;
    }
    try {
      const client = new QueryClient();
      const view = render(
        <QueryClientProvider client={client}>
          <MemoryRouter initialEntries={['/today']}><WindowFrame /><Navigator /></MemoryRouter>
        </QueryClientProvider>,
      );
      expect(document.documentElement.dataset.tabStrip).toBe('28');
      expect(document.title).toBe('Today');
      // The system's parts of the window (the tab bar) are told the app's theme.
      expect(themes).toEqual(['dark']);
      shownTheme = 'light';
      act(() => go?.('/runs/7'));
      expect(document.title).toBe('Run 7');
      expect(themes).toEqual(['dark', 'light']);
      act(() => listener?.({ collection: null, tabStrip: 0 }));
      expect(document.documentElement.dataset.tabStrip).toBeUndefined();
      view.unmount();
      expect(listener).toBeNull();
    } finally {
      host.resmonAPI = before;
      shownTheme = 'dark';
      applyWindowState(undefined);
    }
  });
});


test('the native title follows Back and Forward even when Chromium restores an older page title', () => {
  const host = window as unknown as { resmonAPI?: unknown };
  const before = host.resmonAPI;
  const titles: string[] = [];
  host.resmonAPI = {
    getBackendPort: () => '51234', getApiToken: () => 'token', platform: 'darwin',
    setWindowTitle: (title: string) => titles.push(title),
  };
  let go: ((delta: number) => void) | null = null;
  function Navigator() {
    const navigate = useNavigate();
    go = (delta) => { void navigate(delta); };
    return null;
  }
  try {
    const view = render(
      <QueryClientProvider client={new QueryClient()}>
        <MemoryRouter initialEntries={['/today', '/settings']} initialIndex={1}>
          <WindowFrame /><Navigator />
        </MemoryRouter>
      </QueryClientProvider>,
    );
    act(() => go?.(-1));
    act(() => go?.(1));
    expect(titles).toEqual(['Settings › Appearance', 'Today', 'Settings › Appearance']);
    expect(document.title).toBe('Settings › Appearance');
    view.unmount();
  } finally {
    host.resmonAPI = before;
  }
});
