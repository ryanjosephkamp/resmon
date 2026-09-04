/**
 * Q5 / P4 — can the IPC channels be stubbed from the main process, so no
 * native dialog opens and no `shell` call escapes?
 *
 * All four of `resmon:choose-directory`, `resmon:choose-file`,
 * `resmon:open-path` and `resmon:reveal-path` end in something the operating
 * system does: a modal
 * folder picker that blocks until a human dismisses it, a document opened in
 * whatever application claims it, a Finder window. Under automation the first
 * hangs the run and the other two are side effects on the machine. A
 * verification layer that cannot neutralise them cannot touch any page with a
 * "Choose folder" or "Reveal in Finder" button — Settings, Results, the Danger
 * Zone.
 *
 * `electronApp.evaluate()` runs in the main process with the `electron` module
 * in scope, so `ipcMain.removeHandler` + `ipcMain.handle` replaces the real
 * handler outright. That is a *replacement*, not an interception: the real
 * `dialog.showOpenDialog` is never reached.
 *
 * Proving that takes more than the stubs returning a value. `installIpcGuards`
 * also replaces every OS-facing call `main.ts` makes with a counter, so "no
 * native dialog opened" is a measurement rather than an inference. The five are
 * `dialog.showOpenDialog`, `dialog.showMessageBox`, `shell.openExternal`,
 * `shell.openPath` and `shell.showItemInFolder` — the complete set, taken from
 * `grep -n 'dialog\.\|shell\.' electron/main.ts`. `showMessageBox` is the
 * auto-updater's "Update ready" prompt and is unreachable in a checkout; it is
 * guarded because the packaged leg of the suite runs the same guards.
 */
import { test, expect } from './fixtures/resmon-app';
import * as fs from 'fs';
import * as path from 'path';
import {
  installIpcGuards, readGuards, NOTHING_ESCAPED, STUBBED_CHANNELS,
} from './fixtures/ipc-guards';
import { FRONTEND_ROOT } from './fixtures/resmon-app';
import { ROUTES } from './routes';

test.describe.configure({ mode: 'serial' });

test('Q5b: the guarded channels are the channels the preload bridge exposes', async () => {
  // The counters are only a measurement while they cover everything. A channel
  // added to `preload.ts` and not to the guards would reach the real handler,
  // open a real dialog, and hang the run — and nothing here would say why.
  const source = fs.readFileSync(path.join(FRONTEND_ROOT, 'electron', 'preload.ts'), 'utf8');
  const exposed = [...source.matchAll(/ipcRenderer\.invoke\('([^']+)'/g)]
    .map((m) => m[1]).sort();
  console.log('Q5b PRELOAD CHANNELS', JSON.stringify(exposed));
  expect(exposed).toEqual(Object.values(STUBBED_CHANNELS).sort());
});

test('Q5: every IPC channel is stubbed, and nothing reaches the OS', async ({
  app, win, goto,
}) => {
  await installIpcGuards(app);
  await goto('/');

  // Call each channel the way the renderer does — through the preload bridge,
  // which is the only route the app itself has.
  const results = await win.evaluate(async () => {
    const api = (window as unknown as {
      resmonAPI: {
        chooseDirectory(d?: string): Promise<string | null>;
        chooseFile(d?: string): Promise<string | null>;
        openPath(p: string): Promise<string>;
        revealPath(p: string): Promise<boolean>;
      };
    }).resmonAPI;
    return {
      chosen: await api.chooseDirectory('/tmp'),
      chosenFile: await api.chooseFile('/tmp/claude'),
      opened: await api.openPath('/tmp/e2e-nonexistent.md'),
      revealed: await api.revealPath('/tmp/e2e-nonexistent.md'),
    };
  });

  console.log('Q5 IPC RESULTS', JSON.stringify(results));
  expect(results.chosen).toBe('/tmp/e2e-chosen-directory');
  expect(results.chosenFile).toBe('/tmp/e2e-chosen-file');
  expect(results.opened).toBe('');
  expect(results.revealed).toBe(true);

  const guards = await readGuards(app);
  console.log('Q5 GUARD COUNTS', JSON.stringify(guards));

  // Each stub was reached exactly once …
  expect(guards.stubbed).toEqual({
    chooseDirectory: 1, chooseFile: 1, openPath: 1, revealPath: 1,
  });
  // … and nothing underneath them was.
  expect(guards.escaped).toEqual(NOTHING_ESCAPED);
});

test('P4: a full pass over every route opens no dialog and makes no shell call', async ({
  app, goto, win,
}) => {
  await installIpcGuards(app);
  for (const route of ROUTES) {
    await goto(route.path);
    await expect(win.locator('.app-main')).toBeVisible();
  }
  const guards = await readGuards(app);
  console.log('P4 GUARD COUNTS AFTER FULL PASS', JSON.stringify(guards));
  expect(guards.stubbed).toEqual({
    chooseDirectory: 0, chooseFile: 0, openPath: 0, revealPath: 0,
  });
  expect(guards.escaped).toEqual(NOTHING_ESCAPED);
});
