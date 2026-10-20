/**
 * Overlapping asynchronous operations — jsdom.
 *
 * One generation counter shared by several independent operations means that
 * starting any one of them throws away the outcome of every other one still in
 * flight. The result is not a wrong answer, it is no answer: the control was
 * pressed, the request completed, and nothing on the page changed or said why.
 *
 * Each case below presses a control, starts a second control while the first
 * request is still outstanding — asserting first that the second control is
 * actually enabled in that state, because an unreachable overlap is not a
 * defect — and then completes the first request. What it checks is that both
 * outcomes are written somewhere a person can read.
 *
 * These are jsdom tests of the renderer's own state machine. They stub the API
 * layer, so they establish what the page does with an answer, not that a
 * backend produces one.
 */

import React from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom';
import EvidencePage from '../pages/EvidencePage';
import { evidenceApi, EvidenceFile, Member, Page, Project, SavedNote } from '../api/evidence';
import { selectedApi } from '../api/selectedEvidence';
import { libraryApi } from '../api/library';
import { AssistantProvider, useAssistant } from '../context/AssistantContext';
import { useRuns } from '../hooks/useRuns';

jest.mock('../components/Evidence/EvidenceReader', () => ({ file }: { file: EvidenceFile }) =>
  <div>Reader fixture {file.original_name}</div>);

function deferred<T>() {
  let resolve!: (value: T) => void; let reject!: (e: Error) => void;
  const promise = new Promise<T>((ok, no) => { resolve = ok; reject = no; });
  return { promise, resolve, reject };
}

const id = (n: number) => `${n.toString().padStart(8, '0')}-1111-4111-8111-111111111111`;
const project = (n: number): Project => ({ id: n, project_id: id(n), vault_id: id(9), name: `Project ${n}`, revision: 1,
  created_at_utc: '2026-10-19T00:00:00Z', updated_at_utc: '2026-10-19T00:00:00Z', file_count: 1, note_count: 1 });
const fileFixture = (n: number): EvidenceFile => ({ file_id: id(n), version_id: id(n), vault_id: id(9),
  original_name: `File ${n}.txt`, media_type: 'text/plain', byte_size: 1, sha256: 'a'.repeat(64),
  created_at_utc: '2026-10-19T00:00:00.000000Z' });
const memberFixture = (file: EvidenceFile, n: number): Member => ({ id: n, project_id: id(1), file_id: file.file_id,
  version_id: file.version_id, added_at_utc: '2026-10-19T00:00:00.000000Z', availability: 'not_checked', file });
const noteFixture = (file: EvidenceFile, n: number): SavedNote => ({ id: n, note_id: id(50 + n), project_id: id(1),
  file_id: file.file_id, version_id: file.version_id, kind: 'note', body: `Saved body ${n}`, quote: null,
  page_number: null, revision: 1, file, membership_state: 'member', resolution: 'not_checked',
  created_at_utc: '2026-10-19T00:00:00.000000Z', updated_at_utc: '2026-10-19T00:00:00.000000Z',
  extraction_contract: null, page_text_sha256: null, start_codepoint: null, end_codepoint: null });

const projects = (items: Project[]): Page<Project> =>
  ({ items, through_id: 2, next_after_id: null, has_more: false, total: items.length, count_basis: 'fixture' });

/** A first page that reports more rows behind it, so the Next control renders. */
const firstMembers = (): Page<Member> => ({ items: [memberFixture(fileFixture(3), 1)], through_id: 51,
  next_after_id: 1, has_more: true, total: 51, count_basis: 'fixed ceiling', revision: 1 });
const firstNotes = (): Page<SavedNote> => ({ items: [noteFixture(fileFixture(3), 1)], through_id: 51,
  next_after_id: 1, has_more: true, total: 51, count_basis: 'fixed ceiling', revision: 1 });

async function openProject() {
  render(<EvidencePage />);
  const pick = await screen.findByRole('button', { name: /Project 1 / });
  await act(async () => { fireEvent.click(pick); });
  // The heading renders before the load settles; wait for the page-level busy
  // flag to clear, which is also what makes the overlap assertions meaningful.
  await waitFor(() => expect(screen.getByRole('button', { name: 'Refresh project' })).toBeEnabled());
}

