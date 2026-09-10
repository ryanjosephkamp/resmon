/** Real renderer/HTTP/SSE/permission journey; the CLI's model decision is a double.
 * No assertion here certifies a signed-in model or provider account. */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { _electron, type Page } from '@playwright/test';
import { execFileSync } from 'child_process';
import { test as baseTest, expect, REPO_ROOT, FRONTEND_ROOT, launchEnv, launchResmon, ensureScreenshotDir } from './fixtures/resmon-app';

// This spec owns a distinct worker fixture: its intentional restart must not
// close the app shared by the existing route specs in a full-suite run.
const test = baseTest.extend({
  app: [async ({}, use) => {
    const { app, stateDir } = await launchResmon(true);
    try { await use(app); }
    finally {
      await app.close().catch(() => { /* the restart arm already closed it */ });
      fs.rmSync(stateDir, { recursive: true, force: true });
    }
  }, { scope: 'worker' }],
});

const output = () => ensureScreenshotDir();
async function json(win: Page, port: string, url: string, body?: object) {
  return win.evaluate(async ({ port, url, body }) => {
    const response = await fetch(`http://127.0.0.1:${port}${url}`, body ? {
      method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    } : undefined);
    if (!response.ok) throw new Error(`${url}: ${response.status}`);
    return response.json();
  }, { port, url, body });
}
async function colors(win: Page, tag: string) {
  const rows = await win.evaluate(() => {
    const rgba = (s: string) => (s.match(/[\d.]+/g) || []).map(Number);
    const composite = (fg: number[], bg: number[]) => {
      const a = fg[3] ?? 1; return [0, 1, 2].map(i => fg[i] * a + bg[i] * (1 - a));
    };
    const background = (e: Element | null): number[] => {
      if (!e) return [255, 255, 255];
      return composite(rgba(getComputedStyle(e).backgroundColor), background(e.parentElement));
    };
    const lum = (c: number[]) => c.map(v => { const s = v / 255; return s <= .04045 ? s / 12.92 : ((s + .055) / 1.055) ** 2.4; }).reduce((n, v, i) => n + v * [.2126, .7152, .0722][i], 0);
    const ratio = (a: number[], b: number[]) => (Math.max(lum(a), lum(b)) + .05) / (Math.min(lum(a), lum(b)) + .05);
    const selector = '.assistant-panel, .assistant-trigger, .ai-settings-page';
    return [...document.querySelectorAll(`${selector}, .assistant-panel *, .ai-settings-page *`)].filter(e => {
      const rect = e.getBoundingClientRect(); return rect.width && rect.height && getComputedStyle(e).visibility !== 'hidden' && (e.childNodes.length && [...e.childNodes].some(n => n.nodeType === Node.TEXT_NODE && n.textContent?.trim()) || e.matches('input,textarea,select,button'));
    }).map(e => {
      const css = getComputedStyle(e), bg = background(e), disabled = e.matches(':disabled') || !!e.closest(':disabled');
      let opacity = 1; for (let parent: Element | null = e; parent; parent = parent.parentElement) opacity *= Number(getComputedStyle(parent).opacity);
      const underlying = background(e.parentElement);
      const effectiveBackground = composite([...bg, opacity], underlying);
      const effectiveText = composite([...composite(rgba(css.color), bg), opacity], underlying);
      const placeholder = e.matches('textarea,input') ? getComputedStyle(e, '::placeholder').color : null;
      return { role: e.tagName + '.' + e.className, text: (e.textContent || e.getAttribute('aria-label') || '').slice(0, 70), color: css.color, background: bg, ownBackground: css.backgroundColor, contrast: ratio(effectiveText, effectiveBackground), borderContrast: ratio(rgba(css.borderTopColor), bg), focusContrast: ratio(rgba(css.outlineColor), background(e.parentElement)), placeholder: placeholder ? ratio(composite(rgba(placeholder), bg), bg) : null, disabled, opacity: css.opacity, effectiveOpacity: opacity };
    });
  });
  fs.writeFileSync(path.join(output(), `${tag}-contrast.json`), JSON.stringify(rows, null, 2));
  return rows;
}

