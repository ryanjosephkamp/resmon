/**
 * One authored scholarly source on loopback, and the guard that makes every
 * journey run offline whether or not it uses one.
 *
 * This is the same idea as `e2e/fixtures/source-boundary.ts` and deliberately
 * not the same code: that fixture launches the app out of *this* checkout, with
 * `cwd: FRONTEND_ROOT` written into it and a pile of assertions about its own
 * cleanup. A journey has to be launchable against another build, so the piece
 * that redirects arXiv is here, parameterised by the repository root of the
 * build under test, and everything else it used to carry stays over there.
 *
 * What it replaces is the **input** and nothing else. The request is a real
 * HTTP request over a real socket, made by the shipped arXiv client through
 * `safe_request`; every outcome, zero reason, SQLite write and rendered row
 * downstream is the app's own. What no authored reply can see is arXiv's own
 * behaviour — a schema change or an outage upstream is invisible here, and the
 * handback says so.
 *
 * **The guard is not optional.** The `sitecustomize.py` this writes refuses any
 * connection that is not loopback, and refuses port 8742 in particular: that
 * address carries a live launchd daemon over somebody's real corpus. Every
 * journey launch gets it, including the rows that never query a source, so
 * "this suite did not reach the internet" is a property of the suite rather
 * than of each spec's good behaviour.
 */
import * as fs from 'fs';
import * as http from 'http';
import * as net from 'net';
import * as path from 'path';

/** How the authored source answers. */
export type SourceReply =
  /** One record, over a real HTTP 200. */
  | 'paper'
  /** A valid, empty Atom feed over a real HTTP 200 — `answered_empty`. */
  | 'empty'
  /** The connection ends without an HTTP response — `upstream_failure`. */
  | 'dead'
  /** Accepted and held open until the journey releases it; then one record. */
  | 'held'
  /**
   * Three records over a real HTTP 200, two of which are the same work.
   *
   * Slice 2a. The near-duplicate scan requires two signals to agree — close
   * vectors *and* a near-identical title, with an abstract behind both — so a
   * pair that differs only in the fields dedup keys on is the smallest honest
   * way to produce one. `AUTHORED_TWICE` is that pair.
   */
  | 'duplicates';

export interface AuthoredRecord {
  id: string;
  title: string;
  abstract: string;
  author: string;
  published: string;
  category: string;
}

/**
 * The corpus a journey sees.
 *
 * Every field is invented for this suite. No name here is a real researcher's,
 * no identifier resolves at arXiv, and no sentence was taken from a published
 * abstract, so nothing in this file can be read as a claim about what arXiv
 * holds. The word `perovskite` appears in the title of one record and the
 * abstract of another on purpose: the Explorer journey asks the why-panel which
 * *field* a keyword matched in, and a term that matches in one field only would
 * not tell the two apart.
 */
export const AUTHORED_RECORDS: AuthoredRecord[] = [
  {
    id: '2609.41001v1',
    title: 'Authored perovskite stability note for the journey fixture',
    abstract: 'An invented local record about layered film stability, written for this suite and never fetched.',
    author: 'Ada Fixture',
    published: '2026-09-01T00:00:00Z',
    category: 'cond-mat.mtrl-sci',
  },
  {
    id: '2609.41002v1',
    title: 'Second authored note on invented deposition placeholders',
    abstract: 'An invented local record whose abstract mentions perovskite films, written for this suite and never fetched.',
    author: 'Bo Fixture',
    published: '2026-09-02T00:00:00Z',
    category: 'cond-mat.mtrl-sci',
  },
];

/** The term that matches record one in its title and record two in its abstract. */
export const AUTHORED_KEYWORD = 'perovskite';

/**
 * The same authored work, arriving twice.
 *
 * Insert-time dedup hashes `title|authors|date`, so these two differ in the
 * author and the date and are stored as two papers — which is the state the
 * near-duplicate scan exists to describe. The title and abstract are
 * byte-identical because the embedding is taken from those two fields: a
 * deterministic model gives identical text an identical vector, and the pair is
 * then at distance 0 with a title similarity of 1, which is what the scan's two
 * signals both need. A third, unrelated record is included so that "one pair
 * was linked" is a statement about the pair rather than about the corpus.
 */
