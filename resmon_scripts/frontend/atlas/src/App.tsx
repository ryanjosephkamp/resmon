import { HashRouter, Navigate, Route, Routes } from 'react-router-dom';
import { HOME, SECTIONS, SETTINGS } from './routes';
import { Shell } from './shell/Shell';

/**
 * Hash routes, because the renderer is a set of static files served from a
 * loopback port: a path route would ask that server for a file that is not
 * there on every reload.
 */
export function App() {
  return (
    <HashRouter>
      <Routes>
        <Route element={<Shell />}>
          {[...SECTIONS, SETTINGS].map((section) => (
            <Route key={section.path} path={section.path} element={section.element} />
          ))}
          <Route path="*" element={<Navigate to={HOME} replace />} />
        </Route>
      </Routes>
    </HashRouter>
  );
}
