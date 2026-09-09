import React from 'react';
import { useLocation } from 'react-router-dom';
import { useConnectionIdentity } from '../../hooks/useConnectionIdentity';

const routeTitles: Record<string, string> = {
  '/': 'Dashboard',
  '/dive': 'Deep Dive',
  '/sweep': 'Deep Sweep',
  '/routines': 'Routines',
  '/calendar': 'Calendar',
  '/results': 'Results & Logs',
  '/reading-queue': 'Reading queue',
  '/watchdog': 'Watchdog',
  '/configurations': 'Configurations',
  '/settings': 'Settings',
};

const Header: React.FC = () => {
  const location = useLocation();
  const connection = useConnectionIdentity();
  const observed = connection.observation;
  const title = routeTitles[location.pathname] || 'resmon';
  const labels = {
    checking: 'Checking running app', connected: `Connected · ${observed?.identity?.runtime_id.slice(0, 8)}`,
    offline: 'Running app unavailable', identity_unavailable: 'Identity unavailable',
    instance_mismatch: 'Running app changed',
  };

  return () => { cancelled = true; clearInterval(interval); };
  }, []);

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
