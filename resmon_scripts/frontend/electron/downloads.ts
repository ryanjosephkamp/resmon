import { BrowserWindow, ipcMain, shell } from 'electron';

export interface DownloadRecord {
  id: string;
  filename: string;
  state: 'progressing' | 'completed' | 'cancelled' | 'interrupted';
  path: string;
  receivedBytes: number;
  totalBytes: number;
}

/** Completion comes from Electron's DownloadItem, never the renderer's click. */
export function installDownloads(window: BrowserWindow): void {
  const records = new Map<string, DownloadRecord>();
  let sequence = 0;
  const list = () => Array.from(records.values()).reverse();
  const publish = () => {
    if (!window.webContents.isDestroyed()) window.webContents.send('resmon:downloads-changed', list());
  };
  const checkSender = (event: Electron.IpcMainInvokeEvent) => {
    if (event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame) {
      throw new Error('Download controls are available only in the main app window.');
    }
  };
  ipcMain.handle('resmon:downloads', event => { checkSender(event); return list(); });
  ipcMain.handle('resmon:reveal-download', (event, id: unknown) => {
    checkSender(event);
    const record = typeof id === 'string' ? records.get(id) : undefined;
    if (!record || record.state !== 'completed' || !record.path) {
      throw new Error('Select a completed download from this app session.');
    }
    // Accept a main-owned download ID, never a renderer-supplied filesystem path.
    shell.showItemInFolder(record.path);
    return true;
  });
  window.webContents.session.on('will-download', (_event, item, contents) => {
    if (contents !== window.webContents) return;
    const id = String(++sequence);
    const record: DownloadRecord = { id, filename: item.getFilename(), state: 'progressing', path: '', receivedBytes: 0, totalBytes: item.getTotalBytes() };
    records.set(id, record);
    // Session-only history is bounded. Pending downloads keep their own closures.
    if (records.size > 20) records.delete(records.keys().next().value as string);
    publish();
    item.once('done', (_done, state) => {
      record.state = state;
      record.receivedBytes = item.getReceivedBytes();
      record.totalBytes = item.getTotalBytes();
      record.path = state === 'completed' ? item.getSavePath() : '';
      publish();
    });
  });
}
