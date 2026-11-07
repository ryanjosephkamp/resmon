/**
 * Reading a kept Markdown or TeX file for its rich view: the text cut into the
 * parts the view draws, as plain data. Nothing here produces HTML. The view
 * turns each part into React elements, so a file that holds markup shows that
 * markup as the characters it is; only a formula is drawn, by KaTeX, into an
 * element of its own (`RichView.tsx`).
 *
 * The Markdown read is CommonMark's everyday part and GitHub's tables and task
 * lists: headings, paragraphs, emphasis, code, quotes, lists, rules, tables,
 * links, and math between `$` and `$$` (or `\(` `\)` and `\[` `\]`). A link is
 * kept only for an `http`, `https` or `mailto` address; any other is text. An
 * image is never fetched: the content policy would refuse it, and a kept file
 * should not reach out of the computer when it is read.
 */

export type Inline =
  | { t: 'text'; v: string }
  | { t: 'code'; v: string }
  | { t: 'math'; v: string; asWritten?: true }
  | { t: 'strong'; c: Inline[] }
  | { t: 'em'; c: Inline[] }
  | { t: 'del'; c: Inline[] }
  | { t: 'link'; href: string; c: Inline[] }
  | { t: 'image'; alt: string }
  | { t: 'br' };

export type Block =
  | { t: 'heading'; level: number; c: Inline[] }
  | { t: 'para'; c: Inline[] }
  | { t: 'code'; lang: string; v: string }
  | { t: 'math'; v: string; asWritten?: true }
  | { t: 'quote'; c: Block[] }
  | { t: 'list'; ordered: boolean; start: number; items: { task: boolean | null; c: Block[] }[] }
  | { t: 'table'; align: ('left' | 'center' | 'right' | null)[]; head: Inline[][]; rows: Inline[][][] }
  | { t: 'rule' };

const SAFE_LINK = /^(https?:\/\/|mailto:)/i;
/** A code span opened by more backticks than this is text: every length is one more delimiter to look for. */
const LONGEST_TICKS = 16;
/** How deep quotes and lists nest before the rest is shown as it is written. */
export const DEEPEST = 16;
/**
 * The most formulas one view draws; the rest are shown as written. Each takes
 * KaTeX a quarter of a millisecond or so, so a file of nothing but `$x$` (64,000
 * of them in 256 KiB) would hold the window for seconds.
 */
export const MOST_FORMULAS = 2000;

/**
 * Where a delimiter next appears after a place, remembered. Once one search
 * has found the next occurrence (or that there is none), a later search that
 * starts before that occurrence has the same answer, so each delimiter's text
 * is scanned once rather than once for every opener: a file of 128,000
 * unclosed `\(` reads in one pass, not 128,000.
 */
function finder(text: string): (needle: string, from: number) => number {
  const seen = new Map<string, { from: number; at: number }>();
  return (needle, from) => {
    const last = seen.get(needle);
    if (last && last.from <= from && (last.at < 0 || last.at >= from)) return last.at;
    const at = text.indexOf(needle, from);
    seen.set(needle, { from, at });
    return at;
  };
}

/** The same, for the next place that passes a test: an unescaped bracket, a space, a non-space. */
function scanner(text: string, test: (i: number) => boolean): (from: number) => number {
  let last: { from: number; at: number } | null = null;
  return (from) => {
    if (last && last.from <= from && (last.at < 0 || last.at >= from)) return last.at;
    let i = from;
    while (i < text.length && !test(i)) i += 1;
    last = { from, at: i < text.length ? i : -1 };
    return last.at;
  };
}

function space(ch: string | undefined): boolean {
  if (ch === undefined) return false;
  return ch <= ' ' ? ch === ' ' || ch === '\n' || ch === '\t' || ch === '\r' || ch === '\f' || ch === '\v' : ch >= '\u0080' && /\s/.test(ch);
}

/** Which characters a backslash before them escapes, reading from the start: `\\]` is a backslash and a bracket. */
function escapes(text: string): Uint8Array {
  const escaped = new Uint8Array(text.length + 1);
  for (let k = 1; k < text.length; k += 1) if (text[k - 1] === '\\' && !escaped[k - 1]) escaped[k] = 1;
  return escaped;
}

