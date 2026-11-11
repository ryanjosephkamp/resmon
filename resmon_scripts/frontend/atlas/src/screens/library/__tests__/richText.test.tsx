import { render } from '@testing-library/react';
import { inline, markdown, tex } from '../richText';
import { RichMarkdown, TexView } from '../RichView';

test('inline Markdown: code first, then math, links, and emphasis; nothing else becomes markup', () => {
  expect(inline('a `*b*` $x^2$ **c** *d* ~~e~~')).toEqual([
    { t: 'text', v: 'a ' }, { t: 'code', v: '*b*' }, { t: 'text', v: ' ' }, { t: 'math', v: 'x^2' }, { t: 'text', v: ' ' },
    { t: 'strong', c: [{ t: 'text', v: 'c' }] }, { t: 'text', v: ' ' }, { t: 'em', c: [{ t: 'text', v: 'd' }] }, { t: 'text', v: ' ' },
    { t: 'del', c: [{ t: 'text', v: 'e' }] },
  ]);
  // Prices are not math, and an escaped dollar is a dollar.
  expect(inline('$5 and $6')).toEqual([{ t: 'text', v: '$5 and $6' }]);
  expect(inline('\\$x$')).toEqual([{ t: 'text', v: '$x$' }]);
  expect(inline('\\(a+b\\)')).toEqual([{ t: 'math', v: 'a+b' }]);
});

test('a link is kept only for http, https and mailto; an image is never fetched', () => {
  expect(inline('[x](https://example.org)')).toEqual([{ t: 'link', href: 'https://example.org', c: [{ t: 'text', v: 'x' }] }]);
  expect(inline('[x](javascript:alert(1))')).toEqual([{ t: 'text', v: 'x' }, { t: 'text', v: ')' }]);
  expect(inline('[x](file:///etc/passwd)')).toEqual([{ t: 'text', v: 'x' }]);
  expect(inline('![a plot](https://example.org/plot.png)')).toEqual([{ t: 'image', alt: 'a plot' }]);
});

test('Markdown blocks: headings, code, display math, quotes, nested and task lists, tables, rules', () => {
  const blocks = markdown([
    '# Title', '', 'One **para**', 'continued.', '', '```py', 'x = 1 # <b>', '```', '', '$$', 'E = mc^2', '$$', '',
    '> quoted', '', '- [x] done', '- [ ] open', '  - nested', '', '1. first', '2. second', '', '| a | b |', '|:--|--:|', '| 1 | 2 |', '', '---',
  ].join('\n'));
  expect(blocks.map((b) => b.t)).toEqual(['heading', 'para', 'code', 'math', 'quote', 'list', 'list', 'table', 'rule']);
  expect(blocks[2]).toEqual({ t: 'code', lang: 'py', v: 'x = 1 # <b>' });
  expect(blocks[3]).toEqual({ t: 'math', v: 'E = mc^2' });
  const tasks = blocks[5] as Extract<(typeof blocks)[number], { t: 'list' }>;
  expect(tasks.items.map((i) => i.task)).toEqual([true, false]);
  expect(tasks.items[1]!.c.map((b) => b.t)).toEqual(['para', 'list']);
  const table = blocks[7] as Extract<(typeof blocks)[number], { t: 'table' }>;
  expect(table.align).toEqual(['left', 'right']);
  expect(table.rows).toHaveLength(1);
});

test('TeX source: commands, comments, braces, and every kind of formula found', () => {
  const parts = tex('\\section{A} % note\n$a$ and \\[b\\]\n\\begin{equation}c\\end{equation}\n\\begin{align*}d&=e\\end{align*}');
  expect(parts.filter((p) => p.t === 'math').map((p) => (p as { v: string; display: boolean }))).toEqual([
    expect.objectContaining({ v: 'a', display: false }), expect.objectContaining({ v: 'b', display: true }),
    expect.objectContaining({ v: 'c', display: true }), expect.objectContaining({ v: '\\begin{align*}d&=e\\end{align*}', display: true }),
  ]);
  expect(parts.find((p) => p.t === 'comment')).toEqual({ t: 'comment', v: '% note' });
  expect(parts.filter((p) => p.t === 'command').map((p) => p.v)).toEqual(['\\section']);
  // An escaped percent is text, not a comment.
  expect(tex('50\\% off').some((p) => p.t === 'comment')).toBe(false);
});

test('the rich view draws math with KaTeX into its own element, and shows markup in a file as characters', () => {
  const { container } = render(<RichMarkdown text={'# Notes\n\nThe loss $\\mathcal{L}$ and <script>alert(1)</script>.\n\n$$\\frac{1}{2}$$\n'} />);
  expect(container.querySelector('h2')?.textContent).toBe('Notes');
  expect(container.querySelectorAll('.formula .katex').length).toBe(2);
  expect(container.querySelector('.rich-math .katex-display')).not.toBeNull();
  expect(container.querySelector('script')).toBeNull();
  expect(container.textContent).toContain('<script>alert(1)</script>');
});

test('a formula KaTeX cannot read is shown as its source, and one reaching outside is refused', () => {
  const { container } = render(<RichMarkdown text={'$\\frac{1}{$ and $\\href{https://example.org}{x}$'} />);
  const formulas = container.querySelectorAll('.formula');
  expect(formulas.length).toBe(2);
  // KaTeX shows a formula it cannot parse as its source, marked as an error, rather than dropping it.
  expect(formulas[0]!.querySelector('.katex-error')?.textContent).toContain('\\frac{1}{');
  // trust: false draws \href without a link.
  expect(container.querySelector('a[href]')).toBeNull();
});

test('the TeX view keeps the source and draws its math', () => {
  const { container } = render(<TexView text={'% c\nLet $x$ be\n\\begin{equation}y=1\\end{equation}\n'} />);
  expect(container.querySelector('.tx-comment')?.textContent).toBe('% c');
  expect(container.querySelectorAll('.formula .katex').length).toBe(2);
  expect(container.querySelector('.tx-display .katex-display')).not.toBeNull();
});
