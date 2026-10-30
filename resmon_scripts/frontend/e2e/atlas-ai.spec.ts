/**
 * Atlas: Settings → AI, in the real app: a stored chain of summary lanes kept
 * when the main one changes, the ways Ask can run in words that claim only
 * what was checked, and embeddings set up, priced, stopped, resumed, and used
 * to rank the collection.
 *
 * **Nothing here calls a model.** The command the chain names is a script in
 * this spec's state directory that resmon finds and never runs. The embedding
 * model is a Node server on loopback returning a hash-derived vector per text,
 * as `embeddings.spec.ts` uses; it waits a little before each answer so that a
 * backfill lasts long enough to be stopped. What is the app's own: the settings
 * writes, the engine's reading of the chain (checked with `resolve_chain`
 * itself), the probe, the estimate, the backfill and its stop, the index
 * rebuild, and every sentence on the screen.
 *
 * J09 and J11 drive the same section through `journeys/drivers/atlas.ts`.
 */
import { spawnSync } from 'child_process';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as http from 'http';
import * as net from 'net';
import * as os from 'os';
import * as path from 'path';
import { test, expect, _electron as electron, type Page } from '@playwright/test';
import { FRONTEND_ROOT, SCREENSHOT_DIR, launchEnv, registerStateDir } from './fixtures/resmon-app';

const MODEL = 'e2e-embed';
const DIMS = 8;

/** Three papers with words to embed, and one with neither title nor abstract, which has nothing to embed. */
const SEED = String.raw`
import json, os, sys
sys.path.insert(0, sys.argv[1])
from implementation_scripts.database import init_db, get_connection, insert_document
path = os.environ["RESMON_DB_PATH"]
init_db(path)
conn = get_connection(path)
ids = []
for n, (title, abstract) in enumerate((
    ("Perovskite solar cells that keep their efficiency", "Layered films that resist moisture."),
    ("Light-emitting diodes from layered crystals", "Bright emission from thin crystals."),
    ("Moisture and the stability of thin films", "An authored abstract for the suite."),
    ("", None),
)):
    ids.append(insert_document(conn, {
        "source_repository": "arxiv", "external_id": f"e2e-ai-{n}", "title": title, "abstract": abstract,
        "authors": "Ada Fixture", "publication_date": f"2026-10-0{n + 1}", "metadata_hash": f"e2e-ai-{n}",
    }))
print(json.dumps({"ids": ids}))
`;

/** The engine's own reading of the stored summary settings: the lanes a run would use, in order. */
const RESOLVE = String.raw`
import json, os, sqlite3, sys
sys.path.insert(0, sys.argv[1])
from implementation_scripts.ai_lanes import resolve_chain
conn = sqlite3.connect(os.environ["RESMON_DB_PATH"])
settings = dict(conn.execute("SELECT key, value FROM app_settings WHERE key LIKE 'ai_%'").fetchall())
print(json.dumps([{"kind": l.kind, "provider": l.provider, "model": l.model, "binary_path": l.binary_path,
                   "effort": l.effort, "doc_cap": l.doc_cap, "batch_size": l.batch_size} for l in resolve_chain(settings)]))
`;

function vectorFor(text: string): number[] {
  const digest = crypto.createHash('sha256').update(text, 'utf8').digest();
  const raw: number[] = [];
  for (let i = 0; i < DIMS; i += 1) raw.push(digest[i % digest.length]! / 255 - 0.5);
  const norm = Math.sqrt(raw.reduce((a, v) => a + v * v, 0)) || 1;
  return raw.map((v) => v / norm);
}

