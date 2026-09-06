/**
 * The assistant panel in the real app — decision 7's rebuild-pressure measurement.
 *
 * The brief asks for a number rather than an opinion: *the panel must open on
 * all 24 routes with no layout shift of the main content*. So this measures the
 * main content's bounding box before and after opening the panel, on every route
 * in the table, and fails on any difference. If the shell could not carry a
 * second fixed element without moving the page, this is where that would show
 * up, and the handback would say so with the screenshots.
 *
 * The denominator is `e2e/routes.ts`, which imports the table `App.tsx` renders
 * from — a page that exists is a page this sweeps.
 *
 * P9's second half — *absent with the reason when no runtime is available* — is
 * a separate test, and it has to **make** that state rather than assume it: a
 * developer machine has `claude` installed, so the panel is genuinely available
 * and the first version of that test failed because the feature worked.
 */
import * as path from 'path';
import { test, expect, ensureScreenshotDir } from './fixtures/resmon-app';
import { ROUTES } from './routes';

test.describe('the assistant panel', () => {
  test.describe.configure({ mode: 'serial' });

  test('opens on every route without moving the page', async ({ win, goto, backendPort }) => {
    expect(await backendPort()).not.toBe('8742');

    const moved: string[] = [];
    for (const route of ROUTES) {
      await goto(route.path);

      const trigger = win.getByTestId('assistant-trigger');
      await expect(trigger).toBeVisible();

      const before = await win.locator('main.main-content').boundingBox();
      await trigger.click();
      await expect(win.getByTestId('assistant-panel')).toBeVisible();
      const after = await win.locator('main.main-content').boundingBox();

      if (JSON.stringify(before) !== JSON.stringify(after)) {
        moved.push(`${route.path}: ${JSON.stringify(before)} → ${JSON.stringify(after)}`);
      }

      // Closed again, so the next route starts from the same state rather than
      // from whatever the last one left behind.
      await win.getByLabel('Close the assistant').click();
      await expect(win.getByTestId('assistant-panel')).toBeHidden();
    }

    expect(moved, `the panel moved the main content on ${moved.length} route(s)`)
      .toEqual([]);
  });

  test('says why it is unavailable rather than saying nothing',
    async ({ win, goto, backendPort }) => {
      // The unavailable state has to be *made*, not assumed: this developer
      // machine has `claude` installed, so the panel is genuinely available and
      // the first version of this test failed for the most misleading possible
      // reason — the feature working. The CLI path is pointed at nothing, the
      // app reloaded, and the setting put back afterwards.
      const port = await backendPort();
      const setCliPath = (value: string) => win.evaluate(
        async ([p, v]) => {
          await fetch(`http://127.0.0.1:${p}/api/settings/ai`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ settings: { ai_cli_path: v } }),
          });
        }, [port, value] as const);

      const original = await win.evaluate(async (p) => {
        const res = await fetch(`http://127.0.0.1:${p}/api/settings/ai`);
        return (await res.json()).ai_cli_path as string;
      }, port);

      try {
        await setCliPath('/nonexistent/claude-for-this-test');
        await goto('/');
        await win.getByTestId('assistant-trigger').click();

        const block = win.getByTestId('assistant-unavailable');
        await expect(block).toBeVisible();
        await expect(block).toContainText(/claude/i);
        await expect(block).toContainText('Settings → AI');

        // Codex is named with its reason rather than omitted: a user who has it
        // installed and sees no mention would conclude resmon had not noticed.
        await expect(block).toContainText(/shell/i);

        await expect(win.getByLabel('Message the assistant')).toBeDisabled();

        await win.screenshot({
          path: path.join(ensureScreenshotDir(), 'assistant-unavailable.png'),
          fullPage: false,
        });
      } finally {
        await setCliPath(original || '');
      }
    });

  test('the trigger is reachable by keyboard shortcut', async ({ win, goto }) => {
    await goto('/');
    // These tests share one window in serial mode, and the panel's open state
    // survives a hash navigation because it is not a reload. Start from closed
    // rather than assuming it.
    await win.keyboard.press('Escape');
    await expect(win.getByTestId('assistant-panel')).toBeHidden();
    await win.keyboard.press(process.platform === 'darwin' ? 'Meta+Slash' : 'Control+Slash');
    await expect(win.getByTestId('assistant-panel')).toBeVisible();
    await win.keyboard.press('Escape');
    await expect(win.getByTestId('assistant-panel')).toBeHidden();
  });

  test('the settings tab shows the assistant and why codex is not offered',
    async ({ win, goto }) => {
      await goto('/settings/ai');
      const section = win.getByTestId('assistant-settings');
      await section.scrollIntoViewIfNeeded();
      await expect(section).toBeVisible();
      await expect(win.getByTestId('assistant-settings-status')).toContainText(
        /Available|Not available/);
      await expect(section).toContainText(/shell/i);
    });
});
