import { NavLink } from 'react-router-dom';

/** Library's parts: papers saved to read, files kept in a folder you own, and the evidence taken from them. */
export function LibraryTabs() {
  return (
    <nav className="search-tabs" aria-label="Library">
      <NavLink to="/library" end>Reading queue</NavLink>
      <NavLink to="/library/files">Your files</NavLink>
      <NavLink to="/library/evidence">Evidence</NavLink>
    </nav>
  );
}
