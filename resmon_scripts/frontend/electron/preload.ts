import { contextBridge, ipcRenderer } from 'electron';
import type { DownloadRecord } from './downloads';

/**
 * The backend's port and local API token, asked of the main process once.
 *
 * Neither travels as a command-line argument: `additionalArguments` become the
 * renderer process's argv, which every user on the machine can read with `ps`.
 * A synchronous IPC keeps
 * `getBackendPort()` synchronous for the renderer, which reads it during the
 * first render. The main process answers only this window's top frame.
 */
interface BackendConnection { port: string; token: string | null }

/**
 * The empty port is deliberate: it is never the daemon's default port.
 *
 * The main process does not answer this IPC to any frame but the renderer's
 * own, and it has no answer to give before the backend is up. Naming a default
 * port in either case would point the whole renderer at whatever process
 * happened to hold it — another resmon, over another corpus. An empty port is
 * the honest answer to "which backend?" when nobody said, and `getBaseUrl()` in
 * the renderer refuses it rather than inventing one.
 */
function askBackendConnection(): BackendConnection {
  const answer = ipcRenderer.sendSync('resmon:backend-connection') as BackendConnection | null;
  return answer && typeof answer.port === 'string' ? answer : { port: '', token: null };
}

const connection = askBackendConnection();

/**
 * This window, as the main process describes it: the collection it shows
 * (by id; null until it has one), and how many pixels to leave
 * above the top bar for macOS's tab bar. Asked before the first render, and
 * kept current when the windows go into tabs or out of them.
 */
interface WindowState { collection: string | null; tabStrip: number }

function readWindowState(value: unknown): WindowState {
  const state = value as Partial<WindowState> | null;
  return {
    collection: typeof state?.collection === 'string' ? state.collection : null,
    tabStrip: typeof state?.tabStrip === 'number' && state.tabStrip >= 0 ? state.tabStrip : 0,
  };
}

let windowState = readWindowState(ipcRenderer.sendSync('resmon:window-state'));
const windowStateListeners = new Set<(state: WindowState) => void>();
ipcRenderer.on('resmon:window-state', (_event, value: unknown) => {
  windowState = readWindowState(value);
  for (const listener of windowStateListeners) listener(windowState);
});

/** A message from the main process, heard until the returned function is called. */
function listen(channel: string, callback: () => void): () => void {
  const listener = () => callback();
  ipcRenderer.on(channel, listener);
  return () => { ipcRenderer.removeListener(channel, listener); };
}

contextBridge.exposeInMainWorld('resmonAPI', {
  getBackendPort: (): string => connection.port,
  /** Show another collection in this window, by id; the main process then sends the window's state again. */
  setWindowCollection: (collection: string | null): void => {
    ipcRenderer.send('resmon:window-collection', collection);
  },
  getApiToken: (): string | null => connection.token,
  getDownloads: (): Promise<DownloadRecord[]> => ipcRenderer.invoke('resmon:downloads'),
  revealDownload: (id: string): Promise<boolean> => ipcRenderer.invoke('resmon:reveal-download', id),
  onDownloadsChanged: (callback: (records: DownloadRecord[]) => void): (() => void) => {
    const listener = (_event: Electron.IpcRendererEvent, records: DownloadRecord[]) => callback(records);
    ipcRenderer.on('resmon:downloads-changed', listener);
    return () => { ipcRenderer.removeListener('resmon:downloads-changed', listener); };
  },
  platform: process.platform,
  versions: {
    node: process.versions.node,
    electron: process.versions.electron,
  },
  chooseDirectory: (defaultPath?: string): Promise<string | null> =>
    ipcRenderer.invoke('resmon:choose-directory', defaultPath),
  chooseFile: (defaultPath?: string): Promise<string | null> =>
    ipcRenderer.invoke('resmon:choose-file', defaultPath),
  openPath: (targetPath: string): Promise<string> =>
    ipcRenderer.invoke('resmon:open-path', targetPath),
  revealPath: (targetPath: string): Promise<boolean> =>
    ipcRenderer.invoke('resmon:reveal-path', targetPath),
  trashPath: (targetPath: string): Promise<string> =>
    ipcRenderer.invoke('resmon:trash-path', targetPath),
  // Quit and open again; resolves false where the main process refuses (the
  // service, or a frame that is not the renderer's own).
  relaunch: (): Promise<boolean> => ipcRenderer.invoke('resmon:relaunch'),
  // The app menu's commands for the Atlas renderer: New Deep Dive and the rest.
  onCommand: (callback: (command: string) => void): (() => void) => {
    const listener = (_event: Electron.IpcRendererEvent, command: string) => callback(command);
    ipcRenderer.on('resmon:command', listener);
    return () => { ipcRenderer.removeListener('resmon:command', listener); };
  },
  // Two-finger swipe: whether the system lets two fingers swipe between pages,
  // and the move, which the main process makes.
  swipeNavigation: (): Promise<boolean> => ipcRenderer.invoke('resmon:swipe-navigation'),
  swipeHistory: (direction: 'back' | 'forward'): Promise<boolean> => ipcRenderer.invoke('resmon:swipe-history', direction),
  // The windows: this one's state, another window (or, on macOS, tab) at a
  // page of the app, and the run this window started, which its notification
  // then shows here.
  windowState: (): WindowState => windowState,
  onWindowState: (callback: (state: WindowState) => void): (() => void) => {
    windowStateListeners.add(callback);
    return () => { windowStateListeners.delete(callback); };
  },
  openWindow: (route: string | null, tab = false): void => ipcRenderer.send('resmon:open-window', route, tab),
  setThemeSource: (theme: 'system' | 'light' | 'dark'): void => ipcRenderer.send('resmon:theme-source', theme),
  runStarted: (executionId: number): void => ipcRenderer.send('resmon:run-started', executionId),
  runQueued: (what: { ticket?: string; routineId?: number }): void => ipcRenderer.send('resmon:run-queued', what),
  // The runs going now, or how the app looks, changed here or in another window
  // (`electron/windows.ts`, `relayToOtherWindows`).
  runsChanged: (): void => ipcRenderer.send('resmon:runs-changed'),
  onRunsChanged: (callback: () => void): (() => void) => listen('resmon:runs-changed', callback),
  appearanceChanged: (): void => ipcRenderer.send('resmon:appearance-changed'),
  onAppearanceChanged: (callback: () => void): (() => void) => listen('resmon:appearance-changed', callback),
});
