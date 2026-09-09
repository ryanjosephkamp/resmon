/** Authored source input over real loopback HTTP; never a renderer outcome stub.
 * Only these opted-in launches redirect the arXiv endpoint. Its client/parser,
 * safe_request, execution worker and SQLite outcome writes remain production code.
 */
import * as fs from 'fs';
import * as http from 'http';
import * as net from 'net';
import * as os from 'os';
import * as path from 'path';
import { execFileSync } from 'child_process';
import { _electron as electron, expect } from '@playwright/test';
import type { Page } from '@playwright/test';
import { FRONTEND_ROOT, REPO_ROOT, launchEnv } from './resmon-app';

type Mode = 'paper' | 'empty' | 'failure' | '503' | 'malformed';
interface Stored { execution: Record<string, unknown>[]; sources: Record<string, unknown>[]; documents: Record<string, unknown>[] }
interface SourceRequest { method: string; url: string; status: number | null; transport: string }
const emptyFeed = '<feed xmlns="http://www.w3.org/2005/Atom"></feed>';
const paperFeed = `<feed xmlns="http://www.w3.org/2005/Atom"><entry>
  <id>https://arxiv.org/abs/2609.00001v1</id><title>Authored graph neural network fixture</title>
  <author><name>Ada Fixture</name></author><published>2026-09-01T00:00:00Z</published>
  <summary>Authored local graph neural network fixture, not fetched scholarly content.</summary>
</entry></feed>`;

export async function sourceApi(win: Page, route: string): Promise<Record<string, unknown>> {
  return win.evaluate(async (suffix) => {
    const port = (window as unknown as { resmonAPI: { getBackendPort(): string } })
      .resmonAPI.getBackendPort();
    if (!port || port === '8742') throw new Error('unidentified backend');
    const response = await fetch(`http://127.0.0.1:${port}${suffix}`);
    if (!response.ok) throw new Error(`HTTP ${response.status}: ${suffix}`);
    return response.json();
  }, route);
}

