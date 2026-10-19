/**
 * The renderer never guesses which backend it is talking to.
 *
 * `getBaseUrl()` used to read
 *
 *     const port = window.resmonAPI?.getBackendPort() || '8742';
 *
 * so any falsy answer — no preload at all, an empty string, a zero — addressed
 * every request in the app at port 8742. On a machine that runs the background
 * daemon that port is a *different* resmon, over a different database, while
 * this app's own backend sits on an ephemeral port chosen at launch. The app
 * would then be reading and writing somebody else's corpus with no sign on
 * screen that it had changed instance.
 *
 * This is the second time the same shape has been written in this project. The
 * MCP server once fell through to the default port when a named port stopped
 * answering, attached itself to the daemon, and answered every question
 * truthfully about the wrong corpus — which is why its port resolution now
 * reports the instance as unavailable instead. The lesson did not reach the
 * renderer, so these cases pin it here: an absent port is an error state, not a
 * value to invent.
 *
 * What is *not* banned is the number 8742 itself. A user may legitimately be
 * attached to the background daemon, in which case the main process reports
 * 8742 and the renderer must talk to it. The defect is guessing, not the port,
 * and the last case below is what keeps the fix from quietly removing the
 * attach-to-the-daemon journey.
 */

import * as fs from 'fs';
import * as path from 'path';

import { backendFetch, getBaseUrl } from '../api/client';
import { fetchConnection } from '../api/connection';

/** The daemon's port, written out so a search for it reaches this file too. */
const DAEMON_PORT = '8742';

type Api = NonNullable<Window['resmonAPI']>;

function announce(port: unknown): void {
  (window as unknown as { resmonAPI: Api }).resmonAPI = {
    getBackendPort: () => port as string,
    platform: 'test',
    versions: { node: 'test', electron: 'test' },
  };
}

beforeEach(() => {
  delete (window as { resmonAPI?: unknown }).resmonAPI;
  global.fetch = jest.fn();
});

afterEach(() => {
  jest.restoreAllMocks();
});

describe('getBaseUrl', () => {
  it('refuses to name a backend when no preload answered at all', () => {
    expect(() => getBaseUrl()).toThrow(/backend/i);
  });

  // Every falsy thing `getBackendPort()` can hand back, plus the malformed
  // answers that are not falsy and would have sailed through the old `||`.
  it.each([
    ['empty string', ''],
    ['undefined', undefined],
    ['null', null],
    ['number zero', 0],
    ['string zero', '0'],
    ['not a number', 'eight-seven-four-two'],
    ['above the port range', '65536'],
    ['leading space', ' 8080'],
    ['negative', '-1'],
  ])('refuses a port reported as %s', (_label, port) => {
    announce(port);
    expect(() => getBaseUrl()).toThrow(/backend/i);
  });

  it('never produces a URL addressed at the daemon port when the port is missing', () => {
    for (const port of ['', undefined, null, 0]) {
      announce(port);
      let produced: string | null = null;
      try {
        produced = getBaseUrl();
      } catch {
        produced = null;
      }
      expect(produced).toBeNull();
    }
  });

  it('uses the port the main process actually reported', () => {
    announce('51234');
    expect(getBaseUrl()).toBe('http://127.0.0.1:51234');
  });

  it('still addresses the daemon when the main process genuinely attached to it', () => {
    // Attach-or-spawn: when Electron attaches to the background daemon, 8742 is
    // the truthful answer and the renderer must use it. Refusing the number
    // outright here would delete that journey.
    announce(DAEMON_PORT);
    expect(getBaseUrl()).toBe(`http://127.0.0.1:${DAEMON_PORT}`);
  });
});

describe('the request helpers', () => {
  it('backendFetch refuses before it reaches the network', async () => {
    announce('');
    await expect(backendFetch('/api/health')).rejects.toThrow(/backend/i);
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('a missing port lands in the existing offline channel, not a new one', async () => {
    // `useConnectionIdentity` turns any rejection from `fetchConnection` into
    // the header's `offline` state ("Running app unavailable"). A throw from
    // `getBaseUrl()` therefore shows up where a refused connection already
    // does, rather than inventing a second error surface.
    announce(undefined);
    await expect(fetchConnection()).rejects.toThrow();
    expect(global.fetch).not.toHaveBeenCalled();
  });
});

describe('the Electron side does not guess either', () => {
  // `getBaseUrl()` is the last link in the chain, not the only one. The preload
  // invents a connection when the main process does not answer its IPC, and the
  // main process holds a module-level `backendPort` that is read by that IPC
  // handler. A default in either place puts the guess back with the renderer
  // none the wiser, so neither file may name the port at all.
  const files = ['preload.ts', 'main.ts'];

  it.each(files)('electron/%s names no default backend port', name => {
    const source = fs.readFileSync(
      path.join(__dirname, '..', '..', 'electron', name),
      'utf8',
    );
    expect(source).not.toContain(DAEMON_PORT);
  });
});
