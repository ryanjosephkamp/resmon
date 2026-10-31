import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { Tutorials } from '../Tutorials';

/** A media query answering `reduce` as asked, and remembering who listens. */
function motion(reduced: boolean) {
  window.matchMedia = jest.fn().mockImplementation((query: string) => ({
    matches: reduced && query.includes('reduce'),
    media: query,
    addEventListener: jest.fn(),
    removeEventListener: jest.fn(),
  }));
}

/** An IntersectionObserver the test moves things on and off screen with. */
let observed: { target: Element; callback: IntersectionObserverCallback }[] = [];
class FakeObserver {
  constructor(private readonly callback: IntersectionObserverCallback) {}
  observe(target: Element) { observed.push({ target, callback: this.callback }); }
  disconnect() { observed = observed.filter((o) => o.callback !== this.callback); }
  unobserve() { /* not used */ }
  takeRecords() { return []; }
}

function onScreen(item: HTMLElement, shown: boolean) {
  const frame = item.querySelector('.tutorial-frame');
  const watch = observed.find((o) => o.target === frame);
  if (!watch) throw new Error('nothing watches this recording');
  act(() => watch.callback([{ isIntersecting: shown, target: frame } as unknown as IntersectionObserverEntry], {} as IntersectionObserver));
}

const item = (slug: string) => document.querySelector(`[data-tutorial="${slug}"]`) as HTMLElement;
const picture = (slug: string) => item(slug).querySelector('img')?.getAttribute('data-picture');

describe('Settings › Tutorials', () => {
  beforeEach(() => {
    observed = [];
    (window as unknown as { IntersectionObserver: unknown }).IntersectionObserver = FakeObserver;
  });

  test('the seven recordings, in the tour’s order, each with what it shows, and nothing from the web', () => {
    motion(false);
    render(<Tutorials />);
    const items = screen.getAllByRole('listitem');
    expect(items.map((li) => li.getAttribute('data-tutorial')))
      .toEqual(['today', 'deep-dive', 'deep-sweep', 'watches', 'library', 'health', 'getting-around']);
    expect(items.map((li) => within(li).getByRole('heading').textContent))
      .toEqual(['Today', 'A Deep Dive', 'A Deep Sweep', 'Watches', 'Library', 'Health', 'Getting around']);
    for (const li of items) {
      expect(li.querySelector('.tutorial-covers')?.textContent?.length).toBeGreaterThan(40);
      expect(within(li).getByRole('img')).toHaveAttribute('width', '960');
    }
    // Bundled, so opening the page asks nothing of anybody: no link out, no frame.
    const section = document.querySelector('section.tutorials') as HTMLElement;
    expect(section.querySelectorAll('a[href^="http"], iframe, webview, object, embed')).toHaveLength(0);
    expect(section.textContent).not.toMatch(/YouTube/);
    // Ask is missing on purpose, and the page says why.
    expect(screen.queryByRole('heading', { name: /Ask/ })).toBeNull();
    expect(section.textContent).toContain('Ask has no recording yet');
    expect(section.textContent).toContain('signed-in model');
  });

  test('a recording plays only while it is on screen', () => {
    motion(false);
    render(<Tutorials />);
    expect(picture('today')).toBe('still');
    onScreen(item('today'), true);
    expect(picture('today')).toBe('gif');
    expect(item('today')).toHaveAttribute('data-playing', 'true');
    expect(picture('health')).toBe('still');
    onScreen(item('today'), false);
    expect(picture('today')).toBe('still');
  });

  test('with reduced motion, a still and a Play button; Play plays it, Pause stops it', () => {
    motion(true);
    render(<Tutorials />);
    onScreen(item('library'), true);
    expect(picture('library')).toBe('still');
    const play = within(item('library')).getByRole('button', { name: 'Play Library' });
    expect(play).toHaveAttribute('aria-pressed', 'false');
    fireEvent.click(play);
    expect(picture('library')).toBe('gif');
    const pause = within(item('library')).getByRole('button', { name: 'Pause Library' });
    expect(pause).toHaveAttribute('aria-pressed', 'true');
    fireEvent.click(pause);
    expect(picture('library')).toBe('still');
  });

  test('a recording paused stays paused when it leaves the screen and comes back', () => {
    motion(false);
    render(<Tutorials />);
    onScreen(item('watches'), true);
    fireEvent.click(within(item('watches')).getByRole('button', { name: 'Pause Watches' }));
    expect(picture('watches')).toBe('still');
    onScreen(item('watches'), false);
    onScreen(item('watches'), true);
    expect(picture('watches')).toBe('still');
    expect(within(item('watches')).getByRole('button', { name: 'Play Watches' })).toBeInTheDocument();
  });
});
