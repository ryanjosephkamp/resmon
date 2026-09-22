/**
 * A deterministic embedding model on loopback.
 *
 * Three rows of the register — ranking by meaning, the near-duplicate links and
 * the coverage audit — are all downstream of one thing the app cannot do on its
 * own: turn a paper into a vector. That needs a model, and a journey must never
 * reach one over the internet.
 *
 * So this is a real HTTP server on 127.0.0.1 speaking the shape the shipped
 * `local` embedding provider posts to, and the backend calls it over a real
 * socket with its own client. What it replaces is the *model* and nothing else:
 * the settings write, the probe, the backfill, the `vec0` table, the KNN and
 * every sentence the Explorer prints are the app's own.
 *
 * **The vectors are derived from a hash, not from meaning**, so "close" here is
 * a fact about this fixture rather than about the two papers. Every spec that
 * uses it says so in its ledger row: a journey can establish that the app ranks,
 * labels and counts what a model gave it — not that the ranking is good.
 */
import * as crypto from 'crypto';
import * as http from 'http';
import * as net from 'net';

/** The name the journeys tell the app to call this model, so a screen can be checked for it. */
export const JOURNEY_EMBEDDING_MODEL = 'journey-model';

/** Small on purpose: the index is rebuilt per run and nothing here needs width. */
const DIMS = 8;

/**
 * A unit vector derived from the text's SHA-256.
 *
 * The same construction the e2e suite's own fixture uses, kept identical so the
 * two suites cannot disagree about what "the same text" embeds to.
 */
function vectorFor(text: string): number[] {
  const digest = crypto.createHash('sha256').update(text, 'utf8').digest();
  const raw: number[] = [];
  for (let i = 0; i < DIMS; i += 1) raw.push(digest[i % digest.length] / 255 - 0.5);
  const norm = Math.sqrt(raw.reduce((total, value) => total + value * value, 0)) || 1;
  return raw.map((value) => value / norm);
}

export interface EmbeddingEndpoint {
  /** Where the app's `local` embedding provider is pointed. */
  url: string;
  /** How many embedding requests the app actually made. */
  requestCount(): number;
  close(): Promise<void>;
}

export async function startEmbeddingEndpoint(): Promise<EmbeddingEndpoint> {
  let requests = 0;
  const sockets = new Set<net.Socket>();
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      requests += 1;
      let input: string[] = [];
      try {
        const parsed = JSON.parse(body || '{}');
        input = Array.isArray(parsed.input) ? parsed.input : [parsed.input].filter(Boolean);
      } catch {
        // An unparseable body yields no vectors, which the client rejects — the
        // same answer a broken model would give, rather than a silent success.
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ embeddings: input.map((text) => vectorFor(String(text))) }));
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
  const { port } = server.address() as net.AddressInfo;
  // B3, here as everywhere: the OS picks the port and this refuses the one
  // carrying somebody's real corpus rather than trusting it will not be chosen.
  if (port === 8742) throw new Error('the authored embedding model was given the live daemon port');

  return {
    url: `http://127.0.0.1:${port}`,
    requestCount: () => requests,
    close: async () => {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    },
  };
}
