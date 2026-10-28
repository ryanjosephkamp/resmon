import { NavLink } from 'react-router-dom';

/** Watches' two halves: the searches resmon runs on a schedule, and the people it looks for on papers. */
export function WatchTabs() {
  return (
    <nav className="search-tabs" aria-label="Watches">
      <NavLink to="/watches" end>Searches</NavLink>
      <NavLink to="/watches/people">People</NavLink>
    </nav>
  );
}
