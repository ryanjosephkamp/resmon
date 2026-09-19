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

function askBackendConnection(): BackendConnection {
  const answer = ipcRenderer.sendSync('resmon:backend-connection') as BackendConnection | null;
  return answer && typeof answer.port === 'string' ? answer : { port: '8742', token: null };
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
});
