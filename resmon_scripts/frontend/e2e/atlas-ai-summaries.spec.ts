/**
 * Atlas: summaries, in the real app. A summary lane set up on Settings › AI
 * (a custom endpoint whose stored key is tested, a model chosen from the list
 * the endpoint gives, how each summary is written, two fallbacks added and
 * reordered, a command's limits, and each provider's model remembered); a
 * Deep Dive that summarizes with what Settings › AI holds; one that chooses
 * its own lane and wording for that run alone; and a watch whose editor
 * turns summaries on with a lane of its own, run once from its page.
 *
 * **Nothing here calls a real model.** The provider is an OpenAI-compatible
 * server on loopback in this spec, which lists two authored models, answers
 * every completion with one authored sentence, and records each request,
 * headers included, so the spec can read what each run actually sent: the
 * model, the temperature, the wording asked for, and the key. The key is a
 * test value for that server only, kept in an in-memory keyring. arXiv is a
 * loopback feed of two authored papers. Every other connection the engine
 * tries, and port 8742, is refused by the startup hook, and the spec fails if
 * anything was. The command a lane names is a script resmon finds and never
 * runs. What is the app's own: every control used, the settings and routine
 * it stores, the engine's reading of them (`resolve_chain` itself), the runs,
 * and every sentence on the screen.
 *
 * The watch is saved paused, and run once with Run now; nothing here is left
 * watching.
 */
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as http from 'http';
import * as net from 'net';
import * as os from 'os';
import * as path from 'path';
import { test, expect, _electron as electron, type Page } from '@playwright/test';
import { FRONTEND_ROOT, REPO_ROOT, SCREENSHOT_DIR, launchEnv, registerStateDir } from './fixtures/resmon-app';

/** A test value for the loopback provider below, and for nothing else. */
const KEY = 'e2e-loopback-key-not-a-real-one';
const SUMMARY = 'An authored summary from the loopback provider.';
const MODELS = ['authored-model', 'authored-model-mini'];

const KEYRING = `import keyring.backend
_VALUES = {}
class Keyring(keyring.backend.KeyringBackend):
    priority = 1
    def get_password(self, service, username):
        return _VALUES.get((service, username))
    def set_password(self, service, username, password):
        _VALUES[(service, username)] = password
    def delete_password(self, service, username):
        _VALUES.pop((service, username))
`;

const day = new Date().toISOString().slice(0, 10);
const FEED = `<feed xmlns="http://www.w3.org/2005/Atom">${[1, 2].map((n) => `<entry>
  <id>https://arxiv.org/abs/2610.0000${n}v1</id><title>Authored summaries fixture ${n} on graph learning</title>
  <author><name>Ada Fixture</name></author><published>${day}T00:00:00Z</published>
  <summary>An authored local abstract ${n}, written for this suite and never fetched.</summary>
</entry>`).join('')}</feed>`;

/** The engine's own reading of the stored summary settings: the lanes a run would use, in order. */
const RESOLVE = String.raw`
import json, os, sqlite3, sys
sys.path.insert(0, sys.argv[1])
from implementation_scripts.ai_lanes import resolve_chain
conn = sqlite3.connect(os.environ["RESMON_DB_PATH"])
settings = dict(conn.execute("SELECT key, value FROM app_settings WHERE key LIKE 'ai_%'").fetchall())
print(json.dumps([{"kind": l.kind, "provider": l.provider, "model": l.model, "base_url": l.base_url, "endpoint": l.endpoint,
                   "binary_path": l.binary_path, "doc_cap": l.doc_cap, "batch_size": l.batch_size} for l in resolve_chain(settings)]))
`;

interface Call { method: string; path: string; authorization: string | null; body: Record<string, unknown> }

