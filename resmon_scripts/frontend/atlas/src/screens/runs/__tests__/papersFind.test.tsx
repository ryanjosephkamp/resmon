/**
 * A run's Papers tab finds as the Library does: the words go to the address's
 * `?q=` after a pause, the engine narrows the pages, and the header says how
 * many match of how many. Select All picks the matches only once every match
 * is listed. The engine and the rows' own actions are stand-ins.
 */
import { act, fireEvent, render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { engine } from '../../../api/client';
import { FIND_PAUSE_MS } from '../../library/findDraft';
import { RunTabs, type RunPaper, type RunPapers } from '../RunTabs';
import type { Run } from '../model';

jest.mock('../../../api/client', () => ({ ...jest.requireActual('../../../api/client'), engine: jest.fn() }));
jest.mock('../../library/PaperActions', () => ({ PaperActions: () => null }));

const paper = (id: number, title: string): RunPaper => ({
  id, title, authors: '["Ada Splatter"]', source_repository: 'arxiv', publication_date: '2026-11-09', url: null, doi: null,
  queue_status: null,
} as unknown as RunPaper);

function Where() {
  const at = useLocation();
  return <p data-testid="where">{at.search}</p>;
}

function mount(papers: RunPapers, search = '') {
  (engine as jest.Mock).mockReturnValue({ GET: () => Promise.resolve({ data: { papers: [], total: 0, searched: 0 }, response: {} }) });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[`/runs/7/papers${search}`]}>
        <RunTabs run={{ id: 7 } as unknown as Run} live={[]} names={new Map([['arxiv', 'arXiv']])} events={[]} papers={papers}
          running={false} tab="Papers" onTab={() => undefined} />
        <Where />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

test('what is typed becomes the address’s q after a pause, and Escape clears it', () => {
  jest.useFakeTimers();
  try {
    mount({ papers: [paper(1, 'Gaussian splats'), paper(2, 'Mitochondria')], total: 2, searched: 2, q: '' });
    expect(screen.getByText('2 papers this run stored.')).toBeInTheDocument();
    const box = screen.getByRole('searchbox', { name: 'Find a title, author, or source in this run’s papers' });
    fireEvent.change(box, { target: { value: 'splat ' } });
    act(() => { jest.advanceTimersByTime(FIND_PAUSE_MS); });
    expect(screen.getByTestId('where')).toHaveTextContent('?q=splat');
    fireEvent.keyDown(box, { key: 'Escape' });
    expect(box).toHaveValue('');
    act(() => { jest.advanceTimersByTime(FIND_PAUSE_MS); });
    expect(screen.getByTestId('where')).toHaveTextContent(/^$/);
  } finally {
    jest.useRealTimers();
  }
});

test('the header says how many match of how many, and Select All picks the matches once every one is listed', () => {
  const two = [paper(1, 'Gaussian splats'), paper(4, 'Splatting review')];
  const view = mount({ papers: two, total: 2, searched: 275, q: 'splat' }, '?q=splat');
  expect(screen.getByText('2 of 275 papers match.')).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Select' }));
  expect(screen.getByRole('button', { name: 'Select All 2 Matches' })).toBeInTheDocument();
  view.unmount();

  mount({ papers: two, total: 12, searched: 275, q: 'splat' }, '?q=splat');
  expect(screen.getByText('12 of 275 papers match; the first 2 are listed.')).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Select' }));
  expect(screen.queryByRole('button', { name: /^Select All/ })).toBeNull();
});

test('a find with no match says so, and keeps the box', () => {
  mount({ papers: [], total: 0, searched: 275, q: 'quasar' }, '?q=quasar');
  expect(screen.getByText('No title, author, or source among the 275 papers this run stored contains “quasar”.')).toBeInTheDocument();
  expect(screen.getByRole('searchbox')).toHaveValue('quasar');
  expect(screen.getByRole('button', { name: 'Select' })).toBeDisabled();
});
