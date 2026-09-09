/** Authored source input over real loopback HTTP; never a renderer outcome stub.
 * Only these opted-in launches redirect the arXiv and OpenAlex endpoints. Their
 * clients/parsers, safe_request, execution worker and SQLite outcome writes
 * remain production code.
 *
 * The `authored-*` modes exist because three full-Electron specs used to seed
 * themselves by querying the public scholarly services, which hosted CI then ran
 * outside the offline boundary. They replace the *input* and nothing else: the
 * request is a real HTTP request over a real socket, made by the real client,
 * and every match, vector, link and rendered row downstream is computed by the
 * app. What they cannot see is a provider's own behaviour — a schema change or
 * an outage at arXiv or OpenAlex is invisible to an authored reply, and the
 * handback says so.
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

type Mode = 'paper' | 'empty' | 'failure' | '503' | 'malformed'
  | 'authored-person' | 'authored-corpus' | 'authored-duplicates';
type Provider = 'arxiv' | 'openalex' | 'unknown';
interface Stored { execution: Record<string, unknown>[]; sources: Record<string, unknown>[]; documents: Record<string, unknown>[] }
interface SourceRequest {
  method: string; url: string; path: string; provider: Provider;
  params: Record<string, string>; status: number | null; transport: string;
}
const emptyFeed = '<feed xmlns="http://www.w3.org/2005/Atom"></feed>';
const paperFeed = `<feed xmlns="http://www.w3.org/2005/Atom"><entry>
  <id>https://arxiv.org/abs/2609.00001v1</id><title>Authored graph neural network fixture</title>
  <author><name>Ada Fixture</name></author><published>2026-09-01T00:00:00Z</published>
  <summary>Authored local graph neural network fixture, not fetched scholarly content.</summary>
</entry></feed>`;

// ---------------------------------------------------------------------------
// The authored corpora
//
// Every record below is invented for this suite. No name here is a real
// researcher's, no identifier resolves at either provider, and no sentence was
// taken from a published abstract — so nothing in this file can be read as a
// claim about what arXiv or OpenAlex actually holds.
// ---------------------------------------------------------------------------

interface AuthoredPaper {
  id: string; title: string; abstract: string; authors: string[];
  date: string; category: string;
}

/** Explicitly synthetic. A two-token name, so the matcher's single-token
 *  ambiguity rule is not what produces the basis. */
export const AUTHORED_PERSON = 'Testcase Fixtureborne';

/** arXiv carries no ORCID for anybody, so every match it can produce is
 *  `name_only` — which is the basis this arm exists to see rendered honestly. */
export const AUTHORED_PERSON_PAPERS: AuthoredPaper[] = [
  {
    id: '2609.31001v1',
    title: 'Fixture study of message passing over authored graphs',
    abstract: 'An authored local fixture record describing message passing over synthetic graphs. Not fetched scholarly content.',
    authors: [AUTHORED_PERSON, 'Coauthor Placeholder'],
    date: '2026-09-01', category: 'cs.LG',
  },
  {
    id: '2609.31002v1',
    title: 'Second fixture note on synthetic neighbourhood aggregation',
    abstract: 'A second authored local fixture record describing neighbourhood aggregation over synthetic graphs. Not fetched scholarly content.',
    authors: [AUTHORED_PERSON],
    date: '2026-09-02', category: 'cs.LG',
  },
  {
    id: '2609.31003v1',
    title: 'Third fixture note on authored spectral placeholders',
    abstract: 'A third authored local fixture record describing spectral placeholders over synthetic graphs. Not fetched scholarly content.',
    authors: ['Coauthor Placeholder', AUTHORED_PERSON],
    date: '2026-09-03', category: 'cs.LG',
  },
];

/** Five records for the ranking arm. Every title carries the word `Authored`,
 *  which is what the spec's own term-picking rule lands on. */