/** An OpenAI-compatible provider on loopback that lists `MODELS`, answers with `SUMMARY`, and refuses any other key. */
async function startProvider(): Promise<{ url: string; calls: () => Call[]; close: () => Promise<void> }> {
  const calls: Call[] = [];
  const sockets = new Set<net.Socket>();
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => { raw += chunk; });
    req.on('end', () => {
      const body = ((): Record<string, unknown> => {
        try { return JSON.parse(raw || '{}') as Record<string, unknown>; } catch { return {}; }
      })();
      const authorization = (req.headers.authorization as string | undefined) ?? null;
      calls.push({ method: req.method ?? '', path: req.url ?? '', authorization, body });
      res.setHeader('Content-Type', 'application/json');
      if (authorization !== `Bearer ${KEY}`) {
        res.writeHead(401);
        res.end(JSON.stringify({ error: { message: 'The authored provider refuses this key.' } }));
        return;
      }
      if (req.method === 'GET' && (req.url ?? '').endsWith('/models')) {
        res.end(JSON.stringify({ object: 'list', data: MODELS.map((id) => ({ id, object: 'model' })) }));
        return;
      }
      res.end(JSON.stringify({
        id: 'authored', object: 'chat.completion', model: body.model,
        choices: [{ index: 0, message: { role: 'assistant', content: SUMMARY }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 11, completion_tokens: 7, total_tokens: 18 },
      }));
    });
  });
  server.on('connection', (socket) => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as net.AddressInfo;
  expect(port).not.toBe(8742);
  return {
    url: `http://127.0.0.1:${port}/v1`,
    calls: () => [...calls],
    close: async () => {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

async function api<T>(win: Page, method: string, route: string, body?: unknown): Promise<T> {
  return win.evaluate(async ([m, r, b]) => {
    const port = (window as unknown as { resmonAPI: { getBackendPort(): string } }).resmonAPI.getBackendPort();
    const res = await e2eFetch(`http://127.0.0.1:${port}${r}`, {
      method: m, headers: { 'Content-Type': 'application/json' },
      body: b === undefined ? undefined : JSON.stringify(b),
    });
    return await res.json() as unknown;
  }, [method, route, body] as const) as Promise<T>;
}

/** The chat completions a run sent, after `before` calls. */
const completions = (calls: Call[], before: number) => calls.slice(before).filter((c) => c.path.endsWith('/chat/completions'));
const prompt = (call: Call) => JSON.stringify(call.body.messages ?? '');

test('Summaries: a lane set up on Settings › AI, one run’s own choice, and a watch that summarizes', async () => {
  test.setTimeout(420_000);
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'resmon-e2e-atlas-summaries-'));
  const provider = await startProvider();
  const source = http.createServer((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/atom+xml' });
    res.end(FEED);
  });
  await new Promise<void>((resolve) => source.listen(0, '127.0.0.1', resolve));
  const sourcePort = (source.address() as net.AddressInfo).port;

  const hookDir = path.join(stateDir, 'python-hook');
  fs.mkdirSync(hookDir);
  fs.writeFileSync(path.join(hookDir, 'summaries_keyring.py'), KEYRING);
  fs.writeFileSync(path.join(hookDir, 'sitecustomize.py'), `
import ipaddress, json, socket, sys
from pathlib import Path
state = Path(${JSON.stringify(stateDir)})
original_connect = socket.socket.connect
def connect(self, address):
    if isinstance(address, tuple):
        host, port = address[:2]
        try: local = ipaddress.ip_address(host).is_loopback
        except ValueError: local = host == 'localhost'
        if not local or port == 8742:
            with (state / 'blocked.jsonl').open('a') as stream:
                stream.write(json.dumps({'host': host, 'port': port}) + "\\n")
            raise OSError('atlas-summaries test guard refuses external/8742 connection')
    return original_connect(self, address)
socket.socket.connect = connect
sys.path.insert(0, ${JSON.stringify(path.join(REPO_ROOT, 'resmon_scripts'))})
from implementation_scripts import api_arxiv
api_arxiv._ARXIV_API_URL = ${JSON.stringify(`http://127.0.0.1:${sourcePort}/api/query`)}
`);
  // The sentence tokenizer a summary run imports, from the journeys' committed copy, so nothing is downloaded.
  const nltk = path.join(stateDir, 'nltk-data');
  fs.cpSync(path.join(FRONTEND_ROOT, 'journeys', 'fixtures', 'nltk-data'), nltk, { recursive: true });
  const base = launchEnv(stateDir, true);
  const env: Record<string, string> = {
    ...base, PYTHON_KEYRING_BACKEND: 'summaries_keyring.Keyring', NLTK_DATA: nltk,
    PYTHONPATH: [hookDir, base.PYTHONPATH].filter(Boolean).join(path.delimiter),
  };
  env.NO_PROXY = env.no_proxy = '127.0.0.1,localhost';
  const backend = path.join(FRONTEND_ROOT, '..');
  const engineLanes = () => {
    const read = spawnSync(env.RESMON_PYTHON ?? 'python3', ['-c', RESOLVE, backend], { env, encoding: 'utf8' });
    expect(read.status, read.stderr).toBe(0);
    return JSON.parse(read.stdout.trim().split('\n').pop() ?? '[]') as Record<string, unknown>[];
  };
  const command = path.join(stateDir, 'claude');
  fs.writeFileSync(command, '#!/bin/sh\nexit 1\n', { mode: 0o755 });

  const app = await electron.launch({
    args: ['.', `--user-data-dir=${path.join(stateDir, 'electron-user-data')}`],
    cwd: FRONTEND_ROOT, env, colorScheme: null, timeout: 180_000,
  });
  registerStateDir(stateDir);
  try {
    const win = await app.firstWindow({ timeout: 180_000 });
    const problems: string[] = [];
    win.on('pageerror', (e) => problems.push(e.message));
    const nav = win.getByRole('navigation', { name: 'Sections' });
    await nav.waitFor({ timeout: 120_000 });
    fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });

    // — Settings › AI › Summaries, set up on the screen ------------------------------------------
    await win.evaluate(() => { window.location.hash = '#/settings/ai'; });
    await expect(win.locator('section.settings-group.ai')).toHaveAttribute('aria-busy', 'false', { timeout: 60_000 });
    const summary = win.getByRole('form', { name: 'Summary settings' });
    const saved = summary.locator('.form-actions').getByRole('status');
    await summary.locator('#ai-provider').selectOption('custom');
    await summary.locator('#ai-base-url').fill(provider.url);

    // The key is stored by its own button, then tested where it is kept: the screen never sends it.
    const key = summary.locator('[data-ai="key"]');
    await key.locator('#ai-key').fill(KEY);
    await key.getByRole('button', { name: 'Store', exact: true }).click();
    await expect(key).toHaveAttribute('data-state', 'present', { timeout: 30_000 });
    const tested = provider.calls().length;
    const testRequest = win.waitForRequest((r) => r.url().endsWith('/api/credentials/validate'));
    await key.getByRole('button', { name: 'Test the stored key' }).click();
    expect((await testRequest).postDataJSON()).toEqual({ provider: 'custom', base_url: provider.url });
    await expect(key.locator('[data-ai="key-test"]')).toHaveAttribute('data-outcome', 'accepted', { timeout: 30_000 });
    await expect(key.locator('[data-ai="key-test"]')).toContainText('The provider accepted the key.');
    expect(provider.calls().slice(tested).map((c) => [c.method, c.path, c.authorization]))
      .toEqual([['GET', '/v1/models', `Bearer ${KEY}`]]);

    // The model, from the list the provider gives rather than typed.
    const mainModel = summary.locator('[data-ai="model"]').first();
    await mainModel.getByRole('button', { name: 'Load models' }).click();
    await expect(mainModel.locator('[data-ai="model-list"]')).toHaveText(/^2 models listed by Custom endpoint\./, { timeout: 30_000 });
    await summary.locator('#ai-model').selectOption('authored-model');

    // How each summary is written.
    await summary.locator('#ai-length').selectOption('brief');
    await summary.locator('#ai-tone').selectOption('neutral');
    await summary.locator('#ai-temperature').fill('0.3');
    await summary.locator('#ai-goals').fill('methods, limitations');

    // Two fallbacks, added on the screen, and the second moved ahead of the first.
    const draft = summary.locator('[data-ai="fallback-draft"]');
    await summary.getByRole('button', { name: 'Add a fallback' }).click();
    await draft.locator('#ai-fallback-provider').selectOption('local');
    await draft.locator('#ai-fallback-model').fill('llama3');
    await draft.locator('#ai-fallback-endpoint').fill('http://127.0.0.1:9');
    await draft.getByRole('button', { name: 'Add this fallback' }).click();
    await summary.getByRole('button', { name: 'Add a fallback' }).click();
    await draft.locator('#ai-fallback-provider').selectOption('openai');
    await draft.locator('#ai-fallback-model').fill('gpt-4o-mini');
    await draft.getByRole('button', { name: 'Add this fallback' }).click();
    const lanes = summary.locator('[data-ai="fallbacks"] li');
    await expect(lanes).toHaveCount(2);
    await summary.getByRole('button', { name: 'Move the fallback OpenAI · gpt-4o-mini, with your OpenAI key up' }).click();
    await expect(lanes).toHaveText([/^OpenAI · gpt-4o-mini, with your OpenAI key No OpenAI key is stored/, /^Ollama · llama3, on http:\/\/127\.0\.0\.1:9/]);
    await expect(summary.locator('[data-ai="fallbacks-added"]')).toContainText('2 fallbacks are added here');
    await summary.locator('[data-ai="fallbacks"]').scrollIntoViewIfNeeded();
    await win.screenshot({ path: path.join(SCREENSHOT_DIR, 'atlas-ai-summaries-lane.png'), fullPage: true });
    await summary.getByRole('button', { name: 'Save summary settings' }).click();
    await expect(saved).toHaveText('Saved.', { timeout: 30_000 });

    // What the engine stored, and the lanes it now resolves, in that order.
    const stored = await api<Record<string, string>>(win, 'GET', '/api/settings/ai');
    expect(JSON.parse(stored.ai_chain!)).toEqual([
      { kind: 'api_key', provider: 'custom', model: 'authored-model', credential_alias: 'custom_llm_api_key', base_url: provider.url },
      { kind: 'api_key', provider: 'openai', model: 'gpt-4o-mini', credential_alias: 'openai_api_key' },
      { kind: 'local', provider: 'local', model: 'llama3', endpoint: 'http://127.0.0.1:9' },
    ]);
    expect(stored).toMatchObject({
      ai_provider: 'custom', ai_model: 'authored-model', ai_custom_base_url: provider.url, ai_summary_length: 'brief',
      ai_tone: 'neutral', ai_temperature: '0.3', ai_extraction_goals: 'methods, limitations',
    });
    expect(JSON.parse(stored.ai_default_models!)).toEqual({ custom: 'authored-model' });
    expect(engineLanes().map((l) => [l.provider, l.model])).toEqual([['custom', 'authored-model'], ['openai', 'gpt-4o-mini'], ['local', 'llama3']]);
    expect(engineLanes()[0]).toMatchObject({ base_url: provider.url });

    // A command's limits exist only on its lane: typed here, they are what the engine reads.
    await summary.locator('#ai-provider').selectOption('claude_code');
    await expect(summary.locator('#ai-model')).toHaveValue('');
    await summary.locator('#ai-cli-path').fill(command);
    await summary.locator('#ai-batch-size').fill('3');
    await summary.locator('#ai-doc-cap').fill('20');
    await expect(summary).toContainText('Papers are sent 3 at a time, and a run sends at most 20 to it.');
    await summary.getByRole('button', { name: 'Save summary settings' }).click();
    await expect(saved).toHaveText('Saved.', { timeout: 30_000 });
    expect(engineLanes().map((l) => l.provider)).toEqual(['claude_code', 'openai', 'local']);
    expect(engineLanes()[0]).toMatchObject({ kind: 'subscription', binary_path: command, doc_cap: 20, batch_size: 3 });

    // And back: the custom endpoint returns with the model it was last saved with.
    await summary.locator('#ai-provider').selectOption('custom');
    await expect(summary.locator('#ai-model')).toHaveValue('authored-model');
    await expect(summary.locator('#ai-base-url')).toHaveValue(provider.url);
    await summary.getByRole('button', { name: 'Save summary settings' }).click();
    await expect(saved).toHaveText('Saved.', { timeout: 30_000 });
    expect(engineLanes().map((l) => [l.provider, l.model])).toEqual([['custom', 'authored-model'], ['openai', 'gpt-4o-mini'], ['local', 'llama3']]);

    // — Ask the sources, summarized with what Settings › AI holds ------------------------------------
    const askArxiv = async () => {
      await nav.getByRole('link', { name: 'Search' }).click();
      await win.getByRole('navigation', { name: 'Search' }).getByRole('link', { name: 'Ask the sources' }).click();
      await expect(win.getByRole('heading', { name: 'Ask the sources', level: 1 })).toBeVisible();
      await win.locator('.source[data-source="arxiv"] input').check();
      await win.getByLabel('Search terms').fill('graph learning');
      await win.getByLabel('Search terms').press('Enter');
      await win.getByRole('button', { name: 'Any time', exact: true }).click();
      await win.getByRole('checkbox', { name: 'Summarize each paper' }).check();
    };
    const startRun = async (): Promise<{ id: number; body: Record<string, unknown> }> => {
      const posted = win.waitForRequest((r) => r.url().endsWith('/api/search/dive') && r.method() === 'POST');
      const started = win.waitForResponse((r) => r.url().endsWith('/api/search/dive') && r.request().method() === 'POST');
      await win.getByRole('button', { name: /^Ask / }).click();
      const body = (await posted).postDataJSON() as Record<string, unknown>;
      const { execution_id: id } = await (await started).json() as { execution_id: number };
      const run = win.locator(`.run[data-run="${id}"]`);
      await expect(run).toBeVisible();
      await expect(run).toHaveAttribute('data-status', 'completed', { timeout: 120_000 });
      return { id, body };
    };
    const lanesOf = async (id: number) => (await api<{ ai_lanes: Record<string, unknown>[] }>(win, 'GET', `/api/executions/${id}`)).ai_lanes;

    await askArxiv();
    const choice = win.locator('[data-ask="summaries"]');
    await expect(choice.locator('[data-ai="choice-lanes"]')).toContainText(
      `With Custom endpoint · authored-model, at ${provider.url}, with its key, then OpenAI · gpt-4o-mini, with your OpenAI key, `
      + 'then Ollama · llama3, on http://127.0.0.1:9, as Settings › AI holds them when a run starts.', { timeout: 30_000 });
    let before = provider.calls().length;
    const fromSettings = await startRun();
    expect(fromSettings.body).toMatchObject({ ai_enabled: true });
    expect(fromSettings.body).not.toHaveProperty('ai_settings');
    const sent = completions(provider.calls(), before);
    expect(sent).toHaveLength(2);
    for (const call of sent) {
      expect(call).toMatchObject({ authorization: `Bearer ${KEY}`, body: { model: 'authored-model', temperature: 0.3 } });
      expect(prompt(call)).toContain('Tone: neutral');
      expect(prompt(call)).toContain('Target length: brief');
      expect(prompt(call)).toContain('Extraction goals: methods, limitations');
    }
    const said = win.locator('[data-run="summaries"]');
    await expect(said).toHaveAttribute('data-on', 'true');
    await expect(said.locator('p').first()).toHaveText(
      'Summaries On, with Custom endpoint · authored-model, then OpenAI · gpt-4o-mini, then Ollama · llama3, from Settings › AI. '
      + 'Asked for brief length, neutral tone.');
    await expect(said.locator('li').first()).toHaveText('Custom endpoint · authored-model: summarized 2 of 2 papers.');
    expect((await lanesOf(fromSettings.id))[0]).toMatchObject({ provider: 'custom', model: 'authored-model', outcome: 'ok', docs_succeeded: 2 });
    await win.getByRole('tab', { name: 'Report' }).click();
    await expect(win.locator('.record-text.is-report')).toContainText(SUMMARY);

    // — Ask the sources, with this run's own lane and wording -----------------------------------------
    await askArxiv();
    await choice.getByRole('button', { name: 'One for this run' }).click();
    await choice.locator('#ask-ai-provider').selectOption('custom');
    await expect(choice.locator('#ask-ai-model')).toHaveValue('authored-model');
    await choice.locator('[data-ai="model"]').getByRole('button', { name: 'Load models' }).click();
    await expect(choice.locator('[data-ai="model-list"]')).toHaveText(/^2 models listed by Custom endpoint\./, { timeout: 30_000 });
    await choice.locator('#ask-ai-model').selectOption('authored-model-mini');
    await choice.locator('summary').click();
    await choice.locator('#ask-ai-length').selectOption('detailed');
    await choice.locator('#ask-ai-temperature').fill('0.9');
    await expect(choice.locator('[data-ai="choice-lanes"]')).toContainText(
      `With Custom endpoint · authored-model-mini, at ${provider.url}, with its key, set for this run. The connections in Settings › AI are not tried.`);
    await win.screenshot({ path: path.join(SCREENSHOT_DIR, 'atlas-ai-summaries-run-choice.png'), fullPage: true });
    before = provider.calls().length;
    const own = await startRun();
    expect(own.body).toMatchObject({
      ai_enabled: true,
      ai_settings: {
        provider: 'custom', model: 'authored-model-mini', length: 'detailed', temperature: '0.9',
        chain: JSON.stringify([{ kind: 'api_key', provider: 'custom', model: 'authored-model-mini', credential_alias: 'custom_llm_api_key', base_url: provider.url }]),
      },
    });
    const ownSent = completions(provider.calls(), before);
    expect(ownSent).toHaveLength(2);
    for (const call of ownSent) {
      expect(call.body).toMatchObject({ model: 'authored-model-mini', temperature: 0.9 });
      expect(prompt(call)).toContain('Target length: detailed');
      // What this run did not set is still as Settings › AI has it.
      expect(prompt(call)).toContain('Tone: neutral');
    }
    await expect(said.locator('p').first()).toHaveText(
      'Summaries On, with Custom endpoint · authored-model-mini, set for this run. Asked for detailed length, neutral tone. '
      + 'Its length and temperature were set for this run.');
    await expect(said.locator('li')).toHaveText(['Custom endpoint · authored-model-mini: summarized 2 of 2 papers.']);
    expect(await lanesOf(own.id)).toEqual([expect.objectContaining({ provider: 'custom', model: 'authored-model-mini', outcome: 'ok', docs_succeeded: 2 })]);
    await win.screenshot({ path: path.join(SCREENSHOT_DIR, 'atlas-ai-summaries-run.png') });

    // — A watch whose editor turns summaries on, with a lane of its own -------------------------------
    await win.evaluate(() => { window.location.hash = '#/watches/new'; });
    await win.locator('.source[data-source="arxiv"]').waitFor({ timeout: 60_000 });
    await win.locator('#watch-name').fill('Graph learning, summarized');
    await win.locator('#watch-terms').fill('graph learning');
    await win.keyboard.press('Enter');
    await win.locator('.source[data-source="arxiv"] input').check();
    await win.locator('[data-switch="is_active"]').click();
    await expect(win.locator('[data-switch="is_active"]')).toHaveAttribute('aria-checked', 'false');
    const watchAi = win.locator('[data-editor="summaries"]');
    await expect(win.locator('[data-will="summaries"] p').first()).toHaveText('Off: the papers are found and kept, with no summary.');
    await watchAi.locator('[data-switch="ai_enabled"]').click();
    await watchAi.getByRole('button', { name: 'One for this watch' }).click();
    await watchAi.locator('#watch-ai-provider').selectOption('custom');
    await watchAi.locator('#watch-ai-model').fill('authored-model-mini');
    await watchAi.locator('summary').click();
    await watchAi.locator('#watch-ai-tone').selectOption('accessible');
    await expect(win.locator('[data-will="summaries"] p').first()).toHaveText(
      `With Custom endpoint · authored-model-mini, at ${provider.url}, with its key, set for this watch. The connections in Settings › AI are not tried.`);
    await watchAi.scrollIntoViewIfNeeded();
    await win.screenshot({ path: path.join(SCREENSHOT_DIR, 'atlas-ai-summaries-watch-editor.png') });
    await win.getByRole('button', { name: 'Save watch' }).click();
    await expect(win.locator('.watch-page [data-editor="said"]')).toHaveText('Saved, paused.', { timeout: 30_000 });
    const watchId = Number(/#\/watches\/(\d+)$/.exec(win.url())?.[1]);
    expect(watchId).toBeGreaterThan(0);

    // What the engine stored for the watch, and what its page says.
    const routine = await api<{ ai_enabled: boolean; is_active: boolean; ai_settings: string }>(win, 'GET', `/api/routines/${watchId}`);
    expect(routine).toMatchObject({ ai_enabled: true, is_active: false });
    expect(JSON.parse(routine.ai_settings)).toEqual({
      provider: 'custom', model: 'authored-model-mini', tone: 'accessible',
      chain: JSON.stringify([{ kind: 'api_key', provider: 'custom', model: 'authored-model-mini', credential_alias: 'custom_llm_api_key', base_url: provider.url }]),
    });
    const onPage = win.locator('[data-watch="summaries"]');
    await expect(onPage).toHaveAttribute('data-lane', 'own');
    await expect(onPage).toContainText(`Summaries On, with Custom endpoint · authored-model-mini, at ${provider.url}, with its key, set for this watch.`);
    await win.screenshot({ path: path.join(SCREENSHOT_DIR, 'atlas-ai-summaries-watch.png') });

    // Run once from its page: the watch's own lane and tone are what the run used.
    before = provider.calls().length;
    await win.getByRole('button', { name: 'Run now' }).click();
    const started = win.locator('[data-run-started]');
    await expect(started).toBeVisible({ timeout: 30_000 });
    const watchRun = Number(await started.getAttribute('data-run-started'));
    await started.getByRole('link').click();
    await expect(win.locator(`.run[data-run="${watchRun}"]`)).toHaveAttribute('data-status', 'completed', { timeout: 120_000 });
    const watchSent = completions(provider.calls(), before);
    expect(watchSent).toHaveLength(2);
    for (const call of watchSent) {
      expect(call.body).toMatchObject({ model: 'authored-model-mini', temperature: 0.3 });
      expect(prompt(call)).toContain('Tone: accessible');
      expect(prompt(call)).toContain('Target length: brief');
    }
    await expect(said.locator('p').first()).toHaveText(
      'Summaries On, with Custom endpoint · authored-model-mini, set for its watch. Asked for brief length, accessible tone. Its tone was set for its watch.');
    await expect(said.locator('li')).toHaveText(['Custom endpoint · authored-model-mini: summarized 2 of 2 papers.']);
    await win.screenshot({ path: path.join(SCREENSHOT_DIR, 'atlas-ai-summaries-watch-run.png') });

    expect(problems, 'the renderer threw').toEqual([]);
  } finally {
    await app.close().catch(() => {});
    await provider.close();
    await new Promise<void>((resolve) => source.close(() => resolve()));
    const blocked = fs.existsSync(path.join(stateDir, 'blocked.jsonl'))
      ? fs.readFileSync(path.join(stateDir, 'blocked.jsonl'), 'utf8') : '';
    fs.rmSync(stateDir, { recursive: true, force: true });
    expect(blocked, 'the engine tried to reach something other than this computer').toBe('');
  }
});
