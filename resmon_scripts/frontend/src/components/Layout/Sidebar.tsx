import React from 'react';
import { NavLink } from 'react-router-dom';
import { useExecution } from '../../context/ExecutionContext';

interface NavItem {
  to: string;
  label: string;
  icon: string;
}

const navItems: NavItem[] = [
  { to: '/', label: 'Dashboard', icon: '⊞' },
  { to: '/dive', label: 'Deep Dive', icon: '⎈' },
  { to: '/sweep', label: 'Deep Sweep', icon: '⟐' },
  { to: '/routines', label: 'Routines', icon: '⟳' },
  { to: '/calendar', label: 'Calendar', icon: '▦' },
  { to: '/results', label: 'Results & Logs', icon: '◉' },
  { to: '/configurations', label: 'Configurations', icon: '⚙' },
  { to: '/monitor', label: 'Monitor', icon: '◎' },
  { to: '/repositories', label: 'Repositories & API Keys', icon: '◈' },
  { to: '/settings', label: 'Settings', icon: '☰' },
  { to: '/about-resmon', label: 'About resmon', icon: 'ℹ' },
];

const Sidebar: React.FC = () => {
  const { activeExecution } = useExecution();
  const isRunning = activeExecution?.status === 'running';

  return (
    <aside className="sidebar">
      <div className="sidebar-brand">■ resmon</div>
      <nav className="sidebar-nav">
        {navItems.map((item) => (
          <NavLink
            key={item.to}
            to={item.to}
            end={item.to === '/'}
            className={({ isActive }) =>
              `sidebar-link${isActive ? ' active' : ''}`
            }
          >
            <span className="sidebar-icon">{item.icon}</span>
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
