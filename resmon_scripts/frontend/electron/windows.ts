/**
 * resmon's windows: several on one engine, as plain values `main.ts` wires to
 * Electron, so each rule here is tested without a window (`tests/windows.test.ts`).
 *
 * Every window shows the same renderer, served from one loopback origin, and
 * talks to the same engine with the same port and token: the engine trusts one
 * renderer origin (`/api/auth/renderer-origin`), so a window of its own origin
 * would be refused by the Library's guard. What a window has of its own is its
 * page and its history (each is a document with its own hash route), its
 * downloads, and the collection it shows.
 */

/** What the set needs of a window; Electron's `BrowserWindow` has all of it. */
export interface WindowLike {
  readonly id: number;
  readonly webContents: { readonly mainFrame: unknown };
  isDestroyed(): boolean;
}

/**
 * The collection a window shows. Collections are not built yet: every window
 * shows the only one, which is `null` here, and a window opened for another
 * one will say so through this field without anything else in the set changing.
 */
export type CollectionId = string | null;

interface Entry<W> {
  window: W;
  collection: CollectionId;
  /** When the window opened, and when it was last focused, on one counter. */
  opened: number;
  focused: number;
}

/**
 * The app's own windows: not the link windows that show somebody else's page,
 * and not the window that says resmon is starting. Kept in the order they
 * opened, with the order they were last focused in.
 */
export class WindowSet<W extends WindowLike> {
  // By the window itself: a closed window's properties are not read again.
  private readonly entries = new Map<W, Entry<W>>();
  private clock = 0;

  add(window: W, collection: CollectionId = null): void {
    const now = ++this.clock;
    this.entries.set(window, { window, collection, opened: now, focused: now });
  }

  remove(window: W): void {
    this.entries.delete(window);
  }

  has(window: unknown): window is W {
    return this.entries.has(window as W) && !(window as W).isDestroyed();
  }

  get size(): number {
    return this.live().length;
  }

  /** Every window still open, in the order they opened. */
  all(): W[] {
    return this.live().map((entry) => entry.window);
  }

  /** The window was focused: it is now the one a notice or a menu command goes to when none is focused. */
  focus(window: W): void {
    const entry = this.entries.get(window);
    if (entry) entry.focused = ++this.clock;
  }

  collectionOf(window: W): CollectionId {
    return this.entries.get(window)?.collection ?? null;
  }

  /**
   * The window something with no window of its own goes to: a notification
   * clicked, a second launch of resmon, a menu command, an update ready. The
   * focused one when it is one of these, else the one focused last, else the
   * newest. Null when no window is open.
   */
  target(focused?: unknown): W | null {
    const open = this.live();
    const front = open.find((entry) => entry.window === focused);
    if (front) return front.window;
    const recent = [...open].sort((a, b) => b.focused - a.focused || b.opened - a.opened)[0];
    return recent?.window ?? null;
  }

  /**
   * The window an IPC message came from, or null: a window's own top frame
   * only, never a frame inside it and never a window outside the set (a link
   * window has no preload, and is refused here as well).
   */
  forSender(sender: unknown, frame: unknown): W | null {
    if (frame === null || frame === undefined) return null;
    for (const entry of this.live()) {
      const contents = entry.window.webContents;
      if (contents === sender && contents.mainFrame === frame) return entry.window;
    }
    return null;
  }

  private live(): Entry<W>[] {
    return [...this.entries.values()]
      .filter((entry) => !entry.window.isDestroyed())
      .sort((a, b) => a.opened - b.opened);
  }
}

/** The longest route a window is opened at; a hash route the renderer draws is far shorter. */
const MAX_ROUTE = 2048;

/**
 * A route the renderer asked to open a window at, or null for the start page:
 * a path inside the app (`/runs/12`, `/search?source=arxiv`), never an address
 * elsewhere, a protocol-relative `//host`, or anything with a control character.
 */
export function cleanRoute(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > MAX_ROUTE) return null;
  if (!value.startsWith('/') || value.startsWith('//')) return null;
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f\\]/.test(value)) return null;
  return value;
}

