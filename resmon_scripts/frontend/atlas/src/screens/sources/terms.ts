/**
 * A search's terms and whether any or all of them must match, as the engine
 * reads them from a stored search (`implementation_scripts/search_terms.py`).
 *
 * Each chip is one term. A search with a keyword list matches any term unless
 * it stored `match: "all"`. A search that stored only a typed query (one made
 * through the MCP tools or the command line) asked for that query's words and
 * quoted phrases, every one of them, so it opens as those terms with All.
 */
export type Match = 'any' | 'all';

/** The two choices, in the words the switch shows. */
export const MATCHES: readonly { match: Match; label: string; says: string }[] = [
  { match: 'any', label: 'Any Term', says: 'A paper with any one of the terms is kept.' },
  { match: 'all', label: 'All Terms', says: 'A paper must have every term.' },
];

/**
 * The English stop words a typed query leaves out when it has other words.
 * The same list as `STOP_WORDS` in `search_terms.py`, which
 * `test_search_terms.py` holds this one to.
 */
export const STOP_WORDS: ReadonlySet<string> = new Set([
  'a', 'an', 'and', 'are', 'as', 'at', 'be', 'but', 'by', 'for', 'if', 'in',
  'into', 'is', 'it', 'no', 'not', 'of', 'on', 'or', 'such', 'that', 'the',
  'their', 'then', 'there', 'these', 'they', 'this', 'to', 'was', 'will',
  'with',
]);

const QUOTES = /["“”„‟«»″]/g;

/** One term as it is searched: quote marks dropped, spaces collapsed. */
export function cleanTerm(text: string): string {
  return text.replace(QUOTES, ' ').split(/\s+/).filter(Boolean).join(' ');
}

/** A typed query's terms: a quoted phrase is one term, every other word its own, stop words left out. */
export function splitQuery(query: string): string[] {
  const found: { quoted: boolean; term: string }[] = [];
  for (const each of query.matchAll(/"([^"]*)"|“([^”]*)”|(\S+)/g)) {
    const quoted = each[3] === undefined;
    const term = cleanTerm(each[1] ?? each[2] ?? each[3] ?? '');
    if (term) found.push({ quoted, term });
  }
  const kept = found.filter(({ quoted, term }) => quoted || !STOP_WORDS.has(term.toLowerCase())).map(({ term }) => term);
  return kept.length ? kept : found.map(({ term }) => term);
}

/** A stored match, or the default for how the terms were stored. */
export function matchOf(value: unknown, fallback: Match = 'any'): Match {
  return value === 'any' || value === 'all' ? value : fallback;
}

/** A stored search's terms and match, read the way the engine reads them. */
export function storedTerms(p: Record<string, unknown>): { keywords: string[]; match: Match } {
  const keywords = Array.isArray(p.keywords) ? p.keywords.map(String).filter((k) => k.trim()) : [];
  if (keywords.length) return { keywords, match: matchOf(p.match, 'any') };
  if (typeof p.query === 'string' && p.query.trim()) return { keywords: splitQuery(p.query), match: matchOf(p.match, 'all') };
  return { keywords: [], match: matchOf(p.match, 'any') };
}

/** "“a”", "“a” or “b”", "“a”, “b”, and “c”": each term quoted, joined by how they combine. */
export function termsInWords(terms: readonly string[], match: Match): string {
  const each = terms.map((t) => `\u201c${t}\u201d`);
  const joiner = match === 'all' ? 'and' : 'or';
  if (each.length < 3) return each.join(` ${joiner} `);
  return `${each.slice(0, -1).join(', ')}, ${joiner} ${each[each.length - 1]}`;
}
