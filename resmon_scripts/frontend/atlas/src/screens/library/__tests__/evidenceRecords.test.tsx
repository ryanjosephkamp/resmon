/**
 * Evidence's lists hold everything the project and the Library hold, however
 * long: the files and records are read a page at a time under one ceiling,
 * records sit under their file, Add Files reads every kept file and finds by
 * name or linked paper title, and a pending passage can be let go with Cancel
 * or Escape without losing the note typed for it. The engine and the reader
 * are stand-ins; nothing here reaches a socket.
 */
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { engine } from '../../../api/client';
import type { Anchor, FileRecord, Member, Note, Project } from '../evidenceApi';
import { fileFound, groupByFile } from '../evidenceModel';

jest.mock('../../../api/client', () => ({ ...jest.requireActual('../../../api/client'), engine: jest.fn() }));
jest.mock('../../../bridge', () => ({ isMac: () => true, bridge: () => ({ getBackendPort: () => '51000', getApiToken: () => 'token' }) }));

const ANCHOR: Anchor = {
  page_number: 1, extraction_contract: 'pypdf-6.18.1/plain-lf/v1', page_text_sha256: 'a'.repeat(64),
  start_codepoint: 9, end_codepoint: 20, quote: 'We presentU',
};
jest.mock('../Reader', () => ({
  Reader: ({ file, onAnchor }: { file: { original_name: string }; onAnchor?: (a: Anchor) => void }) => (
    <section aria-label="Reader stand-in">
      <p>{file.original_name}</p>
      <button type="button" onClick={() => onAnchor?.(ANCHOR)}>Use Selected Passage</button>
    </section>
  ),
}));

const PROJECT = {
  id: 1, project_id: 'p1', vault_id: 'v', name: 'splats', revision: 4, file_count: 3, note_count: 0,
  created_at_utc: '2026-11-10T12:00:00Z', updated_at_utc: '2026-11-10T12:00:00Z',
} as unknown as Project;

const file = (n: number): FileRecord => ({
  file_id: `f${n}`, version_id: `v${n}`, vault_id: 'v', sha256: String(n).repeat(64).slice(0, 64), byte_size: 1000 + n,
  media_type: 'application/pdf', original_name: `paper-${n}.pdf`, created_at_utc: '2026-11-10T12:00:00Z',
});
const member = (n: number, id = n): Member => ({
  id, project_id: 'p1', file_id: `f${n}`, version_id: `v${n}`, added_at_utc: '2026-11-10T12:00:00Z', file: file(n), availability: 'not_checked',
});
const note = (id: number, n: number, over: Partial<Note> = {}): Note => ({
  id, note_id: `n${id}`, project_id: 'p1', file_id: `f${n}`, version_id: `v${n}`, kind: 'note', body: `note ${id} on paper ${n}`,
  page_number: null, extraction_contract: null, page_text_sha256: null, start_codepoint: null, end_codepoint: null, quote: null,
  revision: 1, created_at_utc: '2026-11-10T12:00:00Z', updated_at_utc: '2026-11-10T12:00:00Z',
  file: file(n), membership_state: 'member', resolution: 'not_checked', ...over,
});

/** A list the engine pages by id: 50 at a time from `after_id`, under `through_id`. */
function paged<T extends { id: number }>(items: T[], key: string, url: URL) {
  const after = Number(url.searchParams.get('after_id') ?? 0);
  const through = Number(url.searchParams.get('through_id') ?? Math.max(0, ...items.map((i) => i.id)));
  const limit = Number(url.searchParams.get('limit') ?? 50);
  const under = items.filter((i) => i.id > after && i.id <= through);
  const page = under.slice(0, limit);
  const more = under.length > limit;
  return {
    contract_version: 1, vault_id: 'v', project_id: 'p1', revision: 4, [key]: page, through_id: through,
    next_after_id: more ? page[page.length - 1]!.id : null, has_more: more, total: items.filter((i) => i.id <= through).length,
    count_basis: 'current rows at the selected ID ceiling; removals may change counts',
  };
}

let members: Member[] = [];
let notes: Note[] = [];
let asked: string[] = [];
const realFetch = globalThis.fetch;
beforeEach(() => {
  asked = [];
  globalThis.fetch = jest.fn((address: string) => {
    const url = new URL(address);
    asked.push(`${url.pathname}${url.search}`);
    let body: unknown = { contract_version: 1, vault_id: 'v', projects: [PROJECT], through_id: 1, next_after_id: null, has_more: false, total: 1 };
    if (url.pathname.endsWith('/projects/p1')) body = { contract_version: 1, vault_id: 'v', project_id: 'p1', project: PROJECT };
    if (url.pathname.endsWith('/files')) body = paged(members, 'files', url);
    if (url.pathname.endsWith('/notes')) body = paged(notes, 'notes', url);
    return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(body) });
  }) as unknown as typeof fetch;
});
afterEach(() => { globalThis.fetch = realFetch; });

