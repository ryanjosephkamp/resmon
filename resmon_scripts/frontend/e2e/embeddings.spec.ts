/**
 * Ranking by meaning, in the real app (phase 1.9a, D7).
 *
 * Two arms, and the first is the one phase 1.9's P5 actually requires:
 *
 * **Absent.** A build that cannot rank shows *no* sort control and *no* similar
 * panel. Not disabled-with-a-tooltip — absent, the way a missing agent CLI
 * reads. This arm always runs: a fresh app has an empty corpus and no embedding
 * lane, which is the state every install starts in.
 *
 * **Present.** With an embedding model configured and papers embedded, the sort
 * control appears, ranks, and labels itself with what it ranked against. Getting
 * there needs documents in the corpus, and the only way to put them there is a
 * real search — the schema is not this suite's to write to (the rule
 * `search-record.spec.ts` set). So this arm seeds through the backend's own API
 * and **skips with a printed reason** when the machine could not reach a
 * repository, the same shape `ai-settings.spec.ts` uses for the arms that need
 * an absent CLI. Both CI jobs have network, so it runs there.
 *
 * The embedding model is a Node server this spec starts on loopback, returning
 * a deterministic vector per text. The backend calls it over a real socket with
 * its real client; nothing about resmon is stubbed. What that cannot see is a
 * real provider's own behaviour, and the handback says so.
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

test.describe.configure({ mode: 'serial' });

const DIMS = 8;

/** The same hash-derived unit vector the Python fixture uses. Deterministic, not a model. */
function deterministicVector(text: string): number[] {
  const digest = crypto.createHash('sha256').update(text, 'utf8').digest();
  const raw: number[] = [];
  for (let i = 0; i < DIMS; i += 1) raw.push(digest[i % digest.length] / 255 - 0.5);
  const norm = Math.sqrt(raw.reduce((a, v) => a + v * v, 0)) || 1;
  return raw.map((v) => v / norm);
}

/** A loopback server speaking Ollama's `/api/embed`. */
async function startEmbeddingServer(): Promise<{ url: string; close: () => Promise<void> }> {
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      let input: string[] = [];
      try {
        const parsed = JSON.parse(body || '{}');
        input = Array.isArray(parsed.input) ? parsed.input : [parsed.input].filter(Boolean);
      } catch { /* an unparseable body yields no vectors, which the client rejects */ }
      const payload = JSON.stringify({ embeddings: input.map(deterministicVector) });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(payload);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as { port: number };
  return {
    url: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>((resolve) => { server.close(() => resolve()); }),
  };
}

interface Launched {
  app: ElectronApplication;
  win: Page;
  close: () => Promise<void>;
}

async function launch(): Promise<Launched> {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'resmon-e2e-emb-'));
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
    cwd: FRONTEND_ROOT,
    env,
    timeout: 180_000,
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
    app,
    win,
    close: async () => {
      await app.close().catch(() => { /* already gone */ });
      fs.rmSync(stateDir, { recursive: true, force: true });
    },
  };
}

async function goto(win: Page, hash: string): Promise<void> {
  await win.evaluate((h) => { window.location.hash = `#${h}`; }, hash);
  await win.waitForFunction((h) => window.location.hash.startsWith(`#${h}`), hash,
    { timeout: 15_000 });
  await win.waitForLoadState('networkidle').catch(() => { /* long-poll pages never idle */ });
  await win.waitForTimeout(600);
}

/** Call the app's own backend from inside the renderer, on its own origin. */
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


// ---------------------------------------------------------------------------
// P5 — absent
// ---------------------------------------------------------------------------

test('P5: a build that cannot rank shows no sort control and no similar panel', async () => {
  const { win, close } = await launch();
  try {
    const health = await api(win, 'GET', '/api/health');
    // The extension may well load here — sqlite-vec is a runtime dependency —
    // and that is not the same thing as being able to rank. With an empty index
    // the capability is false and the controls must still be absent.
    console.log('P5 HEALTH EMBEDDINGS', JSON.stringify(health.body.embeddings));
    const status = await api(win, 'GET', '/api/embeddings/status');
    expect(status.body.capability.available).toBe(false);
    expect(status.body.capability.reason,
      'an unavailable capability must always carry a reason').toBeTruthy();
    console.log('P5 CAPABILITY', JSON.stringify(status.body.capability));

    await goto(win, '/explorer?q=diffusion');
    await expect(win.getByTestId('explorer-sort')).toHaveCount(0);
    await expect(win.getByTestId('similar-toggle')).toHaveCount(0);
    // And nothing raised: the page rendered its normal self.
    await expect(win.locator('.explorer-results-head')).toBeVisible();
  } finally {
    await close();
  }
});

