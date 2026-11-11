import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { engine } from '../../../api/client';
import { readMap } from '../../today/freshness';
import { RunMap } from '../RunMap';
import type { Sky } from '../../today/model';

jest.mock('../../../api/client', () => ({ ...jest.requireActual('../../../api/client'), engine: jest.fn() }));
jest.mock('../../today/freshness', () => ({ ...jest.requireActual('../../today/freshness'), readMap: jest.fn() }));
jest.mock('../../../theme/appearance', () => ({ useAppearance: () => ({ theme: 'dark', shown: {} }) }));
jest.mock('../../../collections/current', () => ({
  useCollection: () => ({ id: 1 }), collectionParam: () => ({}),
  useCollectionWords: () => ({ name: 'your collection', named: false }),
}));
jest.mock('../../sky/readAfter', () => ({ useReadAfter: () => true }));
jest.mock('../../sky/useMapLook', () => ({ useMapLook: () => ({ look: null, plateLook: null, view: { watches: [], sources: [], state: "any" }, find: {} }) }));
jest.mock('../../sky/MapControls', () => ({ MapBar: () => null, DimKey: () => null }));
jest.mock('../../today/Plate', () => ({
  ...jest.requireActual('../../today/Plate'),
  Plate: ({ sky }: { sky: Sky }) => <div role="img" aria-label="Placed papers" data-ids={Array.from(sky.ids).join(',')} />,
  PlateKey: () => null,
}));

test('the run’s map reads and draws papers while running, and its legend shows only the chosen source', async () => {
  const GET = jest.fn(() => Promise.resolve({ data: { ids: [1, 2, 3], sources: ['arxiv', 'plos', 'hal'], papers: [
    { id: 1, copies: [1, 2], sources: ['arxiv', 'plos'] }, { id: 3, copies: [3], sources: ['plos'] },
  ] }, response: { status: 200 } }));
  (engine as jest.Mock).mockReturnValue({ GET });
  (readMap as jest.Mock).mockResolvedValue({ state: 'ready', basis: 'words', regions: [], points: {
    id: [1, 2, 3], x: [0, 0.2, 1], y: [0, 0.1, 1], region: [0, 0, 0], seen_day: [0, 0, 0],
  } });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(<QueryClientProvider client={client}><MemoryRouter><RunMap compact runId={7} running settledAt={null} endedAt={null} names={new Map([['arxiv', 'arXiv'], ['plos', 'PLOS']])} /></MemoryRouter></QueryClientProvider>);
  await waitFor(() => expect(screen.getByRole('img')).toHaveAttribute('data-ids', '1,3'));
  expect(GET).toHaveBeenCalledWith('/api/executions/{exec_id}/document-ids', { params: { path: { exec_id: 7 }, query: {} } });
  fireEvent.click(screen.getByRole('button', { name: 'arXiv 1' }));
  expect(screen.getByRole('img')).toHaveAttribute('data-ids', '1');
  fireEvent.click(screen.getByRole('button', { name: 'hal 0' }));
  expect(screen.queryByRole('img')).toBeNull();
  expect(screen.getByText('No placed papers from hal are on this map.')).toBeVisible();
  fireEvent.click(screen.getByRole('button', { name: 'All Sources' }));
  expect(screen.getByRole('img')).toHaveAttribute('data-ids', '1,3');
  expect(screen.getByText(/All 3 papers this run stored are on the map, on 2 marks/)).toBeVisible();
});

test.each([true, false])('newly stored papers wait for a map update in the compact=%s view', async (compact) => {
  (engine as jest.Mock).mockReturnValue({ GET: jest.fn(() => Promise.resolve({ data: {
    ids: [1, 2], sources: ['arxiv'], papers: [
      { id: 1, copies: [1], sources: ['arxiv'] }, { id: 2, copies: [2], sources: ['arxiv'] },
    ],
  }, response: { status: 200 } })) });
  (readMap as jest.Mock).mockResolvedValue({ state: 'ready', basis: 'words', regions: [], points: {
    id: [1], x: [0], y: [0], region: [0], seen_day: [0],
  } });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(<QueryClientProvider client={client}><MemoryRouter><RunMap compact={compact} runId={7} running settledAt={null} endedAt={null} names={new Map()} /></MemoryRouter></QueryClientProvider>);
  expect(await screen.findByText(/waiting for the next map update/)).toBeVisible();
  expect(screen.queryByText(/too little text/)).toBeNull();
});
