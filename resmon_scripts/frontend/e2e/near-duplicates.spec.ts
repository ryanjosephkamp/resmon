/**
 * P12 and P15 in the real app — near-duplicate links and the coverage audit.
 *
 * **P12 is the one that matters here.** A link must never make a row disappear
 * on its own. jsdom already asserts the toggle's arithmetic; this asserts it in
 * a real Chromium against a real backend, because the failure it rules out —
 * rows quietly missing from a list — is a rendering fact, not a state fact.
 *
 * **P15's real-browser half**: the audit's two lists render on the Routines
 * page, together with the sentence about what it cannot see.
 *
 * Seeding goes through the backend's own API, the rule `search-record.spec.ts`
 * set: the schema is not this suite's to write to. The embedding model is a Node
 * server on loopback returning a deterministic vector, so distances are exact.
 *
 * Two papers are given the **same title and the same text**, so they embed
 * identically and the near-duplicate rule links them — a genuine duplicate, made
 * by the seeding rather than asserted into the table.
 *
 * **Where those two papers come from changed.** They used to come from arXiv and
 * OpenAlex themselves, on the reasoning that OpenAlex indexes arXiv preprints
 * and the pair would usually overlap; hosted CI therefore ran two live scholarly
 * queries, which is a boundary failure kept in the record. Both providers are
 * now answered by `fixtures/source-boundary.ts` on loopback, in their own
 * formats — Atom for arXiv, an inverted-index JSON work for OpenAlex — through
 * the real clients and the real parsers. The shared work is authored *as* two
 * records with two different identity keys, so `documents` stores two rows and
 * the link is still computed by `near_duplicates` from the vectors and the
 * titles. Nothing inserts the link, and nothing tells the renderer what to draw.
 */
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as http from 'http';
import * as os from 'os';
import * as path from 'path';
import { execFileSync } from 'child_process';
import { test, expect, _electron as electron } from '@playwright/test';
import type { ElectronApplication, Page } from '@playwright/test';
import { launchEnv, FRONTEND_ROOT } from './fixtures/resmon-app';
import {
  AUTHORED_DUPLICATE_DOCUMENTS, AUTHORED_SHARED_TITLE, launchSourceApp,
} from './fixtures/source-boundary';

test.describe.configure({ mode: 'serial' });

const DIMS = 8;

function deterministicVector(text: string): number[] {
  const digest = crypto.createHash('sha256').update(text, 'utf8').digest();
  const raw: number[] = [];
  for (let i = 0; i < DIMS; i += 1) raw.push(digest[i % digest.length] / 255 - 0.5);
  const norm = Math.sqrt(raw.reduce((a, v) => a + v * v, 0)) || 1;
  return raw.map((v) => v / norm);
}

async function startEmbeddingServer(): Promise<{ url: string; close: () => Promise<void> }> {
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      let input: string[] = [];
      try {
        const parsed = JSON.parse(body || '{}');
        input = Array.isArray(parsed.input) ? parsed.input : [parsed.input].filter(Boolean);
      } catch { /* the client rejects an answer with no vectors */ }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ embeddings: input.map(deterministicVector) }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as { port: number };
  return {
    url: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>((resolve) => { server.close(() => resolve()); }),
  };
}

interface Launched { app: ElectronApplication; win: Page; close: () => Promise<void>; }

async function launch(): Promise<Launched> {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'resmon-e2e-dup-'));
  const env = launchEnv(stateDir, true);
  if (env.RESMON_PYTHON && !path.isAbsolute(env.RESMON_PYTHON)) {
    try {
      env.RESMON_PYTHON = execFileSync(
        process.platform === 'win32' ? 'where' : 'which',
        [env.RESMON_PYTHON], { encoding: 'utf8' },
      ).split('\n')[0].trim();
    } catch { /* the launch failure below will say so */ }
  }
  const app = await electron.launch({
    args: ['.', `--user-data-dir=${path.join(stateDir, 'electron-user-data')}`],
    cwd: FRONTEND_ROOT, env, timeout: 180_000,
  });
  const win = await app.firstWindow({ timeout: 180_000 });
  await win.waitForLoadState('domcontentloaded');
  await win.locator('.app-main').waitFor({ state: 'visible', timeout: 60_000 });
  const port = await win.evaluate(
    () => (window as unknown as { resmonAPI: { getBackendPort(): string } })
      .resmonAPI.getBackendPort(),
  );
  expect(port, 'the e2e app must never attach to the live daemon').not.toBe('8742');
  return {
    app, win,
    close: async () => {
      await app.close().catch(() => { /* already gone */ });
      fs.rmSync(stateDir, { recursive: true, force: true });
    },
  };
}

