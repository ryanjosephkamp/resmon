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
 * This is navigation, not routing: `routes.ts` is the table of every route the
 * renderer can serve, which is a longer list including routes the sidebar does
 * not link. These two are checked against each other in
 * `src/__tests__/routes.test.tsx`.
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
  /** The glyph rendered to the left of the label. */
  icon: string;
}

export const NAV_ITEMS: readonly NavItem[] = [
  { to: '/', label: 'Dashboard', icon: '⊞' },
  { to: '/dive', label: 'Deep Dive', icon: '⎈' },
  { to: '/sweep', label: 'Deep Sweep', icon: '⟐' },
  { to: '/routines', label: 'Routines', icon: '⟳' },
  { to: '/calendar', label: 'Calendar', icon: '▦' },
  { to: '/results', label: 'Results & Logs', icon: '◉' },
  { to: '/chats', label: 'Chats', icon: '☏' },
  { to: '/reading-queue', label: 'Reading queue', icon: '⚑' },
  { to: '/library', label: 'Library', icon: '▤' },
  { to: '/evidence', label: 'Evidence', icon: '▧' },
  { to: '/analytics', label: 'Analytics', icon: '▤' },
  { to: '/watchdog', label: 'Watchdog', icon: '◬' },
  { to: '/source-wall', label: 'Source wall', icon: '▩' },
  { to: '/explorer', label: 'Explorer', icon: '⌕' },
  { to: '/profiles', label: 'Watch Profiles', icon: '☖' },
  { to: '/configurations', label: 'Configurations', icon: '⚙' },
  { to: '/monitor', label: 'Monitor', icon: '◎' },
  { to: '/repositories', label: 'Repositories & API Keys', icon: '◈' },
  { to: '/settings', label: 'Settings', icon: '☰' },
  { to: '/about-resmon', label: 'About resmon', icon: 'ℹ' },
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
