import { renderToStaticMarkup } from 'react-dom/server';
import { breakable } from '../breakable';

describe('a name may wrap at its own separators', () => {
  test('a break opportunity after each underscore, hyphen, dot, and slash', () => {
    expect(renderToStaticMarkup(<>{breakable('midnight_agents_arxiv_ai')}</>))
      .toBe('midnight_<wbr/>agents_<wbr/>arxiv_<wbr/>ai');
    expect(renderToStaticMarkup(<>{breakable('a-b.c/d')}</>)).toBe('a-<wbr/>b.<wbr/>c/<wbr/>d');
  });

  test('a name with none is left as it is', () => {
    expect(breakable('Perovskite films')).toBe('Perovskite films');
  });
});
