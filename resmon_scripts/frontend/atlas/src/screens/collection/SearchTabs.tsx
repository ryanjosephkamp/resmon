import { NavLink } from 'react-router-dom';

/** Search's halves: what resmon already holds, asking the sources for more, and what was saved to ask again. */
export function SearchTabs() {
  return (
    <nav className="search-tabs" aria-label="Search">
      <NavLink to="/search" end>Your collection</NavLink>
      <NavLink to="/search/ask">Ask the sources</NavLink>
      <NavLink to="/search/saved">Saved</NavLink>
    </nav>
  );
}
