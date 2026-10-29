import { NavLink } from 'react-router-dom';

/** Library's parts: papers saved to read, and files kept in a folder you own. */
export function LibraryTabs() {
  return (
    <nav className="search-tabs" aria-label="Library">
      <NavLink to="/library" end>Reading queue</NavLink>
      <NavLink to="/library/files">Your files</NavLink>
    </nav>
  );
}
