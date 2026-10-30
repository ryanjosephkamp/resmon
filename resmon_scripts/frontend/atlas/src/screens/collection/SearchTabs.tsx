import { NavLink } from 'react-router-dom';

/**
 * Search's halves: what resmon already holds, asking the sources for more, what
 * was saved to ask again, and the abstracts that share wording.
 */
export function SearchTabs() {
  return (
    <nav className="search-tabs" aria-label="Search">
      <NavLink to="/search" end>Your collection</NavLink>
      <NavLink to="/search/ask">Ask the sources</NavLink>
      <NavLink to="/search/saved">Saved</NavLink>
      <NavLink to="/search/wording">Shared wording</NavLink>
    </nav>
  );
}
