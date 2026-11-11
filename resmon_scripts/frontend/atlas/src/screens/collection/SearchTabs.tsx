import { NavLink } from 'react-router-dom';

/**
 * Search's halves: what resmon already holds, asking the sources for more, one
 * paper looked up everywhere, what was saved to ask again, and the abstracts
 * that share wording.
 */
export function SearchTabs() {
  return (
    <nav className="search-tabs" aria-label="Search">
      <NavLink to="/search" end>Collection</NavLink>
      <NavLink to="/search/ask">Ask the Sources</NavLink>
      <NavLink to="/search/find">Look Up a Paper</NavLink>
      <NavLink to="/search/saved">Saved</NavLink>
      <NavLink to="/search/wording">Shared Wording</NavLink>
    </nav>
  );
}
