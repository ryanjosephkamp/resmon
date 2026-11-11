/**
 * Save to Read from a right-click on a link to a paper's page: the window
 * saves the paper the main process names, and says so, with Undo for a new
 * save; a paper already saved is said to be where it is; a refusal is said.
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { engine, EngineError } from '../../api/client';
import { bridge } from '../../bridge';
import { MenuSave } from '../MenuSave';

jest.mock('../../api/client', () => ({ ...jest.requireActual('../../api/client'), engine: jest.fn() }));
jest.mock('../../bridge', () => ({ ...jest.requireActual('../../bridge'), bridge: jest.fn() }));

const reply = (data: unknown) => Promise.resolve({ data, error: undefined, response: { ok: true, status: 201 } as Response });
const utc = (at: Date) => at.toISOString().slice(0, 19).replace('T', ' ');

function mount(entry: unknown | Error) {
  let told: ((id: number) => void) | null = null;
  (bridge as jest.Mock).mockReturnValue({
    getBackendPort: () => '51000',
    onSaveToRead: (callback: (id: number) => void) => { told = callback; return () => { told = null; }; },
  });
  const POST = jest.fn(() => (entry instanceof Error ? Promise.reject(entry) : reply(entry)));
  const DELETE = jest.fn(() => reply({ entry }));
  (engine as jest.Mock).mockReturnValue({ POST, DELETE });
  const client = new QueryClient();
  const invalidate = jest.spyOn(client, 'invalidateQueries').mockResolvedValue(undefined);
  render(<QueryClientProvider client={client}><MenuSave /></QueryClientProvider>);
  return { POST, DELETE, invalidate, tell: (id: number) => act(() => { told?.(id); }) };
}

afterEach(() => { jest.resetAllMocks(); });

test('a new save is said with the paper’s title, and Undo takes it back', async () => {
  const { POST, DELETE, invalidate, tell } = mount({
    document_id: 42, status: 'to_read', saved_at: utc(new Date()), updated_at: utc(new Date()), read_at: null,
    document: { title: 'Graph Neural Networks, Revisited' },
  });
  await tell(42);
  expect(POST).toHaveBeenCalledWith('/api/reading-queue', { body: { document_id: 42 } });
  const notice = await screen.findByRole('status');
  expect(notice).toHaveTextContent('Saved Graph Neural Networks, Revisited to read.');
  expect(invalidate).toHaveBeenCalledWith({ queryKey: ['reading-queue'] });
  expect(invalidate).toHaveBeenCalledWith({ queryKey: ['paper-places', 42] });
  fireEvent.click(screen.getByRole('button', { name: /^Undo/ }));
  await waitFor(() => expect(DELETE).toHaveBeenCalledWith('/api/reading-queue/{document_id}', { params: { path: { document_id: 42 } } }));
});

test('a paper saved earlier stays where it is, and the notice says where, with no Undo', async () => {
  const { tell } = mount({
    document_id: 7, status: 'read', saved_at: '2026-10-01 09:00:00', updated_at: '2026-10-02 09:00:00', read_at: '2026-10-02 09:00:00',
    document: { title: 'An Older Paper' },
  });
  await tell(7);
  expect(await screen.findByRole('status')).toHaveTextContent('An Older Paper was already saved, in Read.');
  expect(screen.queryByRole('button', { name: /^Undo/ })).toBeNull();
});

test('a refusal is said', async () => {
  const { tell } = mount(new EngineError(404, 'No stored paper has id 9.'));
  await tell(9);
  expect(await screen.findByRole('status')).toHaveTextContent(/^The paper could not be saved to read:/);
});
