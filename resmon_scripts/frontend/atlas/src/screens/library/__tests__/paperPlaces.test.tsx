import { act, render, screen, waitFor } from '@testing-library/react';
import { focusManager, QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { engine } from '../../../api/client';
import type { components } from '../../../api/schema';
import { EvidencePaperLinks, PaperPlaces, invalidatePlacesForFiles } from '../PaperPlaces';

jest.mock('../../../api/client', () => ({ ...jest.requireActual('../../../api/client'), engine: jest.fn() }));
type Paper = components['schemas']['Paper'];
const paper = { id: 7, title: 'A paper', queue_status: 'to_read', collections: [{ id: 2 }] } as Paper;
const file = { file_id: 'file', version_id: 'version', vault_id: 'vault', original_name: 'paper.pdf', media_type: 'application/pdf',
  availability: 'available', paper_links: [{ document_id: 7, title: 'A paper' }] };
const entry = { document_id: 7, status: 'to_read', saved_at: '2026-11-07T12:00:00Z', updated_at: '2026-11-07T12:00:00Z', read_at: null };
const reply = (data: unknown) => Promise.resolve({ data, response: {} });
let get: jest.Mock;

beforeEach(() => {
  get = jest.fn((route: string) => reply(
    route === '/api/library/papers/{document_id}/places' ? { document_id: 7, shelf: entry, files: [file], projects: [{ project_id: 'project', name: 'Review' }], library: { status: 'ready' } }
      : route === '/api/library' ? { status: 'ready', vault: { vault_id: 'vault' } }
      : route === '/api/library/files' ? { vault_id: 'vault', files: [file], has_more: false, through_id: 1 }
        : route === '/api/library/files/{file_id}' ? { vault_id: 'vault', file }
          : route === '/api/library/papers/{document_id}/places' ? { entries: [entry], total: 1 }
            : { vault_id: 'vault', file_id: 'file', version_id: 'version', projects: [{ project_id: 'project', name: 'Review', member: true }, { project_id: 'old', name: 'Former project', member: false }] },
  ));
  (engine as jest.Mock).mockReturnValue({ GET: get });
});

function mount(content: React.ReactNode) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(content, { wrapper: ({ children }) => <QueryClientProvider client={client}><MemoryRouter>{children}</MemoryRouter></QueryClientProvider> });
}

test('the paper links to its shelf with the save date, its PDF, and current projects', async () => {
  mount(<PaperPlaces paper={paper} />);
  expect(await screen.findByRole('link', { name: 'To Read' })).toHaveAttribute('href', '/library?show=to_read');
  expect(screen.getByText(/since .*November.*7.*2026/)).toBeInTheDocument();
  expect(await screen.findByRole('link', { name: 'PDF in Your Files: paper.pdf' })).toHaveAttribute('href', '/library/files/file?paper=7');
  expect(await screen.findByRole('link', { name: 'Review' })).toHaveAttribute('href', '/library/evidence?project=project');
  expect(screen.queryByRole('link', { name: 'Former project' })).not.toBeInTheDocument();
  expect(get).toHaveBeenCalledTimes(1);
  expect(get).toHaveBeenCalledWith('/api/library/papers/{document_id}/places', expect.objectContaining({ headers: { 'X-Resmon-Library': '1' }, params: { path: { document_id: 7 } } }));
});

test('Read uses the recorded read date, not the save date', async () => {
  get.mockImplementation((route: string) => reply(route === '/api/library/papers/{document_id}/places'
    ? { shelf: { ...entry, status: 'read', read_at: '2026-11-08T12:00:00Z' }, files: [], projects: [], library: { status: 'unconfigured' } }
    : { status: 'unconfigured' }));
  mount(<PaperPlaces paper={{ ...paper, queue_status: 'read' }} />);
  expect(await screen.findByRole('link', { name: 'Read' })).toHaveAttribute('href', '/library?show=read');
  expect(screen.getByText(/since .*November.*8.*2026/)).toBeInTheDocument();
});