test('the Embeddings settings section states what cannot embed rather than hiding it',
  async () => {
    const { win, close } = await launch();
    try {
      await goto(win, '/settings/ai');
      const panel = win.getByTestId('embedding-settings');
      await expect(panel).toBeVisible();

      const note = await win.getByTestId('embedding-cannot-note').innerText();
      expect(note).toContain('An Anthropic key cannot do this');
      expect(note).toContain('neither agent CLI can either');

      // Enable, so the provider list renders, and check that a provider which
      // cannot embed is present-and-disabled rather than quietly missing.
      await panel.getByRole('checkbox').check();
      const select = panel.getByLabel('Embedding provider');
      await expect(select).toBeVisible();
      const options = await select.locator('option').evaluateAll(
        (els) => els.map((e) => ({
          value: (e as HTMLOptionElement).value,
          disabled: (e as HTMLOptionElement).disabled,
          label: (e as HTMLOptionElement).textContent || '',
        })),
      );
      console.log('EMBEDDING PROVIDER OPTIONS', JSON.stringify(options));
      // The denominator is the backend's own table, fetched here rather than
      // written down: 11 providers, all offered as options.
      const answers = (await api(win, 'GET', '/api/settings/embeddings')).body.providers;
      expect(options.map((o) => o.value).sort())
        .toEqual(answers.map((p: any) => p.provider).sort());
      for (const answer of answers) {
        const option = options.find((o) => o.value === answer.provider)!;
        expect(option.disabled, `${answer.provider} option enabled state`)
          .toBe(!answer.offered);
      }
      const anthropic = options.find((o) => o.value === 'anthropic')!;
      expect(anthropic.disabled).toBe(true);
      expect(anthropic.label).toContain('cannot embed');
    } finally {
      await close();
    }
  });


// ---------------------------------------------------------------------------
// Present — the sort control, the label, the similar panel
// ---------------------------------------------------------------------------

test('the sort control appears, ranks, and says what it ranked against', async () => {
  const model = await startEmbeddingServer();
  const { win, close } = await launch();
  try {
    const saved = await api(win, 'PUT', '/api/settings/embeddings', {
      settings: {
        embedding_enabled: 'true',
        embedding_provider: 'local',
        embedding_model: 'e2e-model',
        embedding_endpoint: model.url,
      },
    });
    expect(saved.status).toBe(200);
    const probe = await api(win, 'POST', '/api/embeddings/probe', {});
    expect(probe.body.ok, `probe said: ${probe.body.reason}`).toBe(true);

    // Seed through the backend's own API, as search-record.spec.ts does. The
    // execution row is written before the network is touched, so this always
    // creates an execution; whether it creates *papers* depends on the machine
    // reaching a repository.
    const dive = await api(win, 'POST', '/api/search/dive', {
      repository: 'arxiv', query: 'graph neural network',
      keywords: ['graph neural network'], max_results: 5, ai_enabled: false,
    });
    expect(dive.status).toBe(200);
    const execId = dive.body.execution_id as number;

    const deadline = Date.now() + 120_000;
    let embedded = 0;
    while (Date.now() < deadline) {
      const exec = await api(win, 'GET', `/api/executions/${execId}`);
      if (exec.body?.status && exec.body.status !== 'running') {
        embedded = (await api(win, 'GET', '/api/embeddings/status')).body.coverage.embedded;
        if (embedded > 0) break;
        // The run finished with nothing to embed.
        break;
      }
      await win.waitForTimeout(1000);
    }
    console.log('EMBEDDED AFTER SEED', embedded);
    test.skip(
      embedded === 0,
      'NOT VERIFIED — this machine could not reach a repository, so the corpus is '
      + 'empty and there is nothing to rank. The absent-control arm above still ran. '
      + 'Both CI jobs have network and run this.',
    );

    const status = await api(win, 'GET', '/api/embeddings/status');
    expect(status.body.capability.available).toBe(true);

    // A term guaranteed to match: taken from a paper the seed actually stored,
    // because a repository answers a multi-word query with papers containing
    // none of its words.
    const page = await api(win, 'POST', '/api/explorer/search', { limit: 5 });
    const title = String(page.body.results[0].title);
    const term = title.split(/\s+/).find((w) => w.length > 5 && /^[A-Za-z]+$/.test(w));
    test.skip(!term, 'NOT VERIFIED — no usable single-word search term in the seeded corpus');

    await goto(win, `/explorer?q=${encodeURIComponent(term!)}`);
    await expect(win.getByTestId('explorer-sort')).toBeVisible();
    await expect(win.getByTestId('similar-toggle').first()).toBeVisible();

    // Switch to the ranking through the control itself, not by editing the URL.
    await win.getByTestId('explorer-sort').locator('select').selectOption('similarity');
    await win.waitForTimeout(1500);

    const note = await win.getByTestId('rank-note').innerText();
    console.log('RANK NOTE', JSON.stringify(note));
    expect(note).toContain('Closest to:');
    expect(note).toContain(term!);
    expect(note).toContain('e2e-model');

    // A distance is rendered on the rows, and it is a number rather than a word.
    const distances = await win.locator('.explorer-distance').allInnerTexts();
    console.log('RANK DISTANCES', JSON.stringify(distances));
    expect(distances.length).toBeGreaterThan(0);
    expect(distances.some((d) => /^\d+\.\d{3}$/.test(d.trim()))).toBe(true);

    // The similar panel opens and either lists neighbours with distances, or
    // says why it cannot. A bare empty list is the thing being ruled out.
    await win.getByTestId('similar-toggle').first().click();
    await expect(win.getByTestId('similar-body').first()).toBeVisible();
    const body = await win.getByTestId('similar-body').first().innerText();
    console.log('SIMILAR BODY', JSON.stringify(body.slice(0, 300)));
    expect(body.trim().length).toBeGreaterThan(0);
  } finally {
    await close();
    await model.close();
  }
});
