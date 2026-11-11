import { EventEmitter } from 'events';
import type { BaseWindow, KeyboardEvent, MenuItem, MenuItemConstructorOptions } from 'electron';
import fs from 'fs';
import path from 'path';
import ts from 'typescript';
import * as webLinkParts from '../electron/webLinks';

/** Exercise the menu builder without importing main.ts, which starts the app. */
function windowMenu(withLink = false) {
  const source = fs.readFileSync(path.join(__dirname, '../electron/main.ts'), 'utf8');
  const tree = ts.createSourceFile('main.ts', source, ts.ScriptTarget.Latest, true);
  const builder = tree.statements.find((node): node is ts.FunctionDeclaration =>
    ts.isFunctionDeclaration(node) && node.name?.text === 'macWindowMenu');
  if (!builder) throw new Error('macWindowMenu was not found');
  const compiled = ts.transpileModule(builder.getFullText(tree), {
    compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.CommonJS },
  }).outputText;
  const first = { id: 1, getTitle: () => 'Today ', isDestroyed: () => false, isMinimized: () => false, focus: jest.fn(), restore: jest.fn() };
  const second = { id: 2, getTitle: () => 'Settings › Appearance', isDestroyed: () => false, isMinimized: () => true, focus: jest.fn(), restore: jest.fn() };
  const link = { id: 3, getTitle: () => 'https://example.org/terms', isDestroyed: () => false, isMinimized: () => true, focus: jest.fn(), restore: jest.fn() };
  const actions = {
    moveTabToNewWindow: jest.fn(), mergeAllWindows: jest.fn(), toggleTabBar: jest.fn(),
    selectPreviousTab: jest.fn(), selectNextTab: jest.fn(), showAllTabs: jest.fn(),
  };
  const build = new Function('actedOn', 'asLinkWindow', 'tabsMode', 'appWindows', 'BrowserWindow', ...Object.keys(actions),
    `${compiled}; return macWindowMenu;`)(
    (window: unknown) => window ?? first, () => null, { active: true },
    { all: () => [first, second], target: () => first }, { getFocusedWindow: () => withLink ? link : first, getAllWindows: () => withLink ? [first, second, link] : [first, second] },
    ...Object.values(actions),
  ) as () => MenuItemConstructorOptions;
  const menu = build();
  return { menu, items: menu.submenu as MenuItemConstructorOptions[], actions, first, second, link };
}

test('the Window menu owns its tab items and window list so AppKit cannot inject a second merge or detach', () => {
  const { menu } = windowMenu();
  expect(menu.label).toBe('Window');
  expect(menu.role).toBeUndefined();
});

test('tab commands have readable labels and act on the requested window', () => {
  const { items, actions, second } = windowMenu();
  const expected = [
    ['window-previous-tab', 'Show Previous Tab', 'selectPreviousTab'],
    ['window-next-tab', 'Show Next Tab', 'selectNextTab'],
    ['window-all-tabs', 'Show All Tabs', 'showAllTabs'],
  ] as const;
  for (const [id, label, action] of expected) {
    const item = items.find((candidate) => candidate.id === id);
    expect(item?.label).toBe(label);
    expect(item?.role).toBeUndefined();
    item?.click?.({} as MenuItem, second as unknown as BaseWindow, {} as KeyboardEvent);
    expect(actions[action]).toHaveBeenCalledWith(second);
  }
});

test('each open window appears once with its current title and can be brought forward', () => {
  const { items, first, second } = windowMenu();
  const entries = items.filter((item) => item.id?.startsWith('window-open-'));
  expect(entries.map(({ id, label, checked }) => ({ id, label, checked }))).toEqual([
    { id: 'window-open-1', label: 'Today', checked: true },
    { id: 'window-open-2', label: 'Settings › Appearance', checked: false },
  ]);
  entries[1]?.click?.({} as MenuItem, first as unknown as BaseWindow, {} as KeyboardEvent);
  expect(second.restore).toHaveBeenCalledTimes(1);
  expect(second.focus).toHaveBeenCalledTimes(1);
});