export async function launchSourceApp(mode: Mode) {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'resmon-source-boundary-'));
  const requests: SourceRequest[] = [];
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const sockets = new Set<net.Socket>();
  const server = http.createServer((req, res) => {
    const record = { method: req.method ?? '', url: req.url ?? '', status: null,
      transport: 'waiting' } as SourceRequest;
    requests.push(record);
    void gate.then(() => {
      if (mode === 'failure') {
        // The connection really ends without an HTTP response. safe_request
        // must record a transport failure, never an HTTP 200 empty answer.
        record.transport = 'closed-without-response';
        req.socket.destroy();
      } else {
        res.writeHead(mode === '503' ? 503 : 200, { 'Content-Type': 'application/atom+xml' });
        res.end(mode === 'paper' ? paperFeed : mode === 'malformed' ? '<feed><broken' : mode === '503' ? 'Unavailable' : emptyFeed);
        record.status = mode === '503' ? 503 : 200;
        record.transport = 'http-response';
      }
    });
  });
  server.on('connection', (socket) => {
    sockets.add(socket); socket.on('close', () => sockets.delete(socket));
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject); server.listen(0, '127.0.0.1', resolve);
  });
  const sourcePort = (server.address() as net.AddressInfo).port;
  expect(sourcePort).not.toBe(8742);
  const endpoint = `http://127.0.0.1:${sourcePort}/api/query`;
  const env = launchEnv(stateDir, true);
  const hookDir = path.join(stateDir, 'python-source-boundary');
  fs.mkdirSync(hookDir);
  // Startup hook is private to this child's PYTHONPATH; no production file or
  // renderer response changes. This scoped guard also makes accidental endpoint
  // drift fail closed even when the caller has not supplied an offline guard.
  fs.writeFileSync(path.join(hookDir, 'sitecustomize.py'), `
import ipaddress, json, os, socket, sys, runpy
from pathlib import Path
# The scoped endpoint hook shadows sitecustomize; replay the caller's existing
# guard unchanged before adding this fixture's stricter contact receipt.
inherited_guards = []
for entry in os.environ.get('PYTHONPATH', '').split(os.pathsep):
    candidate = Path(entry) / 'sitecustomize.py'
    if candidate.is_file() and candidate.resolve() != Path(__file__).resolve():
        runpy.run_path(str(candidate))
        inherited_guards.append(str(candidate))
state = Path(${JSON.stringify(stateDir)})
original_connect = socket.socket.connect
original_connect_ex = socket.socket.connect_ex
original_getaddrinfo = socket.getaddrinfo
def checked(address):
    if isinstance(address, tuple):
        host, port = address[:2]
        try: local = ipaddress.ip_address(host).is_loopback
        except ValueError: local = host == 'localhost'
        if not local or port == 8742:
            with (state / 'blocked.jsonl').open('a') as stream:
                stream.write(json.dumps({'host': host, 'port': port}) + "\\n")
            raise OSError('source-boundary test guard refuses external/8742 connection')
def connect(self, address):
    checked(address)
    return original_connect(self, address)
def connect_ex(self, address):
    checked(address)
    return original_connect_ex(self, address)
def getaddrinfo(host, port, *args, **kwargs):
    checked((host, port))
    return original_getaddrinfo(host, port, *args, **kwargs)
socket.getaddrinfo = getaddrinfo
socket.socket.connect = connect
socket.socket.connect_ex = connect_ex
sys.path.insert(0, ${JSON.stringify(path.join(REPO_ROOT, 'resmon_scripts'))})
from implementation_scripts import api_arxiv
api_arxiv._ARXIV_API_URL = ${JSON.stringify(endpoint)}
(state / 'source-hook.json').write_text(json.dumps({'pid': os.getpid(), 'parent_pid': os.getppid(), 'endpoint': api_arxiv._ARXIV_API_URL, 'inherited_guards': inherited_guards}))
`);
  execFileSync(env.RESMON_PYTHON, ['-c', 'import ast, pathlib, sys; ast.parse(pathlib.Path(sys.argv[1]).read_text())', path.join(hookDir, 'sitecustomize.py')]);
  env.PYTHONPATH = [hookDir, env.PYTHONPATH].filter(Boolean).join(path.delimiter);
  env.PYTHONDONTWRITEBYTECODE = '1';
  env.PYTHON_KEYRING_BACKEND = 'keyring.backends.null.Keyring';
  env.NO_PROXY = env.no_proxy = '127.0.0.1,localhost';
  for (const key of ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'http_proxy', 'https_proxy', 'all_proxy']) delete env[key];
  let app: Awaited<ReturnType<typeof electron.launch>> | undefined;
  let backendPid: number | undefined;
  const close = async () => {
    release();
    const ownedProcess = app?.process();
    try { if (app) await app.close(); }
    finally {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
      const blocked = fs.existsSync(path.join(stateDir, 'blocked.jsonl'))
        ? fs.readFileSync(path.join(stateDir, 'blocked.jsonl'), 'utf8') : '';
      expect(blocked).toBe('');
      expect(server.listening).toBe(false);
      if (backendPid) {
        // An exited child must not be mistaken for an instance available to a
        // subsequent test. Poll only process existence, never a default port.
        await expect.poll(() => {
          try { process.kill(backendPid as number, 0); return true; } catch { return false; }
        }).toBe(false);
      }
      const appExited = ownedProcess ? ownedProcess.exitCode !== null || ownedProcess.signalCode !== null : null;
      if (ownedProcess) expect(appExited).toBe(true);
      console.log('SOURCE_CLEANUP', JSON.stringify({ stateDir, backendPid, sourcePort,
        serverListening: server.listening, blocked, appExited, backendExited: backendPid ? true : null }));
      fs.rmSync(stateDir, { recursive: true, force: true });
    }
  };
  try {
    app = await electron.launch({ args: ['.', `--user-data-dir=${path.join(stateDir, 'electron-user-data')}`],
      cwd: FRONTEND_ROOT, env, timeout: 180_000 });
    const win = await app.firstWindow({ timeout: 180_000 });
    await win.waitForLoadState('domcontentloaded');
    await win.locator('.app-main').waitFor({ state: 'visible', timeout: 60_000 });
    const hook = JSON.parse(fs.readFileSync(path.join(stateDir, 'source-hook.json'), 'utf8'));
    expect(hook.parent_pid).toBe(app.process().pid);
    expect(hook.endpoint).toBe(endpoint);
    backendPid = hook.pid;
    const port = fs.readFileSync(env.RESMON_PORT_FILE, 'utf8').trim();
    expect(port).toMatch(/^\d+$/); expect(port).not.toBe('8742');
    const health = await sourceApi(win, '/api/health');
    expect(health.pid).toBe(backendPid);
    const stored = (id: number): Stored => JSON.parse(execFileSync(env.RESMON_PYTHON, ['-c', `
import sqlite3, json, sys
with sqlite3.connect('file:' + sys.argv[1] + '?mode=ro', uri=True) as c:
 c.row_factory = sqlite3.Row
 print(json.dumps({'execution': [dict(r) for r in c.execute('SELECT * FROM executions WHERE id=?',(int(sys.argv[2]),))], 'sources': [dict(r) for r in c.execute('SELECT * FROM execution_sources WHERE execution_id=?',(int(sys.argv[2]),))], 'documents': [dict(r) for r in c.execute('SELECT * FROM documents')]}))
`, env.RESMON_DB_PATH, String(id)], { encoding: 'utf8' }));
    expect(stored(0).documents).toEqual([]);
    console.log('SOURCE_INSTANCE', JSON.stringify({ mode, sourceRoot: REPO_ROOT, stateDir,
      database: env.RESMON_DB_PATH, reports: env.RESMON_REPORTS_DIR, portFile: env.RESMON_PORT_FILE,
      profile: path.join(stateDir, 'electron-user-data'), port, sourcePort,
      parentPid: app.process().pid, hook, health, initialDocuments: 0 }));
    return { app, win, close, release, requests, stored,
      waitForRequest: async () => { await expect.poll(() => requests.length).toBeGreaterThan(0); },
      evidence: (id: number) => {
        const result = { mode, executionId: id, requests, stored: stored(id) };
        console.log('SOURCE_EFFECT', JSON.stringify(result)); return result;
      } };
  } catch (error) { await close(); throw error; }
}