describe('Evidence paging outcomes survive another control starting', () => {
  beforeEach(() => {
    window.resmonAPI = { getBackendPort: () => '12345', platform: 'test', versions: { node: 'test', electron: 'test' } };
    window.location.hash = '';
    jest.spyOn(libraryApi, 'status').mockResolvedValue({ vault: { vault_id: id(9) } } as Awaited<ReturnType<typeof libraryApi.status>>);
    jest.spyOn(evidenceApi, 'projects').mockResolvedValue(projects([project(1)]));
    jest.spyOn(evidenceApi, 'detail').mockResolvedValue(project(1));
    jest.spyOn(evidenceApi, 'files').mockResolvedValue(firstMembers());
    jest.spyOn(evidenceApi, 'notes').mockResolvedValue(firstNotes());
    jest.spyOn(selectedApi, 'history').mockResolvedValue({ items: [], through_id: 0, next_after_id: null,
      has_more: false, total: 0, count_basis: 'fixture' });
  });
  afterEach(() => jest.restoreAllMocks());

  it('reports a refused collection page even though Refresh project was pressed first', async () => {
    await openProject();
    const held = deferred<Page<Member>>();
    jest.mocked(evidenceApi.files).mockReturnValueOnce(held.promise);
    fireEvent.click(screen.getByRole('button', { name: 'Next collection files' }));

    // Paging never sets the page-level busy flag, so every control gated on it
    // is live while the page request is outstanding. The overlap is reachable.
    const refresh = screen.getByRole('button', { name: 'Refresh project' });
    expect(refresh).toBeEnabled();
    await act(async () => { fireEvent.click(refresh); });

    await act(async () => { held.reject(new Error('Collection page refused.')); });
    expect(await screen.findByRole('alert')).toHaveTextContent('Collection page refused.');
  });

  it('shows the next saved notes even though a refused removal was started first', async () => {
    await openProject();
    const heldNotes = deferred<Page<SavedNote>>();
    const second = { ...firstNotes(), items: [noteFixture(fileFixture(3), 2)], has_more: false, next_after_id: null };
    jest.mocked(evidenceApi.notes).mockReturnValueOnce(heldNotes.promise);
    fireEvent.click(screen.getByRole('button', { name: 'Next saved notes' }));

    const remove = screen.getByRole('button', { name: /Remove File 3.txt from collection/ });
    expect(remove).toBeEnabled();
    jest.spyOn(evidenceApi, 'remove').mockRejectedValue(new Error('Removal refused.'));
    await act(async () => { fireEvent.click(remove); });
    expect(await screen.findByRole('alert')).toHaveTextContent('Removal refused.');

    await act(async () => { heldNotes.resolve(second); });
    expect(await screen.findByText('Saved body 2')).toBeInTheDocument();
  });

  it('does not lose a saved note because another file was selected while it saved', async () => {
    jest.mocked(evidenceApi.files).mockResolvedValue({ ...firstMembers(),
      items: [memberFixture(fileFixture(3), 1), memberFixture(fileFixture(4), 2)] });
    await openProject();
    fireEvent.click(screen.getByRole('button', { name: /^File 3\.txt text\/plain/ }));
    fireEvent.change(screen.getByLabelText('Note body'), { target: { value: 'kept text' } });

    const held = deferred<{ project: Project; note: SavedNote }>();
    jest.spyOn(evidenceApi, 'save').mockReturnValue(held.promise);
    fireEvent.click(screen.getByRole('button', { name: 'Save note' }));

    // Choosing another collection file is not gated on the note save: the page
    // level busy flag belongs to the project load, not to this panel.
    const other = screen.getByRole('button', { name: /^File 4\.txt text\/plain/ });
    expect(other).toBeEnabled();
    await act(async () => { fireEvent.click(other); });

    const saved = noteFixture(fileFixture(3), 9);
    await act(async () => { held.resolve({ project: { ...project(1), revision: 2, note_count: 2 }, note: saved }); });
    // The record exists. The panel has to say so, and the project has to be
    // reloaded, or a saved note is invisible until something else refreshes.
    expect(await screen.findByText(/Saved this exact evidence record against File 3\.txt/)).toBeInTheDocument();
    expect(evidenceApi.detail).toHaveBeenCalledTimes(2);
  });

  // From the review of this branch: the two paging controls having separate
  // keys was asserted by nothing, and collapsing them onto one left the whole
  // suite green. Both Next buttons render at once and neither sets the
  // page-level busy flag, so this is two ordinary clicks.
  it('keeps a collection page when the notes page is asked for next', async () => {
    await openProject();
    const heldFiles = deferred<Page<Member>>();
    jest.mocked(evidenceApi.files).mockReturnValueOnce(heldFiles.promise);
    fireEvent.click(screen.getByRole('button', { name: 'Next collection files' }));

    const nextNotes = screen.getByRole('button', { name: 'Next saved notes' });
    expect(nextNotes).toBeEnabled();
    jest.mocked(evidenceApi.notes).mockResolvedValueOnce({ ...firstNotes(),
      items: [noteFixture(fileFixture(3), 2)], has_more: false, next_after_id: null });
    await act(async () => { fireEvent.click(nextNotes); });
    expect(await screen.findByText('Saved body 2')).toBeInTheDocument();

    await act(async () => { heldFiles.resolve({ ...firstMembers(),
      items: [memberFixture(fileFixture(4), 2)], has_more: false, next_after_id: null }); });
    expect(screen.queryAllByText(/File 4\.txt/).length).toBeGreaterThan(0);
  });

  // Also from the review: the project list's own Next took no ticket at all,
  // so two quick presses could apply an older page over a newer one.
  it('does not let an older page of projects land on top of a newer one', async () => {
    const more = (items: Project[]): Page<Project> =>
      ({ items, through_id: 9, next_after_id: items[items.length - 1].id, has_more: true, total: 9, count_basis: 'fixture' });
    jest.mocked(evidenceApi.projects).mockResolvedValue(more([project(1)]));
    render(<EvidencePage />);
    const next = await screen.findByRole('button', { name: 'Next projects' });

    const held = deferred<Page<Project>>();
    jest.mocked(evidenceApi.projects).mockReturnValueOnce(held.promise)
      .mockResolvedValueOnce(more([project(3)]));
    fireEvent.click(next);
    await act(async () => { fireEvent.click(next); });
    await screen.findByRole('button', { name: /Project 3 / });

    await act(async () => { held.resolve(more([project(2)])); });
    expect(screen.queryByRole('button', { name: /Project 2 / })).toBeNull();
    expect(screen.getByRole('button', { name: /Project 3 / })).toBeInTheDocument();
  });

  it('does not paste a page of one project into another', async () => {
    jest.mocked(evidenceApi.projects).mockResolvedValue(projects([project(1), project(2)]));
    await openProject();
    const held = deferred<Page<Member>>();
    jest.mocked(evidenceApi.files).mockReturnValueOnce(held.promise);
    fireEvent.click(screen.getByRole('button', { name: 'Next collection files' }));

    jest.mocked(evidenceApi.detail).mockResolvedValue(project(2));
    jest.mocked(evidenceApi.files).mockResolvedValue({ ...firstMembers(), items: [memberFixture(fileFixture(8), 1)] });
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: /Project 2 / })); });
    await screen.findByRole('heading', { name: 'Project 2' });

    await act(async () => { held.resolve({ ...firstMembers(), items: [memberFixture(fileFixture(4), 2)] }); });
    expect(screen.queryAllByText(/File 4\.txt/)).toHaveLength(0);
    expect(screen.queryAllByText(/File 8\.txt/).length).toBeGreaterThan(0);
  });
});