test('URL windows are listed and checked by their actual focus without granting renderer trust', () => {
  const { items, first, link } = windowMenu(true);
  const entries = items.filter((item) => item.id?.startsWith('window-open-'));
  expect(entries.map(({ id, label, checked }) => ({ id, label, checked }))).toEqual([
    { id: 'window-open-1', label: 'Today', checked: false },
    { id: 'window-open-2', label: 'Settings › Appearance', checked: false },
    { id: 'window-open-3', label: 'https://example.org/terms', checked: true },
  ]);
  entries[2]?.click?.({} as MenuItem, first as unknown as BaseWindow, {} as KeyboardEvent);
  expect(link.restore).toHaveBeenCalledTimes(1);
  expect(link.focus).toHaveBeenCalledTimes(1);
});


test('URL-window creation, focus, URL changes, and close refresh the Window menu', () => {
  const source = fs.readFileSync(path.join(__dirname, '../electron/main.ts'), 'utf8');
  const tree = ts.createSourceFile('main.ts', source, ts.ScriptTarget.Latest, true);
  const builder = tree.statements.find((node): node is ts.FunctionDeclaration =>
    ts.isFunctionDeclaration(node) && node.name?.text === 'openLinkWindow');
  if (!builder) throw new Error('openLinkWindow was not found');
  const compiled = ts.transpileModule(builder.getFullText(tree), {
    compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.CommonJS },
  }).outputText;
  class LinkPage {
    static made: LinkPage;
    address = 'https://example.org/terms';
    webContents = Object.assign(new EventEmitter(), {
      getURL: () => this.address, getTitle: () => '', setWindowOpenHandler: jest.fn(),
      loadURL: () => Promise.resolve(), isDestroyed: () => false, close: jest.fn(),
    });
    constructor() { LinkPage.made = this; }
    setBounds() { /* Window geometry is exercised by Electron. */ }
  }
  class LinkWindow extends EventEmitter {
    static made: LinkWindow;
    address = 'https://example.org/terms';
    title: string;
    webContents = Object.assign(new EventEmitter(), {
      id: 7, getURL: () => this.address, setWindowOpenHandler: jest.fn(),
      send: jest.fn(), isDestroyed: () => false, focus: jest.fn(),
    });
    contentView = { addChildView: jest.fn() };
    constructor(options: { title: string }) { super(); this.title = options.title; LinkWindow.made = this; }
    isDestroyed() { return false; }
    getContentSize() { return [900, 700]; }
    setTitle(title: string) { this.title = title; }
    loadURL() { return Promise.resolve(); }
  }
  const refresh = jest.fn();
  const open = new Function('BrowserWindow', 'actedOn', 'nativeTheme', 'shell', 'isHiddenWindow', 'isBackgroundWindow',
    'installApplicationMenu', 'process', 'WebContentsView', 'linkPages', 'path', '__dirname',
    'linkBars', 'lastLinkWindow', 'webLinks', ...Object.keys(webLinkParts), `${compiled}; return openLinkWindow;`)(
    LinkWindow, () => null, { shouldUseDarkColors: false }, {}, () => true, () => true, refresh, { platform: 'darwin' },
    LinkPage, new Map(), path, __dirname, new Map(), null, webLinkParts.DEFAULT_WEB_LINKS, ...Object.values(webLinkParts),
  ) as (url: string) => void;
  open('https://example.org/terms');
  expect(refresh).toHaveBeenCalledTimes(1);
  const window = LinkWindow.made;
  window.emit('focus');
  expect(refresh).toHaveBeenCalledTimes(2);
  LinkPage.made.address = 'https://example.org/terms#storage';
  LinkPage.made.webContents.emit('did-navigate-in-page');
  expect(window.title).toBe('https://example.org/terms#storage');
  expect(refresh).toHaveBeenCalledTimes(3);
  window.emit('closed');
  expect(refresh).toHaveBeenCalledTimes(4);
});