export const AUTHORED_CORPUS_PAPERS: AuthoredPaper[] = [
  {
    id: '2609.32001v1',
    title: 'Authored graph neural network baselines for fixture ranking',
    abstract: 'An authored local record about graph neural network baselines, written for this test and never fetched.',
    authors: ['Ada Fixture'], date: '2026-09-01', category: 'cs.LG',
  },
  {
    id: '2609.32002v1',
    title: 'Authored message passing under synthetic sparsity',
    abstract: 'An authored local record about message passing under synthetic sparsity, written for this test and never fetched.',
    authors: ['Bo Fixture'], date: '2026-09-02', category: 'cs.LG',
  },
  {
    id: '2609.32003v1',
    title: 'Authored pooling operators for placeholder graphs',
    abstract: 'An authored local record about pooling operators for placeholder graphs, written for this test and never fetched.',
    authors: ['Cy Fixture'], date: '2026-09-03', category: 'cs.LG',
  },
  {
    id: '2609.32004v1',
    title: 'Authored attention layers over invented adjacency',
    abstract: 'An authored local record about attention layers over invented adjacency, written for this test and never fetched.',
    authors: ['Di Fixture'], date: '2026-09-04', category: 'cs.LG',
  },
  {
    id: '2609.32005v1',
    title: 'Authored spectral filters on fabricated benchmarks',
    abstract: 'An authored local record about spectral filters on fabricated benchmarks, written for this test and never fetched.',
    authors: ['Ed Fixture'], date: '2026-09-05', category: 'cs.LG',
  },
];

/** The pair the near-duplicate rule is meant to find: one work, indexed twice.
 *  `documents` is unique on (source, external_id), so the two survive as two
 *  rows with two provenances — which is the state P12 is about. The text is
 *  identical on purpose, so the vectors are identical and the title path's two
 *  signals both fire; nothing asserts the link into the table. */
export const AUTHORED_SHARED_TITLE = 'Authored duplicate work on fixture graph alignment';
const AUTHORED_SHARED_ABSTRACT = 'An authored local record indexed by two fixtures at once, used to exercise the near-duplicate rule. Not fetched scholarly content.';
const AUTHORED_SHARED_AUTHORS = ['Ada Fixture', 'Bo Fixture'];
const AUTHORED_SHARED_DATE = '2026-09-01';

export const AUTHORED_DUPLICATE_ARXIV: AuthoredPaper[] = [
  {
    id: '2609.33001v1', title: AUTHORED_SHARED_TITLE, abstract: AUTHORED_SHARED_ABSTRACT,
    authors: AUTHORED_SHARED_AUTHORS, date: AUTHORED_SHARED_DATE, category: 'cs.LG',
  },
  {
    id: '2609.33002v1', title: 'Unrelated fixture note on queue scheduling',
    abstract: 'An authored local record about queue scheduling, deliberately unlike the shared work above.',
    authors: ['Cy Fixture'], date: '2026-09-02', category: 'cs.DC',
  },
  {
    id: '2609.33003v1', title: 'Unrelated fixture note on lexical indexing',
    abstract: 'An authored local record about lexical indexing, deliberately unlike the shared work above.',
    authors: ['Di Fixture'], date: '2026-09-03', category: 'cs.IR',
  },
];

export const AUTHORED_DUPLICATE_OPENALEX: AuthoredPaper[] = [
  {
    id: 'W3300000001', title: AUTHORED_SHARED_TITLE, abstract: AUTHORED_SHARED_ABSTRACT,
    authors: AUTHORED_SHARED_AUTHORS, date: AUTHORED_SHARED_DATE, category: 'Graph theory',
  },
  {
    id: 'W3300000002', title: 'Unrelated fixture survey of column stores',
    abstract: 'An authored local record about column stores, deliberately unlike the shared work above.',
    authors: ['Ed Fixture'], date: '2026-09-02', category: 'Databases',
  },
  {
    id: 'W3300000003', title: 'Unrelated fixture survey of compiler passes',
    abstract: 'An authored local record about compiler passes, deliberately unlike the shared work above.',
    authors: ['Fi Fixture'], date: '2026-09-03', category: 'Compilers',
  },
];

/** Documents an `authored-duplicates` seed stores, across both providers. */
export const AUTHORED_DUPLICATE_DOCUMENTS =
  AUTHORED_DUPLICATE_ARXIV.length + AUTHORED_DUPLICATE_OPENALEX.length;

