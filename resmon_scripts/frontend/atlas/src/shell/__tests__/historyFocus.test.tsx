import { useRef, useState } from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, useLocation, useNavigate, type NavigateFunction } from 'react-router-dom';
import { StageScroll } from '../stageScroll';

function Pages({ delayed = false }: { delayed?: boolean }) {
  const stage = useRef<HTMLElement>(null);
  const navigate = useNavigate();
  const location = useLocation();
  const [ready, setReady] = useState(!delayed);
  go = navigate;
  show = () => setReady(true);
  return (
    <main ref={stage} className="stage">
      <StageScroll stage={stage} />
      {location.pathname === '/analytics'
        ? ready && <a href="#/search?from=2026-10-01" data-month="2026-10" aria-label="October 2026: 12 papers"
          onClick={(event) => { event.preventDefault(); setReady(!delayed); void navigate('/search'); }}>October</a>
        : location.pathname === '/library'
          ? <article data-file="file-1"><a href="#/library/files/file-1" className="thumb" data-focus-key="f:file-1"
            onClick={(event) => { event.preventDefault(); void navigate('/library/files/file-1'); }}>A saved file</a></article>
          : <h1>Destination</h1>}
    </main>
  );
}
let go: NavigateFunction;
let show: () => void;

beforeEach(() => {
  // The focus cases have no measured list rows; the stage itself has no layout in jsdom.
  jest.spyOn(window, 'requestAnimationFrame').mockImplementation(() => 1);
  jest.spyOn(window, 'cancelAnimationFrame').mockImplementation(() => undefined);
});
afterEach(() => jest.restoreAllMocks());

test.each([
  ['/analytics', 'October 2026: 12 papers'],
  ['/library', 'A saved file'],
])('Back restores the focused opener on %s', async (path, name) => {
  render(<MemoryRouter initialEntries={[path]}><Pages /></MemoryRouter>);
  const opener = screen.getByRole('link', { name });
  opener.focus();
  fireEvent.click(opener);
  expect(screen.getByRole('heading', { name: 'Destination' })).toBeInTheDocument();
  act(() => { void go(-1); });
  await waitFor(() => expect(screen.getByRole('link', { name })).toHaveFocus());
});

test('Back waits for an opener the page has not read yet without scrolling it', async () => {
  render(<MemoryRouter initialEntries={['/analytics']}><Pages delayed /></MemoryRouter>);
  act(() => show());
  const opener = screen.getByRole('link', { name: 'October 2026: 12 papers' });
  fireEvent.click(opener);
  act(() => { void go(-1); });
  expect(screen.queryByRole('link')).toBeNull();
  const focus = jest.spyOn(HTMLElement.prototype, 'focus');
  act(() => show());
  await waitFor(() => expect(screen.getByRole('link')).toHaveFocus());
  expect(focus).toHaveBeenCalledWith({ preventScroll: true });
});


test('a key pressed while Back waits for data cancels pending focus restoration', async () => {
  render(<MemoryRouter initialEntries={['/analytics']}><Pages delayed /></MemoryRouter>);
  act(() => show());
  fireEvent.click(screen.getByRole('link'));
  act(() => { void go(-1); });
  fireEvent.keyDown(document.body, { key: 'Tab' });
  act(() => show());
  await waitFor(() => expect(screen.getByRole('link')).toBeInTheDocument());
  expect(screen.getByRole('link')).not.toHaveFocus();
});
