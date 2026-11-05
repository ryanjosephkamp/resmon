import { act, fireEvent, render, renderHook, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { useState, type ReactNode } from 'react';
import { engine } from '../../api/client';
import { CollectionProvider, shownCollection, useCollection, type CollectionList } from '../current';
import { CollectionSwitcher } from '../CollectionSwitcher';
import { MoveCopy, useChangeNotice } from '../MoveCopy';
import { CollectionsSettings } from '../CollectionsSettings';
import { changedWords, type PapersChanged } from '../papers';
import { pickedWords, usePicking } from '../PickBar';
import { collectionWords, YOUR_COLLECTION } from '../words';
import { countSentence, facetCaption, facetEmptyWords } from '../../screens/collection/filters';
import { embeddedWords, missingWords, ranking, type EmbeddingStatus } from '../../screens/settings/embeddingWords';
import { coverageSentences } from '../../screens/lifecycle/model';
import { placementWords } from '../../screens/runs/RunMap';
import { runSkyCaption } from '../../screens/runs/RunSky';

const LIST: CollectionList = {
  collections: [
    { id: 1, name: 'Your collection', is_default: true, papers: 1200, watches: 2, created_at: '2026-11-01T08:00:00Z' },
    { id: 2, name: 'Fluid dynamics', is_default: false, papers: 340, watches: 1, created_at: '2026-11-02T08:00:00Z' },
    { id: 3, name: 'Optics', is_default: false, papers: 0, watches: 0, created_at: '2026-11-03T08:00:00Z' },
  ],
  current_id: 2,
  default_id: 1,
};

jest.mock('../../api/client', () => ({ ...jest.requireActual('../../api/client'), engine: jest.fn() }));

type Call = { method: string; path: string; params: unknown; body: unknown };

// jsdom has no `Response`; `answer` reads only `data` and `error` on success.
const reply = (data: unknown) => Promise.resolve({ data, error: undefined, response: {} as Response });

/** The engine, as the typed client meets it: answers by method and route, and every call kept. */
function engineAnswering(answers: Record<string, (call: Call) => unknown>) {
  const calls: Call[] = [];
  const method = (name: string) => jest.fn((path: string, init?: { params?: unknown; body?: unknown }) => {
    const call = { method: name, path, params: init?.params ?? null, body: init?.body ?? null };
    calls.push(call);
    const answer = answers[`${name} ${path}`];
    if (!answer) return Promise.resolve({ data: undefined, error: { detail: 'Not Found' }, response: { status: 404, url: `http://127.0.0.1${path}` } as Response });
    return reply(answer(call));
  });
  (engine as jest.Mock).mockReturnValue({ GET: method('GET'), POST: method('POST'), PUT: method('PUT'), DELETE: method('DELETE') });
  return calls;
}

afterEach(() => { jest.resetAllMocks(); });

// jsdom has no popovers; the menus' own closing is a no-op here.
const element = HTMLElement.prototype as unknown as { hidePopover?: () => void; showPopover?: () => void };
element.hidePopover ??= () => undefined;
element.showPopover ??= () => undefined;

function Wrapped({ children, path = '/search', client = new QueryClient({ defaultOptions: { queries: { retry: false } } }) }: {
  children: ReactNode; path?: string; client?: QueryClient;
}) {
  return (
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[path]}><CollectionProvider>{children}</CollectionProvider></MemoryRouter>
    </QueryClientProvider>
  );
}

test('a window shows its own collection where it has one, else the one the engine remembers, else the default', () => {
  expect(shownCollection(LIST, null)?.name).toBe('Fluid dynamics');
  expect(shownCollection(LIST, '3')?.name).toBe('Optics');
  expect(shownCollection(LIST, 'optics')?.name).toBe('Optics');
  expect(shownCollection(LIST, 'Chemistry')?.name).toBe('Fluid dynamics');
  expect(shownCollection({ ...LIST, current_id: 99 }, null)?.name).toBe('Your collection');
});

