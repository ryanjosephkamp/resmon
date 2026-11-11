/**
 * Each window's downloads (`electron/downloads.ts`), against a stand-in for
 * Electron's `ipcMain` and a shared session: a second window gets its own
 * downloads rather than an error, and the controls answer the window that asks
 * about its own downloads and no other's.
 */
import { EventEmitter } from 'events';

type Handler = (event: { sender: unknown; senderFrame: unknown }, ...args: unknown[]) => unknown;
const handlers = new Map<string, Handler>();
const revealed: string[] = [];

jest.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, handler: Handler) => {
      if (handlers.has(channel)) throw new Error(`Attempted to register a second handler for '${channel}'`);
      handlers.set(channel, handler);
    },
  },
  shell: { showItemInFolder: (path: string) => { revealed.push(path); } },
  BrowserWindow: class {},
}));

// Imported after the mock, so it registers with the stand-in.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { installDownloads } = require('../electron/downloads') as typeof import('../electron/downloads');

/** One session, as every window of the app shares the default one. */
const session = new EventEmitter();

function fakeWindow() {
  const window = new EventEmitter() as EventEmitter & { webContents: { mainFrame: object } & Record<string, unknown> };
  const sent: unknown[] = [];
  window.webContents = {
    mainFrame: {},
    session,
    isDestroyed: () => false,
    send: (_channel: string, records: unknown) => sent.push(records),
  };
  return { window, sent };
}

function fakeDownload(name: string, savePath: string) {
  const item = new EventEmitter() as EventEmitter & Record<string, unknown>;
  Object.assign(item, {
    getFilename: () => name,
    getTotalBytes: () => 10,
    getReceivedBytes: () => 10,
    getSavePath: () => savePath,
  });
  return item;
}

const ask = (window: { webContents: { mainFrame: unknown } }, frame: unknown = window.webContents.mainFrame) =>
  ({ sender: window.webContents, senderFrame: frame });

test('two windows: no error for the second, each lists and reveals only its own downloads', () => {
  const first = fakeWindow();
  const second = fakeWindow();
  installDownloads(first.window as never);
  expect(() => installDownloads(second.window as never)).not.toThrow();

  const item = fakeDownload('answer.zip', '/tmp/answer.zip');
  session.emit('will-download', {}, item, second.window.webContents);
  item.emit('done', {}, 'completed');

  const list = handlers.get('resmon:downloads')!;
  expect(list(ask(first.window))).toEqual([]);
  expect(list(ask(second.window))).toEqual([
    { id: '1', filename: 'answer.zip', state: 'completed', path: '/tmp/answer.zip', receivedBytes: 10, totalBytes: 10 },
  ]);
  // Told to the window whose download it is, as it started and as it finished.
  expect(second.sent).toHaveLength(2);
  expect(first.sent).toHaveLength(0);

  const reveal = handlers.get('resmon:reveal-download')!;
  expect(() => reveal(ask(first.window), '1')).toThrow('Select a completed download');
  expect(reveal(ask(second.window), '1')).toBe(true);
  expect(revealed).toEqual(['/tmp/answer.zip']);
});

test('a frame inside a window, and a window without downloads, are refused', () => {
  const window = fakeWindow();
  installDownloads(window.window as never);
  const list = handlers.get('resmon:downloads')!;
  expect(() => list(ask(window.window, {}))).toThrow('only in resmon’s own windows');
  const stranger = { webContents: { mainFrame: {} } };
  expect(() => list(ask(stranger))).toThrow('only in resmon’s own windows');
});

test('a closed window\'s downloads go with it, and it hears of no more', () => {
  const window = fakeWindow();
  installDownloads(window.window as never);
  const before = session.listenerCount('will-download');
  window.window.emit('closed');
  expect(session.listenerCount('will-download')).toBe(before - 1);
  expect(() => handlers.get('resmon:downloads')!(ask(window.window))).toThrow('only in resmon’s own windows');
});
