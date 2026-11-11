import { pairLine, percentWords, type SharedWordingBrief, type SharedWordingOverview, type SharedWordingPair } from './wordingModel';

export const standardStatement = (pair: Pick<SharedWordingBrief, 'category'>) => pair.category === 'standard_statement';

/** Each engine group has its own count and cap, including Standard Statements. */
export function wordingGroups(data: SharedWordingOverview) { return data.groups; }

const literal = (value: unknown) => String(value ?? '').replace(/[\\`*_{}[\]()#+!|<>]/g, (c) => `\\${c}`);
const csvCell = (value: unknown) => {
  const raw = String(value ?? '');
  // Quoting alone does not stop a spreadsheet interpreting a cell as a formula.
  const safe = /^[\s]*[=+\-@\t\r]/.test(raw) ? `'${raw}` : raw;
  return `"${safe.replace(/"/g, '""')}"`;
};
const csv = (rows: unknown[][]) => rows.map((row) => row.map(csvCell).join(',')).join('\r\n') + '\r\n';
const fields = ['Paper A', 'Paper B', 'Group', 'Title A', 'Title B', 'Date A', 'Date B', 'Source A', 'Source B',
  'Longest Passage Words', 'Share Of Shorter Phrases', 'Authors In Common', 'Reason'];
const row = (p: SharedWordingBrief) => [p.left.id, p.right.id, standardStatement(p) ? 'standard_statement' : p.category,
  p.left.title, p.right.title, p.left.publication_date, p.right.publication_date, p.left.source_repository, p.right.source_repository,
  p.longest, p.share, p.authors_in_common, p.reason_words];

export function pageCsv(data: SharedWordingOverview): string {
  return csv([fields, ...wordingGroups(data).flatMap((g) => g.pairs.map(row))]);
}

export function pageMarkdown(data: SharedWordingOverview): string {
  const lines = ['# Shared Wording', '', `Method version: ${data.method_version}.`, '',
    'This export contains every pair listed on the page; groups may be capped. It does not include the full texts of unopened comparisons.', '',
    ...Object.entries(data.definitions).map(([key, value]) => `${literal(key)}: ${literal(value)}`), '',
    ...data.limits.map(literal), '', `Scan: ${data.scan ? literal(JSON.stringify(data.scan)) : 'None recorded.'}`, '',
    `Withheld: ${data.withheld}. Arrived since: ${data.arrived_since}.`, ''];
  for (const group of wordingGroups(data)) {
    lines.push(`## ${group.label}`, '', literal(group.note), '', `${group.pairs.length} listed of ${group.count}.`, '');
    for (const p of group.pairs) lines.push(`### Papers ${p.a} and ${p.b}`, '', literal(p.left.title), '', literal(p.right.title), '',
      `${literal(p.left.source_repository)} · ${literal(p.left.publication_date)} / ${literal(p.right.source_repository)} · ${literal(p.right.publication_date)}`, '', pairLine(p, data.settings.phrase_words), '', literal(p.reason_words), '');
  }
  return lines.join('\n');
}

function briefOf(pair: SharedWordingPair): SharedWordingBrief {
  return { ...pair, authors_in_common: pair.authors_in_common.length };
}

export function pairCsv(pair: SharedWordingPair): string {
  return csv([[...fields, 'Text A', 'Text B', 'Shared Passages (Codepoint Ranges)', 'Summary', 'Limitations', 'Method Version', 'Definitions'],
    [...row(briefOf(pair)), pair.left.text, pair.right.text, JSON.stringify(pair.passages), pair.summary.join('\n'), pair.limits.join('\n'), pair.method_version, JSON.stringify(pair.definitions)]]);
}

/** Fences longer than any in the text keep imported markup literal. */
function fenced(text: string): string {
  const longest = Math.max(2, ...Array.from(text.matchAll(/`+/g), (m) => m[0].length));
  const fence = '`'.repeat(longest + 1);
  return `${fence}text\n${text}\n${fence}`;
}

export function pairMarkdown(pair: SharedWordingPair): string {
  return ['# Shared Wording Comparison', '', `Papers ${pair.a} and ${pair.b}. Method version: ${pair.method_version}.`, '',
    ...pair.summary.map(literal), '', `Longest passage: ${pair.longest} words. Share: ${percentWords(pair.share)}.`, '',
    ...Object.values(pair.definitions).map(literal), '', ...(['left', 'right'] as const).flatMap((side) => {
      const p = pair[side];
      return [`## ${literal(p.title)}`, '', `Paper ${p.id}. ${literal(p.source_repository)}. ${literal(p.publication_date)}.`, '',
        literal(p.authors), '', fenced(p.text), ''];
    }), '## Shared Passage Ranges', '', fenced(JSON.stringify(pair.passages, null, 2)), '',
    '## Limitations', '', ...pair.limits.map(literal), ''].join('\n');
}
