/**
 * Several windows on one engine (`electron/windows.ts`): which window a
 * message came from, which window a notice or a menu command goes to, where a
 * new window opens, and when the windows leave room for macOS's tab bar. Every
 * window here is a plain object; nothing is opened.
 */
import {
  RunOwners, TabsMode, WindowSet, cascade, cleanRoute, noticeWindow, routeOf, tabStripHeight, type WindowLike,
} from '../electron/windows';

/** A window as the set sees one: an id, its web contents and their top frame, and whether it is closed. */
interface Fake extends WindowLike {
  webContents: { mainFrame: object };
  closed: boolean;
}

let nextId = 1;
function fakeWindow(): Fake {
  const window: Fake = {
    id: nextId++,
    webContents: { mainFrame: {} },
    closed: false,
    isDestroyed: () => window.closed,
  };
  return window;
}

describe('the windows, each answered about itself', () => {
  test('a message is from the window whose own top frame sent it, and from no other', () => {
    const set = new WindowSet<Fake>();
    const first = fakeWindow();
    const second = fakeWindow();
    set.add(first);
    set.add(second);
    expect(set.forSender(first.webContents, first.webContents.mainFrame)).toBe(first);
    expect(set.forSender(second.webContents, second.webContents.mainFrame)).toBe(second);
    // A frame inside a window, another window's frame, and no frame at all are not the window asking.
    expect(set.forSender(first.webContents, {})).toBeNull();
    expect(set.forSender(first.webContents, second.webContents.mainFrame)).toBeNull();
    expect(set.forSender(first.webContents, null)).toBeNull();
    // A window outside the set (a link window) is never answered.
    const link = fakeWindow();
    expect(set.forSender(link.webContents, link.webContents.mainFrame)).toBeNull();
  });

  test('a closed window is answered no more, and leaves the set without its properties being read', () => {
    const set = new WindowSet<Fake>();
    const first = fakeWindow();
    const second = fakeWindow();
    set.add(first);
    set.add(second);
    first.closed = true;
    expect(set.forSender(first.webContents, first.webContents.mainFrame)).toBeNull();
    expect(set.all()).toEqual([second]);
    expect(set.size).toBe(1);
    expect(set.has(first)).toBe(false);
    set.remove(first);
    expect(set.has(second)).toBe(true);
  });

  test('each window keeps its collection; none named is the only one', () => {
    const set = new WindowSet<Fake>();
    const plain = fakeWindow();
    const other = fakeWindow();
    set.add(plain);
    set.add(other, 'physics');
    expect(set.collectionOf(plain)).toBeNull();
    expect(set.collectionOf(other)).toBe('physics');
  });
});

describe('the window something without a window goes to', () => {
  test('the focused one; else the one focused last; else the newest; none when none is open', () => {
    const set = new WindowSet<Fake>();
    expect(set.target()).toBeNull();
    const first = fakeWindow();
    const second = fakeWindow();
    const third = fakeWindow();
    set.add(first);
    set.add(second);
    set.add(third);
    // A window just opened is the one in front.
    expect(set.target()).toBe(third);
    set.focus(first);
    expect(set.target()).toBe(first);
    // The focused one wins over the one focused last.
    expect(set.target(second)).toBe(second);
    // A focused window outside the set (a link window) is passed over.
    expect(set.target(fakeWindow())).toBe(first);
    first.closed = true;
    expect(set.target()).toBe(third);
  });

  test('a notice shows in the window that started its run, while it is open, and otherwise in the one in front', () => {
    const set = new WindowSet<Fake>();
    const owners = new RunOwners();
    const first = fakeWindow();
    const second = fakeWindow();
    set.add(first);
    set.add(second);
    set.focus(first);
    expect(owners.claim(41, second.id)).toBe(true);
    expect(noticeWindow(set, owners, 41)).toBe(second);
    // A run no window started (a watch's), and a notice with no run, go to the one in front.
    expect(noticeWindow(set, owners, 42)).toBe(first);
    expect(noticeWindow(set, owners, null, second)).toBe(second);
    second.closed = true;
    expect(noticeWindow(set, owners, 41)).toBe(first);
    // No window open: none, and only then is one made.
    first.closed = true;
    expect(noticeWindow(set, owners, 41)).toBeNull();
  });

  test('only a run\'s own id is claimed, and the record stays bounded', () => {
    const owners = new RunOwners(3);
    for (const bad of [0, -1, 1.5, '7', null, undefined, Number.NaN]) expect(owners.claim(bad, 1)).toBe(false);
    for (const id of [1, 2, 3, 4]) owners.claim(id, 10 + id);
    expect(owners.ownerOf(1)).toBeNull();
    expect(owners.ownerOf(4)).toBe(14);
    expect(owners.ownerOf(null)).toBeNull();
  });
});

