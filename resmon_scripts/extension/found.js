// What Save to resmon sends resmon: the best way to look a paper up, from the page or link
// right-clicked, as a `resmon://find` link. Pure, so it is tested without a browser.
// The identifier rules are Link Meteor's (src/core/identifiers.js), trimmed to what resmon's
// Look Up a Paper reads: a DOI, an arXiv id, a PMID, or else a title.

// Crossref's pattern for modern DOIs: 10., 4 to 9 digits, a slash, and a suffix.
const DOI = /10\.\d{4,9}\/[-._;()/:a-z0-9]+/i;
const ARXIV_NEW = /^(\d{4}\.\d{4,5})(v\d+)?$/;
const ARXIV_OLD = /^([a-z-]+(?:\.[a-z]{2})?\/\d{7})(v\d+)?$/i;
const TRAILING = /[.,;:'"\]}>]+$/;
// bioRxiv's and medRxiv's DOIs, with what their addresses add after them (v1, v1.full, v1.full.pdf).
const RXIV = /^(10\.1101\/(?:\d{4}\.\d{2}\.\d{2}\.)?\d{6,})(?:v\d+)?(?:\.[-.\w]*)?$/i;
// The page publishers name after the DOI in their addresses (/doi/10.1002/x/abstract): not part of it.
const PAGE_NAME = /\/(?:full|abstract|summary|fulltext|full-text|pdf|epdf|epub|html|meta|references)$/i;
// resmon's Look Up a Paper reads at most this much.
const MOST_TYPED = 500;
const MOST_FROM = 2048;

function web(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url : null;
  } catch {
    return null;
  }
}

function decode(text) {
  try { return decodeURIComponent(text); } catch { return text; }
}

function tidyDoi(raw) {
  let doi = raw.replace(/\.(pdf|html?|xml|epub)$/i, '');
  for (;;) {
    const before = doi;
    doi = doi.replace(TRAILING, '');
    if (doi.endsWith(')') && (doi.match(/\(/g) || []).length < (doi.match(/\)/g) || []).length) doi = doi.slice(0, -1);
    if (PAGE_NAME.test(doi) && DOI.test(doi.replace(PAGE_NAME, ''))) doi = doi.replace(PAGE_NAME, '');
    if (doi === before) return doi.replace(RXIV, '$1');
  }
}

/** The first DOI in a piece of text, or ''. */
export function doiIn(text) {
  const match = DOI.exec(decode(String(text ?? '')));
  return match ? tidyDoi(match[0]) : '';
}

/** A DOI, arXiv id, or PMID that a web address names, as resmon's Look Up a Paper reads it, or ''. */
export function identifierIn(address) {
  const url = web(address);
  if (!url) return '';
  const host = url.hostname.toLowerCase();
  if (/(^|\.)arxiv\.org$/.test(host)) {
    const match = /^\/(?:abs|pdf|html)\/(.+?)(?:\.pdf)?\/?$/i.exec(decode(url.pathname));
    if (match && (ARXIV_NEW.test(match[1]) || ARXIV_OLD.test(match[1]))) return `arXiv:${match[1]}`;
  }
  if (host === 'pubmed.ncbi.nlm.nih.gov') {
    const pmid = /^\/(\d{1,9})\/?$/.exec(url.pathname)?.[1];
    if (pmid) return `PMID:${pmid}`;
  }
  if (/^(dx\.)?doi\.org$/.test(host)) return doiIn(url.pathname.slice(1));
  for (const [key, text] of url.searchParams) if (key.toLowerCase() === 'doi' && doiIn(text)) return doiIn(text);
  return doiIn(url.pathname) || doiIn(url.search);
}

const words = (text) => String(text ?? '').replace(/\s+/g, ' ').trim();

/**
 * What to look up, from what was right-clicked, the first that serves:
 * - a link: an identifier its address names, the text selected, or its own text (a title, most often);
 * - a page: the text selected on it (a choice the person made), a DOI its citation tags give,
 *   an identifier its address names, its citation title, or its title.
 * Something longer than Look Up a Paper reads is passed over for the next. Empty when nothing serves.
 */
export function findQuery(facts) {
  const candidates = facts.kind === 'link'
    ? [identifierIn(facts.linkUrl), words(facts.selection), words(facts.linkText)]
    : [words(facts.selection), doiIn(facts.metaDoi), identifierIn(facts.pageUrl), words(facts.metaTitle), words(facts.pageTitle)];
  return candidates.find((chosen) => chosen && chosen.length <= MOST_TYPED) ?? '';
}

/** The `resmon://find` link for what was right-clicked, or null when there is nothing to look up. */
export function resmonLink(facts) {
  const q = findQuery(facts);
  if (!q) return null;
  const params = new URLSearchParams({ q });
  const from = facts.kind === 'link' ? facts.linkUrl : facts.pageUrl;
  if (web(from) && String(from).length <= MOST_FROM) params.set('from', String(from));
  return `resmon://find?${params.toString()}`;
}
