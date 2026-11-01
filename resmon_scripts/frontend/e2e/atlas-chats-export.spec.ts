/**
 * Atlas's Ask: a long list of saved conversations, and one whose text is
 * hostile, read and exported literally.
 *
 * 123 conversations are authored into the database, the last one holding a
 * script tag, a link, a broken code fence, a non-Latin character, and a
 * 1,200-character word, with a tool call saved in a form no version reads.
 * The rail has to reach all 123, newest first; the hostile text has to be
 * shown as text, run nothing, and push nothing sideways; and both exports
 * have to carry it byte for byte, the Markdown inside a fence longer than any
 * run of backticks in it. Reading and exporting change nothing stored.
 *
 * Nothing leaves this machine: every https request the window makes is
 * refused and recorded, and the record has to stay empty.
 */
import { test, expect, _electron as electron } from '@playwright/test';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { FRONTEND_ROOT, REPO_ROOT, SCREENSHOT_DIR, ATLAS_LANDMARK, atlasEnv, launchEnv } from './fixtures/resmon-app';

const hostile = '<script>window.chatInjected=true</script>\n[unsafe](https://example.invalid)\n``````\n雪\n' + 'longword'.repeat(150);

test('Ask reaches 123 saved conversations, shows hostile text as text, and exports it literally', async () => {
  test.setTimeout(240_000);
  const state = fs.mkdtempSync(path.join(os.tmpdir(), 'resmon-atlas-chats-'));
  const env = atlasEnv(launchEnv(state, true));
  env.RESMON_DISABLE_SCHEDULER = '1';
  const py = (script: string, ...args: string[]) => execFileSync(env.RESMON_PYTHON, ['-c', script, ...args], { env, encoding: 'utf8', cwd: REPO_ROOT });
  py(`import sys
sys.path.insert(0,'resmon_scripts')
from implementation_scripts import database,assistant_store as s
p=sys.argv[1];database.init_db(p);c=database.get_connection(p)
for i in range(1,124):
 sid=s.create_session(c,runtime='claude_cli',title='Chat %03d %%_ 雪'%i)
 s.add_message(c,sid,role='user',content=sys.argv[2] if i==123 else 'authored '+str(i))
c.execute("UPDATE assistant_messages SET tool_calls='{malformed' WHERE session_id=123")
c.execute("UPDATE assistant_sessions SET created_at='2026-01-01',updated_at='2026-01-01'")
c.commit()`, env.RESMON_DB_PATH, hostile);
  const inventory = () => py(`import sqlite3,json,sys
c=sqlite3.connect('file:'+sys.argv[1]+'?mode=ro',uri=True)
t=[r[0] for r in c.execute("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")]
print(json.dumps({x:c.execute('SELECT * FROM "'+x+'" ORDER BY 1').fetchall() for x in t},default=lambda b:b.hex(),sort_keys=True))`, env.RESMON_DB_PATH);
  const app = await electron.launch({ args: ['.', `--user-data-dir=${path.join(state, 'electron-user-data')}`], cwd: FRONTEND_ROOT, env, timeout: 180_000 });
  try {
    const win = await app.firstWindow({ timeout: 180_000 });
    await win.locator(ATLAS_LANDMARK).waitFor({ state: 'visible', timeout: 60_000 });
    const contacts: string[] = [];
    await win.route('https://**/*', (route) => { contacts.push(route.request().url()); return route.abort(); });
    const port = await win.evaluate(() => (window as unknown as { resmonAPI: { getBackendPort(): string } }).resmonAPI.getBackendPort());
    expect(port).not.toBe('8742');
    // Taken once the engine has started, which writes its own defaults: what
    // follows is held to changing nothing.
    const before = inventory();

    // — all 123, newest first, a page at a time --------------------------------------
    await win.evaluate(() => { window.location.hash = '#/ask'; });
    const rail = win.getByRole('region', { name: 'Saved chats' });
    const rows = rail.locator('.conv-list > li');
    await expect(rows.first()).toBeVisible({ timeout: 30_000 });
    const older = rail.getByRole('button', { name: 'Older conversations' });
    const pages: number[] = [];
    for (let i = 0; i < 10 && await older.isVisible(); i += 1) {
      pages.push(await rows.count());
      await older.click();
      await expect.poll(() => rows.count()).toBeGreaterThan(pages[pages.length - 1]);
    }
    await expect(rows).toHaveCount(123);
    const ids = (await rail.locator('.conv-row strong').allTextContents()).map((t) => Number(t.match(/Chat (\d+)/)![1]));
    expect(ids).toEqual(Array.from({ length: 123 }, (_, i) => 123 - i));
    console.log('ATLAS CHATS PAGES', JSON.stringify({ pages, total: ids.length }));

    // — the hostile one, as text --------------------------------------------------------
    await win.getByLabel('Filter saved titles').fill('Chat 123');
    await rail.locator('.conv-row', { hasText: 'Chat 123 %_ 雪' }).click();
    await expect(win.locator('.conv-title')).toHaveText('Chat 123 %_ 雪');
    const said = win.locator('.conv-msg[data-role="user"] .conv-text');
    await expect(said).toHaveText(hostile);
    expect(await said.evaluate((node) => node.querySelectorAll('script, a, iframe').length)).toBe(0);
    expect(await win.evaluate(() => 'chatInjected' in window)).toBe(false);
    // The 1,200-character word wraps inside the conversation rather than widening the page.
    const wide = await win.evaluate(() => ({ page: document.documentElement.scrollWidth, window: window.innerWidth }));
    expect(wide.page, 'the long word pushed the page sideways').toBeLessThanOrEqual(wide.window);
    await expect(win.locator('.conv-raw summary')).toHaveText('Saved tool calls (not in a form this version reads)');
    await win.screenshot({ path: path.join(SCREENSHOT_DIR, 'atlas-chats-hostile.png') });

    // — both exports, literal -------------------------------------------------------------
    for (const format of ['json', 'markdown'] as const) {
      const destination = path.join(state, `chat-123.${format === 'json' ? 'json' : 'md'}`);
      await app.evaluate(({ BrowserWindow }, target) => {
        BrowserWindow.getAllWindows()[0].webContents.session.once('will-download', (_e, item) => item.setSavePath(target));
      }, destination);
      await win.getByRole('button', { name: format === 'json' ? 'Export JSON' : 'Export Markdown', exact: true }).click();
      await expect.poll(() => fs.existsSync(destination) && fs.statSync(destination).size > 0, { timeout: 30_000 }).toBe(true);
      const text = fs.readFileSync(destination, 'utf8');
      if (format === 'json') {
        const doc = JSON.parse(text);
        expect(doc.messages[0].content).toBe(hostile);
        expect(doc.messages[0].tool_calls.raw).toBe('{malformed');
        expect(doc.completion_status).toBe('unknown');
      } else {
        expect(text).toContain('```````\n' + hostile + '\n```````');
      }
    }

    const after = JSON.parse(inventory()) as Record<string, unknown[]>;
    const was = JSON.parse(before) as Record<string, unknown[]>;
    const changed = Object.keys(was).filter((table) => JSON.stringify(after[table]) !== JSON.stringify(was[table]));
    expect(changed, 'reading and exporting changed something stored').toEqual([]);
    expect(contacts).toEqual([]);
  } finally {
    await app.close().catch(() => { /* already gone */ });
    fs.rmSync(state, { recursive: true, force: true });
  }
});
