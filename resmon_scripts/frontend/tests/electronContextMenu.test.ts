/**
 * The right-click menu's contents (`electron/contextMenu.ts`): what each kind of
 * click offers, in what order, and what each item does.
 */
import type { MenuItemConstructorOptions } from 'electron';
import { contextFacts, contextMenuTemplate, doiOfLink, lookUpLabel, paperOfRoute, type ContextFacts } from '../electron/contextMenu';

const NO_EDIT = { canUndo: false, canRedo: false, canCut: false, canCopy: false, canPaste: false, canSelectAll: false };

function facts(over: Partial<ContextFacts> = {}): ContextFacts {
  return {
    linkURL: '', selectionText: '', isEditable: false, editFlags: NO_EDIT,
    misspelledWord: '', dictionarySuggestions: [], own: null, mac: true, ...over,
  };
}

function actions() {
  return {
    openRoute: jest.fn(), openLinkWindow: jest.fn(), openInBrowser: jest.fn(),
    copyText: jest.fn(), replaceMisspelling: jest.fn(), lookUp: jest.fn(),
  };
}

const labels = (items: MenuItemConstructorOptions[]) => items.map((i) => (i.type === 'separator' ? '—' : i.label));
const click = (items: MenuItemConstructorOptions[], label: string) => {
  const item = items.find((i) => i.label === label);
  if (!item?.click) throw new Error(`no clickable ${label}`);
  (item.click as () => void)();
};

