import React from 'react';
import { HashRouter, Routes, Route } from 'react-router-dom';
import Sidebar from './components/Layout/Sidebar';
import Header from './components/Layout/Header';
import MainContent from './components/Layout/MainContent';
import FloatingWidget from './components/Monitor/FloatingWidget';
import { ExecutionProvider } from './context/ExecutionContext';
import { AuthProvider } from './context/AuthContext';
import { apiClient } from './api/client';
import DashboardPage from './pages/DashboardPage';
import DeepDivePage from './pages/DeepDivePage';
import DeepSweepPage from './pages/DeepSweepPage';
import RoutinesPage from './pages/RoutinesPage';
import CalendarPage from './pages/CalendarPage';
import ResultsPage from './pages/ResultsPage';
import ConfigurationsPage from './pages/ConfigurationsPage';
import MonitorPage from './pages/MonitorPage';
import RepositoriesPage from './pages/RepositoriesPage';
import SettingsPage from './pages/SettingsPage';
import AboutResmonPage from './pages/AboutResmonPage';

/**
 * Tells the backend the renderer is alive so its desktop-notification
 * dispatcher can suppress itself and let the renderer's own
 * ``new Notification(...)`` handle completion alerts. Without this,
 * macOS surfaces a duplicate notification attributed to ``Script
 * Editor`` (the AppleScript host used by the backend's ``osascript``
 * fallback). The backend's TTL is 15 s; pinging every 5 s leaves
 * comfortable headroom.
 */
const useRendererHeartbeat = (): void => {
  React.useEffect(() => {
    let cancelled = false;
    const ping = () => {
      if (cancelled) return;
      apiClient.post('/api/renderer/heartbeat', {}).catch(() => {
        /* backend not ready or transient — retry next tick */
      });
    };
    ping();
    const id = window.setInterval(ping, 5000);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, []);
};

const App: React.FC = () => {
  useRendererHeartbeat();
  return (
    <HashRouter>
      <AuthProvider>
        <ExecutionProvider>
          <div className="app-shell">
            <Sidebar />
            <div className="app-main">
              <Header />
              <MainContent>
                <Routes>
                  <Route path="/" element={<DashboardPage />} />
                  <Route path="/dive" element={<DeepDivePage />} />
                  <Route path="/sweep" element={<DeepSweepPage />} />
                  <Route path="/routines" element={<RoutinesPage />} />
                  <Route path="/calendar" element={<CalendarPage />} />
                  <Route path="/results" element={<ResultsPage />} />
                  <Route path="/configurations" element={<ConfigurationsPage />} />
                  <Route path="/monitor" element={<MonitorPage />} />
                  <Route path="/repositories" element={<RepositoriesPage />} />
                  <Route path="/settings/*" element={<SettingsPage />} />
                  <Route path="/about-resmon/*" element={<AboutResmonPage />} />
                </Routes>
              </MainContent>
            </div>
            <FloatingWidget />
          </div>
        </ExecutionProvider>
      </AuthProvider>
    </HashRouter>
  );
};

export default App;
