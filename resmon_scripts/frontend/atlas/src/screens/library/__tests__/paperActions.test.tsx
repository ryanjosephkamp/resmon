import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { engine } from '../../../api/client';
import { PaperActions } from '../PaperActions';
import { evidence } from '../evidenceApi';
import { preparePaperFile } from '../paperFile';
import { AddToProject } from '../LibraryDialogs';
import type { FullTextStatus, FullTextRequest } from '../../fulltext/fullText';

jest.mock('../../../api/client', () => ({ ...jest.requireActual('../../../api/client'), engine: jest.fn() }));
for (const method of ['projects', 'projectsPage', 'detail', 'add', 'create'] as const) jest.spyOn(evidence, method);

const reply = (data: unknown) => Promise.resolve({ data, response: {} });
const held = { file_id: 'file', version_id: 'version', vault_id: 'vault', byte_size: 10 };
const file = { ...held, original_name: 'paper.pdf', availability: 'not_checked', media_type: 'application/pdf' };
const project = { project_id: 'project', vault_id: 'vault', name: 'Reading', id: 1, updated_at_utc: '2026-11-08T12:00:00Z', revision: 1, file_count: 0 };
const openCopy: FullTextStatus = {
  document_id: 7, downloadable: true, why_not: null, why_not_words: null, copies: [], in_library: null, download: null,
  best: { reported_by: 'openalex', pdf_url: 'https://repo.example/7.pdf', landing_url: null, host: 'repo.example', license: 'cc-by',
    license_words: 'CC BY', license_basis: 'source_record', version: 'published', license_to_be_read: false },
};
const request = (fields: Partial<FullTextRequest>): FullTextRequest => ({
  id: 1, document_id: 7, execution_id: null, requested_by: 'person', requested_at_utc: '2026-11-08T12:00:00Z', finished_at_utc: null,
  state: 'waiting', reason: null, words: null, url: 'https://repo.example/7.pdf', final_url: null, host: 'repo.example',
  license: 'cc-by', license_words: 'CC BY', version: 'published', reported_by: 'openalex', file_id: null, byte_size: null, ...fields,
});

let status = openCopy;
let queue: string | null = null;
let api: { GET: jest.Mock; POST: jest.Mock; DELETE: jest.Mock };

beforeEach(() => {
  status = { ...openCopy }; queue = null;
  jest.clearAllMocks();
  HTMLDialogElement.prototype.showModal = function () { this.setAttribute('open', ''); };
  HTMLDialogElement.prototype.close = function () { this.removeAttribute('open'); };
  api = {
    GET: jest.fn((route: string) => reply(route === '/api/library' ? { status: 'ready', vault: { vault_id: 'vault' } }
      : route === '/api/library/files/{file_id}' ? { file, vault_id: 'vault' } : { document_id: 7, shelf: queue ? { status: queue } : null, files: [], projects: [], library: { status: 'ready' } })),
    POST: jest.fn((route: string) => {
      if (route === '/api/full-text/for-documents') return reply([status]);
      if (route === '/api/reading-queue') { queue = 'to_read'; return reply({ status: queue }); }
      status = { ...status, in_library: held };
      return reply(request({ state: 'stored', file_id: 'file' }));
    }),
    DELETE: jest.fn(() => { queue = null; return reply({ removed: true }); }),
  };
  (engine as jest.Mock).mockReturnValue(api);
  (evidence.projects as jest.Mock).mockResolvedValue({ projects: [project] });
  (evidence.projectsPage as jest.Mock).mockResolvedValue({ projects: [project], has_more: false, next_after_id: null });
  (evidence.detail as jest.Mock).mockResolvedValue({ project });
  (evidence.add as jest.Mock).mockResolvedValue({ project: { ...project, file_count: 1 }, added: true });
  (evidence.create as jest.Mock).mockResolvedValue({ project });
});

