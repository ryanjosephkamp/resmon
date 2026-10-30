import type { Location, NavigateOptions } from 'react-router-dom';
import type { ShortcutId } from '../shell/shortcuts';
import type { SavedConfiguration } from './collection/savedSearches';

/** The two searches Ask the sources starts: one source in depth, or several at once. */
export type SearchKind = 'dive' | 'sweep';

export const ASK_PATH = '/search/ask';

export const KINDS: readonly { kind: SearchKind; name: string; says: string; shortcut: ShortcutId }[] = [
  { kind: 'dive', name: 'Deep Dive', says: 'One source, asked in depth.', shortcut: 'new-dive' },
  { kind: 'sweep', name: 'Deep Sweep', says: 'Several sources at once, each asked the same question.', shortcut: 'new-sweep' },
];

/**
 * What Ask the sources reads from its address's state: the saved search it
 * was opened from, or the kind of search a shortcut or a New search button
 * asked for.
 */
export interface AskState {
  saved?: SavedConfiguration;
  start?: SearchKind;
}

/**
 * Where a request for a new search goes. From any other screen, a new page of
 * history, which draws a fresh form. On Ask the sources itself, the same page
 * replaced, so a shortcut pressed twice is not two pages to go back through,
 * and a saved search the form was opened from stays named while the form is
 * kept.
 */
export function startSearch(kind: SearchKind, at: Pick<Location, 'pathname' | 'state'>): { to: string; options: NavigateOptions } {
  const here = at.pathname === ASK_PATH;
  const kept = here && at.state && typeof at.state === 'object' ? at.state as AskState : {};
  return { to: ASK_PATH, options: { replace: here, state: { ...kept, start: kind } satisfies AskState } };
}