test('the switch names the collection shown, lists each with its papers, and remembers the one chosen', async () => {
  let current = 2;
  const calls = engineAnswering({
    'GET /api/collections': () => ({ ...LIST, current_id: current }),
    'PUT /api/collections/current': (call) => { current = (call.body as { collection: number }).collection; return { current_id: current }; },
  });
  render(<Wrapped><CollectionSwitcher /></Wrapped>);
  const button = await screen.findByRole('button', { name: 'Collection: Fluid dynamics. Choose another collection' });
  expect(button).toHaveTextContent('Fluid dynamics');
  const menu = screen.getByRole('menu', { name: 'Collections', hidden: true });
  const items = within(menu).getAllByRole('menuitemradio', { hidden: true });
  expect(items.map((item) => item.textContent)).toEqual(['Your collection1,200', 'Fluid dynamics340', 'Optics0']);
  expect(items.map((item) => item.getAttribute('aria-checked'))).toEqual(['false', 'true', 'false']);
  expect(within(menu).getAllByRole('menuitem', { hidden: true }).map((item) => item.textContent))
    .toEqual(['New collection', 'Manage collections']);
  fireEvent.click(items[2]!);
  await screen.findByRole('button', { name: 'Collection: Optics. Choose another collection' });
  expect(calls.filter((c) => c.method === 'PUT')).toEqual([
    { method: 'PUT', path: '/api/collections/current', params: null, body: { collection: 3 } }]);
});

test('every read names the collection shown', async () => {
  engineAnswering({ 'GET /api/collections': () => LIST });
  const { result } = renderHook(() => useCollection(), { wrapper: ({ children }) => <Wrapped>{children}</Wrapped> });
  await waitFor(() => expect(result.current.id).toBe(2));
  expect(result.current.several).toBe(true);
  expect(result.current.name).toBe('Fluid dynamics');
});

const MOVED: PapersChanged = {
  mode: 'move', collection_id: 3, from_collection_id: 2, added: [11, 12], already_there: 1,
  removed: [
    { document_id: 11, added_at: '2026-11-02 08:00:00', added_by: 'run', execution_id: 4 },
    { document_id: 12, added_at: '2026-11-02 08:00:01', added_by: 'run', execution_id: 4 },
    { document_id: 13, added_at: '2026-11-02 08:00:02', added_by: 'copy', execution_id: null },
  ],
  not_in_source: 0, missing: 0,
};

test('Move to sends the picked papers to the collection chosen, says what happened, and Undo puts them back', async () => {
  const calls = engineAnswering({
    'GET /api/collections': () => LIST,
    'POST /api/collections/{collection_id}/papers': () => MOVED,
    'POST /api/collections/{collection_id}/papers/undo': () => ({ collection_id: 3, from_collection_id: 2, taken_out: 2, put_back: 3, left_in_place: 0 }),
  });
  render(<Wrapped><MoveCopy which={{ ids: [11, 12, 13] }} from={2} count={3} /></Wrapped>);
  const move = await screen.findByRole('button', { name: 'Move to' });
  await waitFor(() => expect(screen.getAllByRole('menuitem', { hidden: true }).length).toBeGreaterThan(2));
  const menu = screen.getByRole('menu', { name: 'Move to', hidden: true });
  // Every collection but the one the papers are in, then New collection.
  expect(within(menu).getAllByRole('menuitem', { hidden: true }).map((i) => i.textContent))
    .toEqual(['Your collection1,200', 'Optics0', 'New collection']);
  expect(move).toBeEnabled();
  fireEvent.click(within(menu).getByText('Optics'));
  const notice = await screen.findByRole('status');
  expect(notice).toHaveTextContent(
    'Moved 2 papers to Optics. 1 paper was there already; 3 papers left the collection they came from.');
  const sent = calls.find((c) => c.path === '/api/collections/{collection_id}/papers');
  expect(sent?.params).toEqual({ path: { collection_id: 3 } });
  expect(sent?.body).toEqual({ mode: 'move', document_ids: [11, 12, 13], from_collection: 2 });
  fireEvent.click(within(notice).getByRole('button', { name: 'Undo' }));
  await waitFor(() => expect(calls.some((c) => c.path === '/api/collections/{collection_id}/papers/undo')).toBe(true));
  const undone = calls.find((c) => c.path === '/api/collections/{collection_id}/papers/undo');
  expect(undone?.params).toEqual({ path: { collection_id: 3 } });
  expect(undone?.body).toEqual({ added: [11, 12], from_collection: 2, removed: MOVED.removed });
});