function atomFeed(papers: AuthoredPaper[]): string {
  const entries = papers.map((paper) => `  <entry>
    <id>http://arxiv.org/abs/${paper.id}</id>
    <title>${paper.title}</title>
${paper.authors.map((name) => `    <author><name>${name}</name></author>`).join('\n')}
    <published>${paper.date}T00:00:00Z</published>
    <summary>${paper.abstract}</summary>
    <arxiv:primary_category term="${paper.category}"/>
  </entry>`).join('\n');
  return `<feed xmlns="http://www.w3.org/2005/Atom" xmlns:arxiv="http://arxiv.org/schemas/atom">
${entries}
</feed>`;
}

/** OpenAlex hands abstracts over as an inverted index and the client
 *  reconstructs them, so the authored reply is inverted here rather than
 *  shipped as plain text — the reconstruction is production code and stays
 *  under test. */
function invertedIndex(abstract: string): Record<string, number[]> {
  const index: Record<string, number[]> = {};
  abstract.split(' ').forEach((word, position) => {
    (index[word] = index[word] ?? []).push(position);
  });
  return index;
}

function openAlexWorks(papers: AuthoredPaper[]): string {
  return JSON.stringify({
    meta: { count: papers.length, page: 1, per_page: papers.length },
    results: papers.map((paper) => ({
      id: `https://openalex.org/${paper.id}`,
      display_name: paper.title,
      doi: null,
      publication_date: paper.date,
      primary_location: { landing_page_url: `https://openalex.org/${paper.id}` },
      authorships: paper.authors.map((name, position) => ({
        author: {
          id: `https://openalex.org/A${paper.id}${position}`,
          display_name: name,
          orcid: null,
        },
        raw_affiliation_strings: [],
      })),
      abstract_inverted_index: invertedIndex(paper.abstract),
      concepts: [{ display_name: paper.category }],
    })),
  });
}

/** What an authored mode answers a given provider with; `null` means the
 *  request went somewhere this mode does not serve, which is answered 404 and
 *  left visible in the receipts rather than papered over with an empty list. */
function authoredBody(mode: Mode, provider: Provider): string | null {
  if (mode === 'authored-person') {
    return provider === 'arxiv' ? atomFeed(AUTHORED_PERSON_PAPERS) : null;
  }
  if (mode === 'authored-corpus') {
    return provider === 'arxiv' ? atomFeed(AUTHORED_CORPUS_PAPERS) : null;
  }
  if (mode === 'authored-duplicates') {
    if (provider === 'arxiv') return atomFeed(AUTHORED_DUPLICATE_ARXIV);
    if (provider === 'openalex') return openAlexWorks(AUTHORED_DUPLICATE_OPENALEX);
    return null;
  }
  return null;
}

/**
 * The addresses the child's guard is asked about before the app starts.
 *
 * Neither is a scholarly provider and neither is contacted: `192.0.2.1` is
 * TEST-NET-1 (RFC 5737, routed nowhere) and `.invalid` (RFC 2606) never
 * resolves — and the guard refuses both *before* `connect` and before DNS, which
 * is the thing being demonstrated. Port 8742 is deliberately **not** probed:
 * that address carries a live daemon, and a probe that stays harmless only while
 * the guard works is not a check worth having.
 */
