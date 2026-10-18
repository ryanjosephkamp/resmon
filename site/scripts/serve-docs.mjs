#!/usr/bin/env node
/**
 * Serve `docs/` the way GitHub Pages serves it, for looking at the real built
 * output rather than the dev server's version of it.
 *
 * The difference matters. `astro dev` renders pages on request and resolves
 * `base` differently from a static host; the thing that will actually be
 * published is the directory of files in `docs/`, mounted under `/resmon/`,
 * with `index.html` served for a URL ending in a slash and `404.html` for
 * anything missing. That is what this reproduces.
 *
 * Usage, from `site/`:   node scripts/serve-docs.mjs [--port 4399]
 * Then open http://127.0.0.1:4399/resmon/
 */
import { createServer } from 'node:http';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { join, dirname, extname, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const DOCS = join(HERE, '..', '..', 'docs');
const BASE = '/resmon';

const portArg = process.argv.indexOf('--port');
const PORT = portArg === -1 ? 4399 : Number(process.argv[portArg + 1]);

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

const server = createServer((request, response) => {
  const { pathname } = new URL(request.url ?? '/', `http://127.0.0.1:${PORT}`);

  if (pathname === BASE) {
    response.writeHead(301, { Location: `${BASE}/` });
    response.end();
    return;
  }

  let relativePath = pathname.startsWith(`${BASE}/`) ? pathname.slice(BASE.length + 1) : null;

  if (relativePath === null) {
    response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    response.end(`This site is served under ${BASE}/ — try http://127.0.0.1:${PORT}${BASE}/\n`);
    return;
  }

  // `..` must not escape the published directory, exactly as it cannot on Pages.
  relativePath = normalize(decodeURIComponent(relativePath)).replace(/^(\.\.(\/|$))+/, '');

  let file = join(DOCS, relativePath);
  if (relativePath === '' || relativePath.endsWith('/') || (existsSync(file) && statSync(file).isDirectory())) {
    file = join(file, 'index.html');
  }

  if (!existsSync(file) || !statSync(file).isFile()) {
    const notFound = join(DOCS, '404.html');
    const body = existsSync(notFound) ? readFileSync(notFound) : Buffer.from('Not found\n');
    response.writeHead(404, { 'Content-Type': 'text/html; charset=utf-8' });
    response.end(body);
    return;
  }

  response.writeHead(200, {
    'Content-Type': TYPES[extname(file)] ?? 'application/octet-stream',
  });
  response.end(readFileSync(file));
});

// 127.0.0.1 only. Nothing here should be reachable from the network.
server.listen(PORT, '127.0.0.1', () => {
  process.stdout.write(`serving docs/ at http://127.0.0.1:${PORT}${BASE}/\n`);
});