test('To Read after Mark Unread uses the status-change date', async () => {
  get.mockImplementation((route: string) => reply(route === '/api/library/papers/{document_id}/places'
    ? { shelf: { ...entry, updated_at: '2026-11-08T12:00:00Z' }, files: [], projects: [], library: { status: 'unconfigured' } } : { status: 'unconfigured' }));
  mount(<PaperPlaces paper={paper} />);
  expect(await screen.findByText(/since .*November.*8.*2026/)).toBeInTheDocument();
});

test('a missing read date is stated, rather than guessed from another date', async () => {
  get.mockImplementation((route: string) => reply(route === '/api/library/papers/{document_id}/places'
    ? { shelf: { ...entry, status: 'read' }, files: [], projects: [], library: { status: 'unconfigured' } } : { status: 'unconfigured' }));
  mount(<PaperPlaces paper={{ ...paper, queue_status: 'read' }} />);
  expect(await screen.findByText(/date not recorded/)).toBeInTheDocument();
  expect(screen.queryByText(/since/)).not.toBeInTheDocument();
});

test('an unavailable linked file is labeled without hiding other files or projects', async () => {
  get.mockResolvedValue(await reply({ document_id: 7, shelf: entry,
    files: [{ ...file, availability: 'unavailable' }, { ...file, file_id: 'good', original_name: 'readable.pdf' }],
    projects: [{ project_id: 'project', name: 'Review' }], library: { status: 'ready' } }));
  mount(<PaperPlaces paper={paper} />);
  expect((await screen.findByRole('link', { name: 'PDF in Your Files: paper.pdf' })).parentElement)
    .toHaveTextContent('this file could not be checked in the Library folder');
  expect(screen.getByRole('link', { name: 'PDF in Your Files: readable.pdf' })).toBeInTheDocument();
  expect(screen.getByRole('link', { name: 'Review' })).toBeInTheDocument();
  expect(screen.queryByRole('link', { name: 'Your Files' })).not.toBeInTheDocument();
});

test.each(['unconfigured', 'missing', 'busy', 'mismatch', 'needs_attention', 'unavailable'])('a %s Library gives its recovery sentence', async (status) => {
  get.mockResolvedValue(await reply({ document_id: 7, shelf: null, files: [], projects: [], library: { status } }));
  mount(<PaperPlaces paper={paper} />);
  expect(await screen.findByRole('link', { name: 'Your Files' })).toHaveAttribute('href', '/library?show=files');
  expect(screen.queryByText('No Library file is linked to this paper.')).not.toBeInTheDocument();
});

test('returning to a paper reads its current places, sharing the same cache key', async () => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const content = (show: boolean) => <QueryClientProvider client={client}><MemoryRouter>{show && <PaperPlaces paper={paper} />}</MemoryRouter></QueryClientProvider>;
  const view = render(content(true));
  await screen.findByRole('link', { name: 'Review' });
  view.rerender(content(false));
  get.mockResolvedValue(await reply({ document_id: 7, shelf: entry, files: [], projects: [{ project_id: 'project', name: 'Renamed project' }], library: { status: 'ready' } }));
  view.rerender(content(true));
  await screen.findByRole('link', { name: 'Renamed project' });
  expect(get).toHaveBeenCalledTimes(2);
  await client.invalidateQueries({ queryKey: ['paper-places', 8] });
  expect(get).toHaveBeenCalledTimes(2);
  await client.invalidateQueries({ queryKey: ['paper-places', 7] });
  await waitFor(() => expect(get).toHaveBeenCalledTimes(3));
});

test('regaining window focus reads current places', async () => {
  mount(<PaperPlaces paper={paper} />);
  await screen.findByRole('link', { name: 'Review' });
  get.mockResolvedValue(await reply({ document_id: 7, shelf: { ...entry, status: 'read' }, files: [], projects: [], library: { status: 'ready' } }));
  try {
    act(() => { focusManager.setFocused(false); focusManager.setFocused(true); });
    await screen.findByRole('link', { name: 'Read' });
    expect(get).toHaveBeenCalledTimes(2);
  } finally { focusManager.setFocused(undefined); }
});