const PROBE_TARGETS = [
  { host: '192.0.2.1', port: 9 },
  { host: 'boundary-sentinel.invalid', port: 443 },
];

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
  const authored = mode.startsWith('authored');
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'resmon-source-boundary-'));
  const requests: SourceRequest[] = [];
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const sockets = new Set<net.Socket>();
  const server = http.createServer((req, res) => {
    const requested = new URL(req.url ?? '/', 'http://127.0.0.1');
    const provider: Provider = requested.pathname === '/api/query' ? 'arxiv'
      : requested.pathname === '/openalex/works' ? 'openalex' : 'unknown';
    const params: Record<string, string> = {};
    requested.searchParams.forEach((value, key) => { params[key] = value; });
    const record = { method: req.method ?? '', url: req.url ?? '', path: requested.pathname,
      provider, params, status: null, transport: 'waiting' } as SourceRequest;
    requests.push(record);
    void gate.then(() => {
      if (mode === 'failure') {
        // The connection really ends without an HTTP response. safe_request
        // must record a transport failure, never an HTTP 200 empty answer.
        record.transport = 'closed-without-response';
        req.socket.destroy();
      } else if (authored) {
        const body = authoredBody(mode, provider);
        if (body === null) {
          res.writeHead(404, { 'Content-Type': 'text/plain' });
          res.end('this authored mode serves no such provider route');
          record.status = 404;
        } else {
          res.writeHead(200, { 'Content-Type': provider === 'openalex'
            ? 'application/json' : 'application/atom+xml' });
          res.end(body);
          record.status = 200;
        }
        record.transport = 'http-response';
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
  const openAlexEndpoint = `http://127.0.0.1:${sourcePort}/openalex/works`;
  // The authored modes seed a whole run rather than holding one request open,
  // so their replies are not gated behind a caller's `release()`. The existing
  // transport cases keep the gate they were written for.
  if (authored) release();
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
from implementation_scripts import api_arxiv, api_openalex
api_arxiv._ARXIV_API_URL = ${JSON.stringify(endpoint)}
api_openalex._OPENALEX_API_URL = ${JSON.stringify(openAlexEndpoint)}
(state / 'source-hook.json').write_text(json.dumps({'pid': os.getpid(), 'parent_pid': os.getppid(), 'endpoint': api_arxiv._ARXIV_API_URL, 'openalex_endpoint': api_openalex._OPENALEX_API_URL, 'inherited_guards': inherited_guards}))
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
      // Exactly the fixture's own startup probe and nothing else. The older form
      // of this assertion — an empty log — was also satisfied by a guard that
      // never loaded at all, which is the failure this arrangement exists to
      // rule out; anything the app itself tried to reach still fails here.
      expect(blocked.split('\n').filter(Boolean).map((line) => JSON.parse(line)))
        .toEqual(PROBE_TARGETS);
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
    // Fail-closed, demonstrated in the child scope this fixture actually
    // creates, before the app starts and without assuming the caller supplied an
    // offline guard — the hosted UI workflow does not install one.
    const probe = execFileSync(env.RESMON_PYTHON, ['-c', `
import json, socket
refusals = []
for host, port in ${JSON.stringify(PROBE_TARGETS.map((target) => [target.host, target.port]))}:
    try:
        if isinstance(host, str) and host.endswith('.invalid'):
            socket.getaddrinfo(host, port)
        else:
            socket.socket().connect((host, port))
    except OSError as error:
        refusals.append({'host': host, 'port': port, 'error': str(error)})
        continue
    raise SystemExit('scoped guard did not refuse %s:%s' % (host, port))
print(json.dumps(refusals))
`], { env, encoding: 'utf8' });
    const refusals = JSON.parse(probe.trim()) as { host: string; port: number; error: string }[];
    expect(refusals.map((refusal) => ({ host: refusal.host, port: refusal.port })))
      .toEqual(PROBE_TARGETS);
    for (const refusal of refusals) {
      expect(refusal.error).toContain('source-boundary test guard refuses');
    }
    console.log('SOURCE_BOUNDARY_PROBE', JSON.stringify({ mode, stateDir, refusals }));
    app = await electron.launch({ args: ['.', `--user-data-dir=${path.join(stateDir, 'electron-user-data')}`],
      cwd: FRONTEND_ROOT, env, timeout: 180_000 });
    const win = await app.firstWindow({ timeout: 180_000 });
    await win.waitForLoadState('domcontentloaded');
    await win.locator('.app-main').waitFor({ state: 'visible', timeout: 60_000 });
    const hook = JSON.parse(fs.readFileSync(path.join(stateDir, 'source-hook.json'), 'utf8'));
    expect(hook.parent_pid).toBe(app.process().pid);
    expect(hook.endpoint).toBe(endpoint);
    expect(hook.openalex_endpoint).toBe(openAlexEndpoint);
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
    return { app, win, close, release, requests, stored, hook, endpoint, openAlexEndpoint,
      waitForRequest: async () => { await expect.poll(() => requests.length).toBeGreaterThan(0); },
      evidence: (id: number) => {
        const result = { mode, executionId: id, requests, stored: stored(id) };
        console.log('SOURCE_EFFECT', JSON.stringify(result)); return result;
      } };
  } catch (error) { await close(); throw error; }
}