/**
 * The page an address opens in the app, when it is one of the renderer's own
 * (`http://127.0.0.1:<port>/index.html#/watches/3`; `route` null for its start
 * page), or null for any other address. A ⌘-click or a middle click on a link
 * inside the app asks for a new window at that address, which must be a window
 * of the app, not a link window showing the renderer without its preload.
 */
export function routeOf(url: string, rendererOrigin: string | null): { route: string | null } | null {
  if (!rendererOrigin) return null;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.origin !== rendererOrigin) return null;
  if (parsed.pathname !== '/' && parsed.pathname !== '/index.html') return null;
  if (parsed.hash === '' || parsed.hash === '#' || parsed.hash === '#/') return { route: null };
  if (!parsed.hash.startsWith('#/')) return null;
  let route: string;
  try {
    route = decodeURI(parsed.hash.slice(1));
  } catch {
    return null;
  }
  const clean = cleanRoute(route);
  return clean === null ? null : { route: clean };
}

export interface Rect { x: number; y: number; width: number; height: number }

/**
 * Where a new window opens: one step down and to the right of the window it
 * was opened from, as macOS and Windows place a new document window, and back
 * at the work area's corner when that step would leave it.
 */
export function cascade(from: Rect, area: Rect, step = 26): Rect {
  const width = Math.min(from.width, area.width);
  const height = Math.min(from.height, area.height);
  let x = from.x + step;
  let y = from.y + step;
  if (x + width > area.x + area.width || y + height > area.y + area.height) {
    x = area.x + step;
    y = area.y + step;
    if (x + width > area.x + area.width) x = area.x;
    if (y + height > area.y + area.height) y = area.y;
  }
  return { x, y, width, height };
}

/**
 * Which window started each run, for the run's notification: clicking it
 * shows the run in that window, not in whichever one happens to be in front.
 * A run a watch started on its schedule has no window, and neither does one
 * started from the `resmon` command; theirs go to the window in front.
 *
 * A run asked for at the run limit waits in the engine's queue, with no id
 * until it starts. The window that asked is kept against what the engine said
 * of it: its `ticket` (a search or a restart), which the run's row carries as
 * `request_id` once it starts, or its watch, for a watch's Run now, whose
 * answer has no ticket. When a notice comes for a run no window claimed and
 * one is waiting, `main.ts` reads the run's row and `settle` matches it. A
 * watch's queued Run now is matched to that watch's next run to start, which
 * is a scheduled fire instead if one comes due before it.
 *
 * Bounded, since a long session starts runs without end.
 */
export class RunOwners {
  private readonly owners = new Map<number, number>();
  private readonly waiting = new Map<string, number>();

  constructor(private readonly limit = 200) {}

  claim(executionId: unknown, windowId: number): boolean {
    if (typeof executionId !== 'number' || !Number.isInteger(executionId) || executionId <= 0) return false;
    this.owners.delete(executionId);
    this.owners.set(executionId, windowId);
    while (this.owners.size > this.limit) this.owners.delete(this.owners.keys().next().value as number);
    return true;
  }

  /** A run queued at the run limit: by its ticket, or by its watch for a watch's Run now. */
  claimQueued(what: { ticket?: unknown; routineId?: unknown }, windowId: number): boolean {
    // A watch's run is found by its watch first: a watch's fire carries no request id, so a ticket
    // (which a queued Restart or Run again of a watch's run also gets) would never match it.
    const key = typeof what.routineId === 'number' && Number.isInteger(what.routineId) && what.routineId > 0 ? `watch:${what.routineId}`
      : typeof what.ticket === 'string' && what.ticket.length > 0 && what.ticket.length <= 200 ? `ticket:${what.ticket}`
        : null;
    if (key === null) return false;
    this.waiting.delete(key);
    this.waiting.set(key, windowId);
    while (this.waiting.size > this.limit) this.waiting.delete(this.waiting.keys().next().value as string);
    return true;
  }

