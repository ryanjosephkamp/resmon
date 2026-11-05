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
    expect(windowTitle('/search', true)).toBe('Search › Your collection');
    expect(windowTitle('/settings/ai', true)).toBe('Settings › AI');
  });

  test('a screen with an id, by what it shows; anything else, by the app', () => {
    expect(windowTitle('/runs/162', true)).toBe('Run 162');
    expect(windowTitle('/papers/88', true)).toBe('Paper');
    expect(windowTitle('/watches/4', true)).toBe('Watch');
    expect(windowTitle('/watches/4/edit', true)).toBe('Edit watch');
    expect(windowTitle('/watches/people/9', true)).toBe('Watches › Person');
    expect(windowTitle('/nowhere', true)).toBe('resmon');
  });

  test('off macOS the system frame shows the title alone, so the app\'s name follows', () => {
    expect(windowTitle('/today', false)).toBe('Today — resmon');
    expect(windowTitle('/nowhere', false)).toBe('resmon');
  });
});

test('the theme and accent are read again when the window comes to the front', () => {
  const client = new QueryClient();
  const invalidate = jest.spyOn(client, 'invalidateQueries').mockResolvedValue(undefined);
  const view = render(
    <QueryClientProvider client={client}><MemoryRouter><WindowFrame /></MemoryRouter></QueryClientProvider>,
  );
  act(() => { window.dispatchEvent(new Event('focus')); });
  expect(invalidate).toHaveBeenCalledWith({ queryKey: ['appearance'] });
  view.unmount();
  invalidate.mockClear();
  act(() => { window.dispatchEvent(new Event('focus')); });
  expect(invalidate).not.toHaveBeenCalled();
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
