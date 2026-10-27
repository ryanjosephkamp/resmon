import React from 'react';
import type { NavIconName } from './navItems';

/**
 * The sidebar's icons: one family, drawn on a 20-unit grid with a 1.6 stroke
 * and round ends, in `currentColor` so the active and hover colors of the link
 * reach the icon without a second rule.
 *
 * The Source wall icon is the only one that mixes filled and hollow marks, and
 * on purpose: it is the wall's own vocabulary, where a hollow mark is a source
 * that answered with nothing and is still on the record.
 */
const PATHS: Record<NavIconName, React.ReactNode> = {
  dashboard: (
    <>
      <rect x="3" y="3" width="6" height="8" rx="1.5" />
      <rect x="11" y="3" width="6" height="5" rx="1.5" />
      <rect x="3" y="13" width="6" height="4" rx="1.5" />
      <rect x="11" y="10" width="6" height="7" rx="1.5" />
    </>
  ),
  dive: (
    <>
      <circle cx="10" cy="10" r="7" />
      <circle cx="10" cy="10" r="3.5" />
      <circle cx="10" cy="10" r="0.9" fill="currentColor" stroke="none" />
    </>
  ),
  sweep: (
    <>
      <circle cx="8.5" cy="8.5" r="5" />
      <path d="M12.2 12.2 17 17" />
    </>
  ),
  routines: (
    <>
      <path d="M4 9.5a6 6 0 0 1 10.4-4.1L16 7" />
      <path d="M16 3.2V7h-3.8" />
      <path d="M16 10.5a6 6 0 0 1-10.4 4.1L4 13" />
      <path d="M4 16.8V13h3.8" />
    </>
  ),
  calendar: (
    <>
      <rect x="3" y="4.5" width="14" height="12.5" rx="2" />
      <path d="M3 8.5h14M7 2.5v4M13 2.5v4" />
    </>
  ),
  results: (
    <>
      <rect x="4" y="2.5" width="12" height="15" rx="2" />
      <path d="M7 7h6M7 10h6M7 13h4" />
    </>
  ),
  chats: (
    <path d="M4 4.5h12A1.5 1.5 0 0 1 17.5 6v7a1.5 1.5 0 0 1-1.5 1.5H9.2L5.5 17.5v-3H4A1.5 1.5 0 0 1 2.5 13V6A1.5 1.5 0 0 1 4 4.5Z" />
  ),
  reading: (
    <path d="M6 2.5h8a1 1 0 0 1 1 1v14l-5-3.5-5 3.5v-14a1 1 0 0 1 1-1Z" />
  ),
  library: (
    <>
      <rect x="3" y="3" width="3.5" height="14" rx="1" />
      <rect x="7.5" y="3" width="3.5" height="14" rx="1" />
      <path d="m12.6 4.3 3.2-.8 2.2 12.7-3.2.8Z" />
    </>
  ),
  evidence: (
    <>
      <rect x="4" y="2.5" width="12" height="15" rx="2" />
      <path d="M7 6.5h6M7 14.5h4" />
      <rect x="6.5" y="9" width="7" height="2.6" rx="0.6" fill="currentColor" stroke="none" />
    </>
  ),
  analytics: (
    <>
      <path d="M3 17h14" />
      <rect x="4.5" y="9" width="2.6" height="5.5" rx="0.6" />
      <rect x="8.7" y="4.5" width="2.6" height="10" rx="0.6" />
      <rect x="12.9" y="11" width="2.6" height="3.5" rx="0.6" />
    </>
  ),
  watchdog: (
    <>
      <path d="M1.8 10S5 4.5 10 4.5 18.2 10 18.2 10 15 15.5 10 15.5 1.8 10 1.8 10Z" />
      <circle cx="10" cy="10" r="2.6" />
    </>
  ),
  wall: (
    <>
      {[4.5, 10, 15.5].flatMap((y) => [4.5, 10, 15.5].map((x) => (
        x === 15.5 && y === 15.5
          ? <circle key={`${x}-${y}`} cx={x} cy={y} r="1.5" />
          : <circle key={`${x}-${y}`} cx={x} cy={y} r="2" fill="currentColor" stroke="none" />
      )))}
    </>
  ),
  explorer: (
    <>
      <circle cx="10" cy="10" r="7.5" />
      <path d="m12.9 7.1-1.7 4.1-4.1 1.7 1.7-4.1Z" />
    </>
  ),
  profiles: (
    <>
      <circle cx="10" cy="6.5" r="3.2" />
      <path d="M3.5 17c.8-3.4 3.4-5.2 6.5-5.2s5.7 1.8 6.5 5.2" />
    </>
  ),
  configurations: (
    <>
      <path d="M3 5.5h14M3 10h14M3 14.5h14" />
      <circle cx="7" cy="5.5" r="1.9" fill="currentColor" />
      <circle cx="13" cy="10" r="1.9" fill="currentColor" />
      <circle cx="9" cy="14.5" r="1.9" fill="currentColor" />
    </>
  ),
  monitor: <path d="M2 10.5h3.5l2-5 3.5 9 2-4H18" />,
  repositories: (
    <>
      <ellipse cx="10" cy="5" rx="6" ry="2.5" />
      <path d="M4 5v10c0 1.4 2.7 2.5 6 2.5s6-1.1 6-2.5V5" />
      <path d="M4 10c0 1.4 2.7 2.5 6 2.5s6-1.1 6-2.5" />
    </>
  ),
  settings: (
    <>
      <circle cx="10" cy="10" r="2.5" />
      <circle cx="10" cy="10" r="5.6" />
      <path d="M10 1.8v2.6M10 15.6v2.6M1.8 10h2.6M15.6 10h2.6M4.2 4.2l1.8 1.8M14 14l1.8 1.8M4.2 15.8 6 14M14 6l1.8-1.8" />
    </>
  ),
  about: (
    <>
      <circle cx="10" cy="10" r="7.5" />
      <path d="M10 9v5" />
      <circle cx="10" cy="6.3" r="1" fill="currentColor" stroke="none" />
    </>
  ),
};

const NavIcon: React.FC<{ name: NavIconName }> = ({ name }) => (
  <svg
    className="sidebar-icon"
    viewBox="0 0 20 20"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.6"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
    focusable="false"
  >
    {PATHS[name]}
  </svg>
);

export default NavIcon;