test('a copy by search sends the search, not ids, and a copy offers only the collections that lack the paper', async () => {
  const calls = engineAnswering({
    'GET /api/collections': () => LIST,
    'POST /api/collections/{collection_id}/papers': () => ({ ...MOVED, mode: 'copy', collection_id: 1, from_collection_id: null, removed: [], added: [5] }),
  });
  render(<Wrapped><MoveCopy which={{ matching: { sources: ['arxiv'], authors: [], categories: [], collection: 2 } }} from={2} count={40} canMove={false} skip={[3]} /></Wrapped>);
  expect(screen.queryByRole('button', { name: 'Move to' })).toBeNull();
  await screen.findByRole('button', { name: 'Copy to' });
  await waitFor(() => expect(screen.getAllByRole('menuitem', { hidden: true }).length).toBe(2));
  const menu = screen.getByRole('menu', { name: 'Copy to', hidden: true });
  fireEvent.click(within(menu).getByText('Your collection'));
  await screen.findByRole('status');
  expect(calls.find((c) => c.path === '/api/collections/{collection_id}/papers')?.params).toEqual({ path: { collection_id: 1 } });
  expect(calls.find((c) => c.path === '/api/collections/{collection_id}/papers')?.body)
    .toEqual({ mode: 'copy', matching: { sources: ['arxiv'], authors: [], categories: [], collection: 2 } });
});

test('what a move or a copy did, in words', () => {
  expect(changedWords({ ...MOVED, mode: 'copy', removed: [], already_there: 0 }, 'Optics')).toBe('Copied 2 papers to Optics.');
  expect(changedWords({ ...MOVED, added: [], already_there: 1, removed: [] , mode: 'copy' }, 'Optics'))
    .toBe('Nothing copied: Optics holds that paper already.');
  expect(changedWords({ ...MOVED, removed: MOVED.removed.slice(0, 2), already_there: 0, not_in_source: 1, missing: 1 }, 'Optics'))
    .toBe('Moved 2 papers to Optics. 1 paper was not in it to move; 1 paper no longer stored.');
});

test('a pick starts empty again when the search changes, and Select all picks every match', () => {
  const { result, rerender } = renderHook(({ search }) => usePicking(search), { initialProps: { search: 'a' } });
  act(() => result.current.start());
  act(() => result.current.toggle(4));
  act(() => result.current.toggle(9));
  expect([...result.current.picking.picked]).toEqual([4, 9]);
  expect(pickedWords(result.current.picking, 100)).toBe('2 picked');
  act(() => result.current.pickAll());
  expect(pickedWords(result.current.picking, 4210)).toBe('All 4,210 picked');
  rerender({ search: 'b' });
  expect(result.current.picking.all).toBe(false);
  expect(result.current.picking.picked.size).toBe(0);
  expect(result.current.picking.on).toBe(true);
});

test('deleting a collection asks first, and says what happens to its papers and watches', async () => {
  const calls = engineAnswering({
    'GET /api/collections': () => LIST,
    'GET /api/collections/{collection_id}': () => ({
      ...LIST.collections[1], only_here: 300, also_elsewhere: 40, watch_list: [{ id: 7, name: 'Turbulence' }],
    }),
    'DELETE /api/collections/{collection_id}': () => ({
      id: 2, name: 'Fluid dynamics', papers: 340, kept_in_default: 300, still_elsewhere: 40, watches_moved: 1, default_id: 1,
    }),
  });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const invalidated = jest.spyOn(client, 'invalidateQueries');
  render(<Wrapped path="/settings/collections" client={client}><CollectionsSettings /></Wrapped>);
  const ask = await screen.findByRole('button', { name: 'Delete Fluid dynamics' });
  expect(screen.queryByRole('button', { name: 'Delete Your collection' })).toBeNull();
  fireEvent.click(ask);
  const question = await screen.findByRole('group', { name: 'Delete Fluid dynamics?' });
  await waitFor(() => expect(question).toHaveTextContent('300 papers are in no other collection, and will be kept in Your collection.'));
  expect(question).toHaveTextContent('40 papers are also in another collection, and will stay there.');
  expect(question).toHaveTextContent('Turbulence will put its papers in Your collection.');
  expect(calls.some((c) => c.method === 'DELETE')).toBe(false);
  fireEvent.click(within(question).getByRole('button', { name: 'Delete Fluid dynamics' }));
  await screen.findByText(/Deleted Fluid dynamics\./);
  expect(screen.getByText(/Deleted Fluid dynamics\./)).toHaveTextContent(
    'Deleted Fluid dynamics. 300 papers only it held are kept in Your collection. 40 papers stay in the other collections they are in. 1 watch now puts papers in Your collection.');
  // The default collection gained its papers: its Search, Today, and map are read again.
  const keys = invalidated.mock.calls.map(([filters]) => JSON.stringify(filters?.queryKey));
  expect(keys).toEqual(expect.arrayContaining([JSON.stringify(['explorer']), JSON.stringify(['paper'])]));
});

