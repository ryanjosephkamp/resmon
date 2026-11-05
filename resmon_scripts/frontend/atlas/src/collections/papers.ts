import type { QueryClient } from '@tanstack/react-query';
import { answer, engine } from '../api/client';
import type { components } from '../api/schema';
import { invalidateFor } from '../screens/today/freshness';
import { invalidateCollections } from './current';

export type PapersChanged = components['schemas']['CollectionPapersChanged'];
export type ExplorerFilters = components['schemas']['ExplorerFilters'];
export type Mode = 'move' | 'copy';

/** The papers a move or a copy names: by id, or every paper a search of their collection matches. */
export type Which = { ids: readonly number[] } | { matching: ExplorerFilters };

/** Move or copy papers into `target`. A move takes them out of `from`, which a search names itself. */
export function changePapers(mode: Mode, target: number, which: Which, from: number | null): Promise<PapersChanged> {
  const body = 'ids' in which
    ? { mode, document_ids: [...which.ids], ...(mode === 'move' && from !== null ? { from_collection: from } : {}) }
    : { mode, matching: which.matching };
  return answer(engine().POST('/api/collections/{collection_id}/papers', {
    params: { path: { collection_id: target } }, body,
  }));
}

/** Undo a move or a copy, from what it answered. */
export function undoChange(done: PapersChanged) {
  return answer(engine().POST('/api/collections/{collection_id}/papers/undo', {
    params: { path: { collection_id: done.collection_id } },
    body: { added: done.added, from_collection: done.from_collection_id, removed: done.removed },
  }));
}

/** What a change of a collection's papers makes out of date: its counts, its searches, Today, the map, and a paper's page. */
export async function afterPapersChanged(client: QueryClient): Promise<void> {
  await Promise.all([
    invalidateCollections(client),
    client.invalidateQueries({ queryKey: ['explorer'] }),
    client.invalidateQueries({ queryKey: ['explorer-facets'] }),
    client.invalidateQueries({ queryKey: ['paper'] }),
    client.invalidateQueries({ queryKey: ['reading-queue'] }),
    invalidateFor(client, 'papers-arrived'),
    invalidateFor(client, 'paper-changed'),
  ]);
}

/** "3 papers", "1 paper", "every one of 4,210 papers". */
export function papersWords(n: number): string {
  return `${n.toLocaleString('en-US')} ${n === 1 ? 'paper' : 'papers'}`;
}

/**
 * What a move or a copy did, in a sentence: how many arrived, how many were
 * there already, and, for a move, that none left the database.
 */
export function changedWords(done: PapersChanged, target: string): string {
  const moved = done.mode === 'move';
  const arrived = done.added.length;
  const lead = arrived
    ? `${moved ? 'Moved' : 'Copied'} ${papersWords(arrived)} to ${target}.`
    : `Nothing ${moved ? 'moved' : 'copied'}: ${target} holds ${done.already_there === 1 ? 'that paper' : 'those papers'} already.`;
  const extra: string[] = [];
  if (arrived && done.already_there) extra.push(`${papersWords(done.already_there)} ${done.already_there === 1 ? 'was' : 'were'} there already`);
  if (moved && done.removed.length > arrived) extra.push(`${papersWords(done.removed.length)} left the collection they came from`);
  if (done.not_in_source) extra.push(`${papersWords(done.not_in_source)} ${done.not_in_source === 1 ? 'was' : 'were'} not in it to move`);
  if (done.missing) extra.push(`${papersWords(done.missing)} no longer stored`);
  return extra.length ? `${lead} ${extra.join('; ')}.` : lead;
}
