/**
 * What a right-click offers, as a menu template. Pure: the caller supplies the
 * click's facts and the actions, so every case is testable without a window.
 *
 * Sections, in order, each present only when it applies:
 *   spelling   suggestions for a misspelled word in a field;
 *   own link   a link to one of resmon's own pages: Open in New Window, and on
 *              macOS Open in New Tab; for a paper's page, Save to Read too;
 *   web link   Open Link in New Window (resmon's browser), Open Link in Your
 *              Browser, Copy Link, and Copy DOI for a doi.org link;
 *   selection  Copy, and on macOS Look Up;
 *   field      Undo, Redo, Cut, Copy, Paste, and Select All, each enabled as the
 *              field allows;
 *   page       whatever the window adds (a link window's Back, Forward, Reload).
 * An empty template means no menu.
 */
import type { ContextMenuParams, MenuItemConstructorOptions } from 'electron';

export interface ContextFacts {
  /** The link under the pointer, or ''. */
  linkURL: string;
  /** The selected text, or ''. */
  selectionText: string;
  isEditable: boolean;
  editFlags: { canUndo: boolean; canRedo: boolean; canCut: boolean; canCopy: boolean; canPaste: boolean; canSelectAll: boolean };
  misspelledWord: string;
  dictionarySuggestions: string[];
  /** The resmon page a link points to, as `routeOf` gives it (`route` null is the home page), or null for any other link. */
  own: { route: string | null } | null;
  mac: boolean;
}

export interface ContextActions {
  openRoute?: (route: string | null, how: 'window' | 'tab') => void;
  /** Save the paper a link to its page names to the reading queue (the window's page does it, and says so). */
  saveToRead?: (documentId: number) => void;
  openLinkWindow: (url: string) => void;
  /** A tab of resmon's browser, on macOS. */
  openLinkTab?: (url: string) => void;
  openInBrowser: (url: string) => void;
  copyText: (text: string) => void;
  replaceMisspelling: (word: string) => void;
  lookUp: () => void;
}

const MAX_SUGGESTIONS = 5;

/** The paper a link to its page names (`/papers/42`), or null for any other page. */
export function paperOfRoute(route: string | null): number | null {
  const found = /^\/papers\/(\d+)(?:[/?#]|$)/.exec(route ?? '');
  const id = found ? Number(found[1]) : NaN;
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

/** The facts of a right-click, from Electron's `context-menu` event. */
export function contextFacts(
  params: Pick<ContextMenuParams, 'linkURL' | 'selectionText' | 'isEditable' | 'editFlags' | 'misspelledWord' | 'dictionarySuggestions'>,
  own: { route: string | null } | null,
  mac: boolean,
): ContextFacts {
  const flags = params.editFlags;
  return {
    linkURL: params.linkURL ?? '',
    selectionText: params.selectionText ?? '',
    isEditable: params.isEditable,
    editFlags: {
      canUndo: flags.canUndo, canRedo: flags.canRedo, canCut: flags.canCut,
      canCopy: flags.canCopy, canPaste: flags.canPaste, canSelectAll: flags.canSelectAll,
    },
    misspelledWord: params.misspelledWord ?? '',
    dictionarySuggestions: params.dictionarySuggestions ?? [],
    own,
    mac,
  };
}
const LOOK_UP_CHARS = 24;

/** The DOI a doi.org link names, or null. */
export function doiOfLink(url: string): string | null {
  const match = /^https?:\/\/(?:dx\.)?doi\.org\/(10\.\d{4,9}\/\S+)$/i.exec(url.trim());
  if (!match) return null;
  try {
    return decodeURIComponent(match[1]);
  } catch {
    return match[1];
  }
}

function isWebLink(url: string): boolean {
  return /^https?:\/\//i.test(url);
}

/** The selection as Look Up names it: one line, cut short with an ellipsis. */
export function lookUpLabel(selection: string): string {
  const line = selection.replace(/\s+/g, ' ').trim();
  const shown = line.length > LOOK_UP_CHARS ? `${line.slice(0, LOOK_UP_CHARS - 1).trimEnd()}…` : line;
  return `Look Up “${shown}”`;
}

export function contextMenuTemplate(
  facts: ContextFacts,
  actions: ContextActions,
  page: MenuItemConstructorOptions[] = [],
): MenuItemConstructorOptions[] {
  const sections: MenuItemConstructorOptions[][] = [];
  const selection = facts.selectionText.trim();

  if (facts.isEditable && facts.misspelledWord) {
    const guesses = facts.dictionarySuggestions.slice(0, MAX_SUGGESTIONS);
    sections.push(guesses.length
      ? guesses.map((word) => ({ label: word, click: () => actions.replaceMisspelling(word) }))
      : [{ label: 'No Guesses Found', enabled: false }]);
  }

  if (facts.own && actions.openRoute) {
    const route = facts.own.route;
    const open = actions.openRoute;
    const paper = paperOfRoute(route);
    const save = actions.saveToRead;
    sections.push([
      { label: 'Open in New Window', click: () => open(route, 'window') },
      ...(facts.mac ? [{ label: 'Open in New Tab', click: () => open(route, 'tab') }] : []),
    ]);
    if (paper !== null && save) sections.push([{ label: 'Save to Read', click: () => save(paper) }]);
  } else if (isWebLink(facts.linkURL)) {
    const url = facts.linkURL;
    const doi = doiOfLink(url);
    sections.push([
      { label: 'Open Link in New Window', click: () => actions.openLinkWindow(url) },
      ...(facts.mac && actions.openLinkTab ? [{ label: 'Open Link in New Tab', click: () => actions.openLinkTab?.(url) }] : []),
      { label: 'Open Link in Your Browser', click: () => actions.openInBrowser(url) },
      { label: 'Copy Link', click: () => actions.copyText(url) },
      ...(doi ? [{ label: 'Copy DOI', click: () => actions.copyText(doi) }] : []),
    ]);
  }

  if (selection && !facts.isEditable) {
    sections.push([
      { label: 'Copy', role: 'copy' },
      ...(facts.mac ? [{ label: lookUpLabel(selection), click: () => actions.lookUp() }] : []),
    ]);
  }

  if (facts.isEditable) {
    const flags = facts.editFlags;
    sections.push(
      [
        { label: 'Undo', role: 'undo', enabled: flags.canUndo },
        { label: 'Redo', role: 'redo', enabled: flags.canRedo },
      ],
      [
        { label: 'Cut', role: 'cut', enabled: flags.canCut },
        { label: 'Copy', role: 'copy', enabled: flags.canCopy },
        { label: 'Paste', role: 'paste', enabled: flags.canPaste },
        { label: 'Select All', role: 'selectAll', enabled: flags.canSelectAll },
      ],
    );
    if (selection && facts.mac) sections.push([{ label: lookUpLabel(selection), click: () => actions.lookUp() }]);
  }

  if (page.length) sections.push(page);

  return sections.flatMap((section, i) => (i === 0 ? section : [{ type: 'separator' as const }, ...section]));
}
