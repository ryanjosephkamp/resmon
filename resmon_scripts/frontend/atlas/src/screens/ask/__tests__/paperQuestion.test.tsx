import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { engine } from '../../../api/client';
import { Paper } from '../../collection/Paper';
import { Ask } from '../Ask';
import { AskProvider } from '../AskProvider';
import { ask } from '../askApi';
import { paperFile } from '../AskAboutPaper';
import { Reader } from '../../library/Reader';
import type { FileRecord, Project } from '../../library/evidenceApi';

jest.mock('../../../api/client', () => ({ ...jest.requireActual('../../../api/client'), engine: jest.fn() }));
jest.mock('../../sky/PaperSky', () => ({ PaperSky: () => null, basisWords: () => 'by words' }));
jest.mock('../../lifecycle/LifecycleMarks', () => ({ PaperLifecycle: () => null }));
const reply = (data: unknown) => Promise.resolve({ data, response: {} });
let available = true;
const choices = { version: 1, default_error: null, limitations: 'Local prerequisites only.', claude_aliases: [], claude_efforts: [],
  default_request: { runtime: 'claude_cli', provider: 'claude_code', model: null, effort: null },
  connections: [{ runtime: 'claude_cli', provider: 'claude_code', label: 'Claude Code', implemented: true, available: true, reason: 'Found.' }] };
const paper = { id: 7, title: 'Spectral graph filters', authors: 'A. Fixture', source_repository: 'arxiv', collections: [] };
let POST: jest.Mock;
beforeEach(() => {
  available = true;
  POST = jest.fn(() => reply({ links: {} }));
  (engine as jest.Mock).mockReturnValue({ POST, GET: (route: string) => reply(
    route === '/api/assistant/status' ? { composer_choices: { ...choices, connections: choices.connections.map(c => ({ ...c, available })) } }
      : route === '/api/documents/{doc_id}' ? paper
        : route === '/api/documents/{doc_id}/why' ? { keywords: [], runs: [], what_resmon_cannot_see: [] }
          : route === '/api/repositories/catalog' ? []
            : route === '/api/assistant/sessions/browse' ? { sessions: [], has_more: false }
              : route === '/api/library/papers/{document_id}/places' ? { files: [{ file_id: 'file-7', original_name: 'spectral.pdf' }], projects: [] }
                : route === '/api/library/files/{file_id}' ? { file: { file_id: 'file-7', vault_id: 'vault', version_id: 'version', paper_links: [{ document_id: 7, title: 'Spectral graph filters' }] } }
                  : route.endsWith('/text') ? { status: 'extracted', text: 'An authored page.', page_number: 1, page_count: 1 }
                : route === '/api/ai/last-answered' ? { entries: [] }
                : route === '/api/ai/cli/sign-in' ? { status: 'signed_in' } : { pairs: [] }),
  });
});
afterEach(() => jest.restoreAllMocks());
function mount() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={client}><MemoryRouter initialEntries={['/papers/7']}><AskProvider><Routes>
    <Route path="/papers/:id" element={<Paper />} /><Route path="/ask" element={<Ask />} />
  </Routes></AskProvider></MemoryRouter></QueryClientProvider>);
}
test('a paper opens a named, editable question; no conversation or turn is sent until Send', async () => {
  const turn = jest.spyOn(ask, 'turn').mockResolvedValue();
  const create = jest.spyOn(ask, 'create').mockResolvedValue({ id: 31 } as Awaited<ReturnType<typeof ask.create>>);
  jest.spyOn(ask, 'detail').mockImplementation(() => new Promise(() => undefined));
  mount();
  await screen.findByRole('link', { name: /spectral.pdf/ });
  fireEvent.click(await screen.findByRole('link', { name: 'Ask About This Paper' }));
  const composer = await screen.findByRole('textbox', { name: 'Message the Assistant' });
  await waitFor(() => expect((composer as HTMLTextAreaElement).value).toContain('Spectral graph filters'));
  expect((composer as HTMLTextAreaElement).value).toContain('spectral.pdf');
  expect((composer as HTMLTextAreaElement).value).toContain('7');
  expect(screen.getByRole('heading', { name: /Spectral graph filters/ })).toBeInTheDocument();
  expect(create).not.toHaveBeenCalled(); expect(turn).not.toHaveBeenCalled();
  expect(screen.getByText(/Sending attaches “spectral.pdf” to this conversation: the only Library file Ask may read here\./)).toBeInTheDocument();
  fireEvent.change(composer, { target: { value: 'Read paper 7 with the tools and explain its limitations.' } });
  fireEvent.click(screen.getByRole('button', { name: 'Send' }));
  await waitFor(() => expect(turn).toHaveBeenCalled());
  expect(screen.getByRole('heading', { name: /Spectral graph filters/ })).toBeInTheDocument();
  expect(create.mock.calls[0]?.[1]).toContain('Spectral graph filters');
  expect(create.mock.calls[0]?.[1]).toContain('spectral.pdf');
  // The paper's file is attached to the new conversation, and nothing else is.
  expect(create.mock.calls[0]?.[2]).toEqual([{ file_id: 'file-7' }]);
  expect(turn.mock.calls[0]?.[1].text).toBe('Read paper 7 with the tools and explain its limitations.');
});
test('without an available connection the paper points to Settings › AI', async () => {
  available = false; mount();
  expect(await screen.findByRole('link', { name: 'Set Up AI to Ask About This Paper' })).toHaveAttribute('href', '/settings/ai');
  expect(screen.queryByRole('link', { name: 'Ask About This Paper' })).toBeNull();
  expect(POST.mock.calls.filter(([route]) => route === '/api/assistant/sessions')).toHaveLength(0);
});

