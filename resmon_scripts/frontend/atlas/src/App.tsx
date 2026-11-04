import { HashRouter, Navigate, Route, Routes } from 'react-router-dom';
import { DETAILS, HOME, SECTIONS, SETTINGS } from './routes';
import { AskProvider } from './screens/ask/AskProvider';
import { DraftsProvider } from './shell/drafts';
import { Shell } from './shell/Shell';

/**
 * Hash routes, because the renderer is a set of static files served from a
 * loopback port: a path route would ask that server for a file that is not
 * there on every reload.
 *
 * The assistant's state sits above the routes, because a turn outlives the
 * screen it was asked from (see `AskProvider`), and so do forms not yet sent,
 * so Back finds one as it was left (see `DraftsProvider`).
 */
export function App() {
  return (
    <HashRouter>
      <AskProvider>
        <DraftsProvider>
          <Routes>
            <Route element={<Shell />}>
              {[...SECTIONS, SETTINGS, ...DETAILS].map((screen) => (
                <Route key={screen.path} path={screen.path} element={screen.element} />
              ))}
              <Route path="*" element={<Navigate to={HOME} replace />} />
            </Route>
          </Routes>
        </DraftsProvider>
      </AskProvider>
    </HashRouter>
  );
}
