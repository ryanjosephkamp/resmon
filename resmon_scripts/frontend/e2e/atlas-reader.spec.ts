/**
 * Atlas: the Evidence reader's pages, in the real app.
 *
 * A PDF's pages stacked in one scroll, the page number following the scroll
 * and Previous, Next and a typed number still jumping; every page in a
 * gallery, reached by the keyboard; focus mode, which takes the window and
 * gives back the same page and zoom; text on a drawn page selected with the
 * mouse and kept as a passage, held to the engine's codepoints; a web link
 * that opens a link window of its own and never the reader; and a link to
 * another page of the same document that goes there.
 *
 * Find in the document (⌘F, Ctrl+F elsewhere): a phrase across two lines, a
 * word broken at a hyphen, stepping through every match, in the reader and in
 * focus mode, and ⌘F left alone outside the reader.
 *
 * A file whose name has no space in 120 characters stays inside every column
 * it is named in, with the whole name in its tooltip. Then a 500-page PDF: its first page drawn, a fast scroll through half of
 * it measured frame by frame, pages far behind the view let go, and a jump
 * near the end. The numbers are printed as `[reader]` lines. Screenshots in
 * light and dark, at a 1280-pixel window and at a 1920-pixel one (on a
 * display narrower than that, the window is as wide as the display and the
 * page is zoomed out to lay out 1920 CSS pixels).
 *
 * Both PDFs are written by `fixtures/pdf.ts`. Every request beyond loopback
 * is refused while the link is followed. **Scripted:** the native folder
 * chooser. **Not exercised:** the system clipboard, which belongs to the
 * person at the machine; a selection is what a copy would carry, and the
 * selection is what is checked. No network.
 */
import { execFile } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { test, expect, _electron as electron, type ElectronApplication, type Page } from '@playwright/test';
import { FRONTEND_ROOT, SCREENSHOT_DIR, launchEnv, registerStateDir } from './fixtures/resmon-app';
import { longPdf, writePdf } from './fixtures/pdf';

const WEB = 'https://example.org/resmon-reader';
/** As long as the paper names the reader is given in practice, with no space to break at. */
const LONG = 'PixelSplat_3D_Gaussian_Splats_from_Image_Pairs_for_Scalable_Generalizable_3D_Reconstruction_with_the_supplementary_appendix.pdf';
const SENTENCE = 'Selectable sentence on page one.';

const LINKS = writePdf([
  {
    lines: [
      { x: 72, y: 720, size: 16, text: SENTENCE },
      { x: 72, y: 690, size: 12, text: `Read more at ${WEB}` },
      { x: 72, y: 660, size: 12, text: 'Go to the target on page three' },
      // For find: a phrase across two lines, and a word broken at a line-ending hyphen.
      { x: 72, y: 600, size: 12, text: 'A phrase that runs across' },
      { x: 72, y: 585, size: 12, text: 'two lines, and a hyphen-' },
      { x: 72, y: 570, size: 12, text: 'ated word ends the page.' },
    ],
    links: [{ rect: [70, 685, 360, 702], uri: WEB }, { rect: [70, 655, 260, 672], page: 3, top: 500 }],
  },
  { lines: [{ x: 72, y: 720, size: 14, text: 'Second page text.' }] },
  { lines: [{ x: 72, y: 480, size: 14, text: 'Third page target.' }] },
  { lines: [{ x: 72, y: 720, size: 14, text: 'Fourth page text.' }] },
]);

/**
 * 600 frames, each moving the pages 200 CSS pixels down: a fast, steady flick.
 * Each frame's time from the one before, and the most pages kept at once.
 */
async function fastScroll(el: Element) {
  const node = el as HTMLElement;
  const frames: number[] = [];
  const kept: number[] = [];
  let last = performance.now();
  const startedAt = last;
  for (let i = 0; i < 600; i += 1) {
    node.scrollTop += 200;
    await new Promise((resolve) => requestAnimationFrame(resolve));
    const now = performance.now();
    frames.push(now - last);
    last = now;
    kept.push(node.querySelectorAll('.ev-sheet').length);
  }
  const sorted = frames.slice().sort((a, b) => a - b);
  const heap = (performance as unknown as { memory?: { usedJSHeapSize: number } }).memory?.usedJSHeapSize ?? 0;
  return {
    seconds: (performance.now() - startedAt) / 1000, pixels: node.scrollTop,
    median: sorted[Math.floor(sorted.length / 2)]!, p95: sorted[Math.floor(sorted.length * 0.95)]!, worst: sorted[sorted.length - 1]!,
    over50: frames.filter((f) => f > 50).length, mostKept: Math.max(...kept),
    heapMB: Math.round(heap / 1048576),
  };
}

/** The pages in the scroll's view: whether each is drawn at the display's density, and its canvas against its box. */
async function inView(el: Element) {
  const node = el as HTMLElement;
  const box = node.getBoundingClientRect();
  return Array.from(node.querySelectorAll<HTMLElement>('.ev-sheet')).filter((sheet) => {
    const at = sheet.getBoundingClientRect();
    return at.bottom > box.top && at.top < box.bottom;
  }).map((sheet) => {
    const canvas = sheet.querySelector('canvas');
    return {
      page: Number(sheet.dataset.page), sharp: sheet.dataset.sharp === 'true',
      css: sheet.offsetWidth, canvas: canvas?.width ?? 0, density: window.devicePixelRatio,
    };
  });
}

/**
 * The renderer's and the GPU process's memory, in MB. On macOS this is
 * `footprint`'s physical footprint, which counts a GPU-backed canvas's
 * IOSurface where the working set does not; elsewhere, the working set.
 */
