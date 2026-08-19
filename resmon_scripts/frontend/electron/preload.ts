import { contextBridge, ipcRenderer } from 'electron';

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
  platform: process.platform,
  versions: {
    node: process.versions.node,
    electron: process.versions.electron,
  },
  chooseDirectory: (defaultPath?: string): Promise<string | null> =>
    ipcRenderer.invoke('resmon:choose-directory', defaultPath),
  openPath: (targetPath: string): Promise<string> =>
    ipcRenderer.invoke('resmon:open-path', targetPath),
  revealPath: (targetPath: string): Promise<boolean> =>
    ipcRenderer.invoke('resmon:reveal-path', targetPath),
});
