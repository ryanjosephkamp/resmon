/**
 * Every process the main process starts is started the way a packaged app needs.
 *
 * `main.ts` cannot be loaded without Electron, so these read its source, as
 * `electronBackendPort.test.ts` does.
 *
 * - Windows opens a console window for a console program started by a process
 *   that has none, unless the spawn says `windowsHide`. The engine is started in
 *   two places (a window's engine, and the service's), and the command line
 *   installer runs `reg` and `powershell` the same way.
 * - A packaged interpreter must not write bytecode into the app: that edits the
 *   bundle, and breaks its signature once it is signed.
 */
import * as fs from 'fs';
import * as path from 'path';

const read = (name: string) => fs.readFileSync(path.join(__dirname, '..', 'electron', name), 'utf8');

/** The text of each call to `fn(`, up to the matching close of its argument list. */
function calls(source: string, fn: string): string[] {
  const found: string[] = [];
  const pattern = new RegExp(`(?<![\\w.])${fn}\\(`, 'g');
  for (let match = pattern.exec(source); match; match = pattern.exec(source)) {
    let depth = 0;
    let end = match.index + match[0].length - 1;
    for (; end < source.length; end += 1) {
      if (source[end] === '(') depth += 1;
      if (source[end] === ')' && --depth === 0) break;
    }
    found.push(source.slice(match.index, end + 1));
  }
  return found;
}

describe('the main process', () => {
  const main = read('main.ts');

  it('spawns the engine twice, each without a console window', () => {
    const spawns = calls(main, 'spawn');
    expect(spawns).toHaveLength(2);
    for (const call of spawns) expect(call).toContain('windowsHide: true');
  });

  it('writes no bytecode from either packaged engine', () => {
    expect(main.match(/PYTHONDONTWRITEBYTECODE = '1'/g)).toHaveLength(2);
    // Each assignment sits inside the packaged branch, beside the state paths.
    for (const name of ['backendEnv', 'env']) {
      const at = main.indexOf(`${name}.PYTHONDONTWRITEBYTECODE`);
      expect(main.lastIndexOf('if (app.isPackaged)', at)).toBeGreaterThan(main.lastIndexOf('function ', at));
    }
  });
});

describe('the command line installer', () => {
  it('runs every program without a console window', () => {
    const calls_ = calls(read('commandLineInstall.ts'), 'execFile');
    expect(calls_.length).toBeGreaterThan(0);
    for (const call of calls_) expect(call).toContain('windowsHide: true');
  });
});
