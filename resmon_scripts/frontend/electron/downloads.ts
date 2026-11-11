import { BrowserWindow, ipcMain, shell } from 'electron';

export interface DownloadRecord {
  id: string;
  filename: string;
  state: 'progressing' | 'completed' | 'cancelled' | 'interrupted';
  path: string;
  receivedBytes: number;
  totalBytes: number;
}

/** One window's downloads, newest last, while the window is open. */
interface Ledger {
  records: Map<string, DownloadRecord>;
  list(): DownloadRecord[];
}

/**
 * Each window's ledger, by the web contents that shows it. A window lists and
 * reveals only its own downloads: the controls answer the window that asks.
 */
const ledgers = new Map<Electron.WebContents, Ledger>();

/** The asking window's ledger; only a window's own top frame is answered. */
function ledgerFor(event: Electron.IpcMainInvokeEvent): Ledger {
  const ledger = ledgers.get(event.sender);
  if (!ledger || event.senderFrame !== event.sender.mainFrame) {
    throw new Error('Download controls are available only in resmon’s own windows.');
  }
  return ledger;
}

let controlsInstalled = false;

/**
 * The download controls, installed once for every window, with the first:
 * Electron throws when a channel is registered twice, so a window cannot
 * register its own.
 */
function installDownloadControls(): void {
  if (controlsInstalled) return;
  controlsInstalled = true;
  ipcMain.handle('resmon:downloads', (event) => ledgerFor(event).list());
  ipcMain.handle('resmon:reveal-download', (event, id: unknown) => {
    const ledger = ledgerFor(event);
    const record = typeof id === 'string' ? ledger.records.get(id) : undefined;
    if (!record || record.state !== 'completed' || !record.path) {
      throw new Error('Select a completed download from this app session.');
    }
    // Accept a main-owned download ID, never a renderer-supplied filesystem path.
    shell.showItemInFolder(record.path);
    return true;
  });
}

/** Completion comes from Electron's DownloadItem, never the renderer's click. */
export function installDownloads(window: BrowserWindow): void {
  installDownloadControls();
  const contents = window.webContents;
  const records = new Map<string, DownloadRecord>();
  let sequence = 0;
  const ledger: Ledger = { records, list: () => Array.from(records.values()).reverse() };
  ledgers.set(contents, ledger);
  const publish = () => {
    if (!contents.isDestroyed()) contents.send('resmon:downloads-changed', ledger.list());
  };
  const onWillDownload = (_event: Electron.Event, item: Electron.DownloadItem, from: Electron.WebContents) => {
    // Every window shares the default session, so each sees every download and keeps its own.
    if (from !== contents) return;
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
  };
  const session = contents.session;
  session.on('will-download', onWillDownload);
  // A window's downloads go with it; the service opens and closes windows in one process.
  window.once('closed', () => {
    ledgers.delete(contents);
    session.removeListener('will-download', onWillDownload);
  });
}
