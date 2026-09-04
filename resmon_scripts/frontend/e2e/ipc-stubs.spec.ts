/**
 * Q5 / P4 — can the three IPC channels be stubbed from the main process, so no
 * native dialog opens and no `shell` call escapes?
 *
 * All three of `resmon:choose-directory`, `resmon:open-path` and
 * `resmon:reveal-path` end in something the operating system does: a modal
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
import type { ElectronApplication } from '@playwright/test';
import { ROUTES } from './routes';

test.describe.configure({ mode: 'serial' });

interface Escaped {
  showOpenDialog: number;
  showMessageBox: number;
  openExternal: number;
  openPath: number;
  showItemInFolder: number;
}

interface Stubbed {
  chooseDirectory: number;
  openPath: number;
  revealPath: number;
}

interface GuardCounts {
  stubbed: Stubbed;
  escaped: Escaped;
  lastArgs: Record<string, unknown>;
}

/** Nothing reached the operating system. */
const NOTHING_ESCAPED: Escaped = {
  showOpenDialog: 0,
  showMessageBox: 0,
  openExternal: 0,
  openPath: 0,
  showItemInFolder: 0,
};

/**
 * Replace the three IPC handlers with counting stubs, and put a counter on
 * every OS-facing call underneath them.
 */
async function installIpcGuards(app: ElectronApplication): Promise<void> {
  await app.evaluate(({ ipcMain, dialog, shell }) => {
    const counts = {
      stubbed: { chooseDirectory: 0, openPath: 0, revealPath: 0 },
      escaped: {
        showOpenDialog: 0,
        showMessageBox: 0,
        openExternal: 0,
        openPath: 0,
        showItemInFolder: 0,
      },
      lastArgs: {} as Record<string, unknown>,
    };
    (globalThis as unknown as { __e2e: typeof counts }).__e2e = counts;

    // The OS-facing surface first, so a handler that somehow survives
    // replacement is still counted rather than silently opening something.
    dialog.showOpenDialog = (async (...args: unknown[]) => {
      counts.escaped.showOpenDialog += 1;
      counts.lastArgs.showOpenDialog = args;
      return { canceled: true, filePaths: [] };
    }) as unknown as typeof dialog.showOpenDialog;

    dialog.showMessageBox = (async (...args: unknown[]) => {
      counts.escaped.showMessageBox += 1;
      counts.lastArgs.showMessageBox = args;
      return { response: 1, checkboxChecked: false };
    }) as unknown as typeof dialog.showMessageBox;

    shell.openExternal = (async (url: string) => {
      counts.escaped.openExternal += 1;
      counts.lastArgs.openExternal = url;
    }) as unknown as typeof shell.openExternal;

    shell.openPath = (async (p: string) => {
      counts.escaped.openPath += 1;
      counts.lastArgs.openPath = p;
      return '';
    }) as unknown as typeof shell.openPath;

    shell.showItemInFolder = ((p: string) => {
      counts.escaped.showItemInFolder += 1;
      counts.lastArgs.showItemInFolder = p;
    }) as unknown as typeof shell.showItemInFolder;

    ipcMain.removeHandler('resmon:choose-directory');
    ipcMain.handle('resmon:choose-directory', async (_e, defaultPath?: string) => {
      counts.stubbed.chooseDirectory += 1;
      counts.lastArgs.chooseDirectory = defaultPath ?? null;
      return '/tmp/e2e-chosen-directory';
    });

    ipcMain.removeHandler('resmon:open-path');
    ipcMain.handle('resmon:open-path', async (_e, target: string) => {
      counts.stubbed.openPath += 1;
      counts.lastArgs.openPathTarget = target;
      return '';
    });

    ipcMain.removeHandler('resmon:reveal-path');
    ipcMain.handle('resmon:reveal-path', async (_e, target: string) => {
      counts.stubbed.revealPath += 1;
      counts.lastArgs.revealPathTarget = target;
      return true;
    });
  });
}

async function readGuards(app: ElectronApplication): Promise<GuardCounts> {
  return app.evaluate(async () => (globalThis as unknown as { __e2e: GuardCounts }).__e2e);
}

test('Q5: the three IPC channels are stubbed, and nothing reaches the OS', async ({
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
        openPath(p: string): Promise<string>;
        revealPath(p: string): Promise<boolean>;
      };
    }).resmonAPI;
    return {
      chosen: await api.chooseDirectory('/tmp'),
      opened: await api.openPath('/tmp/e2e-nonexistent.md'),
      revealed: await api.revealPath('/tmp/e2e-nonexistent.md'),
    };
  });

  console.log('Q5 IPC RESULTS', JSON.stringify(results));
  expect(results.chosen).toBe('/tmp/e2e-chosen-directory');
  expect(results.opened).toBe('');
  expect(results.revealed).toBe(true);

  const guards = await readGuards(app);
  console.log('Q5 GUARD COUNTS', JSON.stringify(guards));

  // Each stub was reached exactly once …
  expect(guards.stubbed).toEqual({ chooseDirectory: 1, openPath: 1, revealPath: 1 });
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
  expect(guards.stubbed).toEqual({ chooseDirectory: 0, openPath: 0, revealPath: 0 });
  expect(guards.escaped).toEqual(NOTHING_ESCAPED);
});
