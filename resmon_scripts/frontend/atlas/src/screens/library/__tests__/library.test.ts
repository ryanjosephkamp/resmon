import { importWords, kindOf, readable, sizeWords, type LibraryImported } from '../libraryApi';

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

test('the three kinds the Library keeps, and only text is read here', () => {
  expect(['application/pdf', 'text/plain', 'text/markdown'].map(kindOf)).toEqual(['PDF', 'Text', 'Markdown']);
  expect(kindOf('application/x-unknown')).toBe('application/x-unknown');
  expect(readable('text/plain') && readable('text/markdown')).toBe(true);
  expect(readable('application/pdf')).toBe(false);
});
