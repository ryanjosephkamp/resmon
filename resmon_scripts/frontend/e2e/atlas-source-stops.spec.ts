/** Source stops and live map arrivals over authored loopback replies. */
import * as fs from 'fs';
import * as http from 'http';
import * as net from 'net';
import * as os from 'os';
import * as path from 'path';
import { test, expect, _electron as electron, type Page } from '@playwright/test';
import { FRONTEND_ROOT, REPO_ROOT, launchEnv, registerStateDir } from './fixtures/resmon-app';
import { removeStateDir } from './fixtures/cleanup';

async function engine<T>(win: Page, route: string, method = 'GET', body?: unknown): Promise<{ status: number; body: T }> {
  return win.evaluate(async ([r, m, b]) => {
    const port = (window as unknown as { resmonAPI: { getBackendPort(): string } }).resmonAPI.getBackendPort();
    const response = await e2eFetch(`http://127.0.0.1:${port}${r}`, {
      method: m, headers: b === undefined ? {} : { 'Content-Type': 'application/json' },
      ...(b === undefined ? {} : { body: JSON.stringify(b) }),
    });
    return { status: response.status, body: await response.json() };
  }, [route, method, body] as const);
}

for (const control of ['source', 'unfinished', 'run'] as const) test(`${control}: stopping preserves exactly the papers admitted before the stop`, async () => {
  test.setTimeout(240_000);
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'resmon-e2e-source-stops-'));
  let plosRequests = 0;
  const source = http.createServer((req, res) => {
    res.setHeader('Content-Type', req.url?.startsWith('/plos') ? 'application/json' : 'application/atom+xml');
    if (req.url?.startsWith('/plos')) {
      plosRequests++;
      res.end(JSON.stringify({ response: { docs: Array.from({ length: 100 }, (_, n) => ({
        id: n === 0 ? '10.1000/shared' : `10.1000/source-stop-${n}`, title: `Graph learning fixture ${n}`,
        author: ['Ada Fixture'], abstract: ['Graph learning and network structure in an authored local fixture.'], publication_date: '2026-11-01',
      })) } }));
    } else {
      res.end(`<feed xmlns="http://www.w3.org/2005/Atom" xmlns:arxiv="http://arxiv.org/schemas/atom"><entry>
      <id>https://arxiv.org/abs/2611.00001v1</id><title>Graph learning fixture 0</title><arxiv:doi>10.1000/shared</arxiv:doi>
      <author><name>Ada Fixture</name></author><published>2026-11-01T00:00:00Z</published>
      <summary>Graph learning and network structure in an authored local fixture.</summary></entry></feed>`);
    }
  });
  await new Promise<void>((resolve) => source.listen(0, '127.0.0.1', resolve));
  const port = (source.address() as net.AddressInfo).port;
  expect(port).not.toBe(8742);
  const hook = path.join(stateDir, 'hook');
  fs.mkdirSync(hook);
  fs.writeFileSync(path.join(hook, 'sitecustomize.py'), `
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
            raise OSError('source-stop guard refuses external/8742 connection')
    return original_connect(self, address)
socket.socket.connect = connect
sys.path.insert(0, ${JSON.stringify(path.join(REPO_ROOT, 'resmon_scripts'))})
from implementation_scripts import api_arxiv, api_plos
api_arxiv._ARXIV_API_URL = 'http://127.0.0.1:${port}/arxiv'
api_plos._PLOS_API_URL = 'http://127.0.0.1:${port}/plos'
# A long local pace leaves time for the page to ask for a cooperative stop.
api_plos._RATE_LIMITER._interval = 180
`);
  const env = launchEnv(stateDir, true);
  env.RESMON_AI_CLI_DISCOVERY = 'configured-only';
  env.PYTHONPATH = [hook, env.PYTHONPATH].filter(Boolean).join(path.delimiter);
  env.NO_PROXY = env.no_proxy = '127.0.0.1,localhost';
  const app = await electron.launch({ args: ['.', `--user-data-dir=${path.join(stateDir, 'profile')}`], cwd: FRONTEND_ROOT, env, colorScheme: null });
  registerStateDir(stateDir);
  try {
    const win = await app.firstWindow();
    await win.getByRole('navigation', { name: 'Sections' }).waitFor({ timeout: 120_000 });
    const started = await engine<{ execution_id: number }>(win, '/api/search/sweep', 'POST', {
      query: 'graph learning', keywords: ['graph learning'], repositories: ['arxiv', 'plos'], max_results: 200,
    });
    const id = started.body.execution_id;
    await win.evaluate((runId) => { window.location.hash = `#/runs/${runId}`; }, id);
    const run = win.locator(`.run[data-run="${id}"]`);
    await expect(run.locator('.live-row[data-source="plos"] [data-live="detail"]')).toContainText('pace', { timeout: 30_000 });
    // arXiv has already stored its paper; the live run's own map comes first.
    const map = run.locator('.run-maps .run-map');
    await expect(map).toHaveAttribute('data-total', '1', { timeout: 30_000 });
    await expect(map).toHaveAttribute('data-placed', '1', { timeout: 60_000 });
    expect(await run.locator('.run-maps > h2').allTextContents()).toEqual(['This Run’s Papers', 'The Collection']);
    for (const body of [{}, { source: ['plos'] }, { sources: null }, { sources: [] }, { all: true, sources: ['plos'] }, { sources: ['unknown-source'] }]) {
      expect((await engine(win, `/api/executions/${id}/stop-sources`, 'POST', body)).status).toBe(422);
    }
    expect((await engine(win, '/api/executions/9999999/stop-sources', 'POST', { all: true })).status).toBe(404);
    const late = await engine<{ detail: string }>(win, `/api/executions/${id}/stop-sources`, 'POST', { sources: ['arxiv'] });
    expect(late.status).toBe(409);
    expect(late.body.detail).toContain('has finished');
    if (control === 'run') {
      await run.getByRole('button', { name: 'Stop', exact: true }).click();
      await expect(run.getByRole('button', { name: /Stop This Source|Stop Unfinished Sources/ })).toHaveCount(0);
      await expect(run).toHaveAttribute('data-status', 'cancelled', { timeout: 60_000 });
      const retained = await engine<{ ids: number[] }>(win, `/api/executions/${id}/document-ids`);
      expect(retained.body.ids).toHaveLength(1);
      expect(fs.existsSync(path.join(stateDir, 'blocked.jsonl'))).toBe(false);
      return;
    } else if (control === 'source') {
      await run.getByRole('button', { name: 'Stop This Source: PLOS' }).click();
    } else {
      await win.locator('header.bar button.mon').click();
      await win.locator('#run-monitor-panel').getByRole('button', { name: /^Stop Unfinished Sources: / }).click();
      await win.keyboard.press('Escape');
    }
    await expect(run).toHaveAttribute('data-status', 'completed', { timeout: 60_000 });
    expect(plosRequests).toBe(1);
    await expect(run.locator('.recorded-row[data-source="plos"]')).toContainText('stopped by you');
    await expect(run.locator('.recorded-row[data-source="plos"]')).toContainText('100');
    // 101 stored papers, 100 marks by shared recorded DOI. No corpus merge.
    const ids = await engine<{ ids: number[]; papers: { copies: number[]; sources: string[] }[] }>(win, `/api/executions/${id}/document-ids`);
    expect(ids.body.ids).toHaveLength(101);
    expect(ids.body.papers).toHaveLength(100);
    expect(ids.body.papers.find((p) => p.copies.length === 2)?.sources.sort()).toEqual(['arxiv', 'plos']);
    await expect(map).toHaveAttribute('data-total', '101', { timeout: 30_000 });
    await expect(map).toHaveAttribute('data-placed', '101', { timeout: 60_000 });
    await expect(map.locator('[data-run-map="placement"]')).toContainText('101 papers this run stored are on the map, on 100 marks');
    await map.getByRole('button', { name: /^arXiv 1$/ }).click();
    await expect(map.locator('[role="img"]')).toHaveAttribute('aria-label', /1 mark/);
    await map.getByRole('button', { name: 'All Sources', exact: true }).click();
    await run.getByRole('tab', { name: 'Map', exact: true }).click();
    await expect(run.locator(`[data-run-map="${id}"]`)).toHaveCount(1);
    await expect(run.locator('.run-main .run-map')).toHaveCount(0);
    await expect(run.locator(`[data-run-map="${id}"] [data-run-map="placement"]`)).toContainText('101 papers this run stored are on the map, on 100 marks');
    expect(fs.existsSync(path.join(stateDir, 'blocked.jsonl'))).toBe(false);
  } finally {
    await app.close();
    await new Promise<void>((resolve) => source.close(() => resolve()));
    removeStateDir(stateDir);
  }
});
