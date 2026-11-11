import * as path from 'path';
import { test, expect, SCREENSHOT_DIR } from './fixtures/resmon-app';

test('source notes start collapsed and remember opening and closing through page reload', async ({ win, goto }) => {
  for (const route of ['/search/ask', '/watches/new']) {
    await goto(route);
    const notes = win.locator('details.source-notes');
    await expect(notes).toBeVisible();
    await expect(notes).not.toHaveAttribute('open', '');
    await notes.getByText('Source Limits and Keys', { exact: true }).click();
    await expect(notes).toHaveAttribute('open', '');
    await goto('/health/watchdog');
    await win.goBack();
    await expect(notes).toHaveAttribute('open', '');
    await win.screenshot({ path: path.join(SCREENSHOT_DIR, `source-notes-${route.startsWith('/search') ? 'ask' : 'watch'}.png`) });
    await win.reload();
    await expect(notes).toHaveAttribute('open', '');
    await notes.getByText('Source Limits and Keys', { exact: true }).click();
    await win.reload();
    await expect(notes).not.toHaveAttribute('open', '');
    await notes.locator('summary').focus();
    await win.keyboard.press('Space');
    await win.reload();
    await expect(notes).toHaveAttribute('open', '');
    await notes.locator('summary').focus();
    await win.keyboard.press('Enter');
    await win.reload();
    await expect(notes).not.toHaveAttribute('open', '');
  }
});
