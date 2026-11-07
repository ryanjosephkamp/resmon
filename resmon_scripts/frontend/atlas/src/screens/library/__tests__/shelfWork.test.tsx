import { act, render, renderHook, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { Folder } from '../../settings/LibrarySettings';
import { FIND_PAUSE_MS, useFindDraft } from '../findDraft';
import { notRemovedWords, readEveryPage, readsMore, removeEach, removedWords } from '../galleryModel';
import type { LibraryStatus } from '../libraryApi';

test('Select all stops at a page that fails, instead of asking for it again and again', async () => {
  // A failed page answers with the pages it had and `hasNextPage` still true, unless it is asked to throw.
  const failing = jest.fn(async () => { throw new Error('the engine did not answer'); });
  await expect(readEveryPage(true, failing, () => true)).rejects.toThrow('the engine did not answer');
  expect(failing).toHaveBeenCalledTimes(1);
  // It stops at the last page.
  let left = 3;
  const pages = jest.fn(async () => ({ hasNextPage: (left -= 1) > 0 }));
  expect(await readEveryPage(true, pages, () => true)).toEqual({ hasNextPage: false });
  expect(pages).toHaveBeenCalledTimes(3);
  // And when the shelf is gone, even if the engine keeps saying there is more.
  let alive = true;
  const endless = jest.fn(async () => { if (endless.mock.calls.length >= 2) alive = false; return { hasNextPage: true }; });
  await readEveryPage(true, endless, () => alive);
  expect(endless).toHaveBeenCalledTimes(2);
  expect(await readEveryPage(false, failing, () => true)).toBeNull();
});

test('the gallery asks for its next page by itself only until an ask fails', () => {
  const near = { has: true, reading: false, failed: false, last: 9, rows: 10, ahead: 3 };
  expect(readsMore(near)).toBe(true);
  expect(readsMore({ ...near, failed: true })).toBe(false);
  expect(readsMore({ ...near, reading: true })).toBe(false);
  expect(readsMore({ ...near, last: 2 })).toBe(false);
  expect(readsMore({ ...near, has: false })).toBe(false);
});

test('a removal of several carries on past one that fails, and says which stayed and why', async () => {
  const items = ['a', 'b', 'c', 'd'];
  const { went, stayed } = await removeEach(items, async (item) => {
    if (item === 'b') throw new Error('it changed outside resmon');
    return item.toUpperCase();
  }, (item) => `File ${item}`, (error) => (error as Error).message);
  expect(went).toEqual(['A', 'C', 'D']);
  expect(stayed).toEqual([{ name: 'File b', why: 'it changed outside resmon' }]);
  expect(removedWords(['A', 'C', 'D'], 'Your files', stayed)).toEqual({
    lead: 'Removed 3 from Your files.', name: null, rest: ' This one was not removed: “File b” (it changed outside resmon).',
  });
  expect(removedWords(['A'], 'To read', stayed).rest).toBe(' from To read. This one was not removed: “File b” (it changed outside resmon).');
  expect(removedWords(['A'], 'To read')).toEqual({ lead: 'Removed ', name: 'A', rest: ' from To read.' });
  const five = Array.from({ length: 5 }, (_, n) => ({ name: `F${n}`, why: 'gone' }));
  expect(notRemovedWords(five)).toBe('These 5 were not removed: “F0” (gone); “F1” (gone); “F2” (gone); and 2 others.');
});

test('the find field keeps what is typed, a trailing space included, when its own pause writes the address', () => {
  jest.useFakeTimers();
  try {
    const writes: (string | null)[] = [];
    let address = '';
    const { result, rerender } = renderHook(({ show, q }) => useFindDraft(show, q, (next) => { writes.push(next); address = next ?? ''; }),
      { initialProps: { show: 'to_read', q: '' } });
    act(() => result.current[1]('graph '));
    act(() => { jest.advanceTimersByTime(FIND_PAUSE_MS); });
    expect(writes).toEqual(['graph']);
    rerender({ show: 'to_read', q: address });
    expect(result.current[0]).toBe('graph ');
    act(() => result.current[1]('graph neural'));
    act(() => { jest.advanceTimersByTime(FIND_PAUSE_MS); });
    rerender({ show: 'to_read', q: address });
    expect(result.current[0]).toBe('graph neural');
    // A change made elsewhere (Back) is followed.
    rerender({ show: 'to_read', q: 'routing' });
    expect(result.current[0]).toBe('routing');
    // So is another shelf.
    rerender({ show: 'files', q: 'routing' });
    act(() => result.current[1]('notes'));
    rerender({ show: 'read', q: 'routing' });
    expect(result.current[0]).toBe('routing');
  } finally {
    jest.useRealTimers();
  }
});

test('the find field writes nothing once the window has gone to another page in its pause, so Read is not undone', () => {
  jest.useFakeTimers();
  window.history.replaceState(null, '', '/index.html#/library?show=files');
  try {
    const writes: (string | null)[] = [];
    const { result } = renderHook(({ show, q }) => useFindDraft(show, q, (next) => { writes.push(next); }),
      { initialProps: { show: 'files', q: '' } });
    act(() => result.current[1]('unicode'));
    // Read on a card: the address is the file's page at once, while the shelf is still drawn.
    window.history.pushState(null, '', '/index.html#/library/files/f-1');
    act(() => { jest.advanceTimersByTime(FIND_PAUSE_MS); });
    expect(writes).toEqual([]);
  } finally {
    window.history.replaceState(null, '', '/');
    jest.useRealTimers();
  }
});

const STATUS: LibraryStatus = {
  version: 1, status: 'busy', changing: 'moving',
  vault: { vault_id: '0f3a9c1e-5b2d-4c8e-9a71-2d6e8f4b1c03', label: 'resmon-library-x', path: '/tmp/resmon-library-x', created_at_utc: '2026-11-04T00:00:00Z' },
  counts: { items: 3, retained_bytes: 300, basis: 'recorded_metadata', removed: 0 },
  limits: { file_bytes: 67108864, read_bytes: 67108864, free_space_floor: 512000000 },
};

test('while the engine says the folder is being moved, neither way to change it can be started, on any visit', () => {
  const before = (window as unknown as { resmonAPI: unknown }).resmonAPI;
  (window as unknown as { resmonAPI: unknown }).resmonAPI = {
    getBackendPort: () => '51234', getApiToken: () => 'token', chooseDirectory: async () => null,
  };
  try {
    const draw = (status: LibraryStatus) => render(
      <QueryClientProvider client={new QueryClient()}><MemoryRouter><Folder status={status} /></MemoryRouter></QueryClientProvider>,
    );
    const moving = draw(STATUS);
    expect(screen.getByRole('button', { name: 'Moving the files' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Choose where it is now' })).toBeDisabled();
    expect(moving.container.textContent).toContain('The Library folder is being moved.');
    moving.unmount();
    draw({ ...STATUS, status: 'ready', changing: undefined });
    expect(screen.getByRole('button', { name: 'Choose where it is now' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Move it to another folder' })).toBeEnabled();
  } finally {
    (window as unknown as { resmonAPI: unknown }).resmonAPI = before;
  }
});
