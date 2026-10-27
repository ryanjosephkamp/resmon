/**
 * The sidebar's destinations, in the order the sidebar shows them.
 *
 * This list used to live inside `Sidebar.tsx`, where it was the only copy of a
 * fact that two places need. The other place was prose: the Tutorials tab's
 * "Full App Overview" told the reader to "use the ten top-level pages" and
 * named ten, long after the sidebar had grown past them. By 2.3.0 the sidebar
 * had nineteen destinations and the sentence still said ten, so the first
 * instruction in the app's own walk-through described an application the
 * reader did not have in front of them.
 *
 * `routes.ts` already carries the lesson this file applies: a surface with a
 * list in the code, and everything that talks about the surface parameterized
 * over the list. A hand-maintained copy drifts, and the drift is invisible
 * because nothing compares the two. So the list moved here, `Sidebar.tsx`
 * renders from it, and the overview sentence is built from it — a page added
 * to the sidebar now changes that sentence in the same commit, whether or not
 * anyone remembers it exists.
 *
 * This is navigation and `routes.ts` is routing, and today they hold the same
 * twenty destinations: every row of the route table is reached by a link here,
 * and every link here resolves to a row. `src/__tests__/routes.test.tsx`
 * asserts that in both directions, and asserts that the sidebar really renders
 * one link per entry in this order.
 *
 * A row is not the whole surface, and the sentence above is deliberately about
 * rows. `allRouteHashes()` expands the two splat rows into their tabs and comes
 * to thirty hashes; ten of those — six under Settings, four under About resmon
 * — are reached from inside their own page and never from the sidebar. They are
 * outside this comparison on purpose, which is why the test compares rows.
 *
 * Both halves earn their place. A route no link reaches is a page a user cannot
 * get to; a link to no route is a dead end. And since the Tutorials overview
 * now derives its page list from this array, an entry deleted from here would
 * disappear from the app's own documentation in the same stroke and leave the
 * two agreeing about a sidebar that had quietly shrunk — which is the one way
 * deriving the prose is worse than transcribing it, and the reason the check
 * runs in the direction that catches it.
 *
 * Deliberately zero imports, for the same reason `routes.ts` has none: it
 * should be loadable by anything that wants the list, without dragging React
 * in behind it.
 */

/** One destination in the left sidebar. */
export interface NavItem {
  /** Router path, exactly as `NavLink` receives it. */
  to: string;
  /** The name the user reads, in the sidebar and in the documentation. */
  label: string;
  /**
   * Which drawn icon sits to the left of the label (`NavIcon.tsx`). These were
   * Unicode glyphs, and the glyphs were a mixed family: different system fonts
   * drew them at different sizes and weights, Library and Analytics shared one,
   * and Chats was a telephone.
   */
  icon: NavIconName;
}

/** Every icon the sidebar can draw. */
export type NavIconName =
  | 'dashboard' | 'dive' | 'sweep' | 'routines' | 'calendar' | 'results' | 'chats'
  | 'reading' | 'library' | 'evidence' | 'analytics' | 'watchdog' | 'wall' | 'explorer'
  | 'profiles' | 'configurations' | 'monitor' | 'repositories' | 'settings' | 'about';

export const NAV_ITEMS: readonly NavItem[] = [
  { to: '/', label: 'Dashboard', icon: 'dashboard' },
  { to: '/dive', label: 'Deep Dive', icon: 'dive' },
  { to: '/sweep', label: 'Deep Sweep', icon: 'sweep' },
  { to: '/routines', label: 'Routines', icon: 'routines' },
  { to: '/calendar', label: 'Calendar', icon: 'calendar' },
  { to: '/results', label: 'Results & Logs', icon: 'results' },
  { to: '/chats', label: 'Chats', icon: 'chats' },
  { to: '/reading-queue', label: 'Reading queue', icon: 'reading' },
  { to: '/library', label: 'Library', icon: 'library' },
  { to: '/evidence', label: 'Evidence', icon: 'evidence' },
  { to: '/analytics', label: 'Analytics', icon: 'analytics' },
  { to: '/watchdog', label: 'Watchdog', icon: 'watchdog' },
  { to: '/source-wall', label: 'Source wall', icon: 'wall' },
  { to: '/explorer', label: 'Explorer', icon: 'explorer' },
  { to: '/profiles', label: 'Watch Profiles', icon: 'profiles' },
  { to: '/configurations', label: 'Configurations', icon: 'configurations' },
  { to: '/monitor', label: 'Monitor', icon: 'monitor' },
  { to: '/repositories', label: 'Repositories & API Keys', icon: 'repositories' },
  { to: '/settings', label: 'Settings', icon: 'settings' },
  { to: '/about-resmon', label: 'About resmon', icon: 'about' },
];

/**
 * The destination names as an English list: "A, B, and C".
 *
 * Used by the Tutorials tab so that the overview's enumeration is the sidebar
 * rather than a transcription of it.
 */
export function navItemNames(items: readonly NavItem[] = NAV_ITEMS): string {
  const labels = items.map((item) => item.label);
  if (labels.length === 0) return '';
  if (labels.length === 1) return labels[0];
  return `${labels.slice(0, -1).join(', ')}, and ${labels[labels.length - 1]}`;
}
