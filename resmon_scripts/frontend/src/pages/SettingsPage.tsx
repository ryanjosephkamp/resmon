import React from 'react';
import { Routes, Route, NavLink, Navigate } from 'react-router-dom';
import EmailSettings from '../components/Settings/EmailSettings';
import CloudSettings from '../components/Settings/CloudSettings';
import CloudAccountSettings from '../components/Settings/CloudAccountSettings';
import AISettings from '../components/Settings/AISettings';
import StorageSettings from '../components/Settings/StorageSettings';
import NotificationSettings from '../components/Settings/NotificationSettings';
import AdvancedSettings from '../components/Settings/AdvancedSettings';
import AboutAppSettings from '../components/Settings/AboutAppSettings';

const SettingsPage: React.FC = () => {
  return (
    <div className="page-content">
      <div className="page-header">
        <h1>Settings</h1>
      </div>
      <div className="settings-nav">
        <NavLink to="/settings/email" className={({ isActive }) => `tab-btn ${isActive ? 'tab-active' : ''}`}>Email</NavLink>
        <NavLink to="/settings/account" className={({ isActive }) => `tab-btn ${isActive ? 'tab-active' : ''}`}>Cloud Account</NavLink>
        <NavLink to="/settings/cloud" className={({ isActive }) => `tab-btn ${isActive ? 'tab-active' : ''}`}>Cloud Storage</NavLink>
        <NavLink to="/settings/ai" className={({ isActive }) => `tab-btn ${isActive ? 'tab-active' : ''}`}>AI</NavLink>
        <NavLink to="/settings/storage" className={({ isActive }) => `tab-btn ${isActive ? 'tab-active' : ''}`}>Storage</NavLink>
        <NavLink to="/settings/notifications" className={({ isActive }) => `tab-btn ${isActive ? 'tab-active' : ''}`}>Notifications</NavLink>
        <NavLink to="/settings/advanced" className={({ isActive }) => `tab-btn ${isActive ? 'tab-active' : ''}`}>Advanced</NavLink>
        <NavLink to="/settings/about" className={({ isActive }) => `tab-btn ${isActive ? 'tab-active' : ''}`}>About App</NavLink>
      </div>
      <Routes>
        <Route index element={<Navigate to="email" replace />} />
        <Route path="email" element={<EmailSettings />} />
        <Route path="account" element={<CloudAccountSettings />} />
        <Route path="cloud" element={<CloudSettings />} />
        <Route path="ai" element={<AISettings />} />
        <Route path="storage" element={<StorageSettings />} />
        <Route path="notifications" element={<NotificationSettings />} />
        <Route path="advanced" element={<AdvancedSettings />} />
        <Route path="about" element={<AboutAppSettings />} />
      </Routes>
    </div>
  );
};

export default SettingsPage;
