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
  // Cloud account (IMPL-30). Access tokens live only in renderer memory —
  // the refresh token is stored via the keyring bridge in Electron main.
  cloudAuth: {
    signIn: (): Promise<{ access_token: string; email: string; expires_in: number }> =>
      ipcRenderer.invoke('resmon:cloud-sign-in'),
    signOut: (): Promise<{ signed_in: false }> =>
      ipcRenderer.invoke('resmon:cloud-sign-out'),
    refresh: (): Promise<{ access_token: string; expires_in: number }> =>
      ipcRenderer.invoke('resmon:cloud-refresh'),
    status: (): Promise<{ signed_in: boolean; email: string; sync_state: string }> =>
      ipcRenderer.invoke('resmon:cloud-status'),
    setSync: (enabled: boolean): Promise<{ sync_state: string }> =>
      ipcRenderer.invoke('resmon:cloud-sync-toggle', enabled),
  },
});
