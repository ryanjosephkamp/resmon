import { fireEvent, render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { engine } from '../../../api/client';
import { Paper } from '../Paper';
import { ResultList } from '../ResultList';
import { MapPaper } from '../../sky/MapPaper';
import type { components } from '../../../api/schema';

jest.mock('../../../api/client', () => ({ ...jest.requireActual('../../../api/client'), engine: jest.fn() }));
jest.mock('../../sky/PaperSky', () => ({ PaperSky: () => null, basisWords: () => 'by shared words' }));
jest.mock('../../lifecycle/LifecycleMarks', () => ({ PaperLifecycle: () => null, LifecycleMarks: () => null }));
jest.mock('@tanstack/react-virtual', () => ({ useVirtualizer: () => ({
  getVirtualItems: () => [{ key: 7, index: 0, start: 0 }], getTotalSize: () => 78, measureElement: () => undefined,
}) }));

const paper = { id: 7, title: 'A collected paper', authors: 'Ada Fixture', source_repository: 'openalex',
  url: 'https://journal.example/7', doi: null, queue_status: null, first_seen_at: '2026-11-08T12:00:00Z', publication_date: null,
  abstract: null, collections: [{ id: 1, name: 'Main Collection', added_by: 'run', added_at: '2026-11-08T12:00:00Z', execution_id: 1 }],
} as components['schemas']['Paper'];
const reply = (data: unknown) => Promise.resolve({ data, response: {} });

beforeEach(() => {
  (engine as jest.Mock).mockReturnValue({
    GET: (route: string) => reply(route === '/api/library/papers/{document_id}/places' ? { document_id: 7, shelf: null, files: [], projects: [], library: { status: 'unconfigured' } }
      : route === '/api/documents/{doc_id}' ? paper
      : route === '/api/documents/{doc_id}/why' ? { runs: [], headline: 'Found by a run.', keywords: [], what_resmon_cannot_see: [] }
        : route === '/api/repositories/catalog' ? [{ slug: 'openalex', name: 'OpenAlex' }]
          : route === '/api/library' ? { status: 'unconfigured' } : { pairs: [] }),
    POST: (route: string) => reply(route === '/api/full-text/for-documents' ? [{ document_id: 7, downloadable: true,
      download: null, in_library: null, best: null, copies: [], why_not_words: null }] : { links: {} }),
  });
});

function mount(content: React.ReactNode, route = '/') {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={client}><MemoryRouter initialEntries={[route]}>{content}</MemoryRouter></QueryClientProvider>);
}

async function actions() {
  expect(await screen.findByRole('button', { name: 'Save to Read for “A collected paper”' })).toBeInTheDocument();
  expect(await screen.findByRole('button', { name: 'Get the PDF for “A collected paper”' })).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Add to a Project for “A collected paper”' })).toBeInTheDocument();
}

test('Search rows offer the three actions from one compact control', async () => {
  mount(<ResultList rows={[paper as unknown as components['schemas']['ExplorerPaper']]} total={1}
    marks={{ links: {}, matches: {}, events: {} }} folded={null} showFolded={false} ranking="newest" sourceName={() => 'OpenAlex'}
    scroller={document.createElement('div')} more={{ has: false, reading: false, read: () => undefined }} />);
  expect(screen.queryByRole('button', { name: /^Save to Read for/ })).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Paper Actions for “A collected paper”' }));
  fireEvent(screen.getByRole('dialog'), Object.assign(new Event('toggle'), { newState: 'open', oldState: 'closed' }));
  await actions();
});

test('a paper page offers the three actions beside its existing places', async () => {
  mount(<Routes><Route path="/papers/:id" element={<Paper />} /></Routes>, '/papers/7');
  await actions();
  expect(screen.getByRole('region', { name: 'Already in Your Library' })).toBeInTheDocument();
});

test('the map paper panel offers the same three actions without opening another page', async () => {
  mount(<MapPaper id={7} cell="B2" region="Shared words" sourceName={() => 'OpenAlex'} backLabel="Back to the list"
    onBack={() => undefined} onShow={() => undefined} />);
  await actions();
});

test('Escape from the project dialog leaves the map paper panel open', async () => {
  HTMLDialogElement.prototype.showModal = function () { this.setAttribute('open', ''); };
  HTMLDialogElement.prototype.close = function () { this.removeAttribute('open'); };
  const back = jest.fn();
  mount(<MapPaper id={7} cell="B2" region="Shared words" sourceName={() => 'OpenAlex'} backLabel="Back to the list"
    onBack={back} onShow={() => undefined} />);
  fireEvent.click(await screen.findByRole('button', { name: 'Add to a Project for “A collected paper”' }));
  const dialog = await screen.findByRole('dialog');
  fireEvent.keyDown(dialog, { key: 'Escape' });
  expect(back).not.toHaveBeenCalled();
  fireEvent(dialog, new Event('cancel', { bubbles: true, cancelable: true }));
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  expect(back).not.toHaveBeenCalled();
  fireEvent.keyDown(screen.getByRole('button', { name: 'Back to the list' }), { key: 'Escape' });
  expect(back).toHaveBeenCalledTimes(1);
});

test('the map panel ignores Escape while a blocking dialog elsewhere is open', async () => {
  const back = jest.fn();
  mount(<MapPaper id={7} cell="B2" region={null} sourceName={() => 'OpenAlex'} backLabel="Back to the list"
    onBack={back} onShow={() => undefined} />);
  await actions();
  const modal = document.createElement('div');
  modal.setAttribute('aria-modal', 'true');
  document.body.append(modal);
  try {
    fireEvent.keyDown(screen.getByRole('button', { name: 'Back to the list' }), { key: 'Escape' });
    expect(back).not.toHaveBeenCalled();
  } finally { modal.remove(); }
});


test('a stored HTTP arXiv URL is HTTPS in the paper source link and its actions', async () => {
  const previous = paper.url;
  paper.url = 'http://arxiv.org/abs/2601.00001';
  try {
    mount(<Routes><Route path="/papers/:id" element={<Paper />} /></Routes>, '/papers/7');
    const link = await screen.findByRole('link', { name: 'open at the source' });
    expect(link).toHaveAttribute('href', 'https://arxiv.org/abs/2601.00001');
    expect(await screen.findByRole('link', { name: 'Open at OpenAlex for “A collected paper”' })).toHaveAttribute('href', 'https://arxiv.org/abs/2601.00001');
  } finally {
    paper.url = previous;
  }
});
