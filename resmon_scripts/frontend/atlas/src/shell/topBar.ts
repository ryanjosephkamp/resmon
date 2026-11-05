/**
 * The top bar as the person arranged it: the seven sections in their order,
 * the ones it hides, the page a window opens on, and where the resmon name
 * goes. The engine keeps it (`/api/top-bar`); this is the arithmetic over it,
 * with no React and no screens, so the shell, the command palette, the
 * shortcuts sheet, and Settings read it the same way.
 *
 * Hiding a section takes it out of the bar and nothing more. Its address, its
 * shortcut, and the command palette still open it, and Settings is not a
 * section, so it cannot be hidden.
 */
import type { components } from '../api/schema';
import { SCREEN_PATHS } from '../screenPaths';

export type TopBar = components['schemas']['TopBar'];
export type SectionId = TopBar['order'][number];
export type StartPage = TopBar['start'];

/** The sections in the bar's default order, by the names the engine keeps them under. */
export const SECTION_IDS: readonly SectionId[] = ['today', 'watches', 'search', 'runs', 'library', 'ask', 'health'];

export const DEFAULT_TOP_BAR: TopBar = { order: [...SECTION_IDS], hidden: [], start: '/today', lockup: null };

/** A section's address: `/search` for `search`. */
export function sectionAddress(id: SectionId): string {
  return `/${id}`;
}

/** The section a page belongs to, by its address: `search` for `/search/saved`. */
export function sectionOf(path: string): SectionId | null {
  const first = path.split('/')[1] ?? '';
  return (SECTION_IDS as readonly string[]).includes(first) ? first as SectionId : null;
}

/**
 * Every page a window can open on, and the resmon name can go to, in the
 * bar's default order: each section's own address and each tab within it,
 * named as Settings and the window's title name them. The engine accepts
 * exactly these (`TopBarPage`); `__tests__/topBar.test.ts` holds the two to
 * each other.
 */
const PAGES: readonly StartPage[] = [
  '/today',
  '/watches', '/watches/calendar', '/watches/people',
  '/search', '/search/ask', '/search/saved', '/search/wording',
  '/runs',
  '/library', '/library/files', '/library/evidence',
  '/ask',
  '/health', '/health/watchdog', '/health/analytics', '/health/engine',
];

export interface PageChoice {
  path: StartPage;
  section: SectionId;
  /** `Search › Saved`, as `screenPaths.ts` names it. */
  name: string;
}

export const START_PAGES: readonly PageChoice[] = PAGES.map((path) => ({
  path,
  section: sectionOf(path) as SectionId,
  name: SCREEN_PATHS.find((screen) => screen.path === path)?.name ?? path,
}));

/** A page's name, `Search › Saved`; the address itself for one that is not a start page. */
export function pageName(path: string): string {
  return START_PAGES.find((page) => page.path === path)?.name ?? path;
}

const isPage = (path: unknown): path is StartPage => START_PAGES.some((page) => page.path === path);

/** The top bar, read for drawing. */
export interface Arranged {
  /** All seven sections, in the bar's order, the hidden ones in their places. */
  order: SectionId[];
  /** The sections the bar shows, from the left. */
  shown: SectionId[];
  hidden: ReadonlySet<SectionId>;
  /**
   * The section each of ⌘1 to ⌘7 opens: the shown sections from the left,
   * then the hidden ones in their order. ⌘1 is always the bar's first tab.
   */
  keys: SectionId[];
  /** The same, by address, as `shortcuts.ts` takes them. */
  keyPaths: string[];
  /** The page a launch and a new window open on. */
  start: StartPage;
  /** Where the resmon name goes: its own page, or the start page. */
  lockup: StartPage;
}

/**
 * Every known section once, in `names`' order, the unknown and repeated
 * dropped, and a missing one put back after the section it follows by
 * default. The engine answers an order that is already whole; this is the same
 * rule (`resmon._top_bar_order`), so a window that reaches an engine of
 * another build still draws seven sections and nothing it has no screen for.
 */
export function wholeOrder(names: readonly string[]): SectionId[] {
  const order: SectionId[] = [];
  for (const name of names) {
    if ((SECTION_IDS as readonly string[]).includes(name) && !order.includes(name as SectionId)) order.push(name as SectionId);
  }
  SECTION_IDS.forEach((id, index) => {
    if (order.includes(id)) return;
    const before = SECTION_IDS.slice(0, index).reverse().find((other) => order.includes(other));
    order.splice(before ? order.indexOf(before) + 1 : 0, 0, id);
  });
  return order;
}

export function arrange(bar: TopBar): Arranged {
  const order = wholeOrder(bar.order);
  const hidden = new Set(bar.hidden.filter((id) => order.includes(id)));
  const shown = order.filter((id) => !hidden.has(id));
  const start = isPage(bar.start) ? bar.start : DEFAULT_TOP_BAR.start;
  const keys = [...shown, ...order.filter((id) => hidden.has(id))];
  return {
    order,
    shown,
    hidden,
    keys,
    keyPaths: keys.map(sectionAddress),
    start,
    lockup: isPage(bar.lockup) ? bar.lockup : start,
  };
}

/** The arrangement with `id` moved to `to` (0 is the left end), the others keeping their order. */
export function moved(bar: TopBar, id: SectionId, to: number): TopBar {
  const order = wholeOrder(bar.order).filter((other) => other !== id);
  order.splice(Math.max(0, Math.min(to, order.length)), 0, id);
  return { ...bar, order, hidden: order.filter((other) => bar.hidden.includes(other)) };
}

/** The arrangement with `id` shown or hidden. */
export function shownOrHidden(bar: TopBar, id: SectionId, show: boolean): TopBar {
  const order = wholeOrder(bar.order);
  return { ...bar, order, hidden: order.filter((other) => (other === id ? !show : bar.hidden.includes(other))) };
}

export function sameTopBar(a: TopBar, b: TopBar): boolean {
  const list = (names: readonly string[]) => names.join(' ');
  return list(a.order) === list(b.order) && list(a.hidden) === list(b.hidden)
    && a.start === b.start && (a.lockup ?? null) === (b.lockup ?? null);
}

/** Whether this is the bar a fresh install has, as Reset would leave it. */
export function isDefault(bar: TopBar): boolean {
  return sameTopBar({ ...bar, order: wholeOrder(bar.order) }, DEFAULT_TOP_BAR);
}
