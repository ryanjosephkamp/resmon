/**
 * Where the Library cannot exist (Windows has no descriptor-relative file
 * access), the engine answers its status call with 503 and says why. Both
 * pages that read the status show that sentence rather than nothing.
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactElement } from 'react';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { engine } from '../../../api/client';
import { Evidence } from '../Evidence';
import { Library } from '../Library';

jest.mock('../../../api/client', () => ({ ...jest.requireActual('../../../api/client'), engine: jest.fn() }));
jest.mock('../../../bridge', () => ({ bridge: () => ({ getBackendPort: () => '51000', getApiToken: () => '' }) }));

const MESSAGE = 'Safe descriptor-relative Library access is unavailable on this platform.';

/** The Library's status refuses; the reading queue, which is not in the Library folder, answers. */
function refuse(detail: unknown) {
  const GET = jest.fn((route: string) => (route === '/api/library'
    ? Promise.resolve({ data: undefined, error: { detail }, response: { status: 503, url: 'http://127.0.0.1:51000/api/library' } as Response })
    : Promise.resolve({ data: route === '/api/reading-queue' ? { entries: [], total: 0, limit: 1, offset: 0, status: null, counts: { to_read: 0, read: 0, all: 0 }, sort: 'saved', q: '' } : [], response: { status: 200 } as Response })));
  (engine as jest.Mock).mockReturnValue({ GET });
  return GET;
}

const statusCalls = (GET: jest.Mock) => GET.mock.calls.filter(([route]) => route === '/api/library').length;

function mount(page: ReactElement, at: string) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: 1, retryDelay: 1 } } });
  return render(<QueryClientProvider client={client}><MemoryRouter initialEntries={[at]}>{page}</MemoryRouter></QueryClientProvider>);
}

afterEach(() => { jest.resetAllMocks(); });

describe.each([
  ['Library', 'Library › Your files', <Library key="l" />, '/library?show=files'],
  ['Evidence', 'Evidence', <Evidence key="e" />, '/library/evidence'],
])('%s on a computer with no Library', (name, _where, page, at) => {
  test("shows the engine's own message under its heading", async () => {
    const GET = refuse({ reason: 'unsupported_platform', message: MESSAGE });
    mount(page, at);
    expect(await screen.findByText(MESSAGE)).toBeInTheDocument();
    expect(screen.getByRole('heading', { name, level: 1 })).toBeInTheDocument();
    // Final, so it is not asked for again.
    expect(statusCalls(GET)).toBe(1);
  });

  test('says a failure of any other kind as a failure to read', async () => {
    refuse({ reason: 'storage_unavailable', message: 'Library storage is unavailable or blocked.' });
    mount(page, at);
    expect(await screen.findByText(/The library could not be read \(Library storage is unavailable or blocked\.\)/i)).toBeInTheDocument();
  });
});