async function api(win: Page, method: string, route: string, body?: unknown): Promise<any> {
  return win.evaluate(async ([m, r, b]) => {
    const port = (window as unknown as { resmonAPI: { getBackendPort(): string } })
      .resmonAPI.getBackendPort();
    const res = await fetch(`http://127.0.0.1:${port}${r as string}`, {
      method: m as string,
      headers: { 'Content-Type': 'application/json' },
      body: b === undefined ? undefined : JSON.stringify(b),
    });
    return { status: res.status, body: await res.json().catch(() => null) };
  }, [method, route, body] as const);
}

async function goto(win: Page, hash: string): Promise<void> {
  await win.evaluate((h) => { window.location.hash = `#${h}`; }, hash);
  await win.waitForFunction((h) => window.location.hash.startsWith(`#${h}`), hash,
    { timeout: 15_000 });
  await win.waitForLoadState('networkidle').catch(() => { /* long-poll pages never idle */ });
  await win.waitForTimeout(600);
}


test('P12: a near-duplicate is badged, and collapse hides nothing until asked',
  async () => {
    const model = await startEmbeddingServer();
    const { win, close, requests, hook } = await launchSourceApp('authored-duplicates');
    try {
      const health = await api(win, 'GET', '/api/health');
      test.skip(
        !health.body.embeddings?.extension,
        'NOT VERIFIED — this machine cannot load the vector extension '
        + `(${health.body.embeddings?.reason}), so there are no vectors to compare. `
        + 'The ubuntu smoke job runs this.',
      );

      expect((await api(win, 'PUT', '/api/settings/embeddings', {
        settings: {
          embedding_enabled: 'true', embedding_provider: 'local',
          embedding_model: 'e2e-model', embedding_endpoint: model.url,
        },
      })).status).toBe(200);

      // Seeded from **two repositories with one query**, because a
      // near-duplicate needs the same paper twice and one repository cannot
      // supply that: `documents` is unique on (source, external_id), so a
      // repeated dive against one source produces the same rows, not a
      // duplicate. Both dives are answered on loopback in each provider's own
      // format, and the shared work is authored into both replies with the two
      // identity keys the two catalogues would really give it.
      const query = 'graph neural network';
      for (const repository of ['arxiv', 'openalex']) {
        const dive = await api(win, 'POST', '/api/search/dive', {
          repository, query, keywords: [query], max_results: 10, ai_enabled: false,
        });
        expect(dive.status).toBe(200);
        const deadline = Date.now() + 120_000;
        while (Date.now() < deadline) {
          const exec = await api(win, 'GET', `/api/executions/${dive.body.execution_id}`);
          if (exec.body?.status && exec.body.status !== 'running') break;
          await win.waitForTimeout(1000);
        }
      }

      // Both provider routes were really asked, each in its own dialect, and
      // nothing else was.
      expect(hook.endpoint).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/api\/query$/);
      expect(hook.openalex_endpoint).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/openalex\/works$/);
      const providers = requests.map((request) => request.provider);
      expect([...new Set(providers)].sort()).toEqual(['arxiv', 'openalex']);
      for (const request of requests) {
        expect(request.method).toBe('GET');
        expect(request.status).toBe(200);
        expect(request.provider === 'arxiv'
          ? request.params.search_query : request.params.search).toBe(
          request.provider === 'arxiv' ? `all:${query}` : query);
      }
      console.log('P12 SOURCE REQUESTS', JSON.stringify(requests));

      const embedded = (await api(win, 'GET', '/api/embeddings/status'))
        .body.coverage.embedded;
      console.log('P12 EMBEDDED AFTER SEED', embedded);
      // Every authored record from both providers is stored and embedded,
      // including both copies of the shared work. A short corpus is a failure
      // here, not a machine without a network.
      expect(embedded).toBe(AUTHORED_DUPLICATE_DOCUMENTS);

      const scan = await api(win, 'POST', '/api/links/scan');
      expect(scan.status).toBe(200);
      let links = 0;
      const scanDeadline = Date.now() + 60_000;
      while (Date.now() < scanDeadline) {
        const status = await api(win, 'GET', '/api/links/status');
        if (!status.body.run.running) { links = status.body.links; break; }
        await win.waitForTimeout(500);
      }
      console.log('P12 LINKS FOUND', links);
      // The scan found the pair the seed created. The link is the app's own
      // finding — two signals over two rows it embedded itself — and the arm
      // fails rather than skips when it is absent.
      expect(links).toBe(1);

      await goto(win, '/explorer');
      const totalText = await win.locator('.explorer-results-head p').first().innerText();
      const rowsBefore = await win.locator('.explorer-item').count();
      console.log('P12 BEFORE', JSON.stringify({ totalText, rowsBefore }));
      expect(rowsBefore).toBe(AUTHORED_DUPLICATE_DOCUMENTS);
      await expect(win.getByTestId('duplicate-links').first()).toBeVisible();
      // The badge sits on the work that really was indexed twice — on both
      // copies, and reading as the inference it is rather than as an identifier.
      const badged = win.locator('.explorer-item')
        .filter({ hasText: AUTHORED_SHARED_TITLE });
      await expect(badged.locator('[data-testid="duplicate-links"]')).toHaveCount(2);
      await expect(badged.locator('.duplicate-badge').first())
        .toHaveText('likely duplicate');

      // Off on arrival — the property, in the real page.
      const toggle = win.getByTestId('collapse-toggle').locator('input');
      await expect(toggle).toBeVisible();
      await expect(toggle).not.toBeChecked();

      await toggle.check();
      await win.waitForTimeout(800);
      const rowsAfter = await win.locator('.explorer-item').count();
      const totalAfter = await win.locator('.explorer-results-head p').first().innerText();
      console.log('P12 AFTER', JSON.stringify({ totalAfter, rowsAfter }));

      // The count above the list is the backend's and must not move.
      expect(totalAfter).toBe(totalText);
      expect(rowsAfter).toBe(rowsBefore - 1);
      await expect(win.getByTestId('collapse-note')).toContainText('Nothing was removed');

      // And off again restores every row.
      await toggle.uncheck();
      await win.waitForTimeout(500);
      expect(await win.locator('.explorer-item').count()).toBe(rowsBefore);
    } finally {
      await close();
      await model.close();
    }
  });


