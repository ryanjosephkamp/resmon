import React from 'react';
import { useLocation } from 'react-router-dom';
import { useConnectionIdentity } from '../../hooks/useConnectionIdentity';
import { NAV_ITEMS } from './navItems';

// The title is the sidebar's own name for the page, found by the longest
// sidebar path the location starts with. A hand-kept table of titles stood
// here and covered fourteen of the twenty pages, so Analytics, Explorer, Watch
// Profiles, Monitor, Repositories, every Settings tab and About resmon all
// headed themselves "resmon".
export function titleFor(pathname: string): string {
  if (pathname === '/' || pathname === '') return NAV_ITEMS[0].label;
  let best: { to: string; label: string } | null = null;
  for (const item of NAV_ITEMS) {
    if (item.to === '/') continue;
    if (pathname === item.to || pathname.startsWith(`${item.to}/`)) {
      if (!best || item.to.length > best.to.length) best = item;
    }
  }
  return best ? best.label : 'resmon';
}

const Header: React.FC = () => {
  const location = useLocation();
  const connection = useConnectionIdentity();
  const observed = connection.observation;
  const title = titleFor(location.pathname);
  const labels = {
    checking: 'Checking running app', connected: `Connected · ${observed?.identity?.runtime_id.slice(0, 8)}`,
    offline: 'Running app unavailable', identity_unavailable: 'Identity unavailable',
    instance_mismatch: 'Running app changed',
  };

  return (
    <header className="header">
      <span className="header-title">{title}</span>
      <details className="connection-identity">
        <summary aria-label="Connected app details">
          <span className={`status-dot ${connection.status === 'connected' ? 'online' : 'offline'}`} />
          <span role="status">{labels[connection.status]}</span>
        </summary>
        <div className="connection-details">
          <strong>Connected app</strong>
          {connection.stale && <p>Last observation is stale. The current running app has not been accepted.</p>}
          {connection.status === 'identity_unavailable' && <p>This app did not supply a supported runtime identity.</p>}
          <dl>
            <dt>Runtime ID</dt><dd>{observed?.identity?.runtime_id ?? 'Unknown'}</dd>
            <dt>Last observed</dt><dd>{observed ? new Date(observed.observedAt).toLocaleString() : 'Not yet observed'}</dd>
            <dt>Process ID</dt><dd>{observed?.pid ?? 'Unknown'}</dd>
            <dt>Started</dt><dd>{observed?.started_at ?? 'Unknown'}</dd>
            <dt>App version</dt><dd>{observed?.version ?? 'Unknown'}</dd>
            <dt>Schema</dt><dd>{observed?.identity?.schema_version ?? 'Unknown'}</dd>
            <dt>Corpus identity</dt><dd>Unknown</dd>
            <dt>Build identity</dt><dd>Unknown</dd>
          </dl>
          <p>This header remembers the running app until reload. Other app requests are not pinned to it.</p>
          <div className="connection-actions">
            <button type="button" onClick={connection.refresh}>Refresh status</button>
            {(connection.status !== 'connected' && connection.status !== 'checking') &&
              <button type="button" onClick={connection.reaccept}>Use this running app</button>}
          </div>
        </div>
      </details>
    </header>
  );
};

export default Header;