async function memory(app: ElectronApplication): Promise<{ renderer: number; gpu: number; how: string }> {
  const all = await app.evaluate(({ app: electronApp }) => electronApp.getAppMetrics().map((m) => ({ type: m.type, pid: m.pid, kb: m.memory.workingSetSize })));
  const of = (type: string) => all.filter((m) => m.type === type);
  if (process.platform !== 'darwin') {
    return { renderer: of('Tab').reduce((n, m) => n + m.kb, 0) / 1024, gpu: of('GPU').reduce((n, m) => n + m.kb, 0) / 1024, how: 'working set' };
  }
  const footprint = (pid: number) => new Promise<number>((resolve) => {
    execFile('footprint', ['-p', String(pid)], (error, out) => {
      const found = /Footprint: ([\d.]+) (KB|MB|GB)/.exec(String(out));
      resolve(error || !found ? 0 : Number(found[1]) * ({ KB: 1 / 1024, MB: 1, GB: 1024 } as Record<string, number>)[found[2]!]!);
    });
  });
  const sum = async (type: string) => (await Promise.all(of(type).map((m) => footprint(m.pid)))).reduce((n, v) => n + v, 0);
  return { renderer: await sum('Tab'), gpu: await sum('GPU'), how: 'physical footprint' };
}

interface StoredNote { kind: string; page_number: number | null; start_codepoint: number | null; end_codepoint: number | null; quote: string | null }

async function library<T>(win: Page, route: string): Promise<T> {
  return win.evaluate(async (r) => {
    const port = (window as unknown as { resmonAPI: { getBackendPort(): string } }).resmonAPI.getBackendPort();
    const response = await e2eFetch(`http://127.0.0.1:${port}${r}`, { headers: { 'X-Resmon-Library': '1' } });
    if (!response.ok) throw new Error(`${r} answered HTTP ${response.status}: ${await response.text()}`);
    return response.json();
  }, route) as Promise<T>;
}

/** A window this many CSS pixels wide: the window itself where the display allows, zoomed out where it does not. */
async function widen(app: ElectronApplication, win: Page, width: number, theme: 'light' | 'dark'): Promise<string> {
  const said = await app.evaluate(({ BrowserWindow, nativeTheme, screen }, x) => {
    nativeTheme.themeSource = x.theme;
    const area = screen.getPrimaryDisplay().workAreaSize;
    const w = BrowserWindow.getAllWindows()[0]!;
    const fits = x.width <= area.width;
    const zoom = fits ? 1 : area.width / x.width;
    w.setSize(fits ? x.width : area.width, Math.min(area.height, Math.round(900 * zoom)));
    w.webContents.setZoomFactor(zoom);
    return fits ? `${x.width}-pixel window` : `${area.width}-point window at zoom ${zoom.toFixed(3)}`;
  }, { width, theme });
  await expect.poll(() => win.evaluate(() => window.innerWidth), { timeout: 10_000 }).toBeGreaterThanOrEqual(width - 2);
  await expect(win.locator('html')).toHaveAttribute('data-theme', theme, { timeout: 10_000 });
  return said;
}

