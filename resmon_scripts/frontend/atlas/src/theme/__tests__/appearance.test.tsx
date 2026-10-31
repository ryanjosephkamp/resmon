import { useEffect, type ReactNode } from 'react';
import { render } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { AppearanceProvider } from '../appearance';

// The engine never answers here: the page draws with the fallback appearance.
jest.mock('../../api/client', () => ({
  answer: (promise: Promise<unknown>) => promise,
  engine: () => ({ GET: () => new Promise(() => {}), PUT: () => new Promise(() => {}) }),
}));

beforeAll(() => {
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    value: (query: string) => ({
      matches: false, media: query, onchange: null,
      addEventListener: () => {}, removeEventListener: () => {},
      addListener: () => {}, removeListener: () => {}, dispatchEvent: () => false,
    }),
  });
});

afterEach(() => { delete document.documentElement.dataset.theme; });

function wrap(children: ReactNode) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={client}><AppearanceProvider>{children}</AppearanceProvider></QueryClientProvider>;
}

describe('the page carries its theme before any screen draws', () => {
  test('a screen reading the page in its first effect finds the theme already on <html>', () => {
    // A canvas reads its colors from the page in an effect, and a child's
    // effects run before its parent's.
    const seen: (string | undefined)[] = [];
    function Reader() {
      useEffect(() => { seen.push(document.documentElement.dataset.theme); }, []);
      return null;
    }
    render(wrap(<Reader />));
    expect(seen).toEqual(['light']);
  });
});
