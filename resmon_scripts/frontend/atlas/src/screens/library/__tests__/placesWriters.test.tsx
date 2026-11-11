import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { engine } from '../../../api/client';
import { FilePage } from '../FilePage';
import { Library } from '../Library';
import { Evidence } from '../Evidence';
import { evidence, type Project } from '../evidenceApi';
import { RunTabs, type RunPaper } from '../../runs/RunTabs';
import type { Run } from '../../runs/model';

jest.mock('../../../api/client', () => ({ ...jest.requireActual('../../../api/client'), engine: jest.fn() }));
jest.mock('../FileWording', () => ({ FileWording: () => null, CompareButton: () => null }));
jest.mock('../Gallery', () => ({ Gallery: () => null }));
jest.mock('../Reader', () => ({ Reader: () => null }));

const reply = (data: unknown) => Promise.resolve({ data, response: {} });
const file = { file_id: 'file', vault_id: 'vault', version_id: 'version', original_name: 'paper.bin', media_type: 'application/octet-stream',
  byte_size: 10, paper_links: [{ document_id: 7, title: 'A paper' }], project_count: 0, created_at_utc: '2026-11-08T12:00:00Z' };
const project = { project_id: 'project', vault_id: 'vault', name: 'Review', revision: 1, file_count: 0, note_count: 0 } as Project;
let api: { GET: jest.Mock; POST: jest.Mock; PUT: jest.Mock; DELETE: jest.Mock };

beforeEach(() => {
  jest.restoreAllMocks();
  api = {
    GET: jest.fn((route: string) => reply(route === '/api/library' ? { status: 'ready', vault: { vault_id: 'vault' }, counts: { items: 0 } }
      : route === '/api/library/files/{file_id}' ? { file }
        : route === '/api/documents/{doc_id}' ? { id: 7, title: 'A paper', queue_status: 'to_read' }
          : route === '/api/library/files/{file_id}/removal' ? { needs_confirmation: false }
            : route === '/api/reading-queue' ? { counts: { to_read: 0, read: 0 }, entries: [], total: 0 }
              : route === '/api/library/files' ? { files: [], has_more: false }
                : { papers: [], total: 0 })),
    POST: jest.fn(() => reply({})), PUT: jest.fn(() => reply({})), DELETE: jest.fn(() => reply({})),
  };
  (engine as jest.Mock).mockReturnValue(api);
  const page = { contract_version: 1, count_basis: 'catalog', has_more: false, next_after_id: null, through_id: 0, total: 0, vault_id: 'vault' };
  const identity = { contract_version: 1, vault_id: 'vault', project_id: 'project' };
  jest.spyOn(evidence, 'projectsPage').mockResolvedValue({ ...page, projects: [] });
  jest.spyOn(evidence, 'projects').mockResolvedValue({ ...page, projects: [project], total: 1 });
  jest.spyOn(evidence, 'detail').mockResolvedValue({ ...identity, project });
  jest.spyOn(evidence, 'members').mockResolvedValue({ ...page, ...identity, revision: 1, files: [] });
  jest.spyOn(evidence, 'notes').mockResolvedValue({ ...page, project_id: 'project', revision: 1, notes: [] });
  jest.spyOn(evidence, 'rename').mockResolvedValue({ ...identity, project: { ...project, name: 'Renamed' } });
});

function mount(node: React.ReactNode, entry: string | { pathname: string; search: string; state: unknown }) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  client.setQueryData(['paper-places', 7], { document_id: 7, files: [file], projects: [project] });
  client.setQueryData(['paper-places', 8], { document_id: 8, files: [], projects: [] });
  render(<QueryClientProvider client={client}><MemoryRouter initialEntries={[entry]}>{node}</MemoryRouter></QueryClientProvider>);
  return client;
}

async function expectOnlyThisPaper(client: QueryClient) {
  await waitFor(() => expect(client.getQueryState(['paper-places', 7])?.isInvalidated).toBe(true));
  expect(client.getQueryState(['paper-places', 8])?.isInvalidated).toBe(false);
}

test('marking a linked paper read on the file page invalidates its places', async () => {
  const client = mount(<Routes><Route path="/library/files/:fileId" element={<FilePage />} /></Routes>, '/library/files/file?paper=7');
  fireEvent.click(await screen.findByRole('button', { name: 'Mark Read' }));
  await waitFor(() => expect(api.PUT).toHaveBeenCalled());
  await expectOnlyThisPaper(client);
});

test('removing a file on its page invalidates its linked papers, and its Library Undo does too', async () => {
  const client = mount(<Routes>
    <Route path="/library/files/:fileId" element={<FilePage />} />
    <Route path="/library" element={<Library />} />
  </Routes>, '/library/files/file');
  fireEvent.click(await screen.findByRole('button', { name: 'Remove from Your Files' }));
  const undo = await screen.findByRole('button', { name: 'Undo' });
  await expectOnlyThisPaper(client);
  // Mark the inactive entry fresh again so the restore must invalidate it itself.
  client.setQueryData(['paper-places', 7], { document_id: 7, files: [], projects: [] });
  fireEvent.click(undo);
  await waitFor(() => expect(api.POST).toHaveBeenCalledWith('/api/library/removed/{file_id}/restore', expect.anything()));
  await expectOnlyThisPaper(client);
});

test('renaming an Evidence project invalidates the places containing it', async () => {
  const client = mount(<Evidence />, '/library/evidence?project=project');
  fireEvent.click(await screen.findByRole('button', { name: 'Rename' }));
  fireEvent.change(screen.getByRole('textbox', { name: 'The project’s name' }), { target: { value: 'Renamed' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save' }));
  await waitFor(() => expect(evidence.rename).toHaveBeenCalled());
  await expectOnlyThisPaper(client);
});

test('saving a paper from its run invalidates that paper’s places', async () => {
  const client = mount(<RunTabs run={{ id: 3 } as Run} live={[]} names={new Map()} events={[]} running={false} tab="Papers" onTab={() => undefined}
    papers={{ papers: [{ id: 7, title: 'A paper', source_repository: 'arxiv', authors: '', queue_status: null } as RunPaper], total: 1, searched: 1, q: '' }} />, '/runs/3');
  // A run's row offers the same Paper Actions as every list of papers. Its open control watches the places,
  // so they are read again at once: the call is checked, not a mark the refetch would clear.
  const invalidate = jest.spyOn(client, 'invalidateQueries');
  fireEvent.click(screen.getByRole('button', { name: 'Paper Actions for “A paper”' }));
  fireEvent(screen.getByRole('dialog'), Object.assign(new Event('toggle'), { newState: 'open', oldState: 'closed' }));
  fireEvent.click(await screen.findByRole('button', { name: 'Save to Read for “A paper”' }));
  await waitFor(() => expect(api.POST).toHaveBeenCalledWith('/api/reading-queue', { body: { document_id: 7 } }));
  await waitFor(() => expect(invalidate).toHaveBeenCalledWith({ queryKey: ['paper-places', 7] }));
  expect(invalidate).not.toHaveBeenCalledWith({ queryKey: ['paper-places', 8] });
});
