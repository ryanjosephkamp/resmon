import { HashRouter, Navigate, Route, Routes } from 'react-router-dom';
import { DETAILS, SECTIONS, SETTINGS } from './routes';
import { AskProvider } from './screens/ask/AskProvider';
import { DraftsProvider } from './shell/drafts';
import { Shell } from './shell/Shell';
import { useTopBar } from './shell/useTopBar';
import { WindowFrame } from './shell/WindowFrame';

/**
 * Hash routes, because the renderer is a set of static files served from a
 * loopback port: a path route would ask that server for a file that is not
 * there on every reload.
 *
 * The assistant's state sits above the routes, because a turn outlives the
 * screen it was asked from (see `AskProvider`), and so do forms not yet sent,
 * so Back finds one as it was left (see `DraftsProvider`).
 *
 * Each window of the app is its own document with its own router, so its page
 * and its Back and Forward are its own; `WindowFrame` names the window by its
 * page and leaves room for macOS's tab bar. A window opened at no page, as a
 * launch and ⌘N open one, goes to the start page the person chose.
 */
export function App() {
  return (
    <HashRouter>
      <WindowFrame />
      <AskProvider>
        <DraftsProvider>
          <Routes>
            <Route element={<Shell />}>
              {[...SECTIONS, SETTINGS, ...DETAILS].map((screen) => (
                <Route key={screen.path} path={screen.path} element={screen.element} />
              ))}
              <Route path="*" element={<StartPage />} />
            </Route>
          </Routes>
        </DraftsProvider>
      </AskProvider>
    </HashRouter>
  );
}

/** An address with no screen, the empty one a new window opens at included: the start page (Settings › Top bar). */
function StartPage() {
  const { arranged } = useTopBar();
  return <Navigate to={arranged.start} replace />;
}
