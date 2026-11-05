/**
 * The command palette's Go to rows and the Keyboard shortcuts sheet follow
 * the top bar as arranged: in the order of ⌘1 to ⌘7, the bar's sections from
 * the left and then the hidden ones, each hidden one still listed, with its
 * key, and marked as out of the bar.
 */
import { createRef, type ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { AppearanceProvider, APPEARANCE_KEY } from '../../theme/appearance';
import { CommandPalette } from '../CommandPalette';
import { ShortcutsSheet } from '../ShortcutsSheet';
import type { TopBar } from '../topBar';
import { TOP_BAR_KEY } from '../useTopBar';

// The engine never answers: what is drawn is what the cache was given.
jest.mock('../../api/client', () => ({
  ...jest.requireActual('../../api/client'),
  engine: () => ({ GET: () => new Promise(() => {}), PUT: () => new Promise(() => {}) }),
}));

beforeAll(() => {
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    value: (query: string) => ({
      matches: false, media: query, onchange: null,
      addEventListener: () => {}, removeEventListener: () => {},
      addListener: () => {}, removeListener: () => {}, dispatchEvent: () => false,
    }),
  });
  // jsdom has no modal dialogs.
  HTMLDialogElement.prototype.showModal = function showModal(this: HTMLDialogElement) { this.setAttribute('open', ''); };
  HTMLDialogElement.prototype.close = function close(this: HTMLDialogElement) { this.removeAttribute('open'); };
});

const ARRANGED: TopBar = {
  order: ['search', 'today', 'library', 'runs', 'watches', 'health', 'ask'],
  hidden: ['today', 'health'],
  start: '/search/saved',
  lockup: null,
};

function wrap(children: ReactNode) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  client.setQueryData(TOP_BAR_KEY, ARRANGED);
  client.setQueryData(APPEARANCE_KEY, { theme: 'light', accent: null, run_monitor: true });
  return render(
    <QueryClientProvider client={client}>
      <AppearanceProvider><MemoryRouter>{children}</MemoryRouter></AppearanceProvider>
    </QueryClientProvider>,
  );
}

test('the sheet names ⌘1 to ⌘7 by the bar\'s order, the hidden sections last and marked', () => {
  wrap(<ShortcutsSheet open={false} onClose={() => {}} dialog={createRef<HTMLDialogElement>()} mac />);
  const words = (n: number) => document.querySelector(`[data-shortcut="section-${n}"] dt`)?.textContent;
  expect([1, 2, 3, 4, 5, 6, 7].map(words)).toEqual([
    'Search', 'Library', 'Runs', 'Watches', 'Ask', 'Todaynot in the top bar', 'Healthnot in the top bar',
  ]);
  expect(document.querySelector('[data-shortcut="section-6"] kbd')?.textContent).toBe('⌘6');
  expect(document.querySelector('[data-shortcut="settings"] dt')?.textContent).toBe('Settings');
});

test('the palette goes to every section in the keys\' order, the hidden ones too, and Settings after them', () => {
  wrap(<CommandPalette open onClose={() => {}} onRun={() => {}} dialog={createRef<HTMLDialogElement>()} mac />);
  const options = screen.getAllByRole('option');
  const goTo = options.filter((o) => ['Search', 'Library', 'Runs', 'Watches', 'Ask', 'Today', 'Health', 'Settings']
    .some((name) => o.textContent?.startsWith(name)));
  expect(goTo.map((o) => o.querySelector('.palette-label')?.textContent)).toEqual(
    ['Search', 'Library', 'Runs', 'Watches', 'Ask', 'Today', 'Health', 'Settings'],
  );
  const today = goTo[5]!;
  expect(within(today).getByText('Not in the top bar')).toBeInTheDocument();
  expect(today.querySelector('kbd')?.textContent).toBe('⌘6');
  expect(within(goTo[0]!).queryByText('Not in the top bar')).toBeNull();
  expect(goTo[0]!.querySelector('kbd')?.textContent).toBe('⌘1');
  // Settings › Top bar is a place the palette opens by name.
  expect(screen.getByRole('option', { name: /Arrange the top bar/ })).toBeInTheDocument();
});
