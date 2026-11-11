import { NavLink } from 'react-router-dom';

/**
 * Watches' three parts: the searches resmon runs on a schedule, the calendar
 * of when they are due, and the people it looks for on papers.
 */
export function WatchTabs() {
  return (
    <nav className="search-tabs" aria-label="Watches">
      <NavLink to="/watches" end>Searches</NavLink>
      <NavLink to="/watches/calendar">Calendar</NavLink>
      <NavLink to="/watches/people">People</NavLink>
    </nav>
  );
}
