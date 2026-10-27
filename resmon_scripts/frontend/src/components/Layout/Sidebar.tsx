import React from 'react';
import { NavLink } from 'react-router-dom';
import { useExecution } from '../../context/ExecutionContext';
// The destinations themselves live in `navItems.ts`, because the Tutorials
// tab's overview enumerates them and a second hand-written copy of this list
// is exactly what went stale. See that file's header.
import { NAV_ITEMS } from './navItems';
import NavIcon from './NavIcon';
import ResmonMark from './ResmonMark';

const Sidebar: React.FC = () => {
  const { activeExecution } = useExecution();
  const isRunning = activeExecution?.status === 'running';

  return (
    <aside className="sidebar">
      <div className="sidebar-brand"><ResmonMark /> <span>resmon</span></div>
      <nav className="sidebar-nav">
        {NAV_ITEMS.map((item) => (
          <NavLink
            key={item.to}
            to={item.to}
            end={item.to === '/'}
            className={({ isActive }) =>
              `sidebar-link${isActive ? ' active' : ''}`
            }
          >
            <NavIcon name={item.icon} />
            {item.label}
            {item.to === '/monitor' && isRunning && (
              <span className="sidebar-pulse" />
            )}
          </NavLink>
        ))}
      </nav>
    </aside>
  );
};

export default Sidebar;
