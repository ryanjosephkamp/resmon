import { render } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { Fallback } from '../../../shell/Fallback';
import { PageFailed } from '../../../shell/PageFailed';
import { DEEPEST, formulaCount, inline, markdown, MOST_FORMULAS, tex, type Block } from '../richText';
import { drawable, LONGEST_FORMULA, RichMarkdown, TexView } from '../RichView';

/**
 * A kept file is read as it is, and a file can be hostile or broken. Whatever
 * it holds, reading it for the rich view takes time in proportion to its size,
 * never in its square, and nothing in it can freeze or blank the window.
 */
const BUDGET_MS = 200;

function timed(read: () => unknown): number {
  const started = performance.now();
  read();
  return performance.now() - started;
}

const KB = 1024;
const hostile: Record<string, string> = {
  '64 KB of [': '['.repeat(64 * KB),
  '256 KB of [': '['.repeat(256 * KB),
  '128K copies of \\(': '\\('.repeat(128 * KB),
  '![ without a ]': '!['.repeat(128 * KB),
  '[]( without a )': '[]('.repeat(85 * KB),
  'links whose title never closes': '[a](b "'.repeat(36 * KB),
  'autolinks that never close': '<http://'.repeat(32 * KB),
  'autolinks and links before one far space': `${'[<http://'.repeat(28 * KB)} ](x)`,
  'code spans of every length': Array.from({ length: 700 }, (_, n) => '`'.repeat(700 - n)).join('a'),
  'dollars that never close': '$a '.repeat(85 * KB),
  'double dollars that never close': `$$${'a$'.repeat(128 * KB)}`,
  'strikes, strongs and emphasis that never close': '~~a**b__c*d_e '.repeat(18 * KB),
  'a table rule of spaces': `a|b\n${' '.repeat(250 * KB)}x`,
};
const hostileTex: Record<string, string> = {
  '128K copies of \\(': '\\('.repeat(128 * KB),
  '128K copies of \\[': '\\['.repeat(128 * KB),
  'environments that never end': '\\begin{equation}'.repeat(16 * KB),
  'dollars that never close': '$\\$'.repeat(85 * KB),
  'double dollars that never close': `$$${'\\$$'.repeat(85 * KB)}`,
  'a brace on every byte': '{'.repeat(256 * KB),
};

test.each(Object.entries(hostile))('Markdown: %s reads in under 200 ms', (_name, text) => {
  expect(timed(() => markdown(text))).toBeLessThan(BUDGET_MS);
  expect(timed(() => inline(text))).toBeLessThan(BUDGET_MS);
});

test.each(Object.entries(hostileTex))('TeX: %s reads in under 200 ms', (_name, text) => {
  expect(timed(() => tex(text))).toBeLessThan(BUDGET_MS);
});

test('what the linear read finds is what the pattern read found', () => {
  expect(inline('[a \\] b](https://example.org "t") ![x](y.png "z") <https://a.b/c> <mailto:x@y.z>')).toEqual([
    { t: 'link', href: 'https://example.org', c: [{ t: 'text', v: 'a ] b' }] }, { t: 'text', v: ' ' },
    { t: 'image', alt: 'x' }, { t: 'text', v: ' ' },
    { t: 'link', href: 'https://a.b/c', c: [{ t: 'text', v: 'https://a.b/c' }] }, { t: 'text', v: ' ' },
    { t: 'link', href: 'mailto:x@y.z', c: [{ t: 'text', v: 'mailto:x@y.z' }] },
  ]);
  expect(inline('<http://a b>')).toEqual([{ t: 'text', v: '<http://a b>' }]);
  expect(inline('$x $ and $5$6 and $a\\$')).toEqual([{ t: 'text', v: '$x $ and $5$6 and $a$' }]);
  expect(inline('``a`b``')).toEqual([{ t: 'code', v: 'a`b' }]);
  expect(tex('$a\\$b$ and $$c$$')).toEqual([
    { t: 'math', v: 'a\\$b', source: '$a\\$b$', display: false }, { t: 'text', v: ' and ' },
    { t: 'math', v: 'c', source: '$$c$$', display: true },
  ]);
  // Inline math stops at a blank line, as TeX's does.
  expect(tex('$a\n\nb$').filter((p) => p.t === 'math')).toEqual([]);
  // Neighbors of one kind are one piece.
  expect(tex('\\alpha\\beta{{}}')).toEqual([{ t: 'command', v: '\\alpha\\beta' }, { t: 'brace', v: '{{}}' }]);
});

function depth(blocks: readonly Block[]): number {
  let deepest = 0;
  for (const b of blocks) {
    const inner = b.t === 'quote' ? depth(b.c) : b.t === 'list' ? Math.max(0, ...b.items.map((i) => depth(i.c))) : -1;
    deepest = Math.max(deepest, inner + 1);
  }
  return deepest;
}

