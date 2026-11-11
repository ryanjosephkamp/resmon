/**
 * Look Up a Paper opened by a `resmon://find` link (the Save to resmon browser
 * extension): the field holds what the link names, the page it came from is
 * said, and nothing is asked of a source until Find is pressed.
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter, useNavigate } from 'react-router-dom';
import { engine } from '../../../api/client';
import { FindPaper } from '../FindPaper';

jest.mock('../../../api/client', () => ({ ...jest.requireActual('../../../api/client'), engine: jest.fn() }));

let go: (to: string) => void = () => undefined;
function Navigator() {
  go = useNavigate();
  return null;
}

function mount(entry: string) {
  const POST = jest.fn(() => new Promise(() => {}));
  (engine as jest.Mock).mockReturnValue({ GET: jest.fn(() => new Promise(() => {})), POST });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(<QueryClientProvider client={client}><MemoryRouter initialEntries={[entry]}><Navigator /><FindPaper /></MemoryRouter></QueryClientProvider>);
  return { POST };
}

afterEach(() => { jest.resetAllMocks(); });

test('a link fills the field and names its page, and asks nothing', () => {
  const { POST } = mount('/search/find?q=10.1038%2Fnphys1170&from=https%3A%2F%2Fwww.nature.com%2Farticles%2Fnphys1170');
  expect(screen.getByRole('heading', { name: 'Look Up a Paper', level: 1 })).toBeInTheDocument();
  expect(screen.getByRole('link', { name: 'Collection' })).toHaveAttribute('href', '/search');
  expect(screen.getByRole('link', { name: 'Look Up a Paper' })).toHaveAttribute('href', '/search/find');
  expect(screen.getByText('See every source that holds a paper you already know.').tagName).toBe('STRONG');
  expect(document.querySelector('.find-page')).toHaveTextContent('the copies found are added to the collection this window shows');
  expect(screen.getByRole('textbox')).toHaveValue('10.1038/nphys1170');
  const from = document.querySelector('[data-find="from"]');
  expect(from).toHaveTextContent('A link asked resmon to look this up. It names the page it came from: https://www.nature.com/articles/nphys1170.');
  expect(from).toHaveTextContent('Nothing is looked up until you press Find, and nothing is saved until you choose.');
  expect(POST).not.toHaveBeenCalled();
});

test('a link without a page says only that a link asked', () => {
  mount('/search/find?q=Attention%20Is%20All%20You%20Need');
  expect(screen.getByRole('textbox')).toHaveValue('Attention Is All You Need');
  expect(document.querySelector('[data-find="from"]')).toHaveTextContent(/^A link asked resmon to look this up\. Nothing is looked up/);
});

test('a new link replaces what was typed before it, and so does the same link sent again', () => {
  mount('/search/find');
  fireEvent.change(screen.getByRole('textbox'), { target: { value: 'something typed earlier' } });
  act(() => go('/search/find?q=10.1038%2Fnphys1170&sent=1'));
  expect(screen.getByRole('textbox')).toHaveValue('10.1038/nphys1170');
  fireEvent.change(screen.getByRole('textbox'), { target: { value: 'edited' } });
  act(() => go('/search/find?q=10.1038%2Fnphys1170&sent=2'));
  expect(screen.getByRole('textbox')).toHaveValue('10.1038/nphys1170');
});

test('Look Up a Paper opened any other way says nothing of a link', () => {
  mount('/search/find');
  expect(screen.getByRole('textbox')).toHaveValue('');
  expect(document.querySelector('[data-find="from"]')).toBeNull();
});