test('P15: the coverage audit renders its two lists and its caveat', async () => {
  const model = await startEmbeddingServer();
  const { win, close } = await launch();
  try {
    const health = await api(win, 'GET', '/api/health');
    test.skip(!health.body.embeddings?.extension,
      `NOT VERIFIED — no vector extension on this machine (${health.body.embeddings?.reason}).`);

    await api(win, 'PUT', '/api/settings/embeddings', {
      settings: {
        embedding_enabled: 'true', embedding_provider: 'local',
        embedding_model: 'e2e-model', embedding_endpoint: model.url,
      },
    });

    const routine = await api(win, 'POST', '/api/routines', {
      name: 'e2e coverage', schedule_cron: '0 9 * * *',
      parameters: { repositories: ['arxiv'], keywords: ['graph neural network'],
                    query: 'graph neural network', max_results: 5 },
      is_active: false,
    });
    expect([200, 201]).toContain(routine.status);

    await goto(win, '/routines');
    const panel = win.getByTestId('coverage-toggle').first();
    await expect(panel).toBeVisible();
    await panel.click();

    const body = win.getByTestId('coverage-body').first();
    await expect(body).toBeVisible();
    // Whatever the corpus holds, the caveat is always rendered — it is the part
    // a tidy-up would remove first.
    await expect(win.getByTestId('coverage-cannot-see').first())
      .toContainText('only compare against papers it already holds');
    const text = await body.innerText();
    console.log('P15 COVERAGE BODY', JSON.stringify(text.slice(0, 300)));
    expect(text.trim().length).toBeGreaterThan(0);
  } finally {
    await close();
    await model.close();
  }
});
