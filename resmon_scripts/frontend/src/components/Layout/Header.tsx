import React, { useEffect, useState } from 'react';
import { useLocation } from 'react-router-dom';
import { apiClient } from '../../api/client';

const routeTitles: Record<string, string> = {
  '/': 'Dashboard',
  '/dive': 'Deep Dive',
  '/sweep': 'Deep Sweep',
  '/routines': 'Routines',
  '/calendar': 'Calendar',
  '/results': 'Results & Logs',
  '/configurations': 'Configurations',
  '/settings': 'Settings',
};

const Header: React.FC = () => {
  const location = useLocation();
  const [backendOnline, setBackendOnline] = useState(false);

  const title = routeTitles[location.pathname] || 'resmon';

  useEffect(() => {
    let cancelled = false;
    const check = async () => {
      try {
        const resp = await apiClient.get('/api/health');
        if (!cancelled) setBackendOnline(resp.status === 'ok');
      } catch {
        if (!cancelled) setBackendOnline(false);
      }
    };
    check();
    const interval = setInterval(check, 15000);
    return () => { cancelled = true; clearInterval(interval); };
  }, []);

  return (
    <header className="header">
      <span className="header-title">{title}</span>
      <div className="header-status">
        <span>
          <span className={`status-dot ${backendOnline ? 'online' : 'offline'}`} />
          Backend: {backendOnline ? 'Online' : 'Offline'}
        </span>
      </div>
    </header>
  );
};

export default Header;