describe('the pages a window opens at', () => {
  test('a route the renderer asks for is a path inside the app, or the start page', () => {
    expect(cleanRoute('/runs/12')).toBe('/runs/12');
    expect(cleanRoute('/search?source=arxiv')).toBe('/search?source=arxiv');
    for (const bad of ['https://example.org/', '//example.org/x', 'runs/12', '/a\nb', '/a\\b', 7, null, `/${'x'.repeat(3000)}`]) {
      expect(cleanRoute(bad)).toBeNull();
    }
  });

  test('a link to one of the renderer\'s own pages opens a window of the app; any other address does not', () => {
    const origin = 'http://127.0.0.1:5123';
    expect(routeOf(`${origin}/index.html#/watches/3`, origin)).toEqual({ route: '/watches/3' });
    expect(routeOf(`${origin}/#/search?source=arxiv`, origin)).toEqual({ route: '/search?source=arxiv' });
    expect(routeOf(`${origin}/index.html`, origin)).toEqual({ route: null });
    expect(routeOf(`${origin}/index.html#/runs/%E2%80%BA`, origin)).toEqual({ route: '/runs/›' });
    expect(routeOf('http://127.0.0.1:5124/index.html#/today', origin)).toBeNull();
    expect(routeOf('https://arxiv.org/abs/2609.00001', origin)).toBeNull();
    expect(routeOf(`${origin}/other.html#/today`, origin)).toBeNull();
    expect(routeOf(`${origin}/index.html#//evil`, origin)).toBeNull();
    expect(routeOf('not a url', origin)).toBeNull();
    expect(routeOf(`${origin}/index.html#/today`, null)).toBeNull();
  });

  test('a new window opens a step down and right of the one it came from, and back at the corner past the edge', () => {
    const area = { x: 0, y: 25, width: 1440, height: 875 };
    expect(cascade({ x: 100, y: 100, width: 1000, height: 700 }, area)).toEqual({ x: 126, y: 126, width: 1000, height: 700 });
    expect(cascade({ x: 430, y: 190, width: 1000, height: 700 }, area)).toEqual({ x: 26, y: 51, width: 1000, height: 700 });
    // A window wider than the screen it moves to is held to it.
    expect(cascade({ x: 0, y: 0, width: 2000, height: 1200 }, area)).toEqual({ x: 0, y: 25, width: 1440, height: 875 });
  });
});

describe('room for macOS\'s tab bar', () => {
  test('tabs mode starts with a tab command and ends when one window is left', () => {
    const tabs = new TabsMode();
    expect(tabs.active).toBe(false);
    tabs.use();
    expect(tabs.active).toBe(true);
    tabs.windowsNow(3);
    expect(tabs.active).toBe(true);
    tabs.windowsNow(1);
    expect(tabs.active).toBe(false);
  });

  test('Show Tab Bar on a window alone keeps the room while it is shown, through other windows coming and going', () => {
    const tabs = new TabsMode();
    tabs.toggleBar(1);
    expect(tabs.active).toBe(true);
    tabs.windowsNow(2);
    tabs.windowsNow(1);
    expect(tabs.active).toBe(true);
    tabs.toggleBar(1);
    expect(tabs.active).toBe(false);
    // With several windows the bar is somebody's, so the room stays.
    tabs.toggleBar(2);
    expect(tabs.active).toBe(true);
    tabs.windowsNow(0);
    expect(tabs.active).toBe(false);
  });

  test('the strip: none off macOS or out of tabs; the title bar\'s row on macOS 26; two rows before it', () => {
    expect(tabStripHeight('darwin', '26.3.1', true)).toBe(28);
    expect(tabStripHeight('darwin', '27.0', true)).toBe(28);
    expect(tabStripHeight('darwin', '15.6', true)).toBe(56);
    expect(tabStripHeight('darwin', '26.3.1', false)).toBe(0);
    expect(tabStripHeight('win32', '10.0.26100', true)).toBe(0);
    expect(tabStripHeight('linux', '6.8.0', true)).toBe(0);
  });
});
