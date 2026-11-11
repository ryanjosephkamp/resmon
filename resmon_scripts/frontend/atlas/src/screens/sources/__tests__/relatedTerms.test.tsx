import { useState } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { engine } from '../../../api/client';
import { TermsField, useTerms } from '../SourceCatalog';

jest.mock('../../../api/client', () => ({ ...jest.requireActual('../../../api/client'), engine: jest.fn() }));
let collection: number | null = 7;
jest.mock('../../../collections/current', () => ({ ...jest.requireActual('../../../collections/current'), useCollection: () => ({ id: collection }) }));
const reply = (data: unknown) => ({ data, response: {} });
let GET: jest.Mock;
function Field() {
  const [, redraw] = useState(0); const state = useTerms([]);
  return <><TermsField id="terms" label="Search terms" state={state} related /><button onClick={() => redraw(n => n + 1)}>Refresh</button></>;
}
function mount() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={client}><Field /></QueryClientProvider>);
}
function add(term: string) {
  fireEvent.change(screen.getByRole('textbox', { name: 'Search terms' }), { target: { value: term } });
  fireEvent.keyDown(screen.getByRole('textbox', { name: 'Search terms' }), { key: 'Enter' });
}
beforeEach(() => {
  collection = 7;
  GET = jest.fn((_path, options) => Promise.resolve(reply({ term: options.params.query.term, matched_papers: 3,
    suggestions: ['spectral filters', 'graph', 'Spectral Filters', 'networks'] })));
  (engine as jest.Mock).mockReturnValue({ GET });
});
test('a term owns an offer from the shown collection; buttons add once and exclude already added terms', async () => {
  mount(); add('graph');
  const button = await screen.findByRole('button', { name: 'Add “spectral filters”' });
  expect(GET).toHaveBeenCalledWith('/api/collection/related-terms', expect.objectContaining({ params: { query: { term: 'graph', collection: '7' } } }));
  expect(screen.queryByRole('button', { name: 'Add “graph”' })).toBeNull();
  expect(screen.queryByRole('button', { name: 'Add “Spectral Filters”' })).toBeNull();
  expect(button.compareDocumentPosition(screen.getByRole('textbox')) & Node.DOCUMENT_POSITION_PRECEDING).toBeTruthy();
  fireEvent.click(button);
  expect(await screen.findByRole('button', { name: 'Remove spectral filters' })).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: /Add “spectral filters”/i })).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Remove graph' }));
  expect(screen.queryByRole('group', { name: 'Related to “graph”' })).toBeNull();
});
test('no evidence is said plainly', async () => {
  GET.mockImplementation((_p, o) => Promise.resolve(reply({ term: o.params.query.term, matched_papers: 0, suggestions: [] })));
  mount(); add('missing');
  expect(await screen.findByText('No papers in this collection use “missing” yet, so there’s nothing to suggest.')).toBeInTheDocument();
});
test('removal discards a late offer and adding another term leaves earlier offers intact', async () => {
  let finish: (value: unknown) => void = () => undefined;
  GET.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  mount(); add('graph');
  await waitFor(() => expect(GET).toHaveBeenCalledTimes(1));
  fireEvent.click(screen.getByRole('button', { name: 'Remove graph' }));
  await act(async () => finish(reply({ term: 'graph', matched_papers: 1, suggestions: ['late'] })));
  expect(screen.queryByRole('button', { name: 'Add “late”' })).toBeNull();
  add('networks');
  const group = await screen.findByRole('group', { name: 'Related to “networks”' });
  expect(await within(group).findByRole('button', { name: 'Add “spectral filters”' })).toBeInTheDocument();
  add('ocean');
  expect(within(group).getByRole('button', { name: 'Add “spectral filters”' })).toBeInTheDocument();
});

test('a collection switch replaces the offer and a refusal is visible', async () => {
  mount(); add('graph');
  await screen.findByRole('button', { name: 'Add “spectral filters”' });
  collection = 8;
  GET.mockRejectedValue(new Error('Not readable'));
  fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
  expect(await screen.findByText(/Related terms could not be read/)).toHaveTextContent('Not readable');
  expect(screen.queryByRole('button', { name: 'Add “spectral filters”' })).toBeNull();
  const status = screen.getByRole('status');
  expect(status).toHaveAttribute('aria-live', 'polite');
});

test('the window’s collection is known before any papers are read', async () => {
  collection = null;
  mount(); add('graph');
  expect(screen.getByText('Waiting for this window’s collection.')).toBeInTheDocument();
  expect(GET).not.toHaveBeenCalled();
  collection = 7;
  fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
  await screen.findByRole('button', { name: 'Add “spectral filters”' });
  expect(GET).toHaveBeenCalledTimes(1);
  expect(GET.mock.calls[0]?.[1].params.query.collection).toBe('7');
});

test('the field asks the engine to prepare its counts once, the first time it gets the keyboard', async () => {
  mount();
  const field = screen.getByRole('textbox');
  fireEvent.focus(field);
  fireEvent.blur(field);
  fireEvent.focus(field);
  await waitFor(() => expect(GET).toHaveBeenCalledWith('/api/collection/related-terms', { params: { query: { collection: '7' } } }));
  expect(GET.mock.calls.filter(([, options]) => options.params.query.term === undefined)).toHaveLength(1);
});

test('a term added by pressing elsewhere draws its offer only once the press ends', async () => {
  mount();
  const field = screen.getByRole('textbox', { name: 'Search terms' });
  fireEvent.focus(field);
  fireEvent.change(field, { target: { value: 'graph' } });
  fireEvent.pointerDown(window);
  fireEvent.blur(field);
  expect(await screen.findByRole('button', { name: 'Remove graph' })).toBeInTheDocument();
  expect(screen.queryByRole('group', { name: 'Related to “graph”' })).toBeNull();
  fireEvent.pointerUp(window);
  expect(await screen.findByRole('group', { name: 'Related to “graph”' })).toBeInTheDocument();
  // Leaving by the keyboard moves nothing under a pointer, so the offer is drawn at once.
  fireEvent.change(field, { target: { value: 'networks' } });
  fireEvent.blur(field);
  expect(screen.getByRole('group', { name: 'Related to “networks”' })).toBeInTheDocument();
});
