import { importWords, keepable, kindOf, readable, rich, sizeWords, type LibraryImported } from '../libraryApi';

const imported = (created: boolean): LibraryImported => ({ created, duplicate: !created } as unknown as LibraryImported);

test('what a batch of imports did, in the words the import reports', () => {
  expect(importWords([imported(true), imported(true)], 0)).toBe('2 retained, 0 exact duplicates reused.');
  expect(importWords([imported(false)], 0)).toBe('0 retained, 1 exact duplicate reused.');
  expect(importWords([imported(true)], 2)).toBe('1 retained, 0 exact duplicates reused, 2 refused.');
});

test('sizes in decimal units, as a file manager shows them', () => {
  expect(sizeWords(1)).toBe('1 byte');
  expect(sizeWords(999)).toBe('999 bytes');
  expect(sizeWords(1500)).toBe('1.5 KB');
  expect(sizeWords(64 * 1024 * 1024)).toBe('67.1 MB');
});

test('the four kinds the Library keeps: every one but a PDF is read as text, and two have a rich view', () => {
  expect(['application/pdf', 'text/plain', 'text/markdown', 'text/x-tex'].map(kindOf)).toEqual(['PDF', 'Text', 'Markdown', 'TeX']);
  expect(kindOf('application/x-unknown')).toBe('application/x-unknown');
  expect(readable('text/plain') && readable('text/markdown') && readable('text/x-tex')).toBe(true);
  expect(readable('application/pdf')).toBe(false);
  expect([rich('text/markdown'), rich('text/x-tex'), rich('text/plain'), rich('application/pdf')]).toEqual([true, true, false, false]);
  expect(['a.PDF', 'b.tex', 'c.md', 'd.txt', 'e.docx', 'tex'].map(keepable)).toEqual([true, true, true, true, false, false]);
});
