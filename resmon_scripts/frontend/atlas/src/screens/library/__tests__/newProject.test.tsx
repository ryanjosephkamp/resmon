/**
 * Library › Projects makes a project itself: New Project names it, the engine
 * makes it, and the window goes to it in Evidence. The engine is a stand-in;
 * nothing here reaches a socket.
 */
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { engine } from '../../../api/client';

jest.mock('../../../api/client', () => ({ ...jest.requireActual('../../../api/client'), engine: jest.fn() }));
jest.mock('../../../bridge', () => ({ isMac: () => true, bridge: () => ({ getBackendPort: () => '51000', getApiToken: () => 'token' }) }));

const PROJECT = {
  id: 7, project_id: 'p-new', vault_id: 'v', name: 'Gaussian splats', revision: 1, file_count: 0, note_count: 0,
  created_at_utc: '2026-11-10T12:00:00Z', updated_at_utc: '2026-11-10T12:00:00Z',
};

let made: unknown[] = [];
const realFetch = globalThis.fetch;
beforeAll(() => {
  HTMLDialogElement.prototype.showModal = function () { this.setAttribute('open', ''); };
  HTMLDialogElement.prototype.close = function () { this.removeAttribute('open'); };
});
beforeEach(() => {
  made = [];
  globalThis.fetch = jest.fn((address: string, init?: RequestInit) => {
    const url = new URL(address);
    if (init?.method === 'POST' && url.pathname.endsWith('/api/evidence/projects')) {
      made.push(JSON.parse(String(init.body)));
      return Promise.resolve({ ok: true, status: 201, json: () => Promise.resolve({ contract_version: 1, vault_id: 'v', project_id: 'p-new', project: PROJECT }) });
    }
    return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ contract_version: 1, vault_id: 'v', projects: [], through_id: 0, next_after_id: null, has_more: false, total: 0 }) });
  }) as unknown as typeof fetch;
  (engine as jest.Mock).mockReturnValue({
    GET: (path: string) => Promise.resolve({
      data: path === '/api/library'
        ? { status: 'ready', vault: { vault_id: 'v' }, counts: { items: 0 } }
        : { counts: { to_read: 0, read: 0 }, items: [], total: 0 },
      response: {},
    }),
  });
});
afterEach(() => { globalThis.fetch = realFetch; });

function Where() {
  const at = useLocation();
  return <p data-testid="where">{`${at.pathname}${at.search}`}</p>;
}

test('New Project names a project, makes it, and opens it in Evidence', async () => {
  const { Library } = await import('../Library');
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={['/library?show=projects']}>
        <Routes>
          <Route path="/library" element={<Library />} />
          <Route path="/library/evidence" element={<Where />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
  expect(await screen.findByText(/No project yet\. Make one with New Project/)).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'New Project' }));
  const sheet = screen.getByRole('dialog', { name: 'New Project' });
  const create = within(sheet).getByRole('button', { name: 'Create and Open' });
  expect(create).toBeDisabled();
  fireEvent.change(within(sheet).getByLabelText('Project Name'), { target: { value: '  Gaussian splats ' } });
  fireEvent.click(create);
  await waitFor(() => expect(screen.getByTestId('where')).toHaveTextContent('/library/evidence?project=p-new'));
  expect(made).toEqual([{ expected_vault_id: 'v', name: 'Gaussian splats' }]);
});
