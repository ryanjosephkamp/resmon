/**
 * The OS-facing guards: every native call `main.ts` can make, replaced with a
 * counter before a spec touches the app.
 *
 * Extracted from `ipc-stubs.spec.ts` in phase 1.8.7 so more than one spec can
 * install them. The reasoning is unchanged and is worth restating, because it
 * is what makes "no native dialog opened" a **measurement** rather than an
 * inference: `electronApp.evaluate()` runs in the main process with the
 * `electron` module in scope, so assigning over `dialog.showOpenDialog` and
 * friends *replaces* them — the real call is never reached, and a counter says
 * whether anything tried.
 *
 * The five are the complete set, taken from
 * `grep -n 'dialog\.\|shell\.' electron/main.ts`: `dialog.showOpenDialog`,
 * `dialog.showMessageBox` (the auto-updater's prompt), `shell.openExternal`,
 * `shell.openPath` and `shell.showItemInFolder`. When `main.ts` grows a sixth,
 * `main-window.spec.ts` fails: it re-derives the list from the file.
 */
import type { ElectronApplication } from '@playwright/test';

export interface Escaped {
  showOpenDialog: number;
  showMessageBox: number;
  openExternal: number;
  openPath: number;
  showItemInFolder: number;
}

export interface Stubbed {
  chooseDirectory: number;
  openPath: number;
  revealPath: number;
}

export interface GuardCounts {
  stubbed: Stubbed;
  escaped: Escaped;
  lastArgs: Record<string, unknown>;
}

/** Nothing reached the operating system. */
export const NOTHING_ESCAPED: Escaped = {
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
export async function installIpcGuards(app: ElectronApplication): Promise<void> {
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

export async function readGuards(app: ElectronApplication): Promise<GuardCounts> {
  return app.evaluate(async () => (globalThis as unknown as { __e2e: GuardCounts }).__e2e);
}

