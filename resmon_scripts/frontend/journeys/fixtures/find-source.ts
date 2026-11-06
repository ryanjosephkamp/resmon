/** Metadata source answers and a certificate-verified PDF, all authored on loopback. */
import { spawn } from 'child_process';
import { once } from 'events';
import * as fs from 'fs';
import * as http from 'http';
import * as net from 'net';
import * as os from 'os';
import * as path from 'path';
import { resolveInterpreter } from '../../e2e/fixtures/python-interpreter';
import { removeStateDir } from '../../e2e/fixtures/cleanup';
import { authoredPdf } from './authored-pdf';
import type { SourceEndpoint } from './source-endpoint';

const DOI = '10.5555/resmon.journey.find';
const TITLE = 'An authored paper about finding one licensed open copy';
const WITHOUT_LICENSE = 'An authored paper whose open copy states no license';

export async function startFindSource(): Promise<SourceEndpoint> {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'resmon-journey-find-'));
  fs.mkdirSync(path.join(folder, 'serve'));
  fs.writeFileSync(path.join(folder, 'serve', 'paper.pdf'), authoredPdf(['An authored licensed open copy for J50.']));
  const { python } = resolveInterpreter();
  const tls = spawn(python, [path.resolve(__dirname, '../../../verification_scripts/tls_loopback.py'), folder], {
    env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' }, stdio: ['pipe', 'pipe', 'pipe'],
  });
  let stderr = '';
  tls.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });
  const stopTls = async () => {
    if (!tls.pid || tls.exitCode !== null || tls.signalCode !== null) return;
    const exited = once(tls, 'exit');
    const deadline = setTimeout(() => {
      console.warn('[journeys] the owned PDF fixture did not stop after stdin closed; forcing it to stop');
      tls.kill('SIGKILL');
    }, 10_000);
    tls.stdin.end();
    try { await exited; } finally { clearTimeout(deadline); }
  };
  let server: http.Server | undefined;
  const sockets = new Set<net.Socket>();
  try {
    const ready = await new Promise<{ port: number; ca: string }>((resolve, reject) => {
      let out = '';
      const deadline = setTimeout(() => reject(new Error(`PDF fixture did not start: ${stderr}`)), 30_000);
      const fail = (error: Error) => { clearTimeout(deadline); reject(error); };
      tls.once('error', fail);
      tls.once('exit', (code) => fail(new Error(`PDF fixture exited ${code}: ${stderr}`)));
      tls.stdout.on('data', (chunk: Buffer) => {
        out += chunk.toString();
        const line = out.split('\n').find((part) => part.trim().startsWith('{'));
        if (!line) return;
        try { clearTimeout(deadline); resolve(JSON.parse(line) as { port: number; ca: string }); }
        catch (error) { fail(error instanceof Error ? error : new Error(String(error))); }
      });
    });
    if (ready.port === 8742) throw new Error('the PDF fixture was given the live daemon port');
    const requests: string[] = [];
    const work = (licensed: boolean) => ({
      id: `https://openalex.org/${licensed ? 'W9500000001' : 'W9500000002'}`,
      doi: `https://doi.org/${licensed ? DOI : '10.5555/resmon.journey.no-license'}`,
      display_name: licensed ? TITLE : WITHOUT_LICENSE,
      publication_date: '2026-10-01', authorships: [{ author: { display_name: 'Ada Fixture' } }],
      primary_location: { landing_page_url: 'https://journal.resmon.test/authored' },
      locations: [{ is_oa: true, pdf_url: `https://pdf.resmon.test:${ready.port}/paper.pdf`,
        landing_page_url: 'https://journal.resmon.test/authored', license: licensed ? 'cc-by' : null,
        version: 'publishedVersion' }],
    });
    server = http.createServer((request, response) => {
      const url = new URL(request.url ?? '/', 'http://127.0.0.1');
      const route = decodeURIComponent(url.pathname);
      requests.push(route);
      if (route.startsWith('/crossref/')) { request.socket.destroy(); return; }
      if (route.startsWith('/datacite/')) {
        response.writeHead(404, { 'Content-Type': 'application/json' });
        response.end(JSON.stringify({ errors: [{ title: 'Not found' }] }));
        return;
      }
      const body = route === `/openalex/works/doi:${DOI}` ? work(true)
        : route === '/openalex/works' && url.searchParams.get('filter') === `title.search:${WITHOUT_LICENSE}`
          ? { results: [work(false)] } : { results: [] };
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify(body));
    });
    server.on('connection', (socket) => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
    await new Promise<void>((resolve, reject) => {
      server!.once('error', reject);
      server!.listen(0, '127.0.0.1', resolve);
    });
    const port = (server.address() as net.AddressInfo).port;
    if (port === 8742) throw new Error('the find source was given the live daemon port');
    return {
      url: `http://127.0.0.1:${port}/api/query`,
      fullText: { port: ready.port, ca: ready.ca },
      requestCount: () => requests.length,
      release: () => undefined,
      answerWith: () => { throw new Error('the find fixture has fixed per-source answers'); },
      close: async () => {
        try {
          for (const socket of sockets) socket.destroy();
          await new Promise<void>((resolve, reject) => server!.close((error) => error ? reject(error) : resolve()));
        } finally {
          await stopTls();
          removeStateDir(folder);
        }
      },
    };
  } catch (error) {
    for (const socket of sockets) socket.destroy();
    if (server?.listening) await new Promise<void>((resolve) => server!.close(() => resolve()));
    await stopTls();
    removeStateDir(folder);
    throw error;
  }
}
