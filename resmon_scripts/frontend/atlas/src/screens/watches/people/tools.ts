/**
 * Moving people in and out: the starter set that ships with resmon, a file of
 * exported profiles, and one person saved as a file.
 *
 * The file is the engine's interchange format (`watch_profiles.profile_to_json`):
 * a `schema` version and the profile's own fields, with no id and no
 * timestamps, because a person imported into another resmon is the same person
 * and not the same row. The engine reads and writes it; the screen only hands
 * the bytes over and says what came of them.
 */
import type { components } from '../../../api/schema';
import { count, listWords } from '../../today/format';
import type { Profile } from './model';

export type Starter = components['schemas']['StarterWatchProfile'];
export type ImportResult = components['schemas']['WatchProfileImportResult'];

/** "jennifer-doudna.json": the person's name as a file name, the way the starter files are named. */
export function exportFilename(displayName: string): string {
  const slug = displayName
    .normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return `${slug || 'person'}.json`;
}

/**
 * What a chosen file holds, as the import route takes it: a list of exported
 * profiles, or one, which is a list of one. A file that is not JSON, or holds
 * something other than objects, is refused here with the reason, because the
 * route would refuse the whole request without one; what is in each object is
 * the engine's to judge, entry by entry.
 */
export function profilesInFile(text: string, fileName: string):
  { profiles: Record<string, unknown>[] } | { refused: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { refused: `${fileName} is not JSON, so nothing was imported.` };
  }
  const entries = Array.isArray(parsed) ? parsed : [parsed];
  const odd = entries.findIndex((e) => e === null || typeof e !== 'object' || Array.isArray(e));
  if (odd >= 0) {
    return { refused: `${fileName} is not a file of exported people: entry ${odd + 1} is not a profile, so nothing was imported.` };
  }
  return { profiles: entries as Record<string, unknown>[] };
}

/**
 * The import's result in sentences: who came in, and each entry that did not,
 * by its place in the file and the engine's reason. One bad entry never hides
 * the good ones, and a file with none says that rather than nothing. The
 * engine adds every person in the file as a new one and never merges
 * (`/api/profiles/import`), so a person already here comes in twice; that is
 * said with the result, where it can be acted on.
 */
export function importSentence(result: ImportResult, fileName: string): string {
  const came = result.imported.map((p) => p.display_name);
  const head = came.length
    ? `Imported ${count(came.length, 'person', 'people')} from ${fileName}: ${listWords(came)}. `
      + `${came.length === 1 ? 'It is added as a new person' : 'Each is added as a new person'}; `
      + 'resmon never merges an import with the people you have.'
    : `Nothing was imported from ${fileName}.`;
  if (!result.failed.length) return head;
  const why = result.failed.map((f) => `entry ${f.index + 1}, ${f.reason}`).join('; ');
  return `${head} ${count(result.failed.length, 'entry', 'entries')} could not be read: ${why}`;
}

/** The person already watched under a starter's ORCID, if there is one. */
export function alreadyWatched(starter: Starter, people: readonly Profile[]): Profile | undefined {
  const orcid = starter.identifiers.orcid?.value;
  if (!orcid) return undefined;
  return people.find((p) => p.identifiers.orcid?.value === orcid);
}

/** A starter as a new profile: every field it ships with, and nothing the engine adds when it serves one. */
export function starterBody(starter: Starter) {
  return {
    kind: starter.kind,
    display_name: starter.display_name,
    names: starter.names,
    identifiers: starter.identifiers,
    affiliations: starter.affiliations,
    field_hints: starter.field_hints,
    notes: starter.notes ?? null,
  };
}