export const AUTHORED_TWICE: AuthoredRecord[] = [
  {
    id: '2609.42001v1',
    title: 'Authored duplicate: one invented work reaching resmon twice',
    abstract: 'An invented local record written for this suite so that two stored copies of one work exist to be linked. Never fetched.',
    author: 'Cy Fixture',
    published: '2026-09-03T00:00:00Z',
    category: 'cond-mat.mtrl-sci',
  },
  {
    id: '2609.42002v1',
    title: 'Authored duplicate: one invented work reaching resmon twice',
    abstract: 'An invented local record written for this suite so that two stored copies of one work exist to be linked. Never fetched.',
    author: 'Di Fixture',
    published: '2026-09-04T00:00:00Z',
    category: 'cond-mat.mtrl-sci',
  },
  {
    id: '2609.42003v1',
    title: 'Authored single: an unrelated invented record for the same fixture',
    abstract: 'An invented local record about something else entirely, so that the linked pair is a pair rather than the whole corpus.',
    author: 'El Fixture',
    published: '2026-09-05T00:00:00Z',
    category: 'cond-mat.mtrl-sci',
  },
];

function atomFeed(records: AuthoredRecord[]): string {
  const entries = records.map((r) => `<entry>
  <id>https://arxiv.org/abs/${r.id}</id>
  <title>${r.title}</title>
  <author><name>${r.author}</name></author>
  <published>${r.published}</published>
  <updated>${r.published}</updated>
  <summary>${r.abstract}</summary>
  <category term="${r.category}"/>
</entry>`).join('\n');
  return `<feed xmlns="http://www.w3.org/2005/Atom">\n${entries}\n</feed>`;
}

export interface SourceEndpoint {
  /** Where the redirected arXiv client will send its requests. */
  url: string;
  /** How many requests the authored source has actually received. */
  requestCount(): number;
  /** Let a held reply through. A no-op for the other modes. */
  release(): void;
  /**
   * Answer differently from now on.
   *
   * Slice 2a: the Watchdog row needs a source that fails three times and then
   * recovers, which is a sequence rather than a state. Nothing else about the
   * endpoint changes — the socket, the client and the parser stay the app's own.
   */
  answerWith(reply: SourceReply): void;
  close(): Promise<void>;
}

/** Start the authored source. The port is chosen by the OS and is never 8742. */
export async function startSourceEndpoint(reply: SourceReply): Promise<SourceEndpoint> {
  const requests: string[] = [];
  const sockets = new Set<net.Socket>();
  let releaseGate!: () => void;
  const gate = new Promise<void>((resolve) => { releaseGate = resolve; });
  if (reply !== 'held') releaseGate();

  let current = reply;
  const server = http.createServer((req, res) => {
    requests.push(req.url ?? '');
    void gate.then(() => {
      const reply = current;
      if (reply === 'dead') {
        // The connection really ends without an HTTP response, so the shipped
        // HTTP stack records a transport failure rather than an empty answer.
        req.socket.destroy();
        return;
      }
      const body = reply === 'empty'
        ? '<feed xmlns="http://www.w3.org/2005/Atom"></feed>'
        : atomFeed(reply === 'duplicates' ? AUTHORED_TWICE : AUTHORED_RECORDS);
      res.writeHead(200, { 'Content-Type': 'application/atom+xml' });
      res.end(body);
    });
  });
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const port = (server.address() as net.AddressInfo).port;
  if (port === 8742) throw new Error('the authored source was given the live daemon port');

  return {
    url: `http://127.0.0.1:${port}/api/query`,
    requestCount: () => requests.length,
    release: () => releaseGate(),
    answerWith: (next: SourceReply) => {
      current = next;
      // A journey that switches away from `held` has stopped waiting for a
      // release, so the gate is opened rather than left shut over a mode that
      // will never ask for it.
      if (next !== 'held') releaseGate();
    },
    close: async () => {
      releaseGate();
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    },
  };
}

