import { libraryRemovedFile } from '../electron/libraryTrash';

const ID = '0f3a9c1e-5b2d-4c8e-9a71-2d6e8f4b1c03';
const HELD = '7c2e1b9a-3d4f-4a6b-8c5d-9e0f1a2b3c4d';

test('only a file held as removed inside a Library folder can be sent to the Trash', () => {
  expect(libraryRemovedFile(`/Users/x/Docs/resmon-library-${ID}/removed/${HELD}/paper.pdf`, '/')).toBe(true);
  expect(libraryRemovedFile(`/Users/x/Docs/resmon-library-${ID}/files/${HELD}/paper.pdf`, '/')).toBe(false);
  expect(libraryRemovedFile(`/Users/x/Docs/resmon-library-${ID}/removed/${HELD}`, '/')).toBe(false);
  expect(libraryRemovedFile(`/Users/x/Docs/resmon-library-${ID}/removed/${HELD}/../../vault.json`, '/')).toBe(false);
  expect(libraryRemovedFile(`/Users/x/Documents/removed/${HELD}/thesis.pdf`, '/')).toBe(false);
  expect(libraryRemovedFile(`relative/resmon-library-${ID}/removed/${HELD}/a.pdf`, '/')).toBe(false);
  expect(libraryRemovedFile('/Users/x', '/')).toBe(false);
  expect(libraryRemovedFile(42, '/')).toBe(false);
  expect(libraryRemovedFile(`C:\\Users\\x\\resmon-library-${ID}\\removed\\${HELD}\\a.pdf`, '\\')).toBe(true);
});
