import * as fs from 'fs';
import * as path from 'path';

const guide = path.resolve(__dirname, '../../../site/src/content/guide');

test('one guide section explains what the collection, queue, PDF, and project each keep', () => {
  const library = fs.readFileSync(path.join(guide, 'library.md'), 'utf8');
  expect(library).toContain('## From a Run to a Project');
  expect(library).toContain('Every paper a run finds is kept in the collection');
  expect(library).toContain('Erase the Paper Corpus');
  expect(library).toContain('**Add to a Project**');
  expect(library).toContain('**Saved**');
  for (const file of ['search.md', 'projects.md']) {
    expect(fs.readFileSync(path.join(guide, file), 'utf8')).toContain('/resmon/guide/library/#from-a-run-to-a-project');
  }
});
