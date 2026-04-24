import React from 'react';
import { HashRouter, Routes, Route } from 'react-router-dom';
import Sidebar from './components/Layout/Sidebar';
import Header from './components/Layout/Header';
import MainContent from './components/Layout/MainContent';
import FloatingWidget from './components/Monitor/FloatingWidget';
import { ExecutionProvider } from './context/ExecutionContext';
import { AuthProvider } from './context/AuthContext';
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

const App: React.FC = () => {
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