test('Evidence reader: stacked pages, a gallery, focus mode, selectable text, links, and a 500-page PDF', async () => {
  test.setTimeout(600_000);
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'resmon-e2e-atlas-reader-'));
  const parent = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'resmon-e2e-atlas-reader-parent-')));
  const fixtures = fs.mkdtempSync(path.join(os.tmpdir(), 'resmon-e2e-atlas-reader-pdfs-'));
  fs.writeFileSync(path.join(fixtures, 'links.pdf'), LINKS);
  fs.writeFileSync(path.join(fixtures, 'long-500.pdf'), longPdf(500));
  fs.writeFileSync(path.join(fixtures, LONG), writePdf([{ lines: [{ x: 72, y: 720, size: 14, text: 'Appendix page.' }] }]));
  const env: Record<string, string> = { ...launchEnv(stateDir, true), RESMON_UI: 'atlas' };
  const app = await electron.launch({
    args: ['.', `--user-data-dir=${path.join(stateDir, 'electron-user-data')}`],
    cwd: FRONTEND_ROOT, env, colorScheme: null, timeout: 180_000,
  });
  registerStateDir(stateDir);
  try {
    await app.evaluate(({ dialog }, chosen) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [chosen] });
    }, parent);
    const win = await app.firstWindow({ timeout: 180_000 });
    const problems: string[] = [];
    win.on('pageerror', (e) => problems.push(e.message));
    // The text layer and the links are made under the window's policy; nothing they make may be refused by it.
    const refused: string[] = [];
    win.on('console', (m) => { if (/Content Security Policy|Refused to/.test(m.text())) refused.push(m.text()); });
    await expect(win.getByRole('navigation', { name: 'Sections' })).toBeVisible({ timeout: 120_000 });
    const mainId = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.id);
    await widen(app, win, 1440, 'light');

    // — a library holding both PDFs, and a project holding both -------------------------
    await win.evaluate(() => { window.location.hash = '#/library/files'; });
    await win.getByRole('button', { name: 'Choose parent folder' }).click();
    await win.getByRole('button', { name: 'Create the library here' }).click();
    const importer = win.getByLabel('Import PDF, TXT or MD');
    await expect(importer).toBeEnabled({ timeout: 60_000 });
    await importer.setInputFiles(['links.pdf', 'long-500.pdf', LONG].map((n) => path.join(fixtures, n)));
    await expect(win.locator('[data-library="imported"]')).toHaveText('3 retained, 0 exact duplicates reused.', { timeout: 60_000 });
    const { vault } = await library<{ vault: { vault_id: string } }>(win, '/api/library');
    await win.getByRole('navigation', { name: 'Library' }).getByRole('link', { name: 'Evidence' }).click();
    await win.getByLabel('A name for a new project').fill('Reading');
    await win.getByRole('button', { name: 'Start', exact: true }).click();
    await expect(win.locator('h2.ev-title')).toHaveText('Reading', { timeout: 30_000 });
    await win.getByRole('button', { name: 'Add files', exact: true }).click();
    const chooser = win.getByRole('region', { name: 'Add files from your library' });
    for (const name of ['links.pdf', 'long-500.pdf', LONG]) await chooser.locator('label.choice', { hasText: name }).getByRole('checkbox').check();
    await chooser.getByRole('button', { name: 'Add 3 files' }).click();
    await expect(chooser.getByText('Every kept file is already in this project.')).toBeVisible({ timeout: 30_000 });
    await win.getByRole('button', { name: 'Add files', exact: true }).click();
    const { projects } = await library<{ projects: { project_id: string }[] }>(win, `/api/evidence/projects?expected_vault_id=${vault.vault_id}`);
    const notes = async () => (await library<{ notes: StoredNote[] }>(
      win, `/api/evidence/projects/${projects[0]!.project_id}/notes?expected_vault_id=${vault.vault_id}`)).notes;
    const members = win.getByRole('region', { name: 'Files in this project' }).locator('button.library-file');

    // — the pages, stacked, and the page number following the scroll -------------------
    const reader = win.getByRole('region', { name: 'Evidence reader' });
    const image = reader.getByRole('region', { name: 'PDF page image' });
    const scroll = reader.getByRole('region', { name: 'Pages of links.pdf' });
    const pane = reader.getByLabel('Canonical page text');
    const pageInput = reader.getByLabel('Page', { exact: true });
    await members.filter({ hasText: 'links.pdf' }).click();
    await expect(image.getByRole('status')).toHaveText(/^Page 1 of 4 rendered · PDF\.js 6\.3\.289 · \d+ × \d+ pixels/, { timeout: 60_000 });
    await expect(pane).toHaveValue(new RegExp(`^${SENTENCE.replace('.', '\\.')}`), { timeout: 60_000 });
    await expect(scroll).toHaveAttribute('data-pages', '4');
    // Scrolled by hand to the third page's top: the number follows, then the text.
    await scroll.evaluate((el) => {
      const third = el.querySelector<HTMLElement>('.ev-sheet[data-page="3"]');
      el.scrollTop = third ? third.offsetTop - 12 : el.scrollHeight;
    });
    await expect(reader).toHaveAttribute('data-page', /^[23]$/, { timeout: 10_000 });
    await scroll.evaluate((el) => { el.scrollTop = el.scrollHeight; });
    await expect(reader).toHaveAttribute('data-page', '4', { timeout: 10_000 });
    await expect(pageInput).toHaveValue('4');
    await expect(pane).toHaveValue('Fourth page text.', { timeout: 60_000 });
    await expect(image.getByRole('status')).toHaveText(/^Page 4 of 4 rendered/, { timeout: 60_000 });
    // Previous, Next and a typed number still jump.
    await reader.getByRole('button', { name: 'Previous page' }).click();
    await expect(reader).toHaveAttribute('data-page', '3');
    await expect(pane).toHaveValue('Third page target.', { timeout: 60_000 });
    await pageInput.fill('1');
    await pageInput.press('Enter');
    await expect(reader).toHaveAttribute('data-page', '1');
    expect(await scroll.evaluate((el) => el.scrollTop)).toBe(0);
    await reader.getByRole('button', { name: 'Next page' }).click();
    await expect(reader).toHaveAttribute('data-page', '2');
    await expect(pane).toHaveValue('Second page text.', { timeout: 60_000 });
    await pageInput.fill('1');
    await pageInput.press('Enter');
    await expect(pane).toHaveValue(new RegExp(`^${SENTENCE.replace('.', '\\.')}`), { timeout: 60_000 });

    // — text on the drawn page, selected with the mouse and kept as a passage -----------
    const line = scroll.locator('.ev-sheet[data-page="1"] .textLayer span', { hasText: SENTENCE });
    await expect(line).toHaveCount(1, { timeout: 30_000 });
    const box = (await line.boundingBox())!;
    await win.mouse.move(box.x + 1, box.y + box.height / 2);
    await win.mouse.down();
    await win.mouse.move(box.x + box.width - 1, box.y + box.height / 2, { steps: 12 });
    await win.mouse.up();
    const selected = await win.evaluate(() => window.getSelection()?.toString() ?? '');
    expect(selected.trim().length, 'dragging across the drawn line selected nothing').toBeGreaterThan(20);
    expect(SENTENCE).toContain(selected.trim());
    const use = scroll.getByRole('button', { name: 'Use as a passage' });
    await expect(use).toBeVisible({ timeout: 10_000 });
    await use.click();
    const panel = win.getByRole('region', { name: 'Saved evidence notes' });
    await expect(panel.getByRole('heading', { name: 'New exact passage' })).toBeVisible({ timeout: 30_000 });
    await expect(panel.locator('[data-evidence="quote"]')).toHaveText(selected.trim());
    await panel.getByRole('button', { name: 'Save passage' }).click();
    await expect.poll(async () => (await notes()).length, { timeout: 30_000 }).toBe(1);
    const [kept] = await notes();
    const start = SENTENCE.indexOf(selected.trim());
    expect([kept!.kind, kept!.page_number, kept!.quote, kept!.start_codepoint, kept!.end_codepoint])
      .toEqual(['passage', 1, selected.trim(), start, start + selected.trim().length]);
    await win.evaluate(() => window.getSelection()?.removeAllRanges());

    // — a link to another page of the document goes there --------------------------------
    const inside = scroll.locator('.ev-sheet[data-page="1"] button.ev-link[data-link="page"]');
    await expect(inside).toHaveAttribute('aria-label', 'Go to page 3', { timeout: 30_000 });
    await inside.click();
    await expect(reader).toHaveAttribute('data-page', '3', { timeout: 10_000 });

    // — a web link opens a link window of its own, and nothing loads in the reader ---------
    await pageInput.fill('1');
    await pageInput.press('Enter');
    const outside = await app.evaluateHandle(({ session }) => {
      const facts = { refused: [] as string[] };
      session.defaultSession.webRequest.onBeforeRequest({ urls: ['*://*/*'] }, (details, callback) => {
        const local = /^https?:\/\/127\.0\.0\.1(:\d+)?\//.test(details.url);
        if (!local) facts.refused.push(details.url);
        callback({ cancel: !local });
      });
      return facts;
    });
    try {
      const web = scroll.locator('.ev-sheet[data-page="1"] a.ev-link[data-link="web"]');
      await expect(web).toHaveAttribute('href', WEB);
      await expect(web).toHaveAttribute('target', '_blank');
      const at = win.url();
      const before = app.windows().length;
      await web.click();
      await expect.poll(() => app.windows().length, { timeout: 20_000 }).toBe(before + 1);
      await expect.poll(() => outside.evaluate((facts) => facts.refused), { timeout: 20_000 }).toEqual([WEB]);
      const opened = await app.evaluate(({ BrowserWindow }, id) => BrowserWindow.getAllWindows()
        .filter((w) => w.id !== id).map((w) => w.getTitle()), mainId);
      expect(opened).toEqual([WEB]);
      expect(win.url(), 'the reader navigated away').toBe(at);
    } finally {
      await app.evaluate(({ session, BrowserWindow }, id) => {
        session.defaultSession.webRequest.onBeforeRequest(null);
        for (const w of BrowserWindow.getAllWindows()) if (w.id !== id) w.destroy();
      }, mainId);
      await outside.dispose();
    }

    // — every page, in a gallery, by the keyboard -----------------------------------------
    await reader.getByRole('button', { name: 'All pages' }).click();
    const gallery = reader.getByRole('region', { name: 'All pages of links.pdf' });
    await expect(gallery.locator('button.ev-thumb')).toHaveCount(4);
    await expect(gallery.locator('button.ev-thumb img')).toHaveCount(4, { timeout: 30_000 });
    await expect(gallery.locator('button.ev-thumb[aria-current="page"]')).toHaveAttribute('data-page', '1');
    await expect(gallery.locator('button.ev-thumb[data-page="1"]')).toBeFocused();
    await win.keyboard.press('Escape');
    await expect(gallery).toHaveCount(0);
    await expect(reader).toHaveAttribute('data-page', '1');
    await expect(reader.getByRole('button', { name: 'All pages' })).toBeFocused();
    await win.keyboard.press('Enter');
    await expect(gallery.locator('button.ev-thumb[data-page="1"]')).toBeFocused();
    await win.keyboard.press('ArrowRight');
    await win.keyboard.press('ArrowRight');
    await expect(gallery.locator('button.ev-thumb[data-page="3"]')).toBeFocused();
    await win.keyboard.press('Enter');
    await expect(gallery).toHaveCount(0);
    await expect(reader).toHaveAttribute('data-page', '3', { timeout: 10_000 });

    // — find in the document: across lines, stepping, and the keyboard back where it was ----
    const findBar = reader.getByRole('search', { name: 'Find in this document' });
    const query = findBar.getByLabel('Find in the document');
    const count = findBar.locator('[data-find="count"]');
    const said = findBar.locator('[data-find="said"]');
    const marked = (name: string) => win.evaluate((n) => Array.from(CSS.highlights.get(n) ?? [])
      .map((r) => (r as Range).toString().replace(/\s+/g, '')), name);
    // Outside the reader ⌘F is left as it was: nothing takes it. Inside, the reader does.
    await win.evaluate(() => {
      const taken: boolean[] = [];
      (window as unknown as { findTaken: boolean[] }).findTaken = taken;
      window.addEventListener('keydown', (e) => { if (e.key.toLowerCase() === 'f' && (e.metaKey || e.ctrlKey)) taken.push(e.defaultPrevented); });
    });
    await panel.getByLabel('Note', { exact: true }).focus();
    await win.keyboard.press('ControlOrMeta+F');
    await expect(findBar).toHaveCount(0);
    await scroll.focus();
    await win.keyboard.press('ControlOrMeta+F');
    await expect(query).toBeFocused();
    expect(await win.evaluate(() => (window as unknown as { findTaken: boolean[] }).findTaken)).toEqual([false, true]);
    await query.fill('runs across two lines');
    await expect(count).toHaveText('1 of 1', { timeout: 10_000 });
    await expect(said).toHaveText('1 of 1');
    await expect.poll(() => marked('ev-find-current'), { timeout: 10_000 }).toEqual(['runsacrosstwolines']);
    await expect(reader).toHaveAttribute('data-page', '1', { timeout: 10_000 });
    await query.fill('hyphenated');
    await expect(count).toHaveText('1 of 1', { timeout: 10_000 });
    await expect.poll(() => marked('ev-find-current'), { timeout: 10_000 }).toEqual(['hyphen-ated']);
    await win.screenshot({ path: path.join(SCREENSHOT_DIR, 'atlas-reader-find.png') });
    // Six matches on four pages: Enter and Shift+Enter step, wrap, and the view follows.
    await query.fill('page');
    await expect(count).toHaveText('1 of 6', { timeout: 10_000 });
    for (const n of [2, 3, 4]) {
      await query.press('Enter');
      await expect(count).toHaveText(`${n} of 6`);
    }
    await expect(reader).toHaveAttribute('data-page', '2', { timeout: 10_000 });
    await expect(said).toHaveText('4 of 6');
    await query.press('Shift+Enter');
    await expect(count).toHaveText('3 of 6');
    await expect(reader).toHaveAttribute('data-page', '1', { timeout: 10_000 });
    for (const n of [2, 1, 6]) {
      await query.press('Shift+Enter');
      await expect(count).toHaveText(`${n} of 6`);
    }
    await expect(reader).toHaveAttribute('data-page', '4', { timeout: 10_000 });
    await expect.poll(() => marked('ev-find-current'), { timeout: 10_000 }).toEqual(['page']);
    expect((await marked('ev-find')).length, 'the other matches on drawn pages are not marked').toBeGreaterThan(0);
    await query.press('Escape');
    await expect(findBar).toHaveCount(0);
    await expect(scroll).toBeFocused();
    expect(await marked('ev-find')).toEqual([]);
    // In focus mode: the bar opens over the pages, and Escape closes it before it leaves focus mode.
    await reader.getByRole('button', { name: 'Focus' }).click();
    await expect(scroll).toBeFocused();
    await win.keyboard.press('ControlOrMeta+F');
    await expect(query).toBeFocused();
    await expect(query).toHaveValue('page');
    await query.fill('target');
    await expect(count).toHaveText(/^[12] of 2$/, { timeout: 10_000 });
    const bar = (await findBar.boundingBox())!;
    expect(bar.y, 'the find bar is not over the pages in focus mode').toBeGreaterThan(40);
    await win.screenshot({ path: path.join(SCREENSHOT_DIR, 'atlas-reader-find-focus.png') });
    await query.press('Escape');
    await expect(findBar).toHaveCount(0);
    await expect(reader).toHaveAttribute('data-focus', 'true');
    await expect(scroll).toBeFocused();
    await win.keyboard.press('Escape');
    await expect(reader).not.toHaveAttribute('data-focus', 'true');
    // At 1024 pixels, the window CI's macOS job runs in, the focus-mode tools and the find bar still fit.
    await widen(app, win, 1024, 'light');
    await reader.getByRole('button', { name: 'Focus' }).click();
    await scroll.focus();
    await win.keyboard.press('ControlOrMeta+F');
    await expect(query).toBeFocused();
    const narrow = await reader.evaluate((el) => {
      const tools = el.querySelector<HTMLElement>('.ev-tools')!;
      const find = el.querySelector<HTMLElement>('.ev-find')!.getBoundingClientRect();
      const last = Array.from(tools.querySelectorAll<HTMLElement>('button')).pop()!.getBoundingClientRect();
      return { over: tools.scrollWidth - tools.clientWidth, lastRight: last.right, findLeft: find.left, findRight: find.right, width: window.innerWidth };
    });
    expect(narrow.over, 'the focus-mode tools overflow at 1024 pixels').toBeLessThanOrEqual(0);
    expect(narrow.lastRight).toBeLessThanOrEqual(narrow.width);
    expect(narrow.findRight).toBeLessThanOrEqual(narrow.width);
    expect(narrow.findLeft).toBeGreaterThanOrEqual(0);
    await win.screenshot({ path: path.join(SCREENSHOT_DIR, 'atlas-reader-find-1024.png') });
    await query.press('Escape');
    await win.keyboard.press('Escape');
    await expect(reader).not.toHaveAttribute('data-focus', 'true');
    await widen(app, win, 1440, 'light');
    await pageInput.fill('3');
    await pageInput.press('Enter');
    await expect(reader).toHaveAttribute('data-page', '3');

    // — focus mode: the window at fit page, then the same page and the reader's zoom on the way back ---
    const zoom = reader.getByLabel('Zoom', { exact: true });
    await zoom.selectOption('150');
    await expect(image.getByRole('status')).toHaveText(/^Page 3 of 4 rendered/, { timeout: 60_000 });
    await reader.getByRole('button', { name: 'Focus' }).click();
    await expect(reader).toHaveAttribute('data-focus', 'true');
    const viewport = await win.evaluate(() => ({ width: window.innerWidth, height: window.innerHeight }));
    expect(await reader.boundingBox()).toEqual({ x: 0, y: 0, ...viewport });
    await expect(scroll).toBeFocused();
    await expect(members.first()).toBeHidden();
    expect(await win.evaluate(() => !!document.querySelector('nav[aria-label="Sections"]')?.closest('[inert]')),
      'the top bar is still reachable behind focus mode').toBe(true);
    await expect(reader).toHaveAttribute('data-page', '3');
    // Focus mode opens at fit page, whatever the zoom beside the notes.
    await expect(zoom).toHaveValue('page');
    await expect(scroll.locator('.ev-sheet[data-page="3"][data-drawn="true"]')).toBeVisible({ timeout: 30_000 });
    const whole = await scroll.evaluate((el) => {
      const frame = el.getBoundingClientRect();
      const sheet = el.querySelector<HTMLElement>('.ev-sheet[data-page="3"]')!.getBoundingClientRect();
      return { sheet: sheet.height, frame: frame.height };
    });
    expect(whole.sheet, 'fit page draws the whole page inside the window').toBeLessThanOrEqual(whole.frame);
    await win.screenshot({ path: path.join(SCREENSHOT_DIR, 'atlas-reader-focus.png') });
    // The notes come back beside the pages, and go again.
    await reader.getByRole('button', { name: 'Notes' }).click();
    await expect(panel).toBeVisible();
    const side = (await panel.boundingBox())!;
    expect(Math.round(side.x + side.width)).toBe(viewport.width);
    expect((await reader.boundingBox())!.width).toBeLessThan(viewport.width - side.width + 2);
    await win.screenshot({ path: path.join(SCREENSHOT_DIR, 'atlas-reader-focus-notes.png') });
    await panel.getByRole('button', { name: 'Close the notes' }).click();
    await expect(panel).toBeHidden();
    // A zoom chosen in focus mode stays while it lasts.
    await zoom.selectOption('200');
    // Scrolled by the wheel, which lets go of the page the gallery went to.
    await scroll.hover();
    await win.mouse.wheel(0, 20_000);
    await expect(reader).toHaveAttribute('data-page', '4', { timeout: 10_000 });
    await expect(zoom).toHaveValue('200');
    await win.keyboard.press('Escape');
    await expect(reader).not.toHaveAttribute('data-focus', 'true');
    await expect(reader.getByRole('button', { name: 'Focus' })).toBeFocused();
    await expect(reader).toHaveAttribute('data-page', '4');
    // The reader's own zoom is back, and focus mode opens at fit page again.
    await expect(zoom).toHaveValue('150');
    await reader.getByRole('button', { name: 'Focus' }).click();
    await expect(zoom).toHaveValue('page');
    await win.keyboard.press('Escape');
    await expect(reader).not.toHaveAttribute('data-focus', 'true');
    await expect(zoom).toHaveValue('150');
    await expect(members.first()).toBeVisible();
    expect(await win.evaluate(() => document.querySelectorAll('[inert]').length), 'focus mode left something inert').toBe(0);
    await zoom.selectOption('width');

    // — light and dark, at 1280 and at 1920, normal and focused ---------------------------
    for (const theme of ['light', 'dark'] as const) {
      for (const width of [1280, 1920]) {
        const how = await widen(app, win, width, theme);
        console.log(`[reader] screenshots at ${width} CSS pixels, ${theme}: ${how}`);
        await reader.scrollIntoViewIfNeeded();
        await expect(image.getByRole('status')).toHaveText(/rendered/, { timeout: 60_000 });
        await win.screenshot({ path: path.join(SCREENSHOT_DIR, `atlas-reader-${width}-${theme}.png`) });
        await reader.getByRole('button', { name: 'Focus' }).click();
        // The sentence about the page is out of the way in focus mode; the page says it is drawn.
        await expect(scroll.locator('.ev-sheet[data-drawn="true"]').first()).toBeVisible({ timeout: 60_000 });
        await win.screenshot({ path: path.join(SCREENSHOT_DIR, `atlas-reader-focus-${width}-${theme}.png`) });
        await reader.getByRole('button', { name: 'All pages' }).click();
        await expect(reader.getByRole('region', { name: 'All pages of links.pdf' }).locator('img')).toHaveCount(4, { timeout: 30_000 });
        await win.screenshot({ path: path.join(SCREENSHOT_DIR, `atlas-reader-gallery-${width}-${theme}.png`) });
        await win.keyboard.press('Escape');
        await win.keyboard.press('Escape');
        await expect(reader).not.toHaveAttribute('data-focus', 'true');
      }
    }
    // — a long name stays inside every column it is named in -------------------------------
    await widen(app, win, 1440, 'light');
    await members.filter({ hasText: LONG }).click();
    await expect(reader.getByRole('heading', { name: LONG })).toBeVisible({ timeout: 30_000 });
    await expect(reader.getByRole('heading', { name: LONG })).toHaveAttribute('title', LONG);
    await panel.getByLabel('Note', { exact: true }).fill('A note on the appendix.');
    await panel.getByRole('button', { name: 'Save note' }).click();
    await expect.poll(async () => (await notes()).length, { timeout: 30_000 }).toBe(2);
    const record = panel.locator('ol.ev-saved > li[data-kind="note"] .ev-saved-file');
    await expect(record).toHaveAttribute('title', LONG);
    for (const width of [1280, 1440, 1920]) {
      await widen(app, win, width, 'light');
      const outside = await win.evaluate(() => {
        const out: string[] = [];
        for (const el of Array.from(document.querySelectorAll<HTMLElement>(
          '.ev-saved-file, .ev-reader-name, .ev-members .lib-name, .ev-identity code, .ev-note-form .record-sub'))) {
          const column = el.closest<HTMLElement>('.ev-notes, .ev-reader, .ev-members');
          if (!column) continue;
          const [inner, outer] = [el.getBoundingClientRect(), column.getBoundingClientRect()];
          if (inner.right > outer.right + 0.5 || inner.right > window.innerWidth) out.push(`${el.className}: ${Math.round(inner.right)} > ${Math.round(outer.right)}`);
        }
        const stage = document.querySelector<HTMLElement>('main.stage');
        if (stage && stage.scrollWidth > stage.clientWidth) out.push(`the page scrolls sideways: ${stage.scrollWidth} > ${stage.clientWidth}`);
        return out;
      });
      expect(outside, `a long name runs out of its column at ${width} pixels`).toEqual([]);
      await panel.scrollIntoViewIfNeeded();
      await win.screenshot({ path: path.join(SCREENSHOT_DIR, `atlas-reader-long-name-${width}.png`) });
    }
    await widen(app, win, 1440, 'light');

    // — a 500-page PDF: drawn near the view, let go away from it --------------------------
    const metrics = async () => {
      const all = await app.evaluate(({ app: electronApp }) => electronApp.getAppMetrics().map((m) => ({ type: m.type, kb: m.memory.workingSetSize })));
      return { renderer: all.filter((m) => m.type === 'Tab').reduce((n, m) => n + m.kb, 0), gpu: all.filter((m) => m.type === 'GPU').reduce((n, m) => n + m.kb, 0) };
    };
    const before = await metrics();
    const opened = Date.now();
    await members.filter({ hasText: 'long-500.pdf' }).click();
    const long = reader.getByRole('region', { name: 'Pages of long-500.pdf' });
    await expect(image.getByRole('status')).toHaveText(/^Page 1 of 500 rendered/, { timeout: 60_000 });
    const firstPage = Date.now() - opened;
    await expect(long).toHaveAttribute('data-pages', '500');
    // The engine reads the text of PDFs up to 200 pages; it says so rather than show nothing.
    await expect(reader.getByText('Reading this page went past the engine’s bounds, so nothing was kept.')).toBeVisible({ timeout: 60_000 });
    await long.focus();
    const run = await long.evaluate(fastScroll);
    const page = Number(await reader.getAttribute('data-page'));
    await expect(image.getByRole('status')).toHaveText(new RegExp(`^Page ${page} of 500 rendered`), { timeout: 30_000 });
    const sheets = await long.evaluate((el) => ({
      pages: Array.from(el.querySelectorAll<HTMLElement>('.ev-sheet')).map((s) => Number(s.dataset.page)),
      canvasPixels: Array.from(el.querySelectorAll('canvas')).reduce((n, c) => n + c.width * c.height, 0),
    }));
    expect(page, 'the page number did not follow a 120,000-pixel scroll').toBeGreaterThan(150);
    expect(sheets.pages.length, 'more pages are kept than the view needs').toBeLessThanOrEqual(24);
    expect(Math.min(...sheets.pages), 'a page far behind the view was not let go').toBeGreaterThan(page - 20);
    expect(run.mostKept).toBeLessThanOrEqual(24);
    const after = await metrics();
    const jumped = Date.now();
    await pageInput.fill('480');
    await pageInput.press('Enter');
    await expect(image.getByRole('status')).toHaveText(/^Page 480 of 500 rendered/, { timeout: 30_000 });
    const jump = Date.now() - jumped;
    await reader.getByRole('button', { name: 'All pages' }).click();
    const thumbs = reader.getByRole('region', { name: 'All pages of long-500.pdf' });
    await expect(thumbs.locator('button.ev-thumb')).toHaveCount(500);
    await expect(thumbs.locator('button.ev-thumb[data-page="480"] img')).toHaveCount(1, { timeout: 30_000 });
    const drawnThumbs = await thumbs.locator('button.ev-thumb img').count();
    expect(drawnThumbs, 'the gallery drew pages nowhere near its view').toBeLessThan(80);
    await win.screenshot({ path: path.join(SCREENSHOT_DIR, 'atlas-reader-gallery-500.png') });
    await win.keyboard.press('Escape');
    console.log(`[reader] 500-page PDF, ${(fs.statSync(path.join(fixtures, 'long-500.pdf')).size / 1048576).toFixed(1)} MB: `
      + `page 1 drawn ${firstPage} ms after the file was opened; jump to page 480 drawn in ${jump} ms`);
    console.log(`[reader] scroll: ${run.pixels} px in ${run.seconds.toFixed(1)} s over 600 frames; frame median ${run.median.toFixed(1)} ms, `
      + `p95 ${run.p95.toFixed(1)} ms, worst ${run.worst.toFixed(1)} ms, ${run.over50} frames over 50 ms; at most ${run.mostKept} pages kept; `
      + `at rest on page ${page}: ${sheets.pages.length} pages kept, ${(sheets.canvasPixels / 1e6).toFixed(1)} million canvas pixels; JS heap ${run.heapMB} MB`);
    console.log(`[reader] working set: renderer ${Math.round(before.renderer / 1024)} MB before the 500-page PDF, ${Math.round(after.renderer / 1024)} MB after the scroll; `
      + `GPU process ${Math.round(before.gpu / 1024)} MB, then ${Math.round(after.gpu / 1024)} MB; gallery drew ${drawnThumbs} of 500 thumbnails`);
    await win.screenshot({ path: path.join(SCREENSHOT_DIR, 'atlas-reader-500.png') });

    // — the same PDF in focus mode at fit width, drawn at the display's own resolution ------
    // As wide as this display allows up to 1728 CSS pixels, the width of a 14-inch MacBook Pro's default.
    const focusWidth = await app.evaluate(({ screen }) => Math.min(1728, screen.getPrimaryDisplay().workAreaSize.width));
    console.log(`[reader] focus mode: ${await widen(app, win, focusWidth, 'light')}`);
    await pageInput.fill('1');
    await pageInput.press('Enter');
    await expect(long.locator('.ev-sheet[data-page="1"][data-sharp="true"]')).toHaveCount(1, { timeout: 30_000 });
    const beside = await memory(app);
    await reader.getByRole('button', { name: 'Focus' }).click();
    await expect(reader).toHaveAttribute('data-focus', 'true');
    await expect(reader.getByRole('button', { name: 'Notes' })).toHaveAttribute('aria-pressed', 'false');
    // Focus mode opens at fit page; fit width, the most pixels a page is drawn at, is the measure here.
    await expect(zoom).toHaveValue('page');
    await zoom.selectOption('width');
    await expect(long.locator('.ev-sheet[data-page="1"][data-sharp="true"]')).toHaveCount(1, { timeout: 30_000 });
    const density = await win.evaluate(() => window.devicePixelRatio);
    const first = (await long.evaluate(inView))[0]!;
    const begun = await memory(app);
    const focused = await long.evaluate(fastScroll);
    const stopped = Date.now();
    await expect.poll(async () => (await long.evaluate(inView)).every((p) => p.sharp), { timeout: 30_000, intervals: [50] }).toBe(true);
    const settled = Date.now() - stopped;
    const rest = await long.evaluate((el) => ({
      pages: el.querySelectorAll('.ev-sheet').length,
      drawn: el.querySelectorAll('.ev-sheet[data-drawn="true"]').length,
      canvasPixels: Array.from(el.querySelectorAll('canvas')).reduce((n, c) => n + c.width * c.height, 0),
    }));
    const end = await memory(app);
    // The peak, from a second pass sampled as it scrolls; apart from the timed one, because sampling can pause a process.
    const peak = { renderer: Math.max(begun.renderer, end.renderer), gpu: Math.max(begun.gpu, end.gpu) };
    let sampling = true;
    const sampler = (async () => {
      while (sampling) {
        const now = await memory(app);
        peak.renderer = Math.max(peak.renderer, now.renderer);
        peak.gpu = Math.max(peak.gpu, now.gpu);
      }
    })();
    await long.evaluate(fastScroll);
    sampling = false;
    await sampler;
    const jumpedAt = Date.now();
    await pageInput.fill('480');
    await pageInput.press('Enter');
    await expect(long.locator('.ev-sheet[data-page="480"][data-sharp="true"]')).toHaveCount(1, { timeout: 30_000 });
    const sharpJump = Date.now() - jumpedAt;
    // Every page in view is drawn at the display's density: its canvas is its box times the device pixel ratio.
    const shown = await long.evaluate(inView);
    for (const p of shown) {
      expect(p.sharp, `page ${p.page} is drawn below the screen's resolution`).toBe(true);
      expect(Math.abs(p.canvas - p.css * p.density), `page ${p.page}'s canvas is not its box at ${p.density}×`).toBeLessThanOrEqual(2);
    }
    expect(rest.canvasPixels, 'the kept pages are over the canvas budget').toBeLessThanOrEqual(2 ** 26);
    // A crop of body text on page 480, at the display's own pixels.
    const sheet = (await long.locator('.ev-sheet[data-page="480"]').boundingBox())!;
    const crop = { x: Math.round(sheet.x + sheet.width * 0.11), y: Math.round(sheet.y + sheet.height * 0.09), width: 560, height: 200 };
    await win.screenshot({ path: path.join(SCREENSHOT_DIR, 'atlas-reader-sharp-crop.png'), clip: crop });
    await win.screenshot({ path: path.join(SCREENSHOT_DIR, 'atlas-reader-focus-500.png') });
    console.log(`[reader] focus mode at fit width, ${focusWidth} CSS pixels at ${density}×: page ${first.css} CSS pixels wide, canvas ${first.canvas} pixels wide; `
      + `a sharp page 480 ${sharpJump} ms after the jump`);
    console.log(`[reader] focus scroll: ${focused.pixels} px in ${focused.seconds.toFixed(1)} s; frame median ${focused.median.toFixed(1)} ms, `
      + `p95 ${focused.p95.toFixed(1)} ms, worst ${focused.worst.toFixed(1)} ms, ${focused.over50} frames over 50 ms; at most ${focused.mostKept} pages kept; `
      + `pages in view sharp ${settled} ms after the scroll stopped; at rest ${rest.pages} kept, ${rest.drawn} drawn, ${(rest.canvasPixels / 1e6).toFixed(1)} million canvas pixels`);
    console.log(`[reader] focus memory (${begun.how}): in the reader beside the notes just before, renderer ${Math.round(beside.renderer)} MB, `
      + `GPU process ${Math.round(beside.gpu)} MB`);
    console.log(`[reader] focus memory (${begun.how}): renderer ${Math.round(begun.renderer)} MB at the start, peak ${Math.round(peak.renderer)} MB, `
      + `${Math.round(end.renderer)} MB at rest; GPU process ${Math.round(begun.gpu)} MB, peak ${Math.round(peak.gpu)} MB, ${Math.round(end.gpu)} MB at rest`);
    // At 300% a Letter page is 31 million canvas pixels, so three kept would pass the budget: the pages
    // in view stay at the display's resolution, and whatever else is kept stays inside the budget.
    // (`allot`'s unit test drives the budget past its limit; here it holds the window to it.)
    await zoom.selectOption('300');
    const budgeted = () => long.evaluate((el) => {
      const box = el.getBoundingClientRect();
      let inside = 0;
      let beyond = 0;
      let blurred = 0;
      for (const sheet of Array.from(el.querySelectorAll<HTMLElement>('.ev-sheet'))) {
        const canvas = sheet.querySelector('canvas');
        const at = sheet.getBoundingClientRect();
        const pixels = canvas ? canvas.width * canvas.height : 0;
        if (at.bottom > box.top && at.top < box.bottom) {
          inside += pixels;
          if (sheet.dataset.sharp !== 'true') blurred += 1;
        } else {
          beyond += pixels;
        }
      }
      return { inside, beyond, blurred, kept: el.querySelectorAll('.ev-sheet').length };
    });
    await expect.poll(async () => {
      const now = await budgeted();
      return now.inside > 0 && now.blurred === 0 && (now.beyond === 0 || now.inside + now.beyond <= 2 ** 26);
    }, { timeout: 30_000, message: 'at 300% the pages in view are not sharp, or the rest are over the budget' }).toBe(true);
    const tight = await budgeted();
    console.log(`[reader] focus mode at 300%: ${tight.kept} pages kept; ${(tight.inside / 1e6).toFixed(1)} million canvas pixels in view, `
      + `${(tight.beyond / 1e6).toFixed(1)} million for the rest; budget ${(2 ** 26 / 1e6).toFixed(1)} million`);
    await zoom.selectOption('width');
    await win.keyboard.press('Escape');
    await expect(reader).not.toHaveAttribute('data-focus', 'true');

    // — find through 500 pages: the first match while the rest are read, scrolling meanwhile ---
    await pageInput.fill('1');
    await pageInput.press('Enter');
    await long.focus();
    await win.keyboard.press('ControlOrMeta+F');
    await expect(query).toBeFocused();
    await query.fill('');
    const scrolling = long.evaluate(fastScroll);
    await query.pressSequentially('long fixture', { delay: 25 });
    const typed = Date.now();
    let firstShown = 0;
    await expect.poll(async () => {
      const text = (await count.textContent()) ?? '';
      if (!firstShown && /^\d+ of /.test(text)) firstShown = Date.now();
      return text;
    }, { timeout: 60_000, intervals: [20] }).toMatch(/^\d+ of 500$/);
    const allRead = Date.now();
    const during = await scrolling;
    await expect(said).toHaveText(/^\d+ of 500$/);
    // Read once: a new query runs over the kept text.
    const again = Date.now();
    await query.fill('page 250 of the');
    await expect(count).toHaveText('1 of 1', { timeout: 30_000 });
    const cached = Date.now() - again;
    await expect(reader).toHaveAttribute('data-page', '250', { timeout: 10_000 });
    await expect.poll(() => marked('ev-find-current'), { timeout: 10_000 }).toEqual(['Page250ofthe']);
    console.log(`[reader] find in 500 pages: first match shown ${firstShown - typed} ms after the last key, all 500 pages read ${allRead - typed} ms after it; `
      + `a second query over the kept text answered in ${cached} ms`);
    console.log(`[reader] scrolling while typing and reading: frame median ${during.median.toFixed(1)} ms, p95 ${during.p95.toFixed(1)} ms, `
      + `worst ${during.worst.toFixed(1)} ms, ${during.over50} frames over 50 ms`);
    await query.press('Escape');
    await expect(findBar).toHaveCount(0);

    expect(problems).toEqual([]);
    expect(refused).toEqual([]);
  } finally {
    await app.close();
    for (const dir of [stateDir, parent, fixtures]) fs.rmSync(dir, { recursive: true, force: true });
  }
});
