import { NavLink } from 'react-router-dom';

/** Search's two halves: what resmon already holds, and asking the sources for more. */
export function SearchTabs() {
  return (
    <nav className="search-tabs" aria-label="Search">
      <NavLink to="/search" end>Your collection</NavLink>
      <NavLink to="/search/ask">Ask the sources</NavLink>
    </nav>
  );
}