/** Ollama's `/api/embed` on loopback, answering after `delayMs`. */
async function startEmbedder(delayMs: number): Promise<{ url: string; requests: () => number; close: () => Promise<void> }> {
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
      } catch { /* no vectors, which the client refuses */ }
      setTimeout(() => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ embeddings: input.map((t) => vectorFor(String(t))) }));
      }, delayMs);
    });
  });
  server.on('connection', (socket) => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as net.AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    requests: () => requests,
    close: async () => {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

async function api<T>(win: Page, method: string, route: string, body?: unknown): Promise<{ status: number; body: T }> {
  return win.evaluate(async ([m, r, b]) => {
    const port = (window as unknown as { resmonAPI: { getBackendPort(): string } }).resmonAPI.getBackendPort();
    const res = await e2eFetch(`http://127.0.0.1:${port}${r}`, {
      method: m, headers: { 'Content-Type': 'application/json' },
      body: b === undefined ? undefined : JSON.stringify(b),
    });
    return { status: res.status, body: await res.json() as unknown };
  }, [method, route, body] as const) as Promise<{ status: number; body: T }>;
}

test('Settings → AI: a fallback chain kept, Ask in checked words, and embeddings set up, priced, stopped, resumed, and ranked', async () => {
  test.setTimeout(300_000);
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'resmon-e2e-atlas-ai-'));
  const env: Record<string, string> = { ...launchEnv(stateDir, true), RESMON_UI: 'atlas' };
  const backend = path.join(FRONTEND_ROOT, '..');
  const seeded = spawnSync(env.RESMON_PYTHON ?? 'python3', ['-c', SEED, backend], { env, encoding: 'utf8' });
  expect(seeded.status, seeded.stderr).toBe(0);
  const engineLanes = () => {
    const read = spawnSync(env.RESMON_PYTHON ?? 'python3', ['-c', RESOLVE, backend], { env, encoding: 'utf8' });
    expect(read.status, read.stderr).toBe(0);
    return JSON.parse(read.stdout.trim().split('\n').pop() ?? '[]') as Record<string, unknown>[];
  };
  // A command resmon finds and never runs: Settings only looks for it.
  const command = path.join(stateDir, 'claude');
  fs.writeFileSync(command, '#!/bin/sh\nexit 1\n', { mode: 0o755 });
  const embedder = await startEmbedder(700);

  const app = await electron.launch({
    args: ['.', `--user-data-dir=${path.join(stateDir, 'electron-user-data')}`],
    cwd: FRONTEND_ROOT, env, colorScheme: null, timeout: 180_000,
  });
  registerStateDir(stateDir);
  try {
    const win = await app.firstWindow({ timeout: 180_000 });
    const problems: string[] = [];
    win.on('pageerror', (e) => problems.push(e.message));
    await win.getByRole('navigation', { name: 'Sections' }).waitFor({ timeout: 120_000 });

    // A chain as the classic Settings stores one: a command first, then a key and a local model.
    const fallbacks = [
      { kind: 'api_key', provider: 'openai', model: 'gpt-4o-mini', label: 'OpenAI · gpt-4o-mini' },
      { kind: 'local', provider: 'local', model: 'llama3', endpoint: 'http://127.0.0.1:9' },
    ];
    const chain = [
      { kind: 'subscription', provider: 'claude_code', model: 'sonnet', binary_path: command, effort: 'high', doc_cap: 20, batch_size: 3 },
      ...fallbacks,
    ];
    const seededAi = await api(win, 'PUT', '/api/settings/ai', {
      settings: { ai_provider: 'claude_code', ai_model: 'sonnet', ai_cli_path: command, ai_effort: 'high', ai_chain: JSON.stringify(chain) },
    });
    expect(seededAi.status).toBe(200);

    // — Summaries: the chain's first lane in the form, its fallbacks beside it ---------------
    await win.evaluate(() => { window.location.hash = '#/settings/ai'; });
    const group = win.locator('section.settings-group.ai');
    await expect(group).toHaveAttribute('aria-busy', 'false', { timeout: 60_000 });
    const summary = win.getByRole('form', { name: 'Summary settings' });
    await expect(summary.locator('#ai-provider')).toHaveValue('claude_code');
    await expect(summary.locator('#ai-model')).toHaveValue('sonnet');
    await expect(summary.locator('#ai-cli-path')).toHaveValue(command);
    await expect(summary.locator('#ai-effort')).toHaveValue('high');
    await expect(summary).toContainText('Papers are sent 3 at a time, and a run sends at most 20 to it.');
    const lanes = summary.locator('[data-ai="fallbacks"] li');
    await expect(lanes).toHaveText([
      /^OpenAI · gpt-4o-mini, with your OpenAI key/,
      /^Ollama · llama3, on http:\/\/127\.0\.0\.1:9/,
    ]);
    fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });
    await summary.locator('[data-ai="fallbacks"]').scrollIntoViewIfNeeded();
    await win.screenshot({ path: path.join(SCREENSHOT_DIR, 'atlas-ai-summaries.png') });

    // Changing the main lane keeps every fallback exactly as stored, and the engine reads the change.
    await summary.locator('#ai-model').fill('opus');
    await summary.getByRole('button', { name: 'Save summary settings' }).click();
    await expect(summary.locator('.settings-said')).toHaveText('Saved.', { timeout: 30_000 });
    const stored = (await api<{ ai_chain: string; ai_model: string }>(win, 'GET', '/api/settings/ai')).body;
    expect(stored.ai_model).toBe('opus');
    expect(JSON.parse(stored.ai_chain)).toEqual([
      { kind: 'subscription', provider: 'claude_code', model: 'opus', binary_path: command, effort: 'high', doc_cap: 20, batch_size: 3 },
      ...fallbacks,
    ]);
    expect(engineLanes().map((l) => [l.provider, l.model])).toEqual([['claude_code', 'opus'], ['openai', 'gpt-4o-mini'], ['local', 'llama3']]);
    expect(engineLanes()[0]).toMatchObject({ binary_path: command, effort: 'high', doc_cap: 20, batch_size: 3 });

    // A fallback removed here is gone from what a run uses, and the rest keep their order.
    await summary.getByRole('button', { name: 'Remove the fallback OpenAI · gpt-4o-mini, with your OpenAI key' }).click();
    await expect(summary.locator('[data-ai="fallbacks-removed"]')).toContainText('Save to stop using it');
    await summary.getByRole('button', { name: 'Save summary settings' }).click();
    await expect(summary.locator('.settings-said')).toHaveText('Saved.', { timeout: 30_000 });
    await expect(lanes).toHaveCount(1);
    expect(engineLanes().map((l) => l.provider)).toEqual(['claude_code', 'local']);

    // — Ask: a command found is not a command that runs ----------------------------------------
    const route = win.locator('[data-ai="routes"] li[data-kind="claude_cli"]');
    await expect(route).toContainText(`Using the path you set: ${command}`, { timeout: 30_000 });
    await expect(route).toContainText('Sign-in and model acceptance are unverified until the first message.');
    await expect(route).not.toContainText('can run');

    // — Embeddings: what is missing, counted, before anything is set up -------------------------
    const part = win.locator('section.embeddings');
    await expect(part.locator('[data-embeddings="embedded"] dd')).toHaveText('None: no embedding model is set up.');
    await expect(part.locator('[data-embeddings="missing"] dd')).toHaveText('4 papers: no embedding model is set up to make vectors.');
    // The macos-15 runner's python3 cannot load SQLite extensions (embeddings.spec.ts says more).
    // There the screen must say so in both places, and nothing past this point can rank.
    const health = await api<{ embeddings?: { extension: string | null; reason?: string } }>(win, 'GET', '/api/health');
    if (!health.body.embeddings?.extension) {
      await expect(part.locator('[data-embeddings="index"] dd')).toHaveText(/^Not loaded: .+ vectors are still made and kept, and are used once the extension loads\.$/);
      await expect(part.locator('[data-embeddings="ranking"] dd'))
        .toContainText('Ranking by meaning is off: the similarity index (sqlite-vec) did not load in this copy of resmon');
      console.log('ATLAS AI EMBEDDINGS NOT VERIFIED (extension) — this machine cannot load sqlite-vec '
        + `(${health.body.embeddings?.reason}), so setup, backfill, and ranking were not exercised here.`);
      expect(problems, 'the renderer threw').toEqual([]);
      return;
    }
    await expect(part.locator('[data-embeddings="index"] dd')).toHaveText(/^sqlite-vec v\d/);
    await expect(part.locator('[data-embeddings="ranking"] dd'))
      .toHaveText('Ranking by meaning is off: no embedding model is set up, so none of your 4 papers has a vector.');

    const lane = part.getByRole('form', { name: 'Embedding settings' });
    await lane.locator('[data-switch="embedding_enabled"]').click();
    await expect(lane.getByLabel('Provider', { exact: true })).toHaveValue('local');

    // A provider that cannot embed is refused when it is chosen, and the engine refuses it too.
    await lane.getByLabel('Provider', { exact: true }).selectOption('anthropic');
    await expect(lane.locator('[data-embeddings="refusal"]')).toContainText('Anthropic does not offer an embeddings API');
    await expect(lane.getByRole('button', { name: 'Save embedding settings' })).toBeDisabled();
    const refused = await api<{ detail: string }>(win, 'PUT', '/api/settings/embeddings', {
      settings: { embedding_enabled: 'true', embedding_provider: 'anthropic' },
    });
    expect(refused.status).toBe(400);
    expect(refused.body.detail).toContain('Anthropic does not offer an embeddings API');

    // Ollama on loopback: probed, then saved.
    await lane.getByLabel('Provider', { exact: true }).selectOption('local');
    await lane.getByLabel('Model', { exact: true }).fill(MODEL);
    await lane.getByLabel('Ollama endpoint', { exact: true }).fill(embedder.url);
    await lane.getByRole('button', { name: 'Probe this model' }).click();
    await expect(lane.locator('[data-embeddings="probe"]')).toHaveText(`${MODEL} answered with an ${DIMS}-dimensional vector.`, { timeout: 30_000 });
    await expect(lane.locator('[data-embeddings="probe"]')).toHaveAttribute('data-ok', 'true');
    await lane.getByRole('button', { name: 'Save embedding settings' }).click();
    await expect(lane.locator('[data-embeddings="saved"]')).toHaveText('Saved.', { timeout: 30_000 });
    await expect(part.locator('[data-embeddings="embedded"] dd')).toHaveText(`0 of 4 papers, with ${MODEL}.`, { timeout: 30_000 });
    await expect(part.locator('[data-embeddings="missing"]')).toHaveAttribute('data-count', '4');
    await expect(part.locator('[data-embeddings="ranking"] dd'))
      .toHaveText(`Ranking by meaning is off: none of your 4 papers has a vector from ${MODEL} yet.`);

    // One paper per call, so the backfill can be stopped between them. Not a field on the form.
    expect((await api(win, 'PUT', '/api/settings/embeddings', { settings: { embedding_batch_size: '1' } })).status).toBe(200);

    // The cost first: the only way to start is the button the estimate puts there.
    const backfill = part.locator('[data-embeddings="backfill"]');
    await expect(backfill.getByRole('button', { name: /^Embed / })).toHaveCount(0);
    await backfill.getByRole('button', { name: 'Estimate the work' }).click();
    const estimate = backfill.locator('[data-embeddings="estimate"]');
    await expect(estimate).toContainText('3 papers to embed, about');
    await expect(estimate).toContainText('A local model runs on your machine and costs nothing to call.');
    await expect(estimate).toContainText(`${DIMS}-dimensional vectors`);
    await expect(estimate).toContainText('1 other paper has no title or abstract, so there is nothing to embed for it.');
    fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });
    await estimate.scrollIntoViewIfNeeded();
    await win.screenshot({ path: path.join(SCREENSHOT_DIR, 'atlas-ai-embeddings-estimate.png') });

    // Started, then stopped after the batch in flight: what was made is kept.
    await backfill.getByRole('button', { name: 'Embed 3 papers' }).click();
    await expect(backfill.locator('[data-embeddings="progress"]')).toBeVisible();
    await backfill.getByRole('button', { name: 'Stop after this batch' }).click();
    await expect(backfill).toHaveAttribute('data-running', 'false', { timeout: 30_000 });
    await expect(backfill.locator('[data-embeddings="outcome"]'))
      .toHaveText(/^Stopped after [0-2] of 4 papers, as asked\. The vectors made are kept; embedding again starts from the papers still missing\.$/);
    const stopped = (await api<{ coverage: { embedded: number } }>(win, 'GET', '/api/embeddings/status')).body.coverage.embedded;
    expect(stopped, 'the stop did not stop between batches').toBeLessThan(3);
    await expect(part.locator('[data-embeddings="embedded"] dd')).toHaveText(`${stopped} of 4 papers, with ${MODEL}.`);

    // Resumed from what is missing: priced again, and finished.
    await backfill.getByRole('button', { name: 'Estimate the work' }).click();
    await expect(estimate).toContainText(`${3 - stopped} paper${3 - stopped === 1 ? '' : 's'} to embed`);
    await backfill.getByRole('button', { name: /^Embed \d paper/ }).click();
    await expect(backfill.locator('[data-embeddings="outcome"]'))
      .toHaveText(`Embedded ${3 - stopped} of ${4 - stopped} papers with ${MODEL}. 1 paper had no title or abstract to embed.`, { timeout: 60_000 });
    await expect(part.locator('[data-embeddings="embedded"] dd')).toHaveText(`3 of 4 papers, with ${MODEL}.`);
    await expect(part.locator('[data-embeddings="missing"] dd')).toHaveText(`1 paper has no vector from ${MODEL} yet. `
      + 'The last backfill found 1 paper with no title or abstract to embed; it stays missing. '
      + 'It is kept and searchable by its words, and is listed last when the collection is ranked by meaning.');
    await expect(part.locator('[data-embeddings="index"] dd')).toHaveText(/^sqlite-vec v[\d.]+, holding 3 vectors, 8 dimensions each\.$/);
    await expect(part.locator('[data-embeddings="ranking"] dd'))
      .toHaveText(`Ranking by meaning is on. 1 paper without a vector from ${MODEL} is listed last.`);

    // The index rebuilt from the stored vectors says what it now holds.
    await backfill.getByRole('button', { name: 'Rebuild the index' }).click();
    await expect(backfill.locator('[data-embeddings="rebuilt"]')).toHaveText('Rebuilt: the index holds 3 vectors, 8 dimensions each.');
    await backfill.locator('[data-embeddings="rebuilt"]').scrollIntoViewIfNeeded();
    await win.screenshot({ path: path.join(SCREENSHOT_DIR, 'atlas-ai-embeddings.png') });

    // — The collection ranks by meaning, and counts the paper it could not rank ---------------
    await win.getByRole('navigation', { name: 'Sections' }).getByRole('link', { name: 'Search' }).click();
    await expect(win.getByRole('heading', { name: 'Your collection', level: 1 })).toBeVisible({ timeout: 30_000 });
    await expect(win.locator('section.results')).toHaveAttribute('data-capability', 'available', { timeout: 30_000 });
    await expect(win.locator('[data-collection="ranking"]')).toHaveCount(0);
    await win.getByLabel('Search your collection').fill('moisture in thin films');
    await win.getByLabel('Search your collection').press('Enter');
    await win.getByRole('group', { name: 'Order' }).getByRole('button', { name: 'Closest in meaning' }).click();
    await expect(win.locator('.rank-note').first()).toContainText(`Closest to: moisture in thin films — using ${MODEL}`, { timeout: 30_000 });
    await expect(win.locator('.rank-note').first()).toContainText('3 ranked, 1 not embedded yet and listed last');
    await expect(win.locator('.result .result-distance').last()).toHaveText('not ranked');
    expect(embedder.requests(), 'the model was never called').toBeGreaterThan(3);

    expect(problems, 'the renderer threw').toEqual([]);
  } finally {
    await app.close().catch(() => {});
    await embedder.close();
    fs.rmSync(stateDir, { recursive: true, force: true });
  }
});
