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
 *
 * Each hostile input is read at a quarter of its size and at its full size. A
 * linear read takes about four times as long for four times the text, a
 * quadratic one about sixteen times, so the full read is held to under eight
 * times the quarter, with a few milliseconds for the timer: far enough apart
 * that a shared runner's noise does not decide it, as it did with twice the
 * text against three times the time. A ceiling holds too: 200 ms here, and 2 s
 * on a shared CI runner, whose speed varies from run to run; either still fails
 * the reads these inputs once caused, which took a minute or more.
 */
const CEILING_MS = process.env.CI ? 2_000 : 200;
const SLACK_MS = 10;

/** One read's time. */
function once(read: () => unknown): number {
  const started = performance.now();
  read();
  return performance.now() - started;
}

/** The fastest of five timings, after one to warm up, so neither a first call nor a pause for garbage collection decides a case. */
function timed(read: () => unknown): number {
  read();
  let fastest = Infinity;
  for (let i = 0; i < 5; i += 1) fastest = Math.min(fastest, once(read));
  return fastest;
}

const KB = 1024;
/** An input at a scale: 1 is the size that once took seconds or minutes to read, 0.25 is a quarter of the text. */
type Hostile = (scale: number) => string;
const repeated = (unit: string, count: number): Hostile => (scale) => unit.repeat(Math.round(count * scale));
const hostile: Record<string, Hostile> = {
  '64 KB of [': repeated('[', 64 * KB),
  '256 KB of [': repeated('[', 256 * KB),
  '128K copies of \\(': repeated('\\(', 128 * KB),
  '![ without a ]': repeated('![', 128 * KB),
  '[]( without a )': repeated('[](', 85 * KB),
  'links whose title never closes': repeated('[a](b "', 36 * KB),
  'autolinks that never close': repeated('<http://', 32 * KB),
  'autolinks and links before one far space': (scale) => `${repeated('[<http://', 28 * KB)(scale)} ](x)`,
  // Its length grows with the square of the count, so the count grows with the root of the scale.
  'code spans of every length': (scale) => {
    const n = Math.round(700 * Math.sqrt(scale));
    return Array.from({ length: n }, (_, i) => '`'.repeat(n - i)).join('a');
  },
  'dollars that never close': repeated('$a ', 85 * KB),
  'double dollars that never close': (scale) => `$$${repeated('a$', 128 * KB)(scale)}`,
  'strikes, strongs and emphasis that never close': repeated('~~a**b__c*d_e ', 18 * KB),
  'a table rule of spaces': (scale) => `a|b\n${repeated(' ', 250 * KB)(scale)}x`,
};
const hostileTex: Record<string, Hostile> = {
  '128K copies of \\(': repeated('\\(', 128 * KB),
  '128K copies of \\[': repeated('\\[', 128 * KB),
  'environments that never end': repeated('\\begin{equation}', 16 * KB),
  'dollars that never close': repeated('$\\$', 85 * KB),
  'double dollars that never close': (scale) => `$$${repeated('\\$$', 85 * KB)(scale)}`,
  'a brace on every byte': repeated('{', 256 * KB),
};

/**
 * Four times the text in under eight times the time, and the whole of it under
 * the ceiling. Each size is read once to warm up, then five times each, taking
 * turns, and the fastest of each is kept: neither a first call nor a pause for
 * garbage collection decides a case, and a machine busy with something else is
 * busy for both sizes alike rather than for one of them.
 */
function readsLinearly(read: (text: string) => unknown, build: Hostile): void {
  const quarter = build(0.25);
  const full = build(1);
  read(quarter);
  read(full);
  let quarterMs = Infinity;
  let fullMs = Infinity;
  for (let i = 0; i < 5; i += 1) {
    quarterMs = Math.min(quarterMs, once(() => read(quarter)));
    fullMs = Math.min(fullMs, once(() => read(full)));
  }
  expect(fullMs).toBeLessThan(8 * quarterMs + SLACK_MS);
  expect(fullMs).toBeLessThan(CEILING_MS);
}

test.each(Object.entries(hostile))('Markdown: %s reads in time proportional to its size', (_name, build) => {
  readsLinearly(markdown, build);
  readsLinearly(inline, build);
});

test.each(Object.entries(hostileTex))('TeX: %s reads in time proportional to its size', (_name, build) => {
  readsLinearly(tex, build);
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
  expect(ms).toBeLessThan(CEILING_MS * 5);
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
