import { pairCsv, pairMarkdown } from '../wordingExport';
import type { SharedWordingPair } from '../wordingModel';

const pair = { a: 1, b: 2, category: 'different_authors', reasons: [], reason_words: null,
  longest: 24, share: 0.25, method_version: 2, authors_in_common: [],
  left: { id: 1, title: '=formula, title', publication_date: '2026', source_repository: 'crossref', authors: 'A First', text: '😀 first\n```\n<script>literal</script>' },
  right: { id: 2, title: 'Other title', publication_date: null, source_repository: 'arxiv', authors: 'B Second', text: 'Other, "quoted" text' },
  passages: [{ left: [2, 7], right: [0, 5], words: 8 }], summary: ['Measured, not a verdict.'],
  definitions: { longest: 'Consecutive words.', share: 'Share of phrases.', authors: 'Matching names.' },
  limits: ['No claim of plagiarism.'] } as unknown as SharedWordingPair;

test('a pair CSV carries both full texts, measured ranges, qualifications, and literal spreadsheet cells', () => {
  const out = pairCsv(pair);
  expect(out).toContain("'=formula, title");
  expect(out).toContain('Other, ""quoted"" text');
  expect(out).toContain(pair.left.text);
  expect(out).toContain('No claim of plagiarism.');
  expect(out).toContain('Codepoint Ranges');
});

test('a pair Markdown keeps markup literal, including fences, and includes both texts and limits', () => {
  const out = pairMarkdown(pair);
  expect(out).toContain('````text\n' + pair.left.text + '\n````');
  expect(out).toContain(pair.right.text);
  expect(out).toContain('No claim of plagiarism.');
  expect(out).toContain('Share of phrases.');
});

test('CSV identifiers follow the displayed text sides when the later id was published earlier', () => {
  const reversed = { ...pair, left: pair.right, right: pair.left };
  expect(pairCsv(reversed).split('\r\n')[1]).toMatch(/^"2","1",/);
});