test('the Evidence reader carries its linked title and exact file into an unsent question', async () => {
  const turn = jest.spyOn(ask, 'turn').mockResolvedValue();
  const create = jest.spyOn(ask, 'create');
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const file: FileRecord = { file_id: 'file-7', vault_id: 'vault', version_id: 'version', original_name: 'spectral.txt',
    media_type: 'text/plain', sha256: 'a'.repeat(64), byte_size: 40, created_at_utc: '2026-11-09T10:00:00Z' };
  const project = { project_id: 'project', vault_id: 'vault', revision: 1 } as Project;
  render(<QueryClientProvider client={client}><MemoryRouter initialEntries={['/reader']}><AskProvider><Routes>
    <Route path="/reader" element={<Reader project={project} file={file} member pin={null} />} />
    <Route path="/ask" element={<Ask />} />
  </Routes></AskProvider></MemoryRouter></QueryClientProvider>);
  fireEvent.click(await screen.findByRole('link', { name: 'Ask About This Paper' }));
  const composer = await screen.findByRole('textbox', { name: 'Message the Assistant' });
  await waitFor(() => expect((composer as HTMLTextAreaElement).value).toContain('spectral.txt'));
  expect((composer as HTMLTextAreaElement).value).toContain('is attached to this conversation');
  expect((composer as HTMLTextAreaElement).value).toContain('Spectral graph filters');
  expect(create).not.toHaveBeenCalled(); expect(turn).not.toHaveBeenCalled();
  // The exact version the reader showed is the one attached.
  create.mockResolvedValue({ id: 32 } as Awaited<ReturnType<typeof ask.create>>);
  jest.spyOn(ask, 'detail').mockImplementation(() => new Promise(() => undefined));
  fireEvent.click(screen.getByRole('button', { name: 'Send' }));
  await waitFor(() => expect(turn).toHaveBeenCalled());
  expect(create.mock.calls[0]?.[2]).toEqual([{ file_id: 'file-7', version_id: 'version' }]);
});

test('a paper with no Library file says Ask works from its record, and attaches nothing', async () => {
  const turn = jest.spyOn(ask, 'turn').mockResolvedValue();
  const create = jest.spyOn(ask, 'create').mockResolvedValue({ id: 33 } as Awaited<ReturnType<typeof ask.create>>);
  jest.spyOn(ask, 'detail').mockImplementation(() => new Promise(() => undefined));
  const GET = (engine as jest.Mock)().GET as (route: string) => Promise<unknown>;
  (engine as jest.Mock).mockReturnValue({ POST, GET: (route: string) => route === '/api/library/papers/{document_id}/places'
    ? reply({ files: [], projects: [] }) : GET(route) });
  mount();
  fireEvent.click(await screen.findByRole('link', { name: 'Ask About This Paper' }));
  const composer = await screen.findByRole('textbox', { name: 'Message the Assistant' });
  await waitFor(() => expect((composer as HTMLTextAreaElement).value).toContain('read its record first'));
  expect(screen.getByText(/This paper has no file in your Library, so Ask works from its record/)).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Send' }));
  await waitFor(() => expect(turn).toHaveBeenCalled());
  expect(create.mock.calls[0]?.[2]).toBeUndefined();
});

test('the file a paper question attaches is its PDF in the Library folder, not a note beside it', () => {
  const note = { file_id: 'note', media_type: 'text/markdown', availability: 'not_checked' };
  const gone = { file_id: 'gone', media_type: 'application/pdf', availability: 'missing' };
  const pdf = { file_id: 'pdf', media_type: 'application/pdf', availability: 'not_checked' };
  expect(paperFile([note, gone, pdf])?.file_id).toBe('pdf');
  expect(paperFile([gone, note])?.file_id).toBe('note');
  expect(paperFile([gone])?.file_id).toBe('gone');
  expect(paperFile([])).toBeUndefined();
});
