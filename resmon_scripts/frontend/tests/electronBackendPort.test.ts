/**
 * The Electron side never guesses which backend the window talks to.
 *
 * The preload asks the main process for the connection over IPC, and the main
 * process holds the port the backend it attached to or spawned reported. A
 * default port in either file, the daemon's 8742 above all, would put a guess
 * back with the renderer none the wiser, so neither file may name it.
 */
import * as fs from 'fs';
import * as path from 'path';

/** The daemon's port, written out so a search for it reaches this file too. */
const DAEMON_PORT = '8742';

it.each(['preload.ts', 'main.ts'])('electron/%s names no default backend port', (name) => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'electron', name), 'utf8');
  expect(source).not.toContain(DAEMON_PORT);
});