describe('a refused conversation delete is reported', () => {
  let owner: ReturnType<typeof useAssistant>;
  function Harness() { owner = useAssistant(); return <div data-testid="owner">{owner.error}</div>; }
  const json = (payload: unknown) => ({ ok: true, status: 200, headers: { get: () => 'application/json' },
    json: async () => payload, text: async () => JSON.stringify(payload) } as unknown as Response);

  it('even though another conversation was opened while the delete was outstanding', async () => {
    const removal = deferred<Response>();
    (global as unknown as { fetch: unknown }).fetch = jest.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input).replace(/^https?:\/\/[^/]+/, '');
      if (path === '/api/assistant/sessions/3' && init?.method === 'DELETE') return removal.promise;
      if (path === '/api/assistant/status') return json({ available: true, reason: 'fixture' });
      if (path === '/api/assistant/sessions') return json({ sessions: [] });
      return json({ session: { id: 7 }, messages: [] });
    });
    await act(async () => { render(<AssistantProvider><Harness /></AssistantProvider>); });

    // Nothing in the panel is disabled by a delete in flight: `deleting` is a
    // ref, the open and New conversation controls read `isAnswering` only.
    act(() => { void owner.deleteSession(3); });
    await act(async () => { await owner.openSession(7); });

    await act(async () => { removal.reject(new Error('Delete refused: the conversation is in use.')); });
    expect(owner.error).toBe('Delete refused: the conversation is in use.');
  });

  it('even though a second row was deleted while the first was outstanding', async () => {
    const first = deferred<Response>();
    (global as unknown as { fetch: unknown }).fetch = jest.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input).replace(/^https?:\/\/[^/]+/, '');
      if (path === '/api/assistant/sessions/3' && init?.method === 'DELETE') return first.promise;
      if (path === '/api/assistant/status') return json({ available: true, reason: 'fixture' });
      if (path === '/api/assistant/sessions') return json({ sessions: [] });
      return json({ ok: true });
    });
    await act(async () => { render(<AssistantProvider><Harness /></AssistantProvider>); });

    // Deleting one row is not a later run of deleting another, so it must not
    // erase the first one's refusal. `deleting` is a Set, so both are live.
    act(() => { void owner.deleteSession(3); });
    await act(async () => { await owner.deleteSession(5); });

    await act(async () => { first.reject(new Error('Delete refused: the conversation is in use.')); });
    expect(owner.error).toBe('Delete refused: the conversation is in use.');
  });

  // From the review of this branch. Deleting the open conversation and then
  // clicking another row is two ordinary clicks: the row buttons are gated on
  // `isAnswering` only. If the delete lands first and claims the selection
  // key, it invalidates the open that is already in flight -- and that open's
  // `finally` releases `isSelecting` only while its own ticket is current, so
  // the flag is stranded. The panel then sits on no conversation with the
  // composer disabled and nothing written anywhere.
  it('a delete of the open conversation landing first does not strand a later open', async () => {
    const removal = deferred<Response>();
    const seven = deferred<Response>();
    (global as unknown as { fetch: unknown }).fetch = jest.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input).replace(/^https?:\/\/[^/]+/, '');
      if (path === '/api/assistant/sessions/5' && init?.method === 'DELETE') return removal.promise;
      if (path === '/api/assistant/sessions/7') return seven.promise;
      if (path === '/api/assistant/sessions/5') return json({ session: { id: 5 }, messages: [] });
      if (path === '/api/assistant/status') return json({ available: true, reason: 'fixture' });
      if (path === '/api/assistant/sessions') return json({ sessions: [] });
      return json({ ok: true });
    });
    await act(async () => { render(<AssistantProvider><Harness /></AssistantProvider>); });
    await act(async () => { await owner.openSession(5); });
    expect(owner.sessionId).toBe(5);

    act(() => { void owner.deleteSession(5); });
    act(() => { void owner.openSession(7); });
    await act(async () => { removal.resolve(json({ ok: true })); });
    await act(async () => { seven.resolve(json({ session: { id: 7 }, messages: [] })); });

    expect({ sessionId: owner.sessionId, isSelecting: owner.isSelecting, error: owner.error })
      .toEqual({ sessionId: 7, isSelecting: false, error: null });
  });
});