function mount(compact = false, id = 7, title = 'A paper', inRow = false) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const actions = <PaperActions id={id} title={title} sourceName="OpenAlex" sourceUrl="https://journal.example/7" compact={compact} />;
  const view = render(<QueryClientProvider client={client}><MemoryRouter>
    <Location />
    {inRow ? <ul><li>{actions}</li></ul> : actions}
  </MemoryRouter></QueryClientProvider>);
  if (compact) {
    fireEvent.click(screen.getByRole('button', { name: `Paper Actions for “${title}”` }));
    // jsdom does not implement the button's native popover toggle.
    fireEvent(screen.getByRole('dialog'), Object.assign(new Event('toggle'), { newState: 'open', oldState: 'closed' }));
  }
  return { ...view, client };
}

function Location() {
  return <span data-testid="location">{useLocation().pathname}</span>;
}

test.each([false, true])('Save and its undo act in place, without navigation (compact: %s)', async (compact) => {
  mount(compact);
  const save = await screen.findByRole('button', { name: 'Save to Read for “A paper”' });
  await waitFor(() => expect(save).toBeEnabled());
  fireEvent.click(save);
  const saved = await screen.findByRole('button', { name: 'Saved for “A paper”' });
  expect(saved).toHaveAttribute('aria-pressed', 'true');
  await waitFor(() => expect(saved).toBeEnabled());
  fireEvent.click(saved);
  await screen.findByRole('button', { name: 'Save to Read for “A paper”' });
  expect(api.POST).toHaveBeenCalledWith('/api/reading-queue', { body: { document_id: 7 } });
  expect(api.DELETE).toHaveBeenCalledWith('/api/reading-queue/{document_id}', { params: { path: { document_id: 7 } } });
  expect(screen.getByTestId('location')).toHaveTextContent(/^\/$/);
});

test('PDF action changes from Get to Read after the Library holds it', async () => {
  mount();
  fireEvent.click(await screen.findByRole('button', { name: 'Get the PDF for “A paper”' }));
  expect(await screen.findByRole('link', { name: 'Read the PDF for “A paper”' })).toHaveAttribute('href', '/library/files/file?paper=7');
});

test('with no licensed copy, the source and the project menu say why', async () => {
  status = { ...openCopy, downloadable: false, best: null, why_not_words: 'No source states an open license for a copy.' };
  mount();
  expect(await screen.findByRole('link', { name: 'Open at OpenAlex for “A paper”' })).toHaveAttribute('href', 'https://journal.example/7');
  expect(screen.getByText(status.why_not_words!)).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Add to a Project for “A paper”' }));
  expect(await screen.findByText(/The Library needs a PDF.*No source states an open license/)).toBeInTheDocument();
  expect(evidence.add).not.toHaveBeenCalled();
  expect(evidence.create).not.toHaveBeenCalled();
  expect(screen.getByTestId('location')).toHaveTextContent(/^\/$/);
});

test('the project picker gets a missing PDF before adding its exact version, with no page change', async () => {
  mount();
  fireEvent.click(screen.getByRole('button', { name: 'Add to a Project for “A paper”' }));
  fireEvent.click(await screen.findByRole('button', { name: /Reading 0 files/ }));
  await waitFor(() => expect(evidence.add).toHaveBeenCalledWith(project, file));
  expect(api.POST.mock.calls.findIndex(([route]) => route === '/api/documents/{doc_id}/full-text')).toBeGreaterThanOrEqual(0);
  expect(screen.getByRole('link', { name: 'Reading' })).toHaveAttribute('href', '/library/evidence?project=project');
  expect(screen.getByTestId('location')).toHaveTextContent(/^\/$/);
  expect(evidence.create).not.toHaveBeenCalled();
});