test('quotes and lists nest only so deep; deeper than that is shown as it is written', () => {
  const quotes = markdown('>'.repeat(20 * KB));
  expect(depth(quotes)).toBeLessThanOrEqual(DEEPEST + 1);
  const lists = markdown(`${'- '.repeat(10 * KB)}x`);
  expect(depth(lists)).toBeLessThanOrEqual(DEEPEST + 1);
  // Ordinary nesting is unchanged.
  expect(depth(markdown('> a\n> > b\n> > > c'))).toBe(3);
  // And the view draws what is there, rather than throwing.
  const { container } = render(<RichMarkdown text={'>'.repeat(20 * KB)} />);
  expect(container.querySelectorAll('blockquote').length).toBeLessThanOrEqual(DEEPEST + 1);
  expect(container.textContent).toContain('>>>>');
});

test('a formula that defines a macro, or one over 2 KB, is shown as its source, not drawn', () => {
  expect(drawable('\\frac{1}{2}')).toBe(true);
  for (const defining of ['\\def\\b{x}\\b', '\\gdef\\b{x}', '\\edef\\b{x}', '\\xdef\\b{x}', '\\let\\b\\a', '\\newcommand{\\b}{x}',
    '\\renewcommand{\\b}{x}', '\\providecommand{\\b}{x}', '\\global\\def\\b{x}']) {
    expect(drawable(defining)).toBe(false);
  }
  expect(drawable('\\definecolor')).toBe(true);
  expect(drawable('x'.repeat(LONGEST_FORMULA + 1))).toBe(false);
  // The 2,006-character definition used 499 times: it took 89 seconds and 5.5 MB when KaTeX was asked.
  const bomb = `\\def\\b{${'x'.repeat(1000)}}${'\\b'.repeat(499)}`;
  let container!: HTMLElement;
  const ms = timed(() => { ({ container } = render(<RichMarkdown text={`$${bomb}$`} />)); });
  expect(ms).toBeLessThan(BUDGET_MS * 5);
  const formula = container.querySelector('.formula')!;
  expect(formula.getAttribute('data-drawn')).toBe('false');
  expect(formula.querySelector('.katex')).toBeNull();
  expect(formula.textContent).toBe(bomb);
  const { container: texView } = render(<TexView text={'\\begin{equation}\\newcommand{\\b}{y}\\b\\end{equation}'} />);
  expect(texView.querySelector('.formula')?.getAttribute('data-drawn')).toBe('false');
});

test('one view draws the first 2,000 formulas and shows the rest as written, and says so', () => {
  const many = '$x_1$ '.repeat(MOST_FORMULAS + 500);
  expect(formulaCount(markdown(many))).toEqual({ all: MOST_FORMULAS + 500, asWritten: 500 });
  expect(formulaCount(tex(many))).toEqual({ all: MOST_FORMULAS + 500, asWritten: 500 });
  expect(formulaCount(markdown('$a$ $$b$$'))).toEqual({ all: 2, asWritten: 0 });
  const { container } = render(<RichMarkdown text={many} />);
  expect(container.querySelectorAll('.formula .katex')).toHaveLength(MOST_FORMULAS);
  expect(container.querySelectorAll('.formula[data-drawn="false"]')).toHaveLength(500);
  expect(container.querySelector('[data-library="most-formulas"]')?.textContent)
    .toBe('This file holds 2,500 formulas. The first 2,000 are drawn, and the rest are shown as written.');
});

function Throws({ when }: { when: boolean }) {
  if (when) throw new RangeError('Maximum call stack size exceeded');
  return <p>drawn</p>;
}

test('a part that throws while it is drawn is replaced, and drawn again at the next address', () => {
  const quiet = jest.spyOn(console, 'error').mockImplementation(() => undefined);
  try {
    const { container, rerender } = render(
      <Fallback resetKey="a" fallback={(e) => <p className="fell">{e.message}</p>}><Throws when /></Fallback>,
    );
    expect(container.querySelector('.fell')?.textContent).toBe('Maximum call stack size exceeded');
    rerender(<Fallback resetKey="a" fallback={(e) => <p className="fell">{e.message}</p>}><Throws when={false} /></Fallback>);
    expect(container.querySelector('.fell')).not.toBeNull();
    rerender(<Fallback resetKey="b" fallback={(e) => <p className="fell">{e.message}</p>}><Throws when={false} /></Fallback>);
    expect(container.textContent).toBe('drawn');
  } finally {
    quiet.mockRestore();
  }
});

test('the page in place of one that could not be drawn says so and offers a way back', () => {
  const { container } = render(
    <MemoryRouter initialEntries={['/library/files/x']}>
      <PageFailed error={new RangeError('Maximum call stack size exceeded')} />
    </MemoryRouter>,
  );
  expect(container.querySelector('h1')?.textContent).toBe('This page could not be shown');
  expect(container.querySelector('a[href="/today"]')?.textContent).toBe('Open Today');
  expect(container.textContent).toContain('Maximum call stack size exceeded');
});
