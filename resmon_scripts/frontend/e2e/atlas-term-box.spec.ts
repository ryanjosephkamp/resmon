/**
 * The term box holds its terms, and the Match switch under it, in the real app.
 *
 * Ask the Sources and the Watch editor are each a scrolling column of flex
 * children. A child's default is to shrink, and the term box's `min-height` is
 * one row, so with about six terms it shrank to that row and its later rows
 * spilled over what follows it. With eight terms at 1,024 points wide, the box
 * must contain every term and its input, and nothing under it may begin before
 * the box ends. The switch is pressed on both screens, and what it says follows.
 */
import { test, expect } from './fixtures/resmon-app';
import { resize } from './fixtures/maps';
import type { ElectronApplication, Locator, Page } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';
import { SCREENSHOT_DIR } from './fixtures/resmon-app';

const EIGHT = [
  'splats', 'gaussian', 'splat', 'gaussian splatting', 'splatting', 'gaussian splats', 'substrate', 'radiance fields',
];

async function addTerms(win: Page, input: Locator): Promise<void> {
  for (const term of EIGHT) {
    await input.fill(term);
    await input.press('Enter');
  }
  await expect(win.locator('.term')).toHaveCount(EIGHT.length);
}

/** Every term and the input inside the box, and the first thing under it starting below it. */
async function holds(box: Locator, input: Locator): Promise<void> {
  const edge = await box.boundingBox();
  expect(edge).not.toBeNull();
  if (!edge) return;
  const inside = async (part: Locator, what: string) => {
    const at = await part.boundingBox();
    expect(at, what).not.toBeNull();
    if (!at) return;
    expect(at.y, `${what} starts inside the box`).toBeGreaterThanOrEqual(edge.y - 0.5);
    expect(at.y + at.height, `${what} ends inside the box`).toBeLessThanOrEqual(edge.y + edge.height + 0.5);
  };
  const chips = box.locator('.term');
  for (let i = 0; i < await chips.count(); i += 1) await inside(chips.nth(i), `term ${EIGHT[i]}`);
  await inside(input, 'the input');
  // What follows the box in the column: the Match switch, then whatever comes next.
  const next = await box.evaluate((el) => {
    const after = el.nextElementSibling as HTMLElement | null;
    return after ? { top: after.getBoundingClientRect().top, name: after.className } : null;
  });
  expect(next, 'something follows the box').not.toBeNull();
  if (next) expect(next.top, `${next.name} starts below the box`).toBeGreaterThanOrEqual(edge.y + edge.height - 0.5);
}

/**
 * Runs `body` and puts the window back as it was. The `app` fixture is one window for every spec
 * file in the worker, so a size left behind here is the size the next file's checks see.
 */
async function sizedFor(app: ElectronApplication, body: () => Promise<void>): Promise<void> {
  const was = await app.evaluate(({ BrowserWindow }) => {
    const win = BrowserWindow.getAllWindows()[0];
    return win ? { bounds: win.getBounds(), maximized: win.isMaximized() } : null;
  });
  try {
    await body();
  } finally {
    if (was) {
      await app.evaluate(({ BrowserWindow }, w) => {
        const win = BrowserWindow.getAllWindows()[0];
        if (!win) return;
        win.unmaximize();
        win.setBounds(w.bounds);
        if (w.maximized) win.maximize();
      }, was);
    }
  }
}

async function shot(win: Page, name: string): Promise<void> {
  fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });
  await win.screenshot({ path: path.join(SCREENSHOT_DIR, name) });
}

test('eight terms stay in the box on Ask the Sources, and Match switches between Any and All', async ({ app, win, goto }) => {
  await sizedFor(app, async () => {
    await resize(app, 1024, 800);
    await goto('/search/ask');
    const input = win.locator('#ask-terms');
    await addTerms(win, input);
    const box = win.locator('label.terms').filter({ has: input });
    await holds(box, input);

    const group = win.getByRole('group', { name: 'Match' });
    await expect(group.getByRole('button', { name: 'Any Term' })).toHaveAttribute('aria-pressed', 'true');
    await expect(win.getByText('A paper with any one of the terms is kept.')).toBeVisible();
    await shot(win, 'term-box-ask-1024-any.png');
    await group.getByRole('button', { name: 'All Terms' }).click();
    await expect(group.getByRole('button', { name: 'All Terms' })).toHaveAttribute('aria-pressed', 'true');
    await expect(win.getByText('A paper must have every term.')).toBeVisible();
    await holds(box, input);
    await shot(win, 'term-box-ask-1024-all.png');

    // The same switch in the night chart's colors, and in a narrower window.
    const theme = await win.evaluate(() => document.documentElement.dataset.theme ?? '');
    await win.evaluate(() => { document.documentElement.dataset.theme = 'dark'; });
    await shot(win, 'term-box-ask-1024-all-dark.png');
    await win.evaluate((t) => { document.documentElement.dataset.theme = t; }, theme);
    await resize(app, 820, 800);
    await holds(box, input);
    await shot(win, 'term-box-ask-820-all.png');
  });
});

test('eight terms stay in the box in the Watch editor, and its Match is said in what it asks', async ({ app, win, goto }) => {
  await sizedFor(app, async () => {
    // 1,024 points wide, and 1,280 by 600, where the editor's column scrolls (above 1,100 points it is
    // a column of its own beside What It Asks), which is when its children were shrunk.
    for (const [width, height] of [[1024, 800], [1280, 600]] as const) {
      await resize(app, width, height);
      await goto('/watches/new');
      const input = win.locator('#watch-terms');
      await addTerms(win, input);
      const box = win.locator('label.terms').filter({ has: input });
      await holds(box, input);

      const asks = win.locator('[data-will="asks"]');
      await expect(asks).toContainText('any of “splats”');
      const group = win.getByRole('group', { name: 'Match' });
      await group.getByRole('button', { name: 'All Terms' }).click();
      await expect(group.getByRole('button', { name: 'All Terms' })).toHaveAttribute('aria-pressed', 'true');
      await expect(asks).toContainText('all of “splats”');
      await holds(box, input);
      await shot(win, `term-box-watch-editor-${width}-all.png`);
      // A new visit starts a new form.
      await goto('/watches');
    }
  });
});