test('a held PDF is added through New Project without another download', async () => {
  status = { ...openCopy, in_library: held };
  mount();
  fireEvent.click(screen.getByRole('button', { name: 'Add to a Project for “A paper”' }));
  await chooseNew();
  fireEvent.change(screen.getByRole('textbox', { name: 'Project Name' }), { target: { value: 'New reading' } });
  fireEvent.click(screen.getByRole('button', { name: 'Create and Add' }));
  await waitFor(() => expect(evidence.create).toHaveBeenCalledWith('vault', 'New reading'));
  await waitFor(() => expect(evidence.add).toHaveBeenCalledWith(project, file));
  expect(api.POST.mock.calls.filter(([route]) => route === '/api/documents/{doc_id}/full-text')).toHaveLength(0);
});

test('a refused download keeps its reason and browser action, and never adds a file', async () => {
  const words = 'repo.example refused a download from resmon (HTTP 403).';
  status = { ...openCopy, download: request({ state: 'failed', reason: 'site_refused', words }) };
  const openPath = jest.fn().mockResolvedValue('');
  Object.assign(window, { resmonAPI: { getBackendPort: () => '49153', getApiToken: () => null, openPath } });
  try {
    mount();
    fireEvent.click(await screen.findByRole('button', { name: 'Open the Copy in Your Browser for “A paper”' }));
    expect(openPath).toHaveBeenCalledWith('https://repo.example/7.pdf');
    expect(screen.getByText(words)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Add to a Project for “A paper”' }));
    await screen.findByText(`The Library needs a PDF before this paper can be added. ${words}`);
    expect(evidence.add).not.toHaveBeenCalled();
  } finally { delete (window as unknown as { resmonAPI?: unknown }).resmonAPI; }
});

test('a skipped download explains the failed add and makes no empty project', async () => {
  api.POST.mockImplementation((route: string) => {
    if (route === '/api/full-text/for-documents') return reply([status]);
    status = { ...openCopy, download: request({ state: 'skipped', reason: 'daily_cap', words: 'The daily download limit was reached.' }) };
    return reply(status.download);
  });
  mount();
  fireEvent.click(screen.getByRole('button', { name: 'Add to a Project for “A paper”' }));
  await chooseNew();
  fireEvent.change(screen.getByRole('textbox', { name: 'Project Name' }), { target: { value: 'No empty project' } });
  fireEvent.click(screen.getByRole('button', { name: 'Create and Add' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('The daily download limit was reached.');
  expect(evidence.create).not.toHaveBeenCalled();
  expect(evidence.add).not.toHaveBeenCalled();
});

test('closing while a PDF is pending prevents the later project write', async () => {
  status = { ...openCopy, download: request({ state: 'downloading' }) };
  mount();
  fireEvent.click(screen.getByRole('button', { name: 'Add to a Project for “A paper”' }));
  fireEvent.click(await screen.findByRole('button', { name: /Reading 0 files/ }));
  await screen.findByText('Getting the PDF if needed, then adding it to the project.');
  fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
  status = { ...openCopy, in_library: held };
  await act(async () => { await Promise.resolve(); });
  expect(evidence.add).not.toHaveBeenCalled();
  expect(evidence.create).not.toHaveBeenCalled();
});

test('a changed vault or PDF version is refused before adding', async () => {
  status = { ...openCopy, in_library: { ...held, vault_id: 'another' } };
  await expect(preparePaperFile(7, 'vault', new AbortController().signal)).rejects.toThrow('The Library changed');
  status = { ...openCopy, in_library: held };
  api.GET.mockResolvedValue({ data: { file: { ...file, version_id: 'another' }, vault_id: 'vault' }, response: {} });
  await expect(preparePaperFile(7, 'vault', new AbortController().signal)).rejects.toThrow('no longer holds that exact PDF');
});

test('a Library being relinked says why the project picker cannot proceed yet', async () => {
  const normal = api.GET.getMockImplementation()!;
  api.GET.mockImplementation((route: string, options: unknown) => route === '/api/library'
    ? reply({ status: 'ready', vault: { vault_id: 'vault' }, changing: 'relinking' }) : normal(route, options));
  mount();
  fireEvent.click(screen.getByRole('button', { name: 'Add to a Project for “A paper”' }));
  expect(await screen.findByText('resmon is checking the Library folder you chose. Try again in a moment.')).toBeInTheDocument();
  expect(evidence.projects).not.toHaveBeenCalled();
  expect(evidence.add).not.toHaveBeenCalled();
});

test('the compact actions return keyboard focus on Escape', async () => {
  mount(true);
  const save = await screen.findByRole('button', { name: 'Save to Read for “A paper”' });
  fireEvent.keyDown(save, { key: 'Escape' });
  expect(screen.getByRole('button', { name: 'Paper Actions for “A paper”' })).toHaveFocus();
  expect(screen.queryByRole('button', { name: 'Add to a Project for “A paper”' })).not.toBeInTheDocument();
});

test('a refused save leaves the other paper actions available and says what failed', async () => {
  api.POST.mockImplementation((route: string) => route === '/api/reading-queue'
    ? Promise.reject(new Error('The paper could not be saved.')) : reply([status]));
  mount();
  const save = await screen.findByRole('button', { name: 'Save to Read for “A paper”' });
  await waitFor(() => expect(save).toBeEnabled());
  fireEvent.click(save);
  expect(await screen.findByRole('alert')).toHaveTextContent('The paper could not be saved.');
  expect(save).toHaveAttribute('aria-pressed', 'false');
  expect(screen.getByRole('button', { name: 'Add to a Project for “A paper”' })).toBeEnabled();
  expect(screen.getByRole('button', { name: 'Get the PDF for “A paper”' })).toBeEnabled();
});

test('a save does not cancel an outstanding PDF request or discard its result', async () => {
  let release!: (value: unknown) => void;
  const normal = api.POST.getMockImplementation()!;
  api.POST.mockImplementation((route: string, options: unknown) => route === '/api/documents/{doc_id}/full-text'
    ? new Promise((resolve) => { release = resolve; }) : normal(route, options));
  mount();
  const get = await screen.findByRole('button', { name: 'Get the PDF for “A paper”' });
  fireEvent.click(get);
  await waitFor(() => expect(get).toBeDisabled());
  const save = screen.getByRole('button', { name: 'Save to Read for “A paper”' });
  await waitFor(() => expect(save).toBeEnabled());
  fireEvent.click(save);
  await screen.findByRole('button', { name: 'Saved for “A paper”' });
  status = { ...openCopy, in_library: held };
  await act(async () => { release(await reply(request({ state: 'stored', file_id: 'file' }))); });
  expect(await screen.findByRole('link', { name: 'Read the PDF for “A paper”' })).toHaveAttribute('href', '/library/files/file?paper=7');
});

test('Save restores keyboard focus after its queue state has been read again', async () => {
  let finishRead!: (value: unknown) => void;
  let reads = 0;
  const normal = api.GET.getMockImplementation()!;
  api.GET.mockImplementation((route: string, options: unknown) => route === '/api/library/papers/{document_id}/places' && reads++ > 0
    ? new Promise((resolve) => { finishRead = resolve; }) : normal(route, options));
  mount();
  const save = await screen.findByRole('button', { name: 'Save to Read for “A paper”' });
  await waitFor(() => expect(save).toBeEnabled());
  save.focus();
  fireEvent.click(save);
  save.blur();
  const saved = await screen.findByRole('button', { name: 'Saved for “A paper”' });
  expect(saved).toHaveAttribute('aria-disabled', 'true');
  await act(async () => { finishRead(await reply({ document_id: 7, shelf: { status: 'to_read' }, files: [], projects: [], library: { status: 'ready' } })); });
  await waitFor(() => expect(saved).toHaveFocus());
});

test('a background read of the places, such as the busy Library poll, never disables Save', async () => {
  const { client } = mount();
  const save = await screen.findByRole('button', { name: 'Save to Read for “A paper”' });
  await waitFor(() => expect(save).toBeEnabled());
  const normal = api.GET.getMockImplementation()!;
  api.GET.mockImplementation((route: string, options: unknown) => route === '/api/library/papers/{document_id}/places'
    ? new Promise(() => { /* a read still under way */ }) : normal(route, options));
  await act(async () => { void client.refetchQueries({ queryKey: ['paper-places', 7] }); });
  await waitFor(() => expect(client.getQueryState(['paper-places', 7])?.fetchStatus).toBe('fetching'));
  expect(save).toBeEnabled();
});

test('a save refreshes only this paper’s places and never refetches document detail', async () => {
  const { client } = mount();
  client.setQueryData(['paper-places', 8], { document_id: 8 });
  const save = await screen.findByRole('button', { name: 'Save to Read for “A paper”' });
  await waitFor(() => expect(save).toBeEnabled());
  api.GET.mockClear();
  fireEvent.click(save);
  await screen.findByRole('button', { name: 'Saved for “A paper”' });
  await waitFor(() => expect(api.GET).toHaveBeenCalledWith('/api/library/papers/{document_id}/places', expect.anything()));
  expect(api.GET.mock.calls.every(([route]) => route !== '/api/documents/{doc_id}')).toBe(true);
  expect(client.getQueryState(['paper-places', 8])?.isInvalidated).toBe(false);
});

test.each(['read', 'to_read'])('Saved offers Undo with the engine’s exact %s dates', async (shelf) => {
  const entry = { document_id: 7, status: shelf, saved_at: '2026-10-01T12:00:00Z',
    updated_at: '2026-11-07T12:00:00Z', read_at: shelf === 'read' ? '2026-11-07T12:00:00Z' : null };
  queue = shelf;
  api.DELETE.mockImplementation(() => { queue = null; return reply({ removed: true, entry }); });
  const normal = api.POST.getMockImplementation()!;
  api.POST.mockImplementation((route: string, options: unknown) => {
    if (route === '/api/reading-queue/{document_id}/restore') { queue = shelf; return reply({ restored: true, entry }); }
    return normal(route, options);
  });
  mount(true);
  const saved = await screen.findByRole('button', { name: 'Saved for “A paper”' });
  await waitFor(() => expect(saved).toBeEnabled());
  fireEvent.click(saved);
  fireEvent.click(await screen.findByRole('button', { name: 'Undo' }));
  await waitFor(() => expect(api.POST).toHaveBeenCalledWith('/api/reading-queue/{document_id}/restore', {
    params: { path: { document_id: 7 } }, body: { status: shelf, saved_at: entry.saved_at, updated_at: entry.updated_at, read_at: entry.read_at },
  }));
  expect(await screen.findByRole('button', { name: 'Saved for “A paper”' })).toHaveAttribute('aria-pressed', 'true');
});

test('opening focuses the first control only when the native popover is shown', async () => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(<QueryClientProvider client={client}><MemoryRouter>
    <PaperActions id={7} title="A paper" sourceName="OpenAlex" sourceUrl={null} compact />
  </MemoryRouter></QueryClientProvider>);
  const trigger = screen.getByRole('button', { name: 'Paper Actions for “A paper”' });
  trigger.focus();
  fireEvent.click(trigger);
  const dialog = screen.getByRole('dialog');
  expect(trigger).toHaveFocus();
  fireEvent(dialog, Object.assign(new Event('toggle'), { newState: 'open', oldState: 'closed' }));
  // Save stays the first keyboard stop while its places are being read.
  const first = screen.getByRole('button', { name: 'Save to Read for “A paper”' });
  expect(first).toHaveFocus();
  expect(first).toHaveAttribute('aria-disabled', 'true');
  fireEvent.click(first);
  expect(api.POST).not.toHaveBeenCalledWith('/api/reading-queue', expect.anything());
  await waitFor(() => expect(screen.getByRole('button', { name: 'Save to Read for “A paper”' })).toHaveAttribute('aria-disabled', 'false'));
  trigger.focus();
  fireEvent(dialog, Object.assign(new Event('toggle'), { newState: 'open', oldState: 'closed' }));
  expect(screen.getByRole('button', { name: 'Save to Read for “A paper”' })).toHaveFocus();
  trigger.focus();
  fireEvent.click(screen.getByRole('button', { name: 'Paper Actions for “A paper”' }));
  fireEvent(dialog, Object.assign(new Event('toggle'), { newState: 'closed', oldState: 'open' }));
  expect(trigger).toHaveFocus();
});

test('light dismissal keeps focus on the field clicked outside the popover', async () => {
  mount(true);
  const dialog = screen.getByRole('dialog');
  const field = document.createElement('input');
  document.body.append(field);
  field.focus();
  fireEvent(dialog, Object.assign(new Event('toggle', { bubbles: true }), { newState: 'closed', oldState: 'open' }));
  expect(field).toHaveFocus();
  field.remove();
});

test('a row removal puts its Undo notice outside the row in the document body', async () => {
  queue = 'to_read';
  mount(true, 7, 'A paper', true);
  const saved = await screen.findByRole('button', { name: 'Saved for “A paper”' });
  await waitFor(() => expect(saved).toBeEnabled());
  fireEvent.click(saved);
  const undo = await screen.findByRole('button', { name: 'Undo' });
  expect(undo.closest('li')).toBeNull();
  expect(undo.closest('.lib-notice')?.parentElement).toBe(document.body);
});

test('the project sheet keeps its form and folder through a busy Library and recovers', async () => {
  const { client } = mount();
  fireEvent.click(screen.getByRole('button', { name: 'Add to a Project for “A paper”' }));
  await chooseNew();
  const dialog = screen.getByRole('dialog');
  fireEvent.change(screen.getByRole('textbox', { name: 'Project Name' }), { target: { value: 'Kept name' } });
  await act(async () => { client.setQueryData(['library'], { status: 'busy', vault: { vault_id: 'vault' } }); });
  expect(screen.getByRole('dialog')).toBe(dialog);
  expect(screen.getByRole('textbox', { name: 'Project Name' })).toHaveValue('Kept name');
  await waitFor(() => expect(screen.getByRole('button', { name: 'Create and Add' })).toBeDisabled());
  expect(within(dialog).getByRole('status')).toHaveTextContent('Another import');
  await act(async () => { client.setQueryData(['library'], { status: 'ready', vault: { vault_id: 'vault' } }); });
  await waitFor(() => expect(screen.getByRole('button', { name: 'Create and Add' })).toBeEnabled());
});

function picker(onClose = jest.fn()) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(<QueryClientProvider client={client}><AddToProject vault="vault" files={[file]} onClose={onClose} onAdded={jest.fn()} /></QueryClientProvider>);
  return onClose;
}

test('a busy project sheet polls and becomes ready without closing', async () => {
  const normal = api.GET.getMockImplementation()!;
  let busy = true;
  api.GET.mockImplementation((route: string, options: unknown) => route === '/api/library'
    ? reply({ status: busy ? 'busy' : 'ready', vault: { vault_id: 'vault' } }) : normal(route, options));
  mount();
  fireEvent.click(screen.getByRole('button', { name: 'Add to a Project for “A paper”' }));
  await screen.findByText('Another import into this Library is still finishing. Try again in a moment.');
  const dialog = screen.getByRole('dialog');
  busy = false;
  await waitFor(() => expect(screen.getByRole('button', { name: 'New Project…' })).toBeEnabled(), { timeout: 3000 });
  expect(screen.getByRole('dialog')).toBe(dialog);
  expect(screen.queryByText(/Another import/)).not.toBeInTheDocument();
});

test('the picker reads all project pages, newest change first, and finds names', async () => {
  const rows = Array.from({ length: 51 }, (_, n) => ({ ...project, id: n + 1, project_id: `p${n}`, name: `Project ${n}`,
    updated_at_utc: `2026-11-${n === 50 ? '08' : '01'}T12:00:00Z` }));
  (evidence.projectsPage as jest.Mock).mockImplementation((_vault: string, after?: number) => Promise.resolve({
    projects: after ? rows.slice(50) : rows.slice(0, 50), has_more: !after, next_after_id: after ? null : 50,
  }));
  picker();
  const find = await screen.findByRole('searchbox', { name: 'Find a project' });
  expect(screen.getAllByRole('button', { name: /^Project / })[0]).toHaveTextContent('Project 50');
  fireEvent.change(find, { target: { value: '50' } });
  fireEvent.click(screen.getByRole('button', { name: /Project 50/ }));
  await waitFor(() => expect(evidence.add).toHaveBeenCalledWith(rows[50], file));
});

test('Cancel and Escape wait for Create; an add failure retries the project already created', async () => {
  let created!: (value: unknown) => void;
  (evidence.create as jest.Mock).mockImplementation(() => new Promise((resolve) => { created = resolve; }));
  (evidence.add as jest.Mock).mockRejectedValueOnce(new Error('The file could not be added.'));
  const closed = picker();
  await chooseNew();
  fireEvent.change(screen.getByRole('textbox', { name: 'Project Name' }), { target: { value: 'Keep this project' } });
  fireEvent.click(screen.getByRole('button', { name: 'Create and Add' }));
  await waitFor(() => expect(evidence.create).toHaveBeenCalledTimes(1));
  expect(screen.getByRole('button', { name: 'Cancel' })).toBeDisabled();
  fireEvent(screen.getByRole('dialog'), new Event('cancel', { bubbles: true, cancelable: true }));
  expect(closed).not.toHaveBeenCalled();
  await act(async () => { created({ project }); });
  expect(await screen.findByRole('alert')).toHaveTextContent('The file could not be added.');
  fireEvent.click(screen.getByRole('button', { name: /Retry Add/ }));
  await waitFor(() => expect(evidence.add).toHaveBeenCalledTimes(2));
  expect(evidence.create).toHaveBeenCalledTimes(1);
});

test.each(['success', 'failure'])('repeated Escape and a native close keep Create visible through %s, then the picker works again', async (outcome) => {
  let finish!: (value: unknown) => void;
  let fail!: (error: Error) => void;
  (evidence.create as jest.Mock).mockImplementationOnce(() => new Promise((resolve, reject) => { finish = resolve; fail = reject; }));
  mount();
  fireEvent.click(screen.getByRole('button', { name: 'Add to a Project for “A paper”' }));
  await chooseNew();
  fireEvent.change(screen.getByRole('textbox', { name: 'Project Name' }), { target: { value: 'A project' } });
  fireEvent.click(screen.getByRole('button', { name: 'Create and Add' }));
  await waitFor(() => expect(evidence.create).toHaveBeenCalledTimes(1));
  const dialog = screen.getByRole('dialog');
  for (let n = 0; n < 2; n += 1) {
    expect(fireEvent.keyDown(dialog, { key: 'Escape', cancelable: true })).toBe(false);
    expect(dialog).toHaveAttribute('open');
  }
  // A native close can also come from outside the keyboard path.
  dialog.removeAttribute('open');
  fireEvent(dialog, new Event('close'));
  expect(dialog).toHaveAttribute('open');
  expect(screen.getByText('Creating the project. Cancel is available when this finishes.')).toBeVisible();
  await act(async () => { if (outcome === 'success') finish({ project }); else fail(new Error('Create was refused.')); });
  if (outcome === 'failure') {
    expect(await screen.findByRole('alert')).toHaveTextContent('Create was refused.');
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
  } else {
    await waitFor(() => expect(evidence.add).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(dialog).not.toBeInTheDocument());
  }
  fireEvent.click(screen.getByRole('button', { name: 'Add to a Project for “A paper”' }));
  expect(await screen.findByRole('button', { name: /Reading 0 files/ })).toBeEnabled();
  expect(screen.getByRole('dialog')).toHaveAttribute('open');
});

async function chooseNew() {
  const button = await screen.findByRole('button', { name: 'New Project…' });
  await waitFor(() => expect(button).toBeEnabled());
  fireEvent.click(button);
}
