import { HashRouter, Navigate, Route, Routes } from 'react-router-dom';
import { DETAILS, HOME, SECTIONS, SETTINGS } from './routes';
import { AskProvider } from './screens/ask/AskProvider';
import { Shell } from './shell/Shell';

/**
 * Hash routes, because the renderer is a set of static files served from a
 * loopback port: a path route would ask that server for a file that is not
 * there on every reload.
 *
 * The assistant's state sits above the routes, because a turn outlives the
 * screen it was asked from (see `AskProvider`).
 */
export function App() {
  return (
    <HashRouter>
      <AskProvider>
        <Routes>
          <Route element={<Shell />}>
            {[...SECTIONS, SETTINGS, ...DETAILS].map((screen) => (
              <Route key={screen.path} path={screen.path} element={screen.element} />
            ))}
            <Route path="*" element={<Navigate to={HOME} replace />} />
          </Route>
        </Routes>
      </AskProvider>
    </HashRouter>
  );
}
