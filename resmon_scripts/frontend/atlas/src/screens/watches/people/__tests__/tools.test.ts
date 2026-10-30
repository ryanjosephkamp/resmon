import type { Profile } from '../model';
import { alreadyWatched, exportFilename, importSentence, profilesInFile, starterBody, type Starter } from '../tools';

function person(over: Partial<Profile> = {}): Profile {
  return {
    id: 1, kind: 'person', display_name: 'Ada Fixture', names: [{ value: 'Ada Fixture' }], identifiers: {},
    affiliations: [], field_hints: [], notes: null, basis_warning: 'x', ...over,
  } as Profile;
}

const STARTER: Starter = {
  kind: 'person',
  display_name: 'Jennifer Doudna',
  names: [{ value: 'Jennifer Doudna', script: 'latin' }, { value: 'Jennifer A. Doudna', script: 'latin' }],
  identifiers: { orcid: { value: '0000-0001-9161-999X', cited: 'Verified 2026-09-06 against the public ORCID record.' } },
  affiliations: [],
  field_hints: [],
  notes: 'CRISPR genome editing; UC Berkeley.',
  source_file: 'jennifer-doudna.json',
  basis_warning: null,
};

describe('a person saved as a file', () => {
  test('under their name, the way the starter files are named', () => {
    expect(exportFilename('Jennifer Doudna')).toBe('jennifer-doudna.json');
    expect(exportFilename('Vincent Larivière')).toBe('vincent-lariviere.json');
    expect(exportFilename('  J. R. R. Tolkien  ')).toBe('j-r-r-tolkien.json');
  });

  test('a name with nothing a file name can carry still gets one', () => {
    expect(exportFilename('李明')).toBe('person.json');
    expect(exportFilename(' -- ')).toBe('person.json');
  });
});

describe('a file of people, read for the engine', () => {
  test('one exported person, or a list of them, goes to the engine as a list', () => {
    expect(profilesInFile('{"schema": 1, "display_name": "A"}', 'a.json'))
      .toEqual({ profiles: [{ schema: 1, display_name: 'A' }] });
    expect(profilesInFile('[{"schema": 1}, {"schema": 1}]', 'b.json')).toEqual({ profiles: [{ schema: 1 }, { schema: 1 }] });
  });

  test('a file that is not JSON is refused here, by name', () => {
    expect(profilesInFile('not json', 'notes.txt')).toEqual({ refused: 'notes.txt is not JSON, so nothing was imported.' });
  });

  test('a file holding something other than profiles is refused with the entry that is not one', () => {
    expect(profilesInFile('[{"schema": 1}, 3]', 'odd.json')).toEqual({
      refused: 'odd.json is not a file of exported people: entry 2 is not a profile, so nothing was imported.',
    });
    expect(profilesInFile('"a string"', 's.json')).toEqual({
      refused: 's.json is not a file of exported people: entry 1 is not a profile, so nothing was imported.',
    });
  });
});

describe('what came of an import', () => {
  test('everyone who came in, by name', () => {
    expect(importSentence({ imported: [person(), person({ display_name: 'Bo Fixture' })], failed: [] }, 'p.json'))
      .toBe('Imported 2 people from p.json: Ada Fixture and Bo Fixture.');
  });

  test('an entry that could not be read is named by its place in the file and the engine\'s reason, beside the rest', () => {
    expect(importSentence({
      imported: [person()],
      failed: [{ index: 1, reason: "This file has no 'schema' field, so resmon cannot tell what it is." }],
    }, 'p.json')).toBe(
      "Imported 1 person from p.json: Ada Fixture. 1 entry could not be read: entry 2, This file has no 'schema' field, "
        + 'so resmon cannot tell what it is.',
    );
  });

  test('a file nothing came in from says so', () => {
    expect(importSentence({ imported: [], failed: [{ index: 0, reason: 'bad' }] }, 'p.json'))
      .toBe('Nothing was imported from p.json. 1 entry could not be read: entry 1, bad');
  });
});

describe('the starter set', () => {
  test('a starter already watched under its ORCID is found, and one with no ORCID never matches', () => {
    const watched = person({ id: 4, identifiers: { orcid: { value: '0000-0001-9161-999X', cited: '' } } } as Partial<Profile>);
    expect(alreadyWatched(STARTER, [person(), watched])?.id).toBe(4);
    expect(alreadyWatched({ ...STARTER, identifiers: {} }, [watched])).toBeUndefined();
  });

  test('added as it ships: every field, the citation and each spelling\'s script included, and nothing the engine adds', () => {
    const body = starterBody(STARTER);
    expect(body).toEqual({
      kind: 'person', display_name: 'Jennifer Doudna', names: STARTER.names, identifiers: STARTER.identifiers,
      affiliations: [], field_hints: [], notes: 'CRISPR genome editing; UC Berkeley.',
    });
    expect(body).not.toHaveProperty('source_file');
    expect(body).not.toHaveProperty('basis_warning');
  });
});
