import React from 'react';
import { HashRouter, Routes, Route } from 'react-router-dom';
import Sidebar from './components/Layout/Sidebar';
import Header from './components/Layout/Header';
import MainContent from './components/Layout/MainContent';
import FloatingWidget from './components/Monitor/FloatingWidget';
import AssistantPanel from './components/Assistant/AssistantPanel';
import { ExecutionProvider } from './context/ExecutionContext';
import { AssistantProvider } from './context/AssistantContext';
import { apiClient } from './api/client';
import AnalyticsPage from './pages/AnalyticsPage';
import WatchdogPage from './pages/WatchdogPage';
import ExplorerPage from './pages/ExplorerPage';
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
import { APP_ROUTES } from './routes';

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

/**
 * The page each route renders, keyed by the route's own path.
 *
 * Split from `routes.ts` because that table is imported by the Playwright
 * suite, which runs outside webpack and must not pull React or a stylesheet in
 * with it. The two halves are held together by `src/__tests__/routes.test.tsx`:
 * it fails when a key here has no route, when a route has no key, and when
 * this file grows a hand-written `<Route>` that would bypass the table
 * entirely. That last guard is what makes the route list a denominator rather
 * than a copy — see the header of `routes.ts`.
 */
export const PAGE_ELEMENTS: Record<string, React.ReactElement> = {
  '/': <DashboardPage />,
  '/dive': <DeepDivePage />,
  '/sweep': <DeepSweepPage />,
  '/routines': <RoutinesPage />,
  '/calendar': <CalendarPage />,
  '/results': <ResultsPage />,
  '/analytics': <AnalyticsPage />,
  '/watchdog': <WatchdogPage />,
  '/explorer': <ExplorerPage />,
  '/configurations': <ConfigurationsPage />,
  '/monitor': <MonitorPage />,
  '/repositories': <RepositoriesPage />,
  '/settings/*': <SettingsPage />,
  '/about-resmon/*': <AboutResmonPage />,
};

const App: React.FC = () => {
  useRendererHeartbeat();
  return (
    <HashRouter>
        <ExecutionProvider>
          <AssistantProvider>
            <div className="app-shell">
              <Sidebar />
              <div className="app-main">
                <Header />
                <MainContent>
                  <Routes>
                    {APP_ROUTES.map((route) => (
                      <Route
                        key={route.path}
                        path={route.path}
                        element={PAGE_ELEMENTS[route.path]}
                      />
                    ))}
                  </Routes>
                </MainContent>
              </div>
              <FloatingWidget />
              {/* A second fixed element beside the widget, never in the layout
                  flow: the panel must not move the page when it opens, and
                  `e2e/assistant.spec.ts` asserts the main content's bounding box
                  before and after on every route. */}
              <AssistantPanel />
            </div>
          </AssistantProvider>
        </ExecutionProvider>
    </HashRouter>
  );
};

export default App;