test.each(['unconfigured', 'missing', 'mismatch', 'needs_attention', 'unavailable'])('a %s Library is not polled: it changes when the person acts, and a return to the window reads it', async (status) => {
  jest.useFakeTimers();
  get.mockResolvedValue(await reply({ document_id: 7, shelf: entry, files: [], projects: [], library: { status } }));
  const view = mount(<PaperPlaces paper={paper} />);
  try {
    await screen.findByRole('link', { name: 'Your Files' });
    await act(async () => { await jest.advanceTimersByTimeAsync(5000); });
    expect(get).toHaveBeenCalledTimes(1);
  } finally { view.unmount(); jest.useRealTimers(); }
});

test.each(['busy', 'moving', 'relinking'])('a %s Library is polled until ready, then polling stops', async (status) => {
  jest.useFakeTimers();
  get.mockResolvedValue(await reply({ document_id: 7, shelf: entry, files: [], projects: [], library:
    ['moving', 'relinking'].includes(status) ? { status: 'ready', changing: status } : { status } }));
  const view = mount(<PaperPlaces paper={paper} />);
  try {
    await screen.findByRole('link', { name: 'Your Files' });
    get.mockResolvedValue(await reply({ document_id: 7, shelf: entry, files: [], projects: [], library: { status: 'ready' } }));
    await act(async () => { await jest.advanceTimersByTimeAsync(1000); });
    expect(get).toHaveBeenCalledTimes(2);
    expect(screen.queryByRole('link', { name: 'Your Files' })).not.toBeInTheDocument();
    await act(async () => { await jest.advanceTimersByTimeAsync(3000); });
    expect(get).toHaveBeenCalledTimes(2);
  } finally { view.unmount(); jest.useRealTimers(); }
});

test('a failed location read is visible and never described as an empty Library', async () => {
  get.mockRejectedValue(new Error('The folder could not be read.'));
  mount(<PaperPlaces paper={paper} />);
  expect(await screen.findByRole('status')).toHaveTextContent('Some places could not be read: The folder could not be read.');
  expect(screen.queryByText('No Library file is linked to this paper.')).not.toBeInTheDocument();
  expect(screen.queryByText(/Reading its/)).not.toBeInTheDocument();
});

test('a failed refresh does not present an old empty file list as a current result', async () => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  client.setQueryData(['paper-places', 7], { document_id: 7, shelf: null, files: [], projects: [], library: { status: 'ready' } });
  render(<QueryClientProvider client={client}><MemoryRouter><PaperPlaces paper={paper} /></MemoryRouter></QueryClientProvider>);
  get.mockRejectedValue(new Error('The engine is unavailable.'));
  await client.invalidateQueries({ queryKey: ['paper-places', 7] });
  await screen.findByText(/Some places could not be read/);
  expect(screen.queryByText('No Library file is linked to this paper.')).not.toBeInTheDocument();
});

test('an Evidence file links back to its paper without leaving the reader first', async () => {
  mount(<EvidencePaperLinks file={file} />);
  expect(await screen.findByRole('link', { name: 'A paper' })).toHaveAttribute('href', '/papers/7');
  expect(get).toHaveBeenCalledWith('/api/library/files/{file_id}', {
    headers: { 'X-Resmon-Library': '1' }, params: { path: { file_id: 'file' }, query: { expected_vault_id: 'vault' } },
  });
});

test('another file version does not supply a backlink for the version being read', async () => {
  const view = mount(<EvidencePaperLinks file={file} />);
  await screen.findByRole('link', { name: 'A paper' });
  view.rerender(<EvidencePaperLinks file={{ ...file, version_id: 'previous' }} />);
  expect(view.container.querySelector('a')).toBeNull();
});

test('a Library file action invalidates only cached places linked to that file', async () => {
  const client = new QueryClient();
  client.setQueryData(['paper-places', 7], { files: [file] });
  client.setQueryData(['paper-places', 8], { files: [{ ...file, file_id: 'other' }] });
  await invalidatePlacesForFiles(client, [file]);
  expect(client.getQueryState(['paper-places', 7])?.isInvalidated).toBe(true);
  expect(client.getQueryState(['paper-places', 8])?.isInvalidated).toBe(false);
});