describe('useRuns', () => {
  function Probe({ report }: { report: (runs: ReturnType<typeof useRuns>) => void }) {
    report(useRuns());
    return null;
  }
  const mount = () => {
    let runs!: ReturnType<typeof useRuns>;
    const view = render(<Probe report={(r) => { runs = r; }} />);
    return { runs, view };
  };

  it('supersedes only a later run of the same key', () => {
    const { runs } = mount();
    const first = runs.begin('files');
    const notes = runs.begin('notes');
    expect(runs.current('files', first)).toBe(true);
    const second = runs.begin('files');
    expect(runs.current('files', first)).toBe(false);
    expect(runs.current('files', second)).toBe(true);
    // The other operation is untouched — this is the whole point of the key.
    expect(runs.current('notes', notes)).toBe(true);
  });

  it('keys carrying a subject do not supersede each other', () => {
    const { runs } = mount();
    const three = runs.begin('delete:3');
    const five = runs.begin('delete:5');
    expect(runs.current('delete:3', three)).toBe(true);
    expect(runs.current('delete:5', five)).toBe(true);
  });

  it('stops every key at unmount and at an explicit end', () => {
    const a = mount();
    const ticket = a.runs.begin('files');
    a.runs.end();
    expect(a.runs.current('files', ticket)).toBe(false);
    expect(a.runs.mounted).toBe(false);

    const b = mount();
    const other = b.runs.begin('files');
    expect(b.runs.mounted).toBe(true);
    b.view.unmount();
    expect(b.runs.current('files', other)).toBe(false);
    expect(b.runs.mounted).toBe(false);
  });

  it('a ticket begin never hands out is never current', () => {
    const { runs } = mount();
    expect(runs.current('files', 1)).toBe(false);
    expect(runs.begin('files')).toBe(1);
  });

  it('token watches another key without claiming it', () => {
    const { runs } = mount();
    // Nothing has happened to the selection yet, and a watcher that started
    // before the first change is still looking at the same thing.
    const watching = runs.token('selection');
    expect(watching).toBe(0);
    expect(runs.current('selection', watching)).toBe(true);
    runs.begin('selection');
    expect(runs.current('selection', watching)).toBe(false);
    // Watching does not supersede: the selection's own ticket still holds.
    const held = runs.begin('selection');
    expect(runs.token('selection')).toBe(held);
    expect(runs.current('selection', held)).toBe(true);
  });
});

export {};
