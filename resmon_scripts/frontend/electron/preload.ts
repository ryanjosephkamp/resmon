import { contextBridge, ipcRenderer } from 'electron';
import type { DownloadRecord } from './downloads';

/**
 * The backend's port and local API token, asked of the main process once.
 *
 * The port used to arrive as a `--backend-port=` argument, and the token cannot
 * travel that way: `additionalArguments` become the renderer process's argv,
 * which every user on the machine can read with `ps`. A synchronous IPC keeps
 * `getBackendPort()` synchronous for the renderer, which reads it during the
 * first render. The main process answers only this window's top frame.
 */
interface BackendConnection { port: string; token: string | null }

/**
 * The empty port is deliberate, and it used to be the daemon's default port.
 *
 * The main process does not answer this IPC to any frame but the renderer's
 * own, and it has no answer to give before the backend is up. Naming that
 * default in either case pointed the whole renderer at whatever process
 * happened to hold it — another resmon, over another corpus. An empty port is
 * the honest answer to "which backend?" when nobody said, and `getBaseUrl()` in
 * the renderer refuses it rather than inventing one.
 */
function askBackendConnection(): BackendConnection {
  const answer = ipcRenderer.sendSync('resmon:backend-connection') as BackendConnection | null;
  return answer && typeof answer.port === 'string' ? answer : { port: '', token: null };
}

const connection = askBackendConnection();

contextBridge.exposeInMainWorld('resmonAPI', {
  getBackendPort: (): string => connection.port,
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
  // Quit and open again; resolves false where the main process refuses (the
  // service, or a frame that is not the renderer's own).
  relaunch: (): Promise<boolean> => ipcRenderer.invoke('resmon:relaunch'),
  // The app menu's commands for the Atlas renderer: New Deep Dive and the rest.
  onCommand: (callback: (command: string) => void): (() => void) => {
    const listener = (_event: Electron.IpcRendererEvent, command: string) => callback(command);
    ipcRenderer.on('resmon:command', listener);
    return () => { ipcRenderer.removeListener('resmon:command', listener); };
  },
});
