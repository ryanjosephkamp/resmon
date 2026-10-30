import React from 'react';
import { Routes, Route, NavLink, Navigate } from 'react-router-dom';
import EmailSettings from '../components/Settings/EmailSettings';
import AISettings from '../components/Settings/AISettings';
import StorageSettings from '../components/Settings/StorageSettings';
import NotificationSettings from '../components/Settings/NotificationSettings';
import AdvancedSettings from '../components/Settings/AdvancedSettings';

const SettingsPage: React.FC = () => {
  return (
    <div className="page-content">
      {/* No Tutorial button here: each tab's own header carries the one for that
          tab, and two stacked Tutorial buttons on one screen asked the reader to
          guess which was meant. The overview stays in the Tutorials contents. */}
      <div className="page-header">
        <h1>Settings</h1>
      </div>
      <div className="settings-nav">
        <NavLink to="/settings/email" className={({ isActive }) => `tab-btn ${isActive ? 'tab-active' : ''}`}>Email</NavLink>
        <NavLink to="/settings/ai" className={({ isActive }) => `tab-btn ${isActive ? 'tab-active' : ''}`}>AI</NavLink>
        <NavLink to="/settings/storage" className={({ isActive }) => `tab-btn ${isActive ? 'tab-active' : ''}`}>Storage</NavLink>
        <NavLink to="/settings/notifications" className={({ isActive }) => `tab-btn ${isActive ? 'tab-active' : ''}`}>Notifications</NavLink>
        <NavLink to="/settings/advanced" className={({ isActive }) => `tab-btn ${isActive ? 'tab-active' : ''}`}>Advanced</NavLink>
      </div>
      <Routes>
        <Route index element={<Navigate to="email" replace />} />
        <Route path="email" element={<EmailSettings />} />
        <Route path="ai" element={<AISettings />} />
        <Route path="storage" element={<StorageSettings />} />
        <Route path="notifications" element={<NotificationSettings />} />
        <Route path="advanced" element={<AdvancedSettings />} />
      </Routes>
    </div>
  );
};

export default SettingsPage;
