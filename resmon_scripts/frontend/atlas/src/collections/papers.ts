import type { QueryClient } from '@tanstack/react-query';
import { answer, engine } from '../api/client';
import type { components } from '../api/schema';
import { invalidateCollectionCounts } from './invalidation';

export type PapersChanged = components['schemas']['CollectionPapersChanged'];
export type ExplorerFilters = components['schemas']['ExplorerFilters'];
export type Mode = 'move' | 'copy';

/**
 * The papers a move or a copy names: by id, or every paper a search of their
 * collection matches but the ones left out (`except`). `atMost` is how many
 * the person was told: the engine refuses a search that matches more by then.
 */
export type Which = { ids: readonly number[] }
  | { matching: ExplorerFilters; except?: readonly number[]; atMost?: number };

/** Move or copy papers into `target`. A move takes them out of `from`, which a search names itself. */
export function changePapers(mode: Mode, target: number, which: Which, from: number | null): Promise<PapersChanged> {
  const body = 'ids' in which
    ? { mode, document_ids: [...which.ids], ...(mode === 'move' && from !== null ? { from_collection: from } : {}) }
    : {
      mode, matching: which.matching,
      ...(which.except?.length ? { except_ids: [...which.except] } : {}),
      ...(which.atMost ? { at_most: which.atMost } : {}),
    };
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

/** A membership change invalidates counts, searches, Analytics, Today, the map, and a paper's page. */
export function afterPapersChanged(client: QueryClient): Promise<void> {
  return invalidateCollectionCounts(client);
}

/** "3 papers", "1 paper", "every one of 4,210 papers". */
export function papersWords(n: number): string {
  return `${n.toLocaleString('en-US')} ${n === 1 ? 'paper' : 'papers'}`;
}

/**
 * What a move or a copy did, in a sentence: how many arrived, how many were
 * there already, and, for a move, that none left the database.
 */
export function changedWords(done: PapersChanged, target: string, source?: string): string {
  const moved = done.mode === 'move';
  const arrived = done.added.length;
  const left = done.removed.length;
  const origin = source ?? (left === 1 ? 'the collection it came from' : 'the collection they came from');
  const lead = arrived
    ? `${moved ? 'Moved' : 'Copied'} ${papersWords(arrived)} to ${target}.`
    : done.already_there
      ? `${target} already held ${done.already_there === 1 ? 'that paper' : `those ${papersWords(done.already_there)}`}.`
      : `No papers were ${moved ? 'moved' : 'copied'}.`;
  const extra: string[] = [];
  if (arrived && done.already_there) extra.push(`${papersWords(done.already_there)} ${done.already_there === 1 ? 'was' : 'were'} there already`);
  if (moved && left > arrived) extra.push(!arrived
    ? `${left === 1 ? 'It' : 'They'} left ${origin}`
    : `${papersWords(left)} left ${origin}`);
  if (done.not_in_source) extra.push(`${papersWords(done.not_in_source)} ${done.not_in_source === 1 ? 'was' : 'were'} not in ${source ?? 'the source collection'} to move`);
  if (done.missing) extra.push(`${papersWords(done.missing)} ${done.missing === 1 ? 'is' : 'are'} no longer stored`);
  return extra.length ? `${lead} ${extra.join('; ')}.` : lead;
}
