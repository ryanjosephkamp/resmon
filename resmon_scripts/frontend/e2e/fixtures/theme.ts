/**
 * Showing a window in one theme, the way the app takes a theme.
 *
 * The theme a window shows is the engine's appearance (`/api/appearance`, what
 * Settings › Appearance saves), and the window passes it on to the main
 * process (`resmon:theme-source`, from `WindowFrame`), so the parts of the
 * window macOS draws follow it. A spec that set `nativeTheme.themeSource`
 * itself was undone by that relay whenever the window's own appearance loaded
 * after it: the stored `system` came back, and on a Mac in dark mode the page
 * went dark again.
 *
 * So the theme is stored as the engine's, with the accent left as it is, and
 * the window reads its appearance again, as it does each time it comes to the
 * front. The theme has arrived when the page carries it and the main process
 * has been told it.
 */
import { expect, type ElectronApplication, type Page } from '@playwright/test';

export type ThemeName = 'light' | 'dark';

export async function showTheme(app: ElectronApplication, win: Page, theme: ThemeName): Promise<void> {
  await win.evaluate(async (wanted) => {
    const port = (window as unknown as { resmonAPI: { getBackendPort(): string } }).resmonAPI.getBackendPort();
    const route = `http://127.0.0.1:${port}/api/appearance`;
    const read = await e2eFetch(route);
    if (!read.ok) throw new Error(`GET /api/appearance answered HTTP ${read.status}: ${await read.text()}`);
    const stored = await read.json() as { accent: string | null };
    const saved = await e2eFetch(route, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ theme: wanted, accent: stored.accent || null }),
    });
    if (!saved.ok) throw new Error(`PUT /api/appearance answered HTTP ${saved.status}: ${await saved.text()}`);
  }, theme);
  await expect.poll(async () => {
    await win.evaluate(() => { window.dispatchEvent(new Event('focus')); });
    const shown = await win.evaluate(() => document.documentElement.dataset.theme ?? null);
    const told = await app.evaluate(({ nativeTheme }) => nativeTheme.themeSource);
    return { shown, told };
  }, { message: `the window shows the ${theme} theme, and the main process has it`, timeout: 15_000 })
    .toEqual({ shown: theme, told: theme });
}