test.describe('assistant readability and preserved real transport', () => {
  test.describe.configure({ mode: 'serial' });
  let cli = '';
  let isolatedState = '';
  let preserved = '';
  let allowedConfiguration = -1;
  const python = process.env.RESMON_PYTHON || path.join(REPO_ROOT, '.venv/bin/python');
  const preservation = () => execFileSync(python, ['-c', `import sqlite3,json,sys
c=sqlite3.connect('file:'+sys.argv[1]+'?mode=ro',uri=True)
tables=[r[0] for r in c.execute("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name") if r[0] not in ['assistant_sessions','assistant_messages','app_settings','routines']]
print(json.dumps({t:c.execute('SELECT * FROM '+t+(' WHERE id != '+sys.argv[2] if t=='saved_configurations' else '')+' ORDER BY 1').fetchall() for t in tables},sort_keys=True,default=lambda v:{'bytes_hex':v.hex()}))`, path.join(isolatedState, 'resmon.db'), String(allowedConfiguration)], { encoding: 'utf8' });
  test('one palette stays opaque over 12 page/window/OS cases', async ({ app, win, goto, backendPort }) => {
    const port = await backendPort(); expect(port).not.toBe('8742');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'readable-cli-')); cli = path.join(dir, 'fake-claude');
    const python = process.env.RESMON_PYTHON || path.join(REPO_ROOT, '.venv/bin/python');
    fs.writeFileSync(cli, `#!/bin/sh\nexec "${python}" "${path.join(REPO_ROOT, 'resmon_scripts/verification_scripts/fixtures/fake_claude.py')}" "$@"\n`, { mode: 0o755 });
    await json(win, port, '/api/settings/ai', { settings: { ai_cli_path: cli } });
    await win.reload(); await win.waitForSelector('.app-main');
    const manifest = await app.evaluate(({ app }) => ({ pid: process.pid, state: process.env.RESMON_STATE_DIR, db: process.env.RESMON_DB_PATH, reports: process.env.RESMON_REPORTS_DIR, portFile: process.env.RESMON_PORT_FILE, profile: app.getPath('userData') }));
    isolatedState = manifest.state!;
    execFileSync(python, ['-c', `import sqlite3,sys
c=sqlite3.connect(sys.argv[1])
c.execute("INSERT INTO documents(source_repository,external_id,doi,title,authors,url,metadata_hash) VALUES ('arxiv','r04-authored','10.0000/r04-authored','Authored preservation fixture','Synthetic Author','https://example.invalid/reference','r04-authored')")
d=c.execute('SELECT last_insert_rowid()').fetchone()[0]
c.execute("INSERT INTO executions(execution_type,parameters,start_time,status,result_count) VALUES ('deep_dive','{}','2026-01-01','completed',1)")
e=c.execute('SELECT last_insert_rowid()').fetchone()[0]
c.execute('INSERT INTO execution_documents VALUES (?,?,1)',(e,d))
c.execute("INSERT INTO execution_sources(execution_id,source,status,result_count) VALUES (?,'arxiv','ok',1)",(e,))
c.execute('INSERT INTO reading_queue(document_id) VALUES (?)',(d,))
c.commit()`, path.join(isolatedState, 'resmon.db')]);
    preserved = preservation();
    fs.writeFileSync(path.join(output(), 'preservation-before.json'), preserved);
    fs.writeFileSync(path.join(output(), 'readability-instance.json'), JSON.stringify({ ...manifest, port, source: REPO_ROOT, at: new Date().toISOString() }, null, 2));
    const cases = [];
    for (const appearance of ['light', 'dark'] as const) for (const [width, height] of [[960, 600], [1280, 800]]) for (const route of ['/results', '/reading-queue', '/settings/ai']) {
      await app.evaluate(({ BrowserWindow, nativeTheme }, x) => { nativeTheme.themeSource = x.appearance; BrowserWindow.getAllWindows()[0].setSize(x.width, x.height); }, { appearance, width, height });
      await goto(route); await win.keyboard.press('Escape');
      await win.getByTestId('assistant-trigger').click();
      const panel = win.getByTestId('assistant-panel'), composer = win.getByLabel('Message the assistant');
      await expect(composer).toBeFocused();
      await expect(panel).toHaveCSS('background-color', 'rgb(26, 29, 39)');
      await expect(composer).toHaveCSS('background-color', 'rgb(15, 17, 23)');
      await composer.fill('readability draft');
      const tag = `surface-${appearance}-${width}-${route.split('/').pop()}`;
      const measured = await colors(win, tag);
      const panelRows = measured.filter(r => r.role.includes('assistant') && !r.disabled);
      for (const r of panelRows) { expect(r.contrast, r.role).toBeGreaterThanOrEqual(4.5); if (r.placeholder !== null) expect(r.placeholder, r.role + ' placeholder').toBeGreaterThanOrEqual(4.5); }
      const field = measured.find(r => r.role.startsWith('TEXTAREA'))!;
      expect(field.borderContrast).toBeGreaterThanOrEqual(3); expect(field.focusContrast).toBeGreaterThanOrEqual(3);
      await expect(composer).toHaveCSS('outline-style', 'solid');
      const boundary = await composer.evaluate(e => { const c = getComputedStyle(e); return { border: c.borderColor, outline: c.outlineColor, background: c.backgroundColor }; });
      expect(boundary).toEqual({ border: 'rgb(139, 141, 154)', outline: 'rgb(129, 140, 248)', background: 'rgb(15, 17, 23)' });
      await composer.press('Shift+Tab'); await expect(win.getByLabel('Close the assistant')).toBeFocused();
      await win.keyboard.press('Shift+Tab'); await expect(win.getByLabel('New conversation')).toBeFocused();
      await win.keyboard.press('Shift+Tab'); await expect(win.getByLabel('Earlier conversations')).toBeFocused();
      await win.keyboard.press('Tab'); await win.keyboard.press('Tab'); await win.keyboard.press('Tab'); await expect(composer).toBeFocused();
      const geometry = await panel.boundingBox(); const viewport = await win.evaluate(() => ({ width: innerWidth, height: innerHeight }));
      expect(geometry!.x).toBeGreaterThanOrEqual(0); expect(geometry!.y).toBeGreaterThanOrEqual(0);
      expect(geometry!.x + geometry!.width).toBeLessThanOrEqual(viewport.width);
      cases.push({ appearance, width, height, viewport, geometry });
      await win.screenshot({ path: path.join(output(), tag + '.png') });
      await win.getByLabel('Close the assistant').click(); await expect(win.getByTestId('assistant-trigger')).toBeFocused();
    }
    fs.writeFileSync(path.join(output(), 'surface-matrix.json'), JSON.stringify(cases, null, 2)); expect(cases).toHaveLength(12);
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1280, 800));
  });

  test('composer sends multiline text through HTTP and SSE and reopens stored history', async ({ win, goto, backendPort }) => {
    const port = await backendPort(); await goto('/results');
    await win.keyboard.press(process.platform === 'darwin' ? 'Meta+Slash' : 'Control+Slash');
    const composer = win.getByLabel('Message the assistant'); await expect(composer).toBeFocused();
    await composer.fill('SAY:first authored answer'); await composer.press('Shift+Enter'); await composer.press('End'); await composer.type('SAY:second authored answer');
    const submitted = await composer.inputValue(); expect(submitted).toContain('\n');
    const responsePromise = win.waitForResponse(r => /\/assistant\/sessions\/\d+\/messages$/.test(r.url()) && r.request().method() === 'POST');
    await composer.press('Enter'); const response = await responsePromise;
    expect(response.request().postDataJSON()).toEqual({ text: submitted });
    const sse = await response.text(); expect(sse).toContain('text_delta'); expect(sse).toContain('done');
    await expect(win.locator('.assistant-message--assistant .assistant-bubble')).toContainText('first authored answer');
    await expect(win.locator('.assistant-message--assistant .assistant-bubble')).toContainText('second authored answer');
    const id = Number(response.url().match(/sessions\/(\d+)/)![1]);
    const stored = await json(win, port, `/api/assistant/sessions/${id}`);
    expect(stored.messages.some((m: { role: string; content: string }) => m.role === 'user' && m.content === submitted)).toBe(true);
    fs.writeFileSync(path.join(output(), 'composer-transport.json'), JSON.stringify({ request: response.request().postDataJSON(), sse, stored }, null, 2));
    await win.reload(); await win.waitForSelector('.app-main'); await win.getByTestId('assistant-trigger').click();
    await win.getByLabel('Earlier conversations').click(); await win.locator('.assistant-session-open').first().click();
    await expect(win.locator('.assistant-message--assistant .assistant-bubble')).toContainText('second authored answer');
    await expect(composer).not.toHaveValue(submitted);
  });

  test('permission cards deny or create precisely one inactive routine', async ({ app, win, backendPort }) => {
    const port = await backendPort();
    const before = await json(win, port, '/api/routines');
    for (const decision of ['Deny', 'Allow']) {
      await win.getByLabel('New conversation').click();
      const args = { name: `Readability ${decision}`, keywords: ['synthetic'], sources: ['arxiv'], schedule: '0 9 * * *', ai_enabled: false };
      await win.getByLabel('Message the assistant').fill(`CALL:create_routine ${JSON.stringify(args)}`);
      await win.getByRole('button', { name: 'Send', exact: true }).click();
      const card = win.getByTestId('permission-card'); await expect(card).toBeVisible();
      expect(await json(win, port, '/api/routines')).toEqual(before);
      await expect(card.locator('pre')).toHaveText(`create_routine(${JSON.stringify(args, null, 2)})`);
      const rows = await colors(win, `permission-${decision}`);
      for (const r of rows.filter(r => r.role.includes('assistant') && !r.disabled)) expect(r.contrast, r.role).toBeGreaterThanOrEqual(4.5);
      if (decision === 'Allow') { await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.setZoomFactor(2)); await win.waitForTimeout(250); }
      await card.getByRole('button', { name: 'Allow', exact: true }).focus();
      await win.keyboard.press('Tab'); await expect(card.getByRole('button', { name: 'Deny', exact: true })).toBeFocused();
      await win.keyboard.press('Shift+Tab'); await expect(card.getByRole('button', { name: 'Allow', exact: true })).toBeFocused();
      await card.getByRole('button', { name: decision, exact: true }).focus(); await expect(card.getByRole('button', { name: decision, exact: true })).toBeFocused();
      await win.screenshot({ path: path.join(output(), `permission-${decision}.png`) });
      if (decision === 'Allow') {
        const png = await app.evaluate(async ({ BrowserWindow }) => (await BrowserWindow.getAllWindows()[0].webContents.capturePage()).toPNG().toString('base64'));
        fs.writeFileSync(path.join(output(), 'zoom-200-permission.png'), Buffer.from(png, 'base64'));
      }
      await card.getByRole('button', { name: decision, exact: true }).press('Enter'); await expect(card).toBeHidden();
      if (decision === 'Allow') await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.setZoomFactor(1));
      await expect(win.getByRole('button', { name: 'Stop', exact: true })).toBeHidden();
      const after = await json(win, port, '/api/routines');
      if (decision === 'Deny') expect(after).toEqual(before);
      else {
        const rows = Array.isArray(after) ? after : after.routines;
        const prior = Array.isArray(before) ? before : before.routines;
        expect(rows.length).toBe(prior.length + 1);
        const created = rows.find((r: { name: string }) => r.name === args.name);
        expect(created.is_active).toBe(0); expect(created.ai_enabled).toBe(0); expect(created.last_executed_at).toBeNull();
        expect(created.schedule_cron).toBe(args.schedule);
        const params = typeof created.parameters === 'string' ? JSON.parse(created.parameters) : created.parameters;
        expect(params.query).toBe('synthetic'); expect(params.repositories).toEqual(['arxiv']);
        const mirror = JSON.parse(execFileSync(python, ['-c', `import sqlite3,json,sys
c=sqlite3.connect('file:'+sys.argv[1]+'?mode=ro',uri=True)
c.row_factory=sqlite3.Row
print(json.dumps([dict(r) for r in c.execute('SELECT * FROM saved_configurations')]))`, path.join(isolatedState, 'resmon.db')], { encoding: 'utf8' }));
        expect(mirror).toHaveLength(1); expect(mirror[0].name).toBe(args.name);
        const saved = JSON.parse(mirror[0].parameters);
        expect(saved.linked_routine_id).toBe(created.id); expect(saved.parameters).toEqual(params);
        expect(saved.schedule_cron).toBe(args.schedule); expect(saved.is_active).toBe(false); expect(saved.ai_enabled).toBe(false);
        allowedConfiguration = mirror[0].id;
        fs.writeFileSync(path.join(output(), 'permission-mirror.json'), JSON.stringify(mirror, null, 2));

        fs.writeFileSync(path.join(output(), 'permission-effect.json'), JSON.stringify({ before, args, after }, null, 2));
      }
    }
  });

  test('long content, zoom, stop and errors leave controls reachable', async ({ app, win }) => {
    await win.getByLabel('New conversation').click();
    const composer = win.getByLabel('Message the assistant');
    await composer.fill('SAY:' + 'longword'.repeat(160) + '\nSAY:https://example.invalid/' + 'path/'.repeat(100));
    await win.getByRole('button', { name: 'Send', exact: true }).click();
    await expect(win.getByRole('button', { name: 'Stop', exact: true })).toBeHidden();
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.setZoomFactor(2));
    await win.waitForTimeout(350);
    const zoomGeometry = await win.getByTestId('assistant-panel').boundingBox();
    const viewport = await win.evaluate(() => ({ width: innerWidth, height: innerHeight }));
    expect(zoomGeometry!.x + zoomGeometry!.width).toBeLessThanOrEqual(viewport.width);
    expect(zoomGeometry!.y + zoomGeometry!.height).toBeLessThanOrEqual(viewport.height);
    await expect(composer).toBeVisible(); await composer.fill('SLEEP:120');
    await win.getByRole('button', { name: 'Send', exact: true }).click();
    const stop = win.getByRole('button', { name: 'Stop', exact: true }); await expect(stop).toBeVisible();
    await win.screenshot({ path: path.join(output(), 'zoom-200-playwright-capture.png') });
    const nativeCapture = await app.evaluate(async ({ BrowserWindow }) => {
      const window = BrowserWindow.getAllWindows()[0];
      const image = await window.webContents.capturePage();
      return { png: image.toPNG().toString('base64'), imageSize: image.getSize(), bounds: window.getBounds(), contentBounds: window.getContentBounds(), zoom: window.webContents.getZoomFactor() };
    });
    fs.writeFileSync(path.join(output(), 'zoom-200-stop.png'), Buffer.from(nativeCapture.png, 'base64'));
    const { png: _png, ...captureReceipt } = nativeCapture;
    fs.writeFileSync(path.join(output(), 'zoom-200.json'), JSON.stringify({ ...captureReceipt, viewport, panel: zoomGeometry, stop: await stop.boundingBox(), composer: await composer.boundingBox() }, null, 2));
    await stop.click(); await expect(stop).toBeHidden();
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.setZoomFactor(1));
    await win.getByLabel('New conversation').click(); await composer.fill('FAIL:authored failure'); await composer.press('Enter');
    await expect(win.getByRole('alert')).toBeVisible(); await expect(win.getByRole('alert')).not.toBeEmpty();
    for (const r of (await colors(win, 'error')).filter(r => !r.disabled)) expect(r.contrast, r.role).toBeGreaterThanOrEqual(4.5);
  });

  test('existing assistant settings save the same fields and preserve history', async ({ win, goto, backendPort }) => {
    const port = await backendPort(); await win.keyboard.press('Escape');
    const history = await json(win, port, '/api/assistant/sessions');
    await goto('/settings/ai'); const section = win.getByTestId('assistant-settings');
    await section.scrollIntoViewIfNeeded();
    const before = await json(win, port, '/api/settings/assistant');
    await section.getByLabel('Run it with').selectOption('api_key');
    await expect(section.getByLabel('Provider', { exact: true })).toBeVisible();
    await section.getByLabel('Model', { exact: true }).fill('authored-model');
    for (const r of (await colors(win, 'settings-api')).filter(r => !r.disabled)) expect(r.contrast, r.role).toBeGreaterThanOrEqual(4.5);
    await section.getByLabel('Run it with').focus(); await win.keyboard.press('Tab'); await expect(section.getByLabel('Provider', { exact: true })).toBeFocused();
    await win.keyboard.press('Shift+Tab'); await expect(section.getByLabel('Run it with')).toBeFocused();
    await section.getByLabel('Run it with').selectOption('');
    await section.getByLabel('Model', { exact: true }).selectOption('opus');
    await section.getByLabel('Effort', { exact: true }).selectOption('high');
    const responsePromise = win.waitForResponse(r => r.url().endsWith('/api/settings/assistant') && r.request().method() === 'PUT');
    await section.getByRole('button', { name: 'Save assistant settings' }).click(); const response = await responsePromise;
    expect(response.request().postDataJSON()).toEqual({ settings: { assistant_runtime: '', assistant_provider: before.assistant_provider || '', assistant_model: 'opus', assistant_effort: 'high' } });
    await win.reload(); await win.waitForSelector('.ai-settings-page');
    await expect(section.getByLabel('Model', { exact: true })).toHaveValue('opus'); await expect(section.getByLabel('Effort', { exact: true })).toHaveValue('high');
    expect(await json(win, port, '/api/assistant/sessions')).toEqual(history);
    await section.scrollIntoViewIfNeeded(); await section.getByLabel('Model', { exact: true }).focus();
    await expect(section.getByLabel('Model', { exact: true })).toHaveCSS('outline-style', 'solid');
    for (const r of (await colors(win, 'settings')).filter(r => !r.disabled)) expect(r.contrast, r.role).toBeGreaterThanOrEqual(4.5); await win.screenshot({ path: path.join(output(), 'settings.png') });
    await json(win, port, '/api/settings/assistant', { settings: before });
  });

  test('a fresh Electron process reopens the same synthetic history and preserves corpus rows', async ({ app, win, backendPort }) => {
    const port = await backendPort();
    const before = await json(win, port, '/api/assistant/sessions');
    expect(preservation()).toBe(preserved);
    fs.writeFileSync(path.join(output(), 'preservation-after.json'), preservation());
    await app.close();
    const restarted = await _electron.launch({ args: ['.', `--user-data-dir=${path.join(isolatedState, 'electron-user-data')}`], cwd: FRONTEND_ROOT, env: launchEnv(isolatedState, true), timeout: 180000 });
    try {
      const page = await restarted.firstWindow(); await page.waitForSelector('.app-main');
      const newPort = await page.evaluate(() => (window as unknown as { resmonAPI: { getBackendPort(): string } }).resmonAPI.getBackendPort());
      expect(newPort).not.toBe('8742'); expect(await json(page, newPort, '/api/assistant/sessions')).toEqual(before);
      await page.getByTestId('assistant-trigger').click(); await page.getByLabel('Earlier conversations').click();
      await page.locator('.assistant-session-open').filter({ hasText: 'SAY:first authored answer' }).click();
      await expect(page.locator('.assistant-message--assistant .assistant-bubble')).toContainText('second authored answer');
      await page.screenshot({ path: path.join(output(), 'restarted-history.png') });
      fs.writeFileSync(path.join(output(), 'restart.json'), JSON.stringify({ priorPort: port, newPort, pid: restarted.process().pid, state: isolatedState, sessions: before }, null, 2));
    } finally { await restarted.close(); }
  });
});