describe('the right-click menu', () => {
  test('a plain spot offers nothing, so no menu opens', () => {
    expect(contextMenuTemplate(facts(), actions())).toEqual([]);
  });

  test("a link to one of resmon's own pages opens in a new window, and on macOS a new tab", () => {
    const act = actions();
    const mac = contextMenuTemplate(facts({ linkURL: 'app://x/#/collection/7', own: { route: '/collection/7' } }), act);
    expect(labels(mac)).toEqual(['Open in New Window', 'Open in New Tab']);
    click(mac, 'Open in New Tab');
    expect(act.openRoute).toHaveBeenCalledWith('/collection/7', 'tab');
    const other = contextMenuTemplate(facts({ own: { route: null }, mac: false }), act);
    expect(labels(other)).toEqual(['Open in New Window']);
    click(other, 'Open in New Window');
    expect(act.openRoute).toHaveBeenLastCalledWith(null, 'window');
  });

  test("a link to a paper's page can also save that paper to read", () => {
    const act = { ...actions(), saveToRead: jest.fn() };
    const items = contextMenuTemplate(facts({ own: { route: '/papers/42' } }), act);
    expect(labels(items)).toEqual(['Open in New Window', 'Open in New Tab', '—', 'Save to Read']);
    click(items, 'Save to Read');
    expect(act.saveToRead).toHaveBeenCalledWith(42);
    // Any other page of resmon's offers no save.
    expect(labels(contextMenuTemplate(facts({ own: { route: '/library' }, mac: false }), act))).toEqual(['Open in New Window']);
  });

  test("a paper's page is named by its id, and nothing else is", () => {
    expect(paperOfRoute('/papers/42')).toBe(42);
    expect(paperOfRoute('/papers/7?from=today')).toBe(7);
    for (const other of [null, '/papers', '/papers/', '/papers/0', '/papers/-3', '/papers/4x', '/papers/99999999999999999999', '/library/papers/5']) {
      expect(paperOfRoute(other)).toBeNull();
    }
  });

  test("a web link opens in resmon's browser or yours, or is copied; a doi.org link also copies its DOI", () => {
    const act = actions();
    const url = 'https://doi.org/10.1371/journal.pone.0000308';
    const items = contextMenuTemplate(facts({ linkURL: url }), act);
    expect(labels(items)).toEqual(['Open Link in New Window', 'Open Link in Your Browser', 'Copy Link', 'Copy DOI']);
    click(items, 'Open Link in New Window');
    click(items, 'Open Link in Your Browser');
    click(items, 'Copy DOI');
    expect(act.openLinkWindow).toHaveBeenCalledWith(url);
    expect(act.openInBrowser).toHaveBeenCalledWith(url);
    expect(act.copyText).toHaveBeenCalledWith('10.1371/journal.pone.0000308');
    expect(labels(contextMenuTemplate(facts({ linkURL: 'https://arxiv.org/abs/2401.00001' }), act)))
      .toEqual(['Open Link in New Window', 'Open Link in Your Browser', 'Copy Link']);
  });

  test("on macOS a web link also opens as a tab of resmon's browser, right after the window", () => {
    const act = { ...actions(), openLinkTab: jest.fn() };
    const url = 'https://arxiv.org/abs/2401.00001';
    const items = contextMenuTemplate(facts({ linkURL: url }), act);
    expect(labels(items)).toEqual(['Open Link in New Window', 'Open Link in New Tab', 'Open Link in Your Browser', 'Copy Link']);
    click(items, 'Open Link in New Tab');
    expect(act.openLinkTab).toHaveBeenCalledWith(url);
    expect(act.openLinkWindow).not.toHaveBeenCalled();
    expect(labels(contextMenuTemplate(facts({ linkURL: url, mac: false }), act)))
      .toEqual(['Open Link in New Window', 'Open Link in Your Browser', 'Copy Link']);
  });

  test('a link that is neither web nor resmon offers nothing of its own', () => {
    expect(contextMenuTemplate(facts({ linkURL: 'mailto:someone@example.org' }), actions())).toEqual([]);
    expect(contextMenuTemplate(facts({ linkURL: 'file:///etc/hosts' }), actions())).toEqual([]);
  });

  test('a selection is copied, and on macOS looked up by name', () => {
    const act = actions();
    const items = contextMenuTemplate(facts({ selectionText: '  shared   wording  ' }), act);
    expect(labels(items)).toEqual(['Copy', 'Look Up “shared wording”']);
    expect(items[0].role).toBe('copy');
    click(items, 'Look Up “shared wording”');
    expect(act.lookUp).toHaveBeenCalled();
    expect(labels(contextMenuTemplate(facts({ selectionText: 'x', mac: false }), act))).toEqual(['Copy']);
  });

  test('a selected link offers the link first, then the selection', () => {
    const items = contextMenuTemplate(facts({ linkURL: 'https://example.org/a', selectionText: 'a' }), actions());
    expect(labels(items)).toEqual([
      'Open Link in New Window', 'Open Link in Your Browser', 'Copy Link', '—', 'Copy', 'Look Up “a”',
    ]);
  });

  test('a field edits, each item enabled as the field allows', () => {
    const items = contextMenuTemplate(facts({
      isEditable: true, editFlags: { ...NO_EDIT, canPaste: true, canSelectAll: true },
    }), actions());
    expect(labels(items)).toEqual(['Undo', 'Redo', '—', 'Cut', 'Copy', 'Paste', 'Select All']);
    expect(items.filter((i) => i.enabled).map((i) => i.label)).toEqual(['Paste', 'Select All']);
    expect(items.find((i) => i.label === 'Select All')?.role).toBe('selectAll');
  });

  test('a misspelled word in a field leads with its suggestions, at most five', () => {
    const act = actions();
    const items = contextMenuTemplate(facts({
      isEditable: true, misspelledWord: 'recieve', dictionarySuggestions: ['receive', 'relieve', 'reprieve', 'recite', 'revive', 'reweave'],
    }), act);
    expect(labels(items).slice(0, 6)).toEqual(['receive', 'relieve', 'reprieve', 'recite', 'revive', '—']);
    click(items, 'receive');
    expect(act.replaceMisspelling).toHaveBeenCalledWith('receive');
    const none = contextMenuTemplate(facts({ isEditable: true, misspelledWord: 'qzxv' }), act);
    expect(none[0]).toMatchObject({ label: 'No Guesses Found', enabled: false });
  });

  test("a window's own items come last, after a separator", () => {
    const items = contextMenuTemplate(facts({ selectionText: 'a', mac: false }), actions(), [{ label: 'Reload' }]);
    expect(labels(items)).toEqual(['Copy', '—', 'Reload']);
    expect(labels(contextMenuTemplate(facts(), actions(), [{ label: 'Reload' }]))).toEqual(['Reload']);
  });
});

describe('the pieces', () => {
  test('doiOfLink reads doi.org and dx.doi.org links, decoded, and nothing else', () => {
    expect(doiOfLink('https://doi.org/10.1000/xyz%2F1')).toBe('10.1000/xyz/1');
    expect(doiOfLink('http://dx.doi.org/10.1016/j.cell.2020.01.001')).toBe('10.1016/j.cell.2020.01.001');
    expect(doiOfLink('https://doi.org/about')).toBeNull();
    expect(doiOfLink('https://example.org/10.1000/xyz')).toBeNull();
  });

  test('lookUpLabel keeps one line and cuts a long selection with an ellipsis', () => {
    expect(lookUpLabel('word')).toBe('Look Up “word”');
    expect(lookUpLabel('a very long selection that keeps on going')).toBe('Look Up “a very long selection t…”');
  });

  test("contextFacts copies what the menu needs from Electron's event", () => {
    const made = contextFacts({
      linkURL: 'https://example.org', selectionText: 's', isEditable: false,
      editFlags: { ...NO_EDIT, canCopy: true, canEditRichly: false, canDelete: false } as never,
      misspelledWord: '', dictionarySuggestions: [],
    }, null, false);
    expect(made).toEqual(facts({ linkURL: 'https://example.org', selectionText: 's', editFlags: { ...NO_EDIT, canCopy: true }, mac: false }));
  });
});
