import type { PropsWithChildren } from 'react';
import { act, renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { engine } from '../../../api/client';
import { buildSky } from '../../today/model';
import { useMapLook } from '../useMapLook';
import { DEFAULT_VIEW } from '../look';

jest.mock('../../../api/client', () => ({ ...jest.requireActual('../../../api/client'), engine: jest.fn() }));
const names = (slug: string) => slug;
const skyFor = (label: string) => buildSky({ id: [1, 2, 3], x: [0, 1, 2], y: [0, 0, 0], region: [0, 1, 1], seen_day: [0, 0, 0] },
  [{ id: 0, label, x: 0, y: 0, r: 0.1, size: 1, terms: [] }, { id: 1, label: 'Other', x: 1.5, y: 0, r: 0.1, size: 2, terms: [] }], 0);

function setup(label: string) {
  (engine as jest.Mock).mockReturnValue({ GET: (route: string) => Promise.resolve({ data: route === '/api/map/views/{name}'
    ? { ...DEFAULT_VIEW, color: 'source' } : { ids: [1, 2, 3], source: [0, 0, 0], sources: ['arxiv'], published_day: [], found_at: [],
      saved: [], read: [], new: [], watches: [], window: 'first_look' }, response: {} }) });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const wrapper = ({ children }: PropsWithChildren) => <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  return renderHook(({ sky }) => useMapLook('run', sky, names), { wrapper, initialProps: { sky: skyFor(label) } });
}

test('region restriction also narrows the source legend to the papers actually lit', async () => {
  const hook = setup('Protein');
  await waitFor(() => expect(hook.result.current.look?.legend[0]?.count).toBe(3));
  act(() => hook.result.current.regions.onSelect([0]));
  expect(hook.result.current.look?.shown).toBe(1);
  expect(hook.result.current.look?.legend[0]?.count).toBe(1);
  act(() => hook.result.current.regions.onSelect([]));
});

test('a different fit cannot reuse a selected region id for a different subject', async () => {
  const hook = setup('Protein');
  await waitFor(() => expect(hook.result.current.look?.legend[0]?.count).toBe(3));
  act(() => hook.result.current.regions.onSelect([0]));
  hook.rerender({ sky: skyFor('Quantum') });
  expect(hook.result.current.regions.selected).toEqual([]);
  expect(hook.result.current.look?.shown).toBe(3);
});
