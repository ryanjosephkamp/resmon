/**
 * The OS-facing guards: every native call `main.ts` can make, replaced with a
 * counter before a spec touches the app.
 *
 * Shared by `ipc-stubs.spec.ts` and every other spec that installs them. The
 * reasoning is worth stating, because it is what makes "no native dialog
 * opened" a **measurement** rather than an inference: `electronApp.evaluate()`
 * runs in the main process with the `electron` module in scope, so assigning
 * over `dialog.showOpenDialog` and friends *replaces* them — the real call is
 * never reached, and a counter says whether anything tried.
 *
 * The six are the complete set, taken from
 * `grep -n 'dialog\.\|shell\.' electron/main.ts`: `dialog.showOpenDialog`,
 * `dialog.showMessageBox` (the auto-updater's prompt), `shell.openExternal`,
 * `shell.openPath`, `shell.showItemInFolder` and `shell.trashItem` (a file the
 * Library holds as removed, sent to the Trash). When `main.ts` grows a seventh,
 * `main-window.spec.ts` fails: it re-derives the list from the file.
 */
import type { ElectronApplication } from '@playwright/test';

export interface Escaped {
  showOpenDialog: number;
  showMessageBox: number;
  openExternal: number;
  openPath: number;
  showItemInFolder: number;
  trashItem: number;
}

export interface Stubbed {
  chooseDirectory: number;
  chooseFile: number;
  openPath: number;
  revealPath: number;
  getDownloads: number;
  revealDownload: number;
  relaunch: number;
  swipeNavigation: number;
  swipeHistory: number;
  trashPath: number;
  defaultBrowser: number;
}

/**
 * The IPC channels the preload bridge exposes, and therefore the complete set a
 * guard has to replace. Checked against `electron/preload.ts` by
 * `ipc-stubs.spec.ts`, not counted by hand, so the set is a denominator rather
 * than a hand count.
 */
export const STUBBED_CHANNELS: Record<keyof Stubbed, string> = {
  chooseDirectory: 'resmon:choose-directory',
  chooseFile: 'resmon:choose-file',
  openPath: 'resmon:open-path',
  revealPath: 'resmon:reveal-path',
  getDownloads: 'resmon:downloads',
  revealDownload: 'resmon:reveal-download',
  relaunch: 'resmon:relaunch',
  swipeNavigation: 'resmon:swipe-navigation',
  swipeHistory: 'resmon:swipe-history',
  trashPath: 'resmon:trash-path',
  defaultBrowser: 'resmon:default-browser',
};

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
  trashItem: 0,
};

/**
 * Replace the preload IPC handlers with counting stubs, and put a counter on
 * every OS-facing call underneath them.
 */
export async function installIpcGuards(app: ElectronApplication): Promise<void> {
  await app.evaluate(({ ipcMain, dialog, shell }) => {
    const counts = {
      stubbed: { chooseDirectory: 0, chooseFile: 0, openPath: 0, revealPath: 0, getDownloads: 0, revealDownload: 0, relaunch: 0, swipeNavigation: 0, swipeHistory: 0, trashPath: 0, defaultBrowser: 0 },
      escaped: {
        showOpenDialog: 0,
        showMessageBox: 0,
        openExternal: 0,
        openPath: 0,
        showItemInFolder: 0,
        trashItem: 0,
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

    shell.trashItem = (async (p: string) => {
      counts.escaped.trashItem += 1;
      counts.lastArgs.trashItem = p;
    }) as unknown as typeof shell.trashItem;

    ipcMain.removeHandler('resmon:choose-directory');
    ipcMain.handle('resmon:choose-directory', async (_e, defaultPath?: string) => {
      counts.stubbed.chooseDirectory += 1;
      counts.lastArgs.chooseDirectory = defaultPath ?? null;
      return '/tmp/e2e-chosen-directory';
    });

    ipcMain.removeHandler('resmon:choose-file');
    ipcMain.handle('resmon:choose-file', async (_e, defaultPath?: string) => {
      counts.stubbed.chooseFile += 1;
      counts.lastArgs.chooseFile = defaultPath ?? null;
      return '/tmp/e2e-chosen-file';
    });

    ipcMain.removeHandler('resmon:open-path');
    ipcMain.handle('resmon:open-path', async (_e, target: string) => {
      counts.stubbed.openPath += 1;
      counts.lastArgs.openPathTarget = target;
      return '';
    });

    ipcMain.removeHandler('resmon:downloads');
    ipcMain.handle('resmon:downloads', async () => {
      counts.stubbed.getDownloads += 1;
      return [];
    });
    ipcMain.removeHandler('resmon:reveal-download');
    ipcMain.handle('resmon:reveal-download', async (_e, id: string) => {
      counts.stubbed.revealDownload += 1;
      counts.lastArgs.revealDownloadId = id;
      return true;
    });

    ipcMain.removeHandler('resmon:reveal-path');
    ipcMain.handle('resmon:reveal-path', async (_e, target: string) => {
      counts.stubbed.revealPath += 1;
      counts.lastArgs.revealPathTarget = target;
      return true;
    });

    // Quitting and opening again would end the run: counted, never done.
    ipcMain.removeHandler('resmon:relaunch');
    ipcMain.handle('resmon:relaunch', async () => {
      counts.stubbed.relaunch += 1;
      return false;
    });

    // The two-finger swipe reads a system setting and moves the history: off
    // here, and counted, so a stray wheel event cannot navigate a guarded run.
    ipcMain.removeHandler('resmon:swipe-navigation');
    ipcMain.handle('resmon:swipe-navigation', async () => {
      counts.stubbed.swipeNavigation += 1;
      return false;
    });
    // Sending a file to the Trash is counted and refused, never done.
    ipcMain.removeHandler('resmon:trash-path');
    ipcMain.handle('resmon:trash-path', async (_e, target: string) => {
      counts.stubbed.trashPath += 1;
      counts.lastArgs.trashPathTarget = target;
      return 'Stubbed in this run: nothing was moved to the Trash.';
    });
    // The default browser's name is read from the system: counted, and answered as unknown.
    ipcMain.removeHandler('resmon:default-browser');
    ipcMain.handle('resmon:default-browser', async () => {
      counts.stubbed.defaultBrowser += 1;
      return null;
    });
    ipcMain.removeHandler('resmon:swipe-history');
    ipcMain.handle('resmon:swipe-history', async (_e, direction: unknown) => {
      counts.stubbed.swipeHistory += 1;
      counts.lastArgs.swipeHistory = direction;
      return false;
    });
  });
}

export async function readGuards(app: ElectronApplication): Promise<GuardCounts> {
  return app.evaluate(async () => (globalThis as unknown as { __e2e: GuardCounts }).__e2e);
}