/**
 * Write the startup hook the backend of the build under test is launched with.
 *
 * Two jobs, in this order. First it refuses every non-loopback connection and
 * every connection to 8742, appending each refusal to `blocked.jsonl` so a run
 * can say afterwards what it tried to reach. Then — only when a source endpoint
 * was asked for — it points the shipped arXiv client at that endpoint.
 *
 * It replays any `sitecustomize.py` already on `PYTHONPATH` first, because
 * Python loads exactly one and this one would otherwise silently replace a
 * guard the caller installed.
 *
 * Returns the directory to put at the front of `PYTHONPATH`.
 */
export function writeStartupHook(options: {
  stateDir: string;
  /** The repository root of the build under test — the parent of `resmon_scripts/`. */
  repoRoot: string;
  /** The authored source, when this journey uses one. */
  sourceUrl?: string;
}): string {
  const hookDir = path.join(options.stateDir, 'journey-python-hook');
  fs.mkdirSync(hookDir, { recursive: true });
  const redirect = options.sourceUrl
    ? `
sys.path.insert(0, ${JSON.stringify(path.join(options.repoRoot, 'resmon_scripts'))})
from implementation_scripts import api_arxiv
api_arxiv._ARXIV_API_URL = ${JSON.stringify(options.sourceUrl)}
`
    : '';
  fs.writeFileSync(path.join(hookDir, 'sitecustomize.py'), `
import ipaddress, json, os, runpy, socket, sys
from pathlib import Path

# Python imports exactly one sitecustomize. Replay whatever the caller already
# had on the path before shadowing it, or this hook silently disables it.
for entry in os.environ.get('PYTHONPATH', '').split(os.pathsep):
    candidate = Path(entry) / 'sitecustomize.py'
    if candidate.is_file() and candidate.resolve() != Path(__file__).resolve():
        runpy.run_path(str(candidate))

_state = Path(${JSON.stringify(options.stateDir)})
_connect, _connect_ex, _getaddrinfo = socket.socket.connect, socket.socket.connect_ex, socket.getaddrinfo


def _checked(address):
    if isinstance(address, tuple):
        host, port = address[:2]
        try:
            local = ipaddress.ip_address(host).is_loopback
        except ValueError:
            local = host == 'localhost'
        # 8742 is a live daemon over a real corpus. A journey never binds it and
        # never probes it, and a run that tried says so in this file.
        if not local or port == 8742:
            with (_state / 'blocked.jsonl').open('a') as stream:
                stream.write(json.dumps({'host': str(host), 'port': port}) + "\\n")
            raise OSError('journey suite guard refuses external/8742 connection')


def connect(self, address):
    _checked(address)
    return _connect(self, address)


def connect_ex(self, address):
    _checked(address)
    return _connect_ex(self, address)


def getaddrinfo(host, port, *args, **kwargs):
    _checked((host, port))
    return _getaddrinfo(host, port, *args, **kwargs)


socket.socket.connect = connect
socket.socket.connect_ex = connect_ex
socket.getaddrinfo = getaddrinfo
${redirect}
(_state / 'journey-hook.json').write_text(json.dumps({
    'pid': os.getpid(), 'parent_pid': os.getppid(),
    'source_url': ${JSON.stringify(options.sourceUrl ?? null)},
}))
`);
  // An in-memory keyring, so a journey can save a credential and read back what
  // the app shows for one.
  //
  // The alternative was the null backend, which accepts a write and stores
  // nothing — so "a stored key reads back as a mask" could not be journeyed at
  // all, because no key was ever stored. This is the answer the backend's own
  // `conftest.py` reached too: never the person's real keychain, but a real
  // store for the length of the process. It is a dict inside the backend
  // process, so it dies with the process and never touches the machine.
  fs.writeFileSync(path.join(hookDir, 'journey_keyring.py'), `
import keyring.backend

_VALUES = {}


class Keyring(keyring.backend.KeyringBackend):
    """One journey's credentials, in memory. Nothing here reaches the OS."""

    priority = 1

    def get_password(self, service, username):
        return _VALUES.get((service, username))

    def set_password(self, service, username, password):
        _VALUES[(service, username)] = password

    def delete_password(self, service, username):
        _VALUES.pop((service, username), None)
`);
  return hookDir;
}

/** Everything the guard refused during a run — empty is the expected answer. */
export function blockedConnections(stateDir: string): { host: string; port: number }[] {
  const file = path.join(stateDir, 'blocked.jsonl');
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line));
}