test('the notice a move leaves outlives the pick bar: Done right after the move keeps its Undo', async () => {
  const calls = engineAnswering({
    'GET /api/collections': () => LIST,
    'POST /api/collections/{collection_id}/papers': () => MOVED,
    'POST /api/collections/{collection_id}/papers/undo': () => ({ collection_id: 3, from_collection_id: 2, taken_out: 2, put_back: 3, left_in_place: 0 }),
  });
  function Search() {
    const changed = useChangeNotice();
    const [picking, setPicking] = useState(true);
    return (
      <>
        {picking && (
          <div>
            <MoveCopy which={{ ids: [11, 12, 13] }} from={2} count={3} onNotice={changed.show} />
            <button type="button" onClick={() => setPicking(false)}>Done</button>
          </div>
        )}
        {changed.notice}
      </>
    );
  }
  render(<Wrapped><Search /></Wrapped>);
  await waitFor(() => expect(screen.getAllByRole('menuitem', { hidden: true }).length).toBeGreaterThan(2));
  fireEvent.click(within(screen.getByRole('menu', { name: 'Move to', hidden: true })).getByText('Optics'));
  await screen.findByRole('status');
  fireEvent.click(screen.getByRole('button', { name: 'Done' }));
  expect(screen.queryByRole('button', { name: 'Move to' })).toBeNull();
  const notice = screen.getByRole('status');
  expect(notice).toHaveTextContent('Moved 2 papers to Optics.');
  fireEvent.click(within(notice).getByRole('button', { name: 'Undo' }));
  await waitFor(() => expect(calls.some((c) => c.path === '/api/collections/{collection_id}/papers/undo')).toBe(true));
});

describe('a window and its own collection', () => {
  type Listener = (state: { collection: string | null; tabStrip: number }) => void;
  let listeners: Listener[] = [];
  let state: { collection: string | null; tabStrip: number };
  const set = jest.fn((collection: string | null) => {
    state = { ...state, collection };
    for (const listener of listeners) listener(state);
  });
  beforeEach(() => {
    listeners = [];
    state = { collection: null, tabStrip: 0 };
    set.mockClear();
    (window as unknown as { resmonAPI?: unknown }).resmonAPI = {
      getBackendPort: () => '9001', getApiToken: () => null,
      windowState: () => state,
      onWindowState: (listener: Listener) => { listeners.push(listener); return () => { listeners = listeners.filter((l) => l !== listener); }; },
      setWindowCollection: set,
    };
  });
  afterEach(() => { delete (window as unknown as { resmonAPI?: unknown }).resmonAPI; });

  function Shown() {
    const current = useCollection();
    return (
      <>
        <p data-testid="shown">{current.name}</p>
        <button type="button" onClick={() => void current.switchTo(3)}>Optics here</button>
      </>
    );
  }

  test('a window with none takes the one the engine remembers; a switch changes this window and is remembered for the next', async () => {
    const calls = engineAnswering({
      'GET /api/collections': () => LIST,
      'PUT /api/collections/current': () => ({ current_id: 3 }),
    });
    render(<Wrapped><Shown /></Wrapped>);
    await waitFor(() => expect(screen.getByTestId('shown')).toHaveTextContent('Fluid dynamics'));
    // Taken as its own, so a switch in another window, which changes what the engine remembers, does not move it.
    expect(set).toHaveBeenCalledWith('2');
    fireEvent.click(screen.getByRole('button', { name: 'Optics here' }));
    await waitFor(() => expect(screen.getByTestId('shown')).toHaveTextContent('Optics'));
    expect(set).toHaveBeenLastCalledWith('3');
    await waitFor(() => expect(calls.some((c) => c.method === 'PUT' && c.path === '/api/collections/current')).toBe(true));
    // The main process says this window shows another (as a window opened from another starts on its collection).
    act(() => { for (const listener of listeners) listener({ collection: '1', tabStrip: 0 }); });
    await waitFor(() => expect(screen.getByTestId('shown')).toHaveTextContent('Your collection'));
  });
});

