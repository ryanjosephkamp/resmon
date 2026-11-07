/**
 * Today keeps the time it says to the reader, and Escape clears the paper a
 * reader chose from its list.
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { engine } from '../../../api/client';
import { DEFAULT_VIEW } from '../../sky/look';
import { collectionSky } from '../../sky/collectionSky';
import { Today } from '../../Today';
import { fullDate } from '../format';

jest.mock('../../../api/client', () => ({ ...jest.requireActual('../../../api/client'), engine: jest.fn() }));
// The canvas is not what is under test; the plate's children (the date line) and key are.
jest.mock('../Plate', () => {
  const { forwardRef } = jest.requireActual('react');
  return {
    Plate: forwardRef(function Plate(props: { children?: unknown }, ref: unknown) {
      void ref;
      return <div data-testid="plate">{props.children as never}</div>;
    }),
    PlateKey: () => null,
  };
});
jest.mock('../FirstRun', () => ({ FirstRun: () => null }));
jest.mock('../../../theme/appearance', () => ({ useAppearance: () => ({ theme: 'light', shown: {} }) }));
jest.mock('../../sky/collectionSky', () => {
  const actual = jest.requireActual('../../sky/collectionSky');
  return { collectionSky: jest.fn(actual.collectionSky) };
});

// jsdom has no `Response`; `answer` reads only `data` and `error` on success.
const reply = (data: unknown) => Promise.resolve({ data, error: undefined, response: {} as Response });

const MAP = {
  state: 'ready', basis: 'words', model: null, error: null, fitted_at: null, fitted_count: 2, placed_since_fit: 0,
  refitting: false, embedding_coverage: null,
  points: { id: [1, 2], region: [0, 0], seen_day: [20_400, 20_400], x: [0.2, 0.8], y: [0.3, 0.7] },
  regions: [{ id: 0, label: 'Sparse models', r: 0.4, size: 2, terms: ['sparse'], x: 0.5, y: 0.5 }],
  unplaced: { no_text: 0, not_embedded: 0 },
};
const paper = (id: number, title: string) => ({
  id, title, authors: 'Ada Lovelace', source: 'arxiv', first_seen_at: '2026-11-03T08:00:00Z', publication_date: '2026-11-01',
  abstract_lede: null, doi: null, url: null, queue_status: null, watches: [],
});
const TODAY = {
  now: '2026-11-03T12:07:40Z', since: '2026-11-02T09:00:00Z', window: 'since_last_look', total: 2, from_searches: 2, watches: [],
  papers: [paper(1, 'Sparse recovery'), paper(2, 'Dense recovery')],
};

function answers(path: string): unknown {
  switch (path) {
    case '/api/map': return MAP;
    case '/api/today': return TODAY;
    case '/api/scheduler/status': return { state: 'running', routines: [] };
    case '/api/repositories/catalog': return [{ slug: 'arxiv', name: 'arXiv' }];
    case '/api/backup/last': return { last_backup: null };
    case '/api/map/views/{name}': return DEFAULT_VIEW;
    case '/api/map/facets': return { sources: [] };
    case '/api/documents/briefs': return [];
    case '/api/executions': return [];
    case '/api/lifecycle/for-documents': return { events: {}, checked: {} };
    default: return {};
  }
}

function mount() {
  (engine as jest.Mock).mockReturnValue({
    GET: jest.fn((path: string) => reply(answers(path))),
    POST: jest.fn((path: string) => reply(answers(path))),
    PUT: jest.fn((path: string) => reply(answers(path))),
    DELETE: jest.fn(() => reply({})),
  });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={client}><Today /></QueryClientProvider>);
}

beforeEach(() => {
  // jsdom does not know `:popover-open`, which a browser does: read it as matching nothing.
  const query = Document.prototype.querySelector;
  jest.spyOn(Document.prototype, 'querySelector').mockImplementation(function querySelector(this: Document, selector: string) {
    return query.call(this, selector.replace(', :popover-open', ''));
  });
  window.matchMedia = jest.fn().mockReturnValue({ matches: true, addEventListener: jest.fn(), removeEventListener: jest.fn() });
});
afterEach(() => { jest.restoreAllMocks(); jest.resetAllMocks(); jest.useRealTimers(); });

describe('the time Today says', () => {
  // A query reads the page's text with each no-break space folded into a space, as the date line's text is matched here.
  const dateLine = (at: Date) => fullDate(at).replace(/\u00a0/g, ' ');

  test('the date line moves by the minute, and the map is not built again for it', async () => {
    jest.useFakeTimers({ now: new Date('2026-11-03T12:07:40Z'), doNotFake: ['nextTick', 'queueMicrotask'] });
    mount();
    const opened = dateLine(new Date('2026-11-03T12:07:40Z'));
    expect(await screen.findByText(opened)).toBeInTheDocument();
    const built = (collectionSky as jest.Mock).mock.calls.length;
    expect(built).toBeGreaterThan(0);

    act(() => { jest.advanceTimersByTime(20_000); });
    expect(await screen.findByText(dateLine(new Date('2026-11-03T12:08:00Z')))).toBeInTheDocument();
    expect(screen.queryByText(opened)).toBeNull();

    act(() => { jest.advanceTimersByTime(60_000); });
    expect(await screen.findByText(dateLine(new Date('2026-11-03T12:09:00Z')))).toBeInTheDocument();
    expect((collectionSky as jest.Mock).mock.calls.length).toBe(built);
  });
});

describe('Escape in the list', () => {
  async function chosen() {
    mount();
    const title = await screen.findByRole('button', { name: 'Sparse recovery' });
    fireEvent.click(title);
    await waitFor(() => expect(title).toHaveAttribute('aria-pressed', 'true'));
    return title;
  }

  test('clears the chosen paper and returns the keyboard to its title', async () => {
    const title = await chosen();
    const save = screen.getAllByRole('button', { name: 'Save to your reading queue' })[1] as HTMLElement;
    save.focus();
    fireEvent.keyDown(save, { key: 'Escape' });
    await waitFor(() => expect(title).toHaveAttribute('aria-pressed', 'false'));
    expect(title).toHaveFocus();
  });

  test('leaves the choice when the key was already handled, was typed in a field, or a dialog is open', async () => {
    const title = await chosen();
    const save = screen.getAllByRole('button', { name: 'Save to your reading queue' })[1] as HTMLElement;

    save.addEventListener('keydown', (event) => event.preventDefault(), { once: true });
    fireEvent.keyDown(save, { key: 'Escape' });
    expect(title).toHaveAttribute('aria-pressed', 'true');

    const field = document.createElement('input');
    screen.getByLabelText('Today').append(field);
    fireEvent.keyDown(field, { key: 'Escape' });
    expect(title).toHaveAttribute('aria-pressed', 'true');
    field.remove();

    const dialog = document.createElement('dialog');
    dialog.setAttribute('open', '');
    document.body.append(dialog);
    fireEvent.keyDown(save, { key: 'Escape' });
    expect(title).toHaveAttribute('aria-pressed', 'true');
    dialog.remove();

    fireEvent.keyDown(save, { key: 'Escape' });
    await waitFor(() => expect(title).toHaveAttribute('aria-pressed', 'false'));
  });
});

describe('a map the engine could not read', () => {
  test('says the engine\'s own sentence, not a route and a status', async () => {
    (engine as jest.Mock).mockReturnValue({
      GET: jest.fn((path: string) => (path === '/api/map'
        ? Promise.resolve({
          data: undefined, error: { detail: 'The engine failed while answering this request (IndexError).' },
          response: { url: 'http://127.0.0.1:9/api/map', status: 500 } as Response,
        })
        : reply(answers(path)))),
      POST: jest.fn((path: string) => reply(answers(path))),
      PUT: jest.fn((path: string) => reply(answers(path))),
      DELETE: jest.fn(() => reply({})),
    });
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(<QueryClientProvider client={client}><Today /></QueryClientProvider>);
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'The engine failed while answering this request (IndexError). Nothing here is shown from memory.');
    expect(screen.getByRole('alert')).not.toHaveTextContent('HTTP 500');
  });
});