  /** Whether `executionId` might be a queued run a window is waiting for: no owner yet, and one is waiting. */
  unsettled(executionId: number | null): executionId is number {
    return executionId !== null && !this.owners.has(executionId) && this.waiting.size > 0;
  }

  /** A run that started from the queue, as its row says: given to the window that queued it, if one did. */
  settle(executionId: number, row: { request_id?: unknown; routine_id?: unknown }): number | null {
    const keys = [
      typeof row.request_id === 'string' ? `ticket:${row.request_id}` : null,
      typeof row.routine_id === 'number' ? `watch:${row.routine_id}` : null,
    ];
    for (const key of keys) {
      const windowId = key === null ? undefined : this.waiting.get(key);
      if (key !== null && windowId !== undefined) {
        this.waiting.delete(key);
        this.claim(executionId, windowId);
        return windowId;
      }
    }
    return null;
  }

  ownerOf(executionId: number | null): number | null {
    return executionId === null ? null : this.owners.get(executionId) ?? null;
  }
}

/**
 * The window a notice shows in: the one that started its run, while it is
 * still open, else the one `WindowSet.target` names. Null when no window is
 * open, and only then does a click make one.
 */
export function noticeWindow<W extends WindowLike>(
  set: WindowSet<W>, owners: RunOwners, executionId: number | null, focused?: unknown,
): W | null {
  const owner = owners.ownerOf(executionId);
  const asked = owner === null ? null : set.all().find((window) => window.id === owner) ?? null;
  return asked ?? set.target(focused);
}

/**
 * Whether the app's windows are in tabs, which decides whether the renderer
 * leaves room at the top of each window for macOS's tab bar.
 *
 * resmon's windows draw their own top bar under a hidden title bar, and macOS
 * draws a window's tab bar over the top of its content there: nothing moves the
 * page down. Electron says nothing about whether a window's tab bar shows, so
 * this follows the only ways one can appear here. Electron turns off macOS's
 * automatic tabbing (a second window opened beside the first, with "Prefer
 * tabs" set to Always, still opened as a window: measured), so a tab bar shows
 * only after New Tab, the tab bar's new-tab button, Merge All Windows, or Show
 * Tab Bar, which are all resmon's own menu items. From then on every window
 * leaves the room, whether or not it is in a group itself, because a tab
 * dragged between windows is not reported either; a window alone in tabs mode
 * shows an empty strip, which is the safe mistake. With one window left, the
 * mode ends, unless that window's tab bar was shown by Show Tab Bar.
 */
export class TabsMode {
  private on = false;
  private shownAlone = false;

  get active(): boolean {
    return this.on;
  }

  /** New Tab, the tab bar's new-tab button, or Merge All Windows. */
  use(): void {
    this.on = true;
  }

  /** Show Tab Bar or Hide Tab Bar, on a window that is alone or in a group. */
  toggleBar(windows: number): void {
    if (windows <= 1) {
      this.shownAlone = !this.shownAlone;
      this.on = this.shownAlone;
    } else {
      this.on = true;
    }
  }

  /** The number of windows changed; with one or none left, tabs mode ends unless its bar was shown. */
  windowsNow(windows: number): void {
    if (windows <= 1) this.on = this.shownAlone && windows === 1;
    if (windows === 0) this.shownAlone = false;
  }
}

/**
 * How many pixels the renderer leaves above its bar for macOS's tab bar, or 0.
 *
 * Measured on macOS 26: once a window's title has been set, its tab bar sits in
 * the title bar's own row, beside the window controls, 28 points tall (before
 * the title is first set it sits in a second row under it, which is why
 * `main.ts` sets each window's title again after a tab change). Earlier
 * versions draw the tab bar as a row of its own under the title bar; 56 is the
 * two rows at 28 points each, not measured on those versions.
 */
export function tabStripHeight(platform: NodeJS.Platform, systemVersion: string, tabs: boolean): number {
  if (platform !== 'darwin' || !tabs) return 0;
  const major = Number.parseInt(systemVersion.split('.')[0] ?? '', 10);
  return Number.isFinite(major) && major >= 26 ? 28 : 56;
}