/** The Library's kept files, 500 to a page by name, with paper links. */
function library(kept: Array<{ n: number; title?: string }>) {
  const calls: string[] = [];
  const files = kept.map(({ n, title }) => ({
    ...file(n), id: n, relative_path: `files/f${n}`, paper_links: title ? [{ document_id: n, title, identity_scope: 'this app database only', basis: 'owner_association' }] : [],
    project_count: 0, availability: 'not_checked',
  }));
  (engine as jest.Mock).mockReturnValue({
    GET: (path: string, init: { params?: { query?: { offset?: number; limit?: number } } }) => {
      if (path === '/api/library') return Promise.resolve({ data: { status: 'ready', vault: { vault_id: 'v' } }, response: {} });
      const offset = init.params?.query?.offset ?? 0;
      const limit = init.params?.query?.limit ?? 50;
      calls.push(`offset=${offset}`);
      const page = files.slice(offset, offset + limit);
      return Promise.resolve({
        data: { version: 1, vault_id: 'v', files: page, through_id: files.length, next_before_id: null, has_more: offset + limit < files.length, sort: 'name', offset, total: files.length },
        response: {},
      });
    },
  });
  return calls;
}

async function mount() {
  const { Evidence } = await import('../Evidence');
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(<QueryClientProvider client={client}><MemoryRouter initialEntries={['/library/evidence?project=p1']}><Evidence /></MemoryRouter></QueryClientProvider>);
  return screen.findByRole('region', { name: 'Saved evidence notes' });
}

test('every file and record is read, a page at a time under the first page’s ceiling', async () => {
  members = Array.from({ length: 120 }, (_, i) => member(i + 1));
  notes = Array.from({ length: 130 }, (_, i) => note(i + 1, (i % 3) + 1));
  library([]);
  const panel = await mount();
  await waitFor(() => expect(panel.querySelectorAll('ol.ev-saved > li')).toHaveLength(130));
  expect(document.querySelectorAll('.ev-members li')).toHaveLength(120);
  const notePages = asked.filter((a) => a.includes('/notes'));
  expect(notePages).toHaveLength(3);
  for (const later of notePages.slice(1)) expect(later).toContain('through_id=130');
  expect(screen.queryByText(/Showing \d+ of/)).toBeNull();
});

test('records sit under their file in the project’s order, newest first, and This File Only narrows to the open file', async () => {
  members = [member(2, 1), member(1, 2)];
  notes = [note(1, 1), note(2, 2), note(3, 1), note(4, 9, { file: file(9), membership_state: 'removed' })];
  library([]);
  const panel = await mount();
  await waitFor(() => expect(panel.querySelectorAll('section.ev-group')).toHaveLength(3));
  const groups = Array.from(panel.querySelectorAll('section.ev-group'));
  expect(groups.map((g) => g.querySelector('.ev-saved-file')!.textContent)).toEqual(['paper-2.pdf', 'paper-1.pdf', 'paper-9.pdf']);
  expect(Array.from(groups[1]!.querySelectorAll('li'), (li) => li.getAttribute('data-note'))).toEqual(['n3', 'n1']);
  expect(groups[2]).toHaveTextContent('file removed from the project');

  // The first file in the project is the one open.
  fireEvent.click(within(panel).getByRole('button', { name: 'This File Only' }));
  expect(panel.querySelectorAll('section.ev-group')).toHaveLength(1);
  expect(panel.querySelector('.ev-group .ev-saved-file')).toHaveTextContent('paper-2.pdf');
  fireEvent.click(within(panel).getByRole('button', { name: 'All Files' }));
  expect(panel.querySelectorAll('section.ev-group')).toHaveLength(3);
});

