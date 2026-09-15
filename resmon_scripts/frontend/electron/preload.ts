import { contextBridge, ipcRenderer } from 'electron';
import type { DownloadRecord } from './downloads';

function extractBackendPort(): string {
  for (const arg of process.argv) {
    if (arg.startsWith('--backend-port=')) {
      return arg.split('=')[1];
    }
  }
  return '8742';
}

const backendPort = extractBackendPort();

contextBridge.exposeInMainWorld('resmonAPI', {
  getBackendPort: (): string => backendPort,
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
