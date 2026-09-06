/**
 * R1 end to end: a sentence typed into the routine editor becomes the thing the
 * coverage audit compares against.
 *
 * `routines.intent` shipped as a column in 1.9a and the audit has read it since
 * 1.9b, but no request body carried the field, so every audit in the field fell
 * back to the routine's own keywords — a query measured against results that
 * query produced. jsdom establishes that the modal puts the value in the body,
 * and `test_routine_intent.py` establishes that the API stores it. **Neither
 * establishes that a person typing in the real window reaches the column**, and
 * that is the whole of R1.
 *
 * So this drives the actual modal in real Chromium against the real backend:
 * open Edit, type, save, then read the routine back through the API and open the
 * audit panel, which must now say it is comparing against the written intent
 * rather than the keywords.
 *
 * No embedding model is needed. The audit's early return still reports `intent`
 * and `intent_source` before it needs a vector, and the panel renders both — the
 * part under test here is which of the two facts the audit is using, not the
 * distances it would draw from one.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFileSync } from 'child_process';
import { test, expect, _electron as electron } from '@playwright/test';
import type { ElectronApplication, Page } from '@playwright/test';
import { launchEnv, FRONTEND_ROOT } from './fixtures/resmon-app';

test.describe.configure({ mode: 'serial' });

const INTENT = 'methods for irregular time series in astronomy';

interface Launched { app: ElectronApplication; win: Page; close: () => Promise<void>; }

async function launch(): Promise<Launched> {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'resmon-e2e-intent-'));
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

test('R1: an intent typed in the editor is what the audit compares against', async () => {
  const { win, close } = await launch();
  try {
    // Seeded through the API — the schema is not this suite's to write to — and
    // deliberately *without* an intent, which is the state every routine in the
    // field is in before this release.
    const created = await api(win, 'POST', '/api/routines', {
      name: 'e2e intent', schedule_cron: '0 9 * * *',
      parameters: { repositories: ['arxiv'], keywords: ['time series'],
                    query: 'time series', max_results: 5 },
      is_active: false,
    });
    expect([200, 201]).toContain(created.status);
    const routineId = created.body.id;
    expect(created.body.intent ?? null).toBeNull();

    await goto(win, '/routines');

    // The audit before: comparing against the keywords, and saying so.
    const toggle = win.getByTestId('coverage-toggle').first();
    await expect(toggle).toBeVisible();
    await toggle.click();
    await expect(win.getByTestId('coverage-intent').first())
      .toContainText('because no intent has been written for it');
    await toggle.click();

    // `exact` matters: `getByRole`'s name filter is a case-insensitive substring
    // by default, and the collapsed page-help header reads "Create, edit, and
    // manage scheduled sweeps" — so a loose "Edit" matches the help toggle first
    // and silently opens nothing.
    await win.getByRole('button', { name: 'Edit', exact: true }).first().click();
    const field = win.locator('#routine-intent');
    await expect(field).toBeVisible();
    await expect(field).toHaveValue('');
    await field.fill(INTENT);
    await win.getByRole('button', { name: 'Update', exact: true }).click();
    await win.waitForTimeout(1200);

    // It reached the column.
    const fetched = await api(win, 'GET', `/api/routines/${routineId}`);
    expect(fetched.body.intent).toBe(INTENT);

    // Re-opening the editor shows it, rather than an empty box over a stored value.
    await win.getByRole('button', { name: 'Edit', exact: true }).first().click();
    await expect(win.locator('#routine-intent')).toHaveValue(INTENT);
    await win.getByRole('button', { name: 'Cancel', exact: true }).click();

    // And the audit is now comparing against it, which is the point of the field.
    await win.getByTestId('coverage-toggle').first().click();
    const intentLine = win.getByTestId('coverage-intent').first();
    await expect(intentLine).toContainText(INTENT);
    await expect(intentLine).toContainText('the intent written for this routine');
    await expect(intentLine).not.toContainText('no intent has been written');
  } finally {
    await close();
  }
});