/**
 * Where a link's or an image's `(destination "title")` ends, one past its `)`,
 * for openers at ever later places. Each kind of opener has one of these, with
 * its own remembered searches, so the two never undo each other's memory.
 */
function destinations(text: string): (open: number) => { end: number; href: string } | null {
  const find = finder(text);
  const nextSpace = scanner(text, (k) => space(text[k]));
  const nextNonSpace = scanner(text, (k) => !space(text[k]));
  return (open) => {
    if (text[open] !== '(') return null;
    const paren = find(')', open + 1);
    const gap = nextSpace(open + 1);
    const stop = paren < 0 ? gap : gap < 0 ? paren : Math.min(paren, gap);
    if (stop < 0) return null;
    const href = text.slice(open + 1, stop);
    if (text[stop] === ')') return { end: stop + 1, href };
    const title = nextNonSpace(stop);
    if (title < 0 || text[title] !== '"') return null;
    const quote = find('"', title + 1);
    return quote >= 0 && text[quote + 1] === ')' ? { end: quote + 2, href } : null;
  };
}

/**
 * Inline Markdown: code first (nothing inside it is read), then math, links,
 * emphasis. Every search for a closing delimiter is remembered (`finder`), so
 * the read is linear in the text whatever it holds.
 */
export function inline(text: string): Inline[] {
  const out: Inline[] = [];
  let plain = '';
  const flush = () => { if (plain) { out.push({ t: 'text', v: plain }); plain = ''; } };
  const find = finder(text);
  let escaped: Uint8Array | null = null;
  const nextBracket = scanner(text, (k) => text[k] === ']' && !(escaped ??= escapes(text))[k]);
  const nextSpace = scanner(text, (k) => space(text[k]));
  const linkTarget = destinations(text);
  const imageTarget = destinations(text);
  let i = 0;
  while (i < text.length) {
    const ch = text[i]!;
    if (ch === '\\' && i + 1 < text.length) {
      const next = text[i + 1]!;
      if (next === '(') {
        const end = find('\\)', i + 2);
        if (end > 0) { flush(); out.push({ t: 'math', v: text.slice(i + 2, end) }); i = end + 2; continue; }
      }
      if (next === '\n') { flush(); out.push({ t: 'br' }); i += 2; continue; }
      if (/[!-/:-@[-`{-~]/.test(next)) { plain += next; i += 2; continue; }
    }
    if (ch === '`') {
      let length = 1;
      while (text[i + length] === '`') length += 1;
      const run = '`'.repeat(length);
      const end = length <= LONGEST_TICKS ? find(run, i + length) : -1;
      if (end > 0) { flush(); out.push({ t: 'code', v: text.slice(i + length, end).replace(/^ (.*) $/s, '$1') }); i = end + length; continue; }
      plain += run; i += length; continue;
    }
    if (ch === '$' && text[i + 1] !== '$') {
      // `$x$`: not `$ ` and not ` $`, the rule pandoc keeps, so "$5 and $6" stays text.
      const end = find('$', i + 1);
      if (end > i + 1 && !space(text[i + 1]) && (end === i + 2 || (!space(text[end - 1]) && text[end - 1] !== '\\'))
        && !/\d/.test(text[end + 1] ?? '')) {
        flush(); out.push({ t: 'math', v: text.slice(i + 1, end) }); i = end + 1; continue;
      }
    }
    if (ch === '$' && text[i + 1] === '$') {
      const end = find('$$', i + 2);
      if (end > i + 2) { flush(); out.push({ t: 'math', v: text.slice(i + 2, end) }); i = end + 2; continue; }
    }
    if (ch === '!' && text[i + 1] === '[') {
      const close = find(']', i + 2);
      const target = close > 0 ? imageTarget(close + 1) : null;
      if (target) { flush(); out.push({ t: 'image', alt: text.slice(i + 2, close) }); i = target.end; continue; }
    }
    if (ch === '[') {
      const close = nextBracket(i + 1);
      const target = close > 0 ? linkTarget(close + 1) : null;
      if (target) {
        flush();
        const label = inline(text.slice(i + 1, close));
        if (SAFE_LINK.test(target.href)) out.push({ t: 'link', href: target.href, c: label });
        else out.push(...label);
        i = target.end;
        continue;
      }
    }
    const scheme = ch === '<' ? /^(?:https?:\/\/|mailto:)/i.exec(text.slice(i + 1, i + 9)) : null;
    if (scheme) {
      const angle = find('>', i + 1);
      const gap = nextSpace(i + 1);
      if (angle > i + 1 + scheme[0].length && (gap < 0 || angle < gap)) {
        const href = text.slice(i + 1, angle);
        flush(); out.push({ t: 'link', href, c: [{ t: 'text', v: href }] }); i = angle + 1; continue;
      }
    }
    if (ch === '~' && text[i + 1] === '~') {
      const end = find('~~', i + 2);
      if (end > i + 2) { flush(); out.push({ t: 'del', c: inline(text.slice(i + 2, end)) }); i = end + 2; continue; }
    }
    if ((ch === '*' || ch === '_') && text[i + 1] === ch) {
      const end = find(ch + ch, i + 2);
      if (end > i + 2) { flush(); out.push({ t: 'strong', c: inline(text.slice(i + 2, end)) }); i = end + 2; continue; }
    }
    if (ch === '*' || (ch === '_' && (i === 0 || /[\s(]/.test(text[i - 1]!)))) {
      const end = find(ch, i + 1);
      if (end > i + 1 && !space(text[i + 1]) && !space(text[end - 1])
        && (ch === '*' || end + 1 >= text.length || /[\s.,;:!?)]/.test(text[end + 1]!))) {
        flush(); out.push({ t: 'em', c: inline(text.slice(i + 1, end)) }); i = end + 1; continue;
      }
    }
    if (ch === '\n') {
      if (plain.endsWith('  ')) {
        let cut = plain.length;
        while (cut > 0 && plain[cut - 1] === ' ') cut -= 1;
        plain = plain.slice(0, cut);
        flush();
        out.push({ t: 'br' });
      } else plain += ' ';
      i += 1;
      continue;
    }
    plain += ch;
    i += 1;
  }
  flush();
  return out;
}

const FENCE = /^ {0,3}(`{3,}|~{3,})\s*([^`\s]*)/;
const HEADING = /^ {0,3}(#{1,6})(?:\s+(.*?))?\s*#*\s*$/;
const RULE = /^ {0,3}([-*_])(?:\s*\1){2,}\s*$/;
const BULLET = /^( {0,12})([-*+])\s+(.*)$/;
const ORDERED = /^( {0,12})(\d{1,9})[.)]\s+(.*)$/;
// Tested on the trimmed line: a leading `\s*` beside `\|?\s*` let a line of spaces take time in its square.
const TABLE_RULE = /^\|?\s*:?-+:?\s*(?:\|\s*:?-+:?\s*)*\|?$/;

function cells(line: string): string[] {
  let body = line.trim();
  if (body.startsWith('|')) body = body.slice(1);
  if (body.endsWith('|') && !body.endsWith('\\|')) body = body.slice(0, -1);
  const out: string[] = [];
  let cell = '';
  for (let i = 0; i < body.length; i += 1) {
    if (body[i] === '\\' && body[i + 1] === '|') { cell += '|'; i += 1; continue; }
    if (body[i] === '|') { out.push(cell.trim()); cell = ''; continue; }
    cell += body[i];
  }
  out.push(cell.trim());
  return out;
}

/** Markdown blocks, read line by line, with the formulas past `MOST_FORMULAS` marked to be shown as written. */
export function markdown(source: string): Block[] {
  const read = blocks(source.replace(/\r\n?/g, '\n').replace(/\t/g, '    ').split('\n'), 0);
  let left = MOST_FORMULAS;
  const formula = (math: { asWritten?: true }) => { if (left > 0) left -= 1; else math.asWritten = true; };
  const inlines = (parts: readonly Inline[]) => {
    for (const part of parts) {
      if (part.t === 'math') formula(part);
      else if ('c' in part) inlines(part.c);
    }
  };
  const walk = (list: readonly Block[]) => {
    for (const block of list) {
      if (block.t === 'heading' || block.t === 'para') inlines(block.c);
      else if (block.t === 'math') formula(block);
      else if (block.t === 'quote') walk(block.c);
      else if (block.t === 'list') for (const item of block.items) walk(item.c);
      else if (block.t === 'table') for (const row of [block.head, ...block.rows]) for (const cell of row) inlines(cell);
    }
  };
  walk(read);
  return read;
}

/** How many formulas a read holds, and how many of them are shown as written. */
export function formulaCount(read: readonly Block[] | readonly TexPart[]): { all: number; asWritten: number } {
  const count = { all: 0, asWritten: 0 };
  const formula = (math: { asWritten?: true }) => { count.all += 1; if (math.asWritten) count.asWritten += 1; };
  const inlines = (parts: readonly Inline[]) => {
    for (const part of parts) {
      if (part.t === 'math') formula(part);
      else if ('c' in part) inlines(part.c);
    }
  };
  const walk = (list: readonly (Block | TexPart)[]) => {
    for (const block of list) {
      if (block.t === 'math') formula(block);
      else if (block.t === 'heading' || block.t === 'para') inlines(block.c);
      else if (block.t === 'quote') walk(block.c);
      else if (block.t === 'list') for (const item of block.items) walk(item.c);
      else if (block.t === 'table') for (const row of [block.head, ...block.rows]) for (const cell of row) inlines(cell);
    }
  };
  walk(read);
  return count;
}

/** What is nested deeper than `DEEPEST`: shown as it is written, one paragraph of text. */
function asWritten(lines: readonly string[]): Block[] {
  return [{ t: 'para', c: [{ t: 'text', v: lines.join('\n') }] }];
}

function blocks(lines: string[], depth: number): Block[] {
  if (depth > DEEPEST) return asWritten(lines);
  const out: Block[] = [];
  let i = 0;
  const startsBlock = (line: string) => !line.trim() || FENCE.test(line) || HEADING.test(line) || RULE.test(line)
    || /^ {0,3}>/.test(line) || BULLET.test(line) || ORDERED.test(line) || /^\s*(\$\$|\\\[)/.test(line);
  while (i < lines.length) {
    const line = lines[i]!;
    if (!line.trim()) { i += 1; continue; }
    const fence = FENCE.exec(line);
    if (fence) {
      const marker = fence[1]!;
      const body: string[] = [];
      i += 1;
      while (i < lines.length && !new RegExp(`^ {0,3}${marker[0] === '`' ? '`' : '~'}{${marker.length},}\\s*$`).test(lines[i]!)) {
        body.push(lines[i]!);
        i += 1;
      }
      i += 1;
      out.push({ t: 'code', lang: fence[2] ?? '', v: body.join('\n') });
      continue;
    }
    const display = /^\s*(\$\$|\\\[)(.*)$/.exec(line);
    if (display) {
      const close = display[1] === '$$' ? '$$' : '\\]';
      const body: string[] = [];
      let tail = display[2] ?? '';
      let end = tail.indexOf(close);
      if (end >= 0) {
        out.push({ t: 'math', v: tail.slice(0, end).trim() });
        i += 1;
        continue;
      }
      body.push(tail);
      i += 1;
      while (i < lines.length) {
        tail = lines[i]!;
        end = tail.indexOf(close);
        if (end >= 0) { body.push(tail.slice(0, end)); i += 1; break; }
        body.push(tail);
        i += 1;
      }
      out.push({ t: 'math', v: body.join('\n').trim() });
      continue;
    }
    const heading = HEADING.exec(line);
    if (heading) {
      out.push({ t: 'heading', level: heading[1]!.length, c: inline(heading[2] ?? '') });
      i += 1;
      continue;
    }
    if (RULE.test(line)) { out.push({ t: 'rule' }); i += 1; continue; }
    if (/^ {0,3}>/.test(line)) {
      const body: string[] = [];
      while (i < lines.length && lines[i]!.trim() && /^ {0,3}>/.test(lines[i]!)) {
        body.push(lines[i]!.replace(/^ {0,3}> ?/, ''));
        i += 1;
      }
      out.push({ t: 'quote', c: blocks(body, depth + 1) });
      continue;
    }
    const listStart = BULLET.exec(line) ?? ORDERED.exec(line);
    if (listStart) {
      const ordered = !BULLET.test(line);
      const indent = listStart[1]!.length;
      const items: { task: boolean | null; c: Block[] }[] = [];
      while (i < lines.length) {
        const current = lines[i]!;
        const item = (ordered ? ORDERED : BULLET).exec(current);
        if (!item || item[1]!.length !== indent) break;
        const body = [item[3]!];
        i += 1;
        while (i < lines.length) {
          const next = lines[i]!;
          if (!next.trim()) {
            const after = lines[i + 1];
            if (after !== undefined && /^\s+/.test(after) && (after.length - after.trimStart().length) > indent) { body.push(''); i += 1; continue; }
            break;
          }
          const nested = (BULLET.exec(next) ?? ORDERED.exec(next));
          if (nested && nested[1]!.length <= indent) break;
          if (!nested && !/^\s/.test(next) && startsBlock(next)) break;
          body.push(next.slice(Math.min(indent + 2, next.length - next.trimStart().length)));
          i += 1;
        }
        const task = /^\[([ xX])\]\s+/.exec(body[0]!);
        if (task) body[0] = body[0]!.slice(task[0].length);
        items.push({ task: task ? task[1] !== ' ' : null, c: blocks(body, depth + 1) });
      }
      out.push({ t: 'list', ordered, start: ordered ? Number(listStart[2]) : 1, items });
      continue;
    }
    if (line.includes('|') && i + 1 < lines.length && TABLE_RULE.test(lines[i + 1]!.trim()) && lines[i + 1]!.includes('-')) {
      const head = cells(line);
      const align = cells(lines[i + 1]!).map((c) => (c.startsWith(':') && c.endsWith(':') ? 'center' : c.endsWith(':') ? 'right' : c.startsWith(':') ? 'left' : null));
      i += 2;
      const rows: Inline[][][] = [];
      while (i < lines.length && lines[i]!.trim() && lines[i]!.includes('|')) {
        rows.push(cells(lines[i]!).slice(0, head.length).map(inline));
        i += 1;
      }
      out.push({ t: 'table', align: head.map((_, n) => align[n] ?? null), head: head.map(inline), rows });
      continue;
    }
    const para: string[] = [line.trim()];
    i += 1;
    while (i < lines.length && lines[i]!.trim() && !startsBlock(lines[i]!)) {
      para.push(lines[i]!.replace(/^\s+/, ''));
      i += 1;
    }
    out.push({ t: 'para', c: inline(para.join('\n')) });
  }
  return out;
}

/** A piece of TeX source: plain text, a command, a comment, a brace, or a formula. */
export type TexPart =
  | { t: 'text'; v: string }
  | { t: 'command'; v: string }
  | { t: 'comment'; v: string }
  | { t: 'brace'; v: string }
  | { t: 'math'; v: string; source: string; display: boolean; asWritten?: true };

const DISPLAY_ENVIRONMENTS = 'equation|equation\\*|align|align\\*|gather|gather\\*|multline|multline\\*|eqnarray|eqnarray\\*|displaymath|alignat|alignat\\*|flalign|flalign\\*';
const ENVIRONMENT = new RegExp(`\\\\begin\\{(${DISPLAY_ENVIRONMENTS})\\}`, 'y');
const COMMAND = /\\(?:[A-Za-z@]+\*?|.)/y;

/**
 * TeX source cut into what the highlighted view colors, with every formula
 * found: `$…$`, `$$…$$`, `\(…\)`, `\[…\]`, and the display environments KaTeX
 * draws. Everything else is source, shown as written. Every search for a
 * closing delimiter is remembered, as in Markdown, so the read is linear.
 */
export function tex(source: string): TexPart[] {
  const text = source.replace(/\r\n?/g, '\n');
  const out: TexPart[] = [];
  let plain = '';
  const flush = () => { if (plain) { out.push({ t: 'text', v: plain }); plain = ''; } };
  const find = finder(text);
  const escaped = escapes(text);
  const nextDollar = scanner(text, (k) => text[k] === '$' && !escaped[k]);
  const nextDoubleDollar = scanner(text, (k) => text[k] === '$' && text[k + 1] === '$' && !escaped[k]);
  let i = 0;
  while (i < text.length) {
    const ch = text[i]!;
    if (ch === '%') {
      const end = find('\n', i);
      flush();
      out.push({ t: 'comment', v: text.slice(i, end < 0 ? text.length : end) });
      i = end < 0 ? text.length : end;
      continue;
    }
    if (ch === '\\') {
      ENVIRONMENT.lastIndex = i;
      const environment = ENVIRONMENT.exec(text);
      if (environment) {
        const close = `\\end{${environment[1]}}`;
        const end = find(close, i);
        if (end > 0) {
          const whole = text.slice(i, end + close.length);
          flush();
          // KaTeX draws `equation` as its body and `eqnarray` and `displaymath` as `align*` and a bare display.
          const name = environment[1]!.replace('\\*', '*');
          const body = text.slice(i + environment[0].length, end);
          const drawn = /^equation\*?$|^displaymath$/.test(name) ? body
            : /^eqnarray\*?$/.test(name) ? `\\begin{align*}${body.replace(/&\s*=\s*&/g, '&=')}\\end{align*}` : whole;
          out.push({ t: 'math', v: drawn.trim(), source: whole, display: true });
          i = end + close.length;
          continue;
        }
      }
      if (text[i + 1] === '[' || text[i + 1] === '(') {
        const display = text[i + 1] === '[';
        const end = find(display ? '\\]' : '\\)', i + 2);
        if (end > 0) {
          flush();
          out.push({ t: 'math', v: text.slice(i + 2, end).trim(), source: text.slice(i, end + 2), display });
          i = end + 2;
          continue;
        }
      }
      COMMAND.lastIndex = i;
      const command = COMMAND.exec(text);
      if (command) {
        flush();
        out.push({ t: 'command', v: command[0] });
        i += command[0].length;
        continue;
      }
    }
    if (ch === '$') {
      const display = text[i + 1] === '$';
      const open = display ? 2 : 1;
      let end = display ? nextDoubleDollar(i + 2) : nextDollar(i + 1);
      // `$…$` stops at a blank line, as TeX's own inline math does.
      if (!display && end >= 0) {
        const blank = find('\n\n', i + 1);
        if (blank >= 0 && blank < end) end = -1;
      }
      if (end > i + open - 1) {
        flush();
        out.push({ t: 'math', v: text.slice(i + open, end).trim(), source: text.slice(i, end + open), display });
        i = end + open;
        continue;
      }
    }
    if (ch === '{' || ch === '}' || ch === '[' || ch === ']') {
      flush();
      out.push({ t: 'brace', v: ch });
      i += 1;
      continue;
    }
    plain += ch;
    i += 1;
  }
  flush();
  // A display formula is set on its own line: the line break written after it in the source is that line's end.
  for (let n = 1; n < out.length; n += 1) {
    const before = out[n - 1]!, part = out[n]!;
    if (before.t === 'math' && before.display && part.t === 'text' && part.v.startsWith('\n')) out[n] = { t: 'text', v: part.v.slice(1) };
  }
  // Neighbors of one kind are one piece: `\alpha\beta` reads the same as two, and a file of 100,000
  // braces is one element on the page, not 100,000.
  const merged: TexPart[] = [];
  let left = MOST_FORMULAS;
  for (const part of out) {
    if (part.t === 'math') { if (left > 0) left -= 1; else part.asWritten = true; }
    if (part.t === 'text' && part.v === '') continue;
    const last = merged[merged.length - 1];
    if (last && last.t === part.t && part.t !== 'math' && last.t !== 'math') merged[merged.length - 1] = { t: part.t, v: last.v + part.v };
    else merged.push(part);
  }
  return merged;
}
