import { memo, useLayoutEffect, useMemo, useRef, type ReactNode } from 'react';
import katex from 'katex';
import { markdown, tex, type Block, type Inline, type TexPart } from './richText';

/**
 * The rich view of a kept Markdown or TeX file. Loaded on its own, with
 * KaTeX's stylesheet, the first time a rich view is opened (`richViewChunk.ts`),
 * so the gallery and the reader do not carry the math renderer: KaTeX 0.19.0
 * and its fonts, served from this window's own origin as the content policy
 * requires.
 *
 * A formula is drawn by `katex.render` into an element of its own: KaTeX
 * builds the elements and sets their positions through the style object,
 * which the content policy allows, rather than through markup. Commands that
 * reach outside the formula (`\href`, `\url`, `\includegraphics`, `\htmlId`
 * and the rest) are refused by `trust: false`, and macros are bounded. A
 * formula KaTeX cannot read is shown as its source, marked, never dropped.
 */
export function RichMarkdown({ text }: { text: string }) {
  const parsed = useMemo(() => markdown(text), [text]);
  return <div className="rich md-rich">{parsed.map((b, i) => <BlockView key={i} block={b} />)}</div>;
}

export function TexView({ text }: { text: string }) {
  const parts = useMemo(() => tex(text), [text]);
  return <pre className="rich tex-rich">{parts.map((p, i) => <TexPiece key={i} part={p} />)}</pre>;
}

const OPTIONS = { throwOnError: false, trust: false, strict: 'ignore', maxSize: 40, maxExpand: 500, output: 'htmlAndMathml' } as const;

/** One formula, drawn by KaTeX into its own element. */
export const Formula = memo(function Formula({ source, display, title }: { source: string; display: boolean; title?: string }) {
  const ref = useRef<HTMLSpanElement>(null);
  useLayoutEffect(() => {
    const node = ref.current;
    if (!node) return;
    node.replaceChildren();
    try {
      katex.render(source, node, { ...OPTIONS, displayMode: display });
      node.dataset.drawn = 'true';
    } catch {
      node.textContent = source;
      node.dataset.drawn = 'false';
    }
  }, [source, display]);
  return (
    <span ref={ref} className={display ? 'formula display' : 'formula'} title={title ?? source}
      role="math" aria-label={source} />
  );
});

function inlines(parts: readonly Inline[]): ReactNode[] {
  return parts.map((p, i) => {
    switch (p.t) {
      case 'text': return p.v;
      case 'code': return <code key={i}>{p.v}</code>;
      case 'math': return <Formula key={i} source={p.v} display={false} />;
      case 'strong': return <strong key={i}>{inlines(p.c)}</strong>;
      case 'em': return <em key={i}>{inlines(p.c)}</em>;
      case 'del': return <del key={i}>{inlines(p.c)}</del>;
      case 'link': return <a key={i} href={p.href} target="_blank" rel="noreferrer">{inlines(p.c)}</a>;
      case 'image': return <span key={i} className="rich-image" title="Images in a kept file are not loaded.">[Image{p.alt ? `: ${p.alt}` : ''}]</span>;
      case 'br': return <br key={i} />;
      default: return null;
    }
  });
}

function BlockView({ block }: { block: Block }) {
  switch (block.t) {
    case 'heading': {
      // The file's own name is the view's heading; a file's level 1 is one below it.
      const level = Math.min(6, block.level + 1);
      const Tag = `h${level}` as 'h2';
      return <Tag>{inlines(block.c)}</Tag>;
    }
    case 'para': return <p>{inlines(block.c)}</p>;
    case 'code': return <pre className="rich-code" data-lang={block.lang || undefined}><code>{block.v}</code></pre>;
    case 'math': return <div className="rich-math"><Formula source={block.v} display /></div>;
    case 'quote': return <blockquote>{block.c.map((b, i) => <BlockView key={i} block={b} />)}</blockquote>;
    case 'rule': return <hr />;
    case 'list': {
      const items = block.items.map((item, i) => (
        <li key={i} className={item.task === null ? undefined : 'task'}>
          {item.task !== null && <input type="checkbox" checked={item.task} disabled aria-label={item.task ? 'Done' : 'Not done'} />}
          {item.c.length === 1 && item.c[0]!.t === 'para'
            ? inlines(item.c[0]!.c)
            : item.c.map((b, n) => <BlockView key={n} block={b} />)}
        </li>
      ));
      return block.ordered ? <ol start={block.start === 1 ? undefined : block.start}>{items}</ol> : <ul>{items}</ul>;
    }
    case 'table':
      return (
        <div className="rich-table">
          <table>
            <thead><tr>{block.head.map((c, i) => <th key={i} style={{ textAlign: block.align[i] ?? undefined }}>{inlines(c)}</th>)}</tr></thead>
            <tbody>
              {block.rows.map((row, r) => (
                <tr key={r}>{block.head.map((_, i) => <td key={i} style={{ textAlign: block.align[i] ?? undefined }}>{inlines(row[i] ?? [])}</td>)}</tr>
              ))}
            </tbody>
          </table>
        </div>
      );
    default: return null;
  }
}

function TexPiece({ part }: { part: TexPart }) {
  switch (part.t) {
    case 'text': return <>{part.v}</>;
    case 'command': return <span className="tx-cmd">{part.v}</span>;
    case 'comment': return <span className="tx-comment">{part.v}</span>;
    case 'brace': return <span className="tx-brace">{part.v}</span>;
    case 'math':
      return part.display
        ? <span className="tx-display"><Formula source={part.v} display title={part.source} /></span>
        : <Formula source={part.v} display={false} title={part.source} />;
    default: return null;
  }
}

export default function RichView({ text, media }: { text: string; media: string }) {
  return media === 'text/x-tex' ? <TexView text={text} /> : <RichMarkdown text={text} />;
}
