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
  | { t: 'math'; v: string }
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
  | { t: 'math'; v: string }
  | { t: 'quote'; c: Block[] }
  | { t: 'list'; ordered: boolean; start: number; items: { task: boolean | null; c: Block[] }[] }
  | { t: 'table'; align: ('left' | 'center' | 'right' | null)[]; head: Inline[][]; rows: Inline[][][] }
  | { t: 'rule' };

const SAFE_LINK = /^(https?:\/\/|mailto:)/i;

/** Inline Markdown: code first (nothing inside it is read), then math, links, emphasis. */
export function inline(text: string): Inline[] {
  const out: Inline[] = [];
  let plain = '';
  const flush = () => { if (plain) { out.push({ t: 'text', v: plain }); plain = ''; } };
  let i = 0;
  while (i < text.length) {
    const ch = text[i]!;
    const rest = text.slice(i);
    if (ch === '\\' && i + 1 < text.length) {
      const next = text[i + 1]!;
      if (next === '(') {
        const end = text.indexOf('\\)', i + 2);
        if (end > 0) { flush(); out.push({ t: 'math', v: text.slice(i + 2, end) }); i = end + 2; continue; }
      }
      if (next === '\n') { flush(); out.push({ t: 'br' }); i += 2; continue; }
      if (/[!-/:-@[-`{-~]/.test(next)) { plain += next; i += 2; continue; }
    }
    if (ch === '`') {
      const run = /^`+/.exec(rest)![0];
      const end = text.indexOf(run, i + run.length);
      if (end > 0) { flush(); out.push({ t: 'code', v: text.slice(i + run.length, end).replace(/^ (.*) $/s, '$1') }); i = end + run.length; continue; }
      plain += run; i += run.length; continue;
    }
    if (ch === '$' && text[i + 1] !== '$') {
      // `$x$`: not `$ ` and not ` $`, the rule pandoc keeps, so "$5 and $6" stays text.
      const close = /^\$([^\s$](?:[^$]*?[^\s$\\])?)\$(?!\d)/.exec(rest);
      if (close) { flush(); out.push({ t: 'math', v: close[1]! }); i += close[0].length; continue; }
    }
    if (ch === '$' && text[i + 1] === '$') {
      const end = text.indexOf('$$', i + 2);
      if (end > i + 2) { flush(); out.push({ t: 'math', v: text.slice(i + 2, end) }); i = end + 2; continue; }
    }
    if (ch === '!' && text[i + 1] === '[') {
      const image = /^!\[([^\]]*)\]\(([^)\s]*)(?:\s+"[^"]*")?\)/.exec(rest);
      if (image) { flush(); out.push({ t: 'image', alt: image[1]! }); i += image[0].length; continue; }
    }
    if (ch === '[') {
      const link = /^\[((?:[^\]\\]|\\.)*)\]\(([^)\s]*)(?:\s+"[^"]*")?\)/.exec(rest);
      if (link) {
        flush();
        const label = inline(link[1]!);
        if (SAFE_LINK.test(link[2]!)) out.push({ t: 'link', href: link[2]!, c: label });
        else out.push(...label);
        i += link[0].length;
        continue;
      }
    }
    if (ch === '<') {
      const auto = /^<((?:https?:\/\/|mailto:)[^\s>]+)>/i.exec(rest);
      if (auto) { flush(); out.push({ t: 'link', href: auto[1]!, c: [{ t: 'text', v: auto[1]! }] }); i += auto[0].length; continue; }
    }
    if (ch === '~' && text[i + 1] === '~') {
      const end = text.indexOf('~~', i + 2);
      if (end > i + 2) { flush(); out.push({ t: 'del', c: inline(text.slice(i + 2, end)) }); i = end + 2; continue; }
    }
    if ((ch === '*' || ch === '_') && text[i + 1] === ch) {
      const end = text.indexOf(ch + ch, i + 2);
      if (end > i + 2) { flush(); out.push({ t: 'strong', c: inline(text.slice(i + 2, end)) }); i = end + 2; continue; }
    }
    if (ch === '*' || (ch === '_' && (i === 0 || /[\s(]/.test(text[i - 1]!)))) {
      const end = text.indexOf(ch, i + 1);
      if (end > i + 1 && !/\s/.test(text[i + 1]!) && !/\s/.test(text[end - 1]!)
        && (ch === '*' || end + 1 >= text.length || /[\s.,;:!?)]/.test(text[end + 1]!))) {
        flush(); out.push({ t: 'em', c: inline(text.slice(i + 1, end)) }); i = end + 1; continue;
      }
    }
    if (ch === '\n') {
      if (/ {2,}$/.test(plain)) { plain = plain.replace(/ +$/, ''); flush(); out.push({ t: 'br' }); } else plain += ' ';
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
const TABLE_RULE = /^\s*\|?\s*:?-{1,}:?\s*(\|\s*:?-{1,}:?\s*)*\|?\s*$/;

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

/** Markdown blocks, read line by line. */
export function markdown(source: string): Block[] {
  return blocks(source.replace(/\r\n?/g, '\n').replace(/\t/g, '    ').split('\n'));
}

function blocks(lines: string[]): Block[] {
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
      out.push({ t: 'quote', c: blocks(body) });
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
        items.push({ task: task ? task[1] !== ' ' : null, c: blocks(body) });
      }
      out.push({ t: 'list', ordered, start: ordered ? Number(listStart[2]) : 1, items });
      continue;
    }
    if (line.includes('|') && i + 1 < lines.length && TABLE_RULE.test(lines[i + 1]!) && lines[i + 1]!.includes('-')) {
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
  | { t: 'math'; v: string; source: string; display: boolean };

const DISPLAY_ENVIRONMENTS = 'equation|equation\\*|align|align\\*|gather|gather\\*|multline|multline\\*|eqnarray|eqnarray\\*|displaymath|alignat|alignat\\*|flalign|flalign\\*';
const ENVIRONMENT = new RegExp(`^\\\\begin\\{(${DISPLAY_ENVIRONMENTS})\\}`);

/**
 * TeX source cut into what the highlighted view colors, with every formula
 * found: `$…$`, `$$…$$`, `\(…\)`, `\[…\]`, and the display environments KaTeX
 * draws. Everything else is source, shown as written.
 */
export function tex(source: string): TexPart[] {
  const text = source.replace(/\r\n?/g, '\n');
  const out: TexPart[] = [];
  let plain = '';
  const flush = () => { if (plain) { out.push({ t: 'text', v: plain }); plain = ''; } };
  let i = 0;
  while (i < text.length) {
    const ch = text[i]!;
    const rest = text.slice(i);
    if (ch === '%') {
      const end = text.indexOf('\n', i);
      flush();
      out.push({ t: 'comment', v: text.slice(i, end < 0 ? text.length : end) });
      i = end < 0 ? text.length : end;
      continue;
    }
    if (ch === '\\') {
      const environment = ENVIRONMENT.exec(rest);
      if (environment) {
        const close = `\\end{${environment[1]}}`;
        const end = text.indexOf(close, i);
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
      if (rest.startsWith('\\[') || rest.startsWith('\\(')) {
        const close = rest[1] === '[' ? '\\]' : '\\)';
        const end = text.indexOf(close, i + 2);
        if (end > 0) {
          flush();
          out.push({ t: 'math', v: text.slice(i + 2, end).trim(), source: text.slice(i, end + 2), display: rest[1] === '[' });
          i = end + 2;
          continue;
        }
      }
      const command = /^\\(?:[A-Za-z@]+\*?|.)/.exec(rest);
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
      let end = -1;
      for (let j = i + open; j < text.length; j += 1) {
        if (text[j] === '\\') { j += 1; continue; }
        if (text[j] === '$' && (!display || text[j + 1] === '$')) { end = j; break; }
        if (!display && text[j] === '\n' && text[j + 1] === '\n') break;
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
  return out.filter((p) => p.t !== 'text' || p.v !== '');
}