test('Cancel and Escape let a pending passage go and keep the note typed for it', async () => {
  members = [member(1)];
  notes = [];
  library([]);
  const panel = await mount();
  fireEvent.click(await screen.findByRole('button', { name: 'Use Selected Passage' }));
  expect(within(panel).getByRole('heading', { name: 'New Exact Passage' })).toBeInTheDocument();
  fireEvent.change(within(panel).getByLabelText('Your note on it (optional)'), { target: { value: 'Worth citing.' } });
  fireEvent.click(within(panel).getByRole('button', { name: 'Cancel' }));
  expect(within(panel).getByRole('heading', { name: 'New Plain Note' })).toBeInTheDocument();
  expect(within(panel).getByLabelText('Note')).toHaveValue('Worth citing.');
  expect(within(panel).queryByRole('button', { name: 'Cancel' })).toBeNull();

  // Escape from the note box, and from outside any field.
  fireEvent.click(screen.getByRole('button', { name: 'Use Selected Passage' }));
  fireEvent.keyDown(within(panel).getByLabelText('Your note on it (optional)'), { key: 'Escape' });
  expect(within(panel).getByRole('heading', { name: 'New Plain Note' })).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Use Selected Passage' }));
  act(() => { fireEvent.keyDown(document.body, { key: 'Escape' }); });
  expect(within(panel).getByRole('heading', { name: 'New Plain Note' })).toBeInTheDocument();
  expect(within(panel).getByLabelText('Note')).toHaveValue('Worth citing.');
});

test('Cancel on an edit leaves the saved body alone and gives the box back what it held', async () => {
  members = [member(1)];
  notes = [note(1, 1, { body: 'The saved body.' })];
  library([]);
  const panel = await mount();
  fireEvent.change(await within(panel).findByLabelText('Note'), { target: { value: 'A draft of my own.' } });
  fireEvent.click(within(panel).getByRole('button', { name: 'Edit the Body' }));
  expect(within(panel).getByRole('heading', { name: 'Edit the Saved Body · paper-1.pdf' })).toBeInTheDocument();
  expect(within(panel).getByLabelText('Note')).toHaveValue('The saved body.');
  fireEvent.click(within(panel).getByRole('button', { name: 'Cancel' }));
  expect(within(panel).getByRole('heading', { name: 'New Plain Note' })).toBeInTheDocument();
  expect(within(panel).getByLabelText('Note')).toHaveValue('A draft of my own.');
  expect(within(panel).getByText('The saved body.')).toBeInTheDocument();
});

test('Add Files reads every kept file, leaves out every file the project holds, and finds by name or linked title', async () => {
  members = Array.from({ length: 60 }, (_, i) => member(i + 1));
  notes = [];
  const kept = Array.from({ length: 700 }, (_, i) => ({ n: i + 1, title: i + 1 === 650 ? 'UltraVoxelGS: Voxel-First Gaussian Splatting' : undefined }));
  const calls = library(kept);
  await mount();
  fireEvent.click(await screen.findByRole('button', { name: 'Add Files' }));
  const chooser = await screen.findByRole('region', { name: 'Add Files from the Library' });
  await waitFor(() => expect(within(chooser).getByText('640 files to choose from')).toBeInTheDocument());
  expect(calls).toEqual(['offset=0', 'offset=500']);
  // The 51st to 60th files are in the project too, so none of them is offered.
  expect(within(chooser).queryByText('paper-55.pdf')).toBeNull();
  // 400 are drawn, and the rest a button away.
  expect(chooser.querySelectorAll('input[type="checkbox"]')).toHaveLength(400);
  expect(within(chooser).getByRole('button', { name: 'Show 240 More' })).toBeInTheDocument();

  fireEvent.click(within(chooser).getByRole('checkbox', { name: /paper-61\.pdf/ }));
  fireEvent.change(within(chooser).getByRole('searchbox', { name: 'Find a file or paper title' }), { target: { value: 'voxel-first' } });
  await waitFor(() => expect(within(chooser).getByText('1 of 640 files matches')).toBeInTheDocument());
  expect(within(chooser).getByRole('checkbox', { name: /paper-650\.pdf/ })).toBeInTheDocument();
  expect(within(chooser).getByText('1 chosen file not shown by this find')).toBeInTheDocument();
  expect(within(chooser).getByRole('button', { name: 'Add 1 File' })).toBeEnabled();
});

test('records group by exact version, and a find matches a name or a linked paper’s title', () => {
  const twoVersions = [note(1, 1), note(2, 1, { version_id: 'v1b', file: { ...file(1), version_id: 'v1b' } })];
  expect(groupByFile(twoVersions, [member(1)]).map((g) => [g.key, g.member])).toEqual([['f1:v1', true], ['f1:v1b', false]]);
  const kept = { original_name: 'Wang 2026.pdf', paper_links: [{ title: 'UltraVoxelGS' }] };
  expect(fileFound(kept, '  wang ')).toBe(true);
  expect(fileFound(kept, 'ultravoxel')).toBe(true);
  expect(fileFound(kept, 'splat')).toBe(false);
  expect(fileFound(kept, '')).toBe(true);
});