describe('the words that name the collection shown, and count its papers', () => {
  // Two collections of different sizes: 1,200 papers in the default one, 2 in Photonics, 1,202 in all.
  const photonics = collectionWords('Photonics', true);
  const only = collectionWords('Your collection', false);
  const status = (collection: { embedded: number; total: number } | null): EmbeddingStatus => ({
    run: { running: false, model: null, processed: 0, total: 0, skipped_no_text: 0, started_at: null, finished_at: null, cancelled: false, reason: null },
    coverage: { embedded: 0, total: 1202, model: null },
    extension: { extension: 'v0.1.9', reason: null },
    index: { model: null, dims: null, rows: 0 },
    lane: null,
    capability: { available: false, extension: 'v0.1.9', reason: 'Nothing is embedded yet.', model: null, indexed: 0 },
    ...(collection ? { collection_coverage: { ...collection, model: null } } : {}),
  });

  test('"your collection" while it is the only one, its name where there are several', () => {
    expect(only).toMatchObject({ named: false, name: 'your collection', Name: 'Your collection' });
    expect(only.papers(5)).toBe('your 5 papers');
    expect(photonics).toMatchObject({ named: true, name: 'Photonics', Name: 'Photonics' });
    expect(photonics.papers(2)).toBe('the 2 papers in Photonics');
    expect(YOUR_COLLECTION).toMatchObject({ named: false, name: 'your collection' });
  });

  test("Search's count line and its menus name the collection", () => {
    const page = { total: 2, total_is_exact: true };
    expect(countSentence(page, false, '', photonics)).toBe('2 papers in Photonics');
    expect(countSentence({ total: 1200, total_is_exact: true }, false, '', only)).toBe('1,200 papers in your collection');
    expect(facetCaption('source', { words: false, others: false }, 1, 50, photonics)).toMatch(/^Each number counts the papers .* in Photonics\./);
    expect(facetEmptyWords('author', { words: false, others: false }, 0, photonics)).toBe('Photonics has no papers yet, so there is no author to choose.');
  });

  test("the ranking note counts the shown collection's papers, not every paper resmon holds", () => {
    expect(ranking(status({ embedded: 0, total: 2 }), photonics).sentence)
      .toBe('Ranking by meaning is off: no embedding model is set up, so none of the 2 papers in Photonics has a vector.');
    expect(ranking(status({ embedded: 0, total: 1200 }), only).sentence)
      .toBe('Ranking by meaning is off: no embedding model is set up, so none of your 1,200 papers has a vector.');
    // Read without a collection, the note counts what the engine counted: every paper.
    expect(ranking(status(null)).sentence).toContain('none of your 1,202 papers');
  });

  test('Settings says its numbers are every collection\'s, as a backfill embeds every paper', () => {
    const withModel = { ...status(null), coverage: { embedded: 2, total: 1202, model: 'nomic-embed-text' } };
    expect(embeddedWords(withModel, true)).toBe('2 of 1,202 papers in every collection, with nomic-embed-text.');
    expect(embeddedWords(withModel)).toBe('2 of 1,202 papers, with nomic-embed-text.');
    expect(missingWords(withModel, true)).toMatch(/^1,200 papers in every collection have no vector from nomic-embed-text yet\./);
    const lifecycle = { corpus: 1202, checked: 0, unchecked: 1202, errored: 0, no_identifier: 0, last_checked_at: null, recheck_after_days: 30 };
    expect(coverageSentences(lifecycle, new Date(), true)[0])
      .toBe('None of the 1,202 papers in every collection has been checked yet.');
  });

  test("a run's map and a watch's count the run's papers in the collection shown", () => {
    const map = { state: 'ready', basis: 'words', error: null } as Parameters<typeof placementWords>[0];
    expect(placementWords(map, 0, 0, photonics).sentence).toBe('This run stored no papers that are still in Photonics.');
    expect(placementWords(map, 2, 2, photonics).sentence).toBe('All 2 papers this run stored in Photonics are on the map.');
    expect(placementWords(map, 2, 2).sentence).toBe('All 2 papers this run stored are on the map.');
    const facts = { placed: 2, total: 2, ready: true, basis: 'words' } as Parameters<typeof runSkyCaption>[0];
    expect(runSkyCaption(facts, false, photonics)).toBe('All 2 papers from this run in Photonics, marked where they sit in it.');
    expect(runSkyCaption({ ...facts, total: 0, placed: 0 }, false, photonics)).toBe('None of the papers this run stored is in Photonics.');
    expect(runSkyCaption({ ...facts, total: 0, placed: 0 }, false)).toBe('This run stored no papers.');
  });
});
