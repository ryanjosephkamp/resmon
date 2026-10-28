import type { ReactNode } from 'react';

/**
 * The Markdown a run's report is written in, drawn as the page's own type.
 *
 * Only what `report_generator.py` writes: `#`–`###` headings, `**bold**`,
 * `[links](https://…)`, `- ` lists, `> ` quotes, `---` rules and the two
 * trailing spaces that break a line. Everything becomes React elements; no
 * string is ever handed to the DOM as HTML, so a paper title or abstract that
 * contains markup is shown as the characters it is. A link is drawn only for
 * an `http` or `https` address; anything else stays text.
 */
export function Markdown({ text }: { text: string }) {
  return <div className="md">{blocks(text)}</div>;
}

function inline(text: string, key: string): ReactNode[] {
  const out: ReactNode[] = [];
  const pattern = /\*\*(.+?)\*\*|\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g;
  let last = 0;
  let index = 0;
  for (const match of text.matchAll(pattern)) {
    const at = match.index ?? 0;
    if (at > last) out.push(text.slice(last, at));
    if (match[1] !== undefined) {
      out.push(<strong key={`${key}-b${index}`}>{inline(match[1], `${key}-b${index}`)}</strong>);
    } else {
      out.push(<a key={`${key}-a${index}`} href={match[3]} target="_blank" rel="noreferrer">{match[2]}</a>);
    }
    last = at + match[0].length;
    index += 1;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

/** Lines joined into one paragraph, with a break where a line ended in two spaces. */
function lines(group: string[], key: string): ReactNode[] {
  const out: ReactNode[] = [];
  group.forEach((line, i) => {
    out.push(...inline(line.replace(/ {2,}$/, ''), `${key}-${i}`));
    if (i < group.length - 1) out.push(/ {2,}$/.test(line) ? <br key={`${key}-br${i}`} /> : ' ');
  });
  return out;
}

function blocks(text: string): ReactNode[] {
  const source = text.replace(/\r\n?/g, '\n').split('\n');
  const out: ReactNode[] = [];
  let i = 0;
  while (i < source.length) {
    const line = source[i] ?? '';
    const key = `l${i}`;
    if (!line.trim()) { i += 1; continue; }
    const heading = line.match(/^(#{1,3})\s+(.*)$/);
    if (heading) {
      // One level down: the run's own title is the page's heading.
      const level = (heading[1] ?? '#').length;
      const content = inline(heading[2] ?? '', key);
      out.push(level === 1 ? <h2 key={key}>{content}</h2> : level === 2 ? <h3 key={key}>{content}</h3> : <h4 key={key}>{content}</h4>);
      i += 1;
      continue;
    }
    if (/^-{3,}\s*$/.test(line)) { out.push(<hr key={key} />); i += 1; continue; }
    if (line.startsWith('- ')) {
      const items: string[] = [];
      while (i < source.length && (source[i] ?? '').startsWith('- ')) { items.push((source[i] ?? '').slice(2)); i += 1; }
      out.push(<ul key={key}>{items.map((item, n) => <li key={n}>{inline(item, `${key}-${n}`)}</li>)}</ul>);
      continue;
    }
    if (line.startsWith('>')) {
      const quoted: string[] = [];
      while (i < source.length && (source[i] ?? '').startsWith('>')) { quoted.push((source[i] ?? '').replace(/^>\s?/, '')); i += 1; }
      out.push(<blockquote key={key}>{lines(quoted, key)}</blockquote>);
      continue;
    }
    const para: string[] = [];
    while (i < source.length) {
      const next = source[i] ?? '';
      if (!next.trim() || /^(#{1,3}\s|-{3,}\s*$|- |>)/.test(next)) break;
      para.push(next);
      i += 1;
    }
    out.push(<p key={key}>{lines(para, key)}</p>);
  }
  return out;
}
