/**
 * The find over a map waits for typing to rest before it asks the engine, and
 * does nothing on arrival, when nothing has been typed: a timer that set the
 * same empty words drew the map's bar again 220 ms after every visit.
 */
import { act, render } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { engine } from '../../../api/client';
import { useMapLook } from '../useMapLook';

jest.mock('../../../api/client', () => ({ ...jest.requireActual('../../../api/client'), engine: jest.fn() }));

const reply = (data: unknown) => Promise.resolve({ data, error: undefined, response: {} as Response });

describe('the find over a map', () => {
  let GET: jest.Mock;
  beforeEach(() => {
    jest.useFakeTimers();
    GET = jest.fn().mockImplementation((route: string) => (route === '/api/map/views/{name}'
      ? reply({ color: 'region', watches: [], sources: [], dates: 'found', date_from: null, date_to: null, state: 'any', list_by: 'watch' })
      : reply({ query: 'protein', ids: [] })));
    (engine as jest.Mock).mockReturnValue({ GET, PUT: jest.fn() });
  });
  afterEach(() => {
    jest.useRealTimers();
    jest.resetAllMocks();
  });

  function mount() {
    const seen: { typed: string; draws: number } = { typed: '', draws: 0 };
    let type: (words: string) => void = () => {};
    function Bar() {
      const look = useMapLook('today', null, (slug) => slug);
      seen.draws += 1;
      seen.typed = look.find.typed;
      type = look.find.setTyped;
      return null;
    }
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(<QueryClientProvider client={client}><Bar /></QueryClientProvider>);
    return { seen, type: (words: string) => type(words) };
  }

  test('arriving with nothing typed, it draws nothing again and asks nothing', async () => {
    const { seen } = mount();
    // The stored view arrives and is drawn: the arrival itself.
    for (let i = 0; i < 5; i += 1) await act(async () => { jest.advanceTimersByTime(10); });
    const settled = seen.draws;
    await act(async () => { jest.advanceTimersByTime(1_000); });
    expect(seen.draws).toBe(settled);
    expect(GET).not.toHaveBeenCalledWith('/api/map/find', expect.anything());
  });

  test('typed words are asked about once typing has rested', async () => {
    const { type } = mount();
    await act(async () => { type('protein'); });
    await act(async () => { jest.advanceTimersByTime(100); });
    expect(GET).not.toHaveBeenCalledWith('/api/map/find', expect.anything());
    await act(async () => { jest.advanceTimersByTime(200); });
    expect(GET).toHaveBeenCalledWith('/api/map/find', { params: { query: { q: 'protein' } } });
  });
});
