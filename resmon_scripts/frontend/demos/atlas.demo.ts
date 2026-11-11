/**
 * The Atlas demos, one task each, from start to finish.
 *
 * Each case copies the demo collection, launches resmon over the copy, shows
 * its title card, does the task at a person's pace, and leaves a take in
 * `$RESMON_DEMO_OUT/takes/<slug>`; `media.ts` makes the GIF and the video from
 * it. The searches ask the real sources over the network. A run that did not
 * complete is not filmed as if it had: the case fails, and is recorded again.
 *
 * Ask is answered by a real Codex: `RESMON_DEMO_CODEX` names the signed-in
 * `codex` command, and each take is one turn on that sign-in. Without it the
 * Ask case is skipped. `RESMON_DEMO_ASK_TEXT` replaces the question, for a
 * rehearsal on the repository's Codex double; a take is never made that way.
 *
 * Run one with `npm run demos -- -g "Deep Dive"`; see README.md.
 */
import { expect, test } from '@playwright/test';
import type { Locator, Page } from '@playwright/test';
import { readFileSync } from 'fs';
import * as path from 'path';
import { Demo } from './recorder';
import { collectionDir } from './paths';
import { DEMOS, type DemoTitle } from './titles';

const demo = (slug: string): DemoTitle => {
  const found = DEMOS.find((d) => d.slug === slug);
  if (!found) throw new Error(`No demo ${slug}`);
  return found;
};

async function go(win: Page, hash: string): Promise<void> {
  await win.evaluate((h) => { window.location.hash = `#${h}`; }, hash);
  await win.waitForFunction((h) => window.location.hash.startsWith(`#${h}`), hash);
}

const sections = (win: Page) => win.getByRole('navigation', { name: 'Sections' });

/** The engine's answer to a route, through the window's own connection. */
async function engine<T>(win: Page, route: string): Promise<T> {
  return win.evaluate(async (r) => {
    const port = (window as unknown as { resmonAPI: { getBackendPort(): string } }).resmonAPI.getBackendPort();
    return (await e2eFetch(`http://127.0.0.1:${port}${r}`)).json();
  }, route) as Promise<T>;
}

/** A change sent to the engine, through the window's own connection; it must succeed. */
async function send(win: Page, route: string, method: string, body: unknown): Promise<void> {
  await win.evaluate(async ([r, m, b]) => {
    const port = (window as unknown as { resmonAPI: { getBackendPort(): string } }).resmonAPI.getBackendPort();
    const response = await e2eFetch(`http://127.0.0.1:${port}${r}`, {
      method: m as string, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b),
    });
    if (!response.ok) throw new Error(`${r} answered HTTP ${response.status}: ${await response.text()}`);
  }, [route, method, body] as const);
}

interface MapBody { points: { id: number[]; x: number[]; y: number[] } }

/**
 * A paper on the plate that is easy to point at: not new today, clear of the
 * plate's own cards and of other papers, and nearest the spot asked for.
 */
async function quietPaper(win: Page, canvas: Locator, near: { x: number; y: number }, avoid: Locator[]): Promise<{ id: number; x: number; y: number }> {
  const map = await engine<MapBody>(win, '/api/map');
  const today = await engine<{ papers: { id: number }[] }>(win, '/api/today');
  const fresh = new Set(today.papers.map((p) => p.id));
  const [cx, cy, scale] = ((await canvas.getAttribute('data-view')) ?? '').split(' ').map(Number);
  const box = await canvas.boundingBox();
  if (!box || cx === undefined || cy === undefined || scale === undefined) throw new Error('The plate has no view');
  const blocked = (await Promise.all(avoid.map((a) => a.boundingBox()))).filter((b) => b !== null);
  const points = map.points.id.map((id, i) => ({
    id,
    x: box.x + ((map.points.x[i] ?? 0) - cx) * scale + box.width / 2,
    y: box.y + box.height / 2 - ((map.points.y[i] ?? 0) - cy) * scale,
  }));
  const inside = (p: { x: number; y: number }, b: { x: number; y: number; width: number; height: number }, pad = 0) =>
    p.x > b.x - pad && p.x < b.x + b.width + pad && p.y > b.y - pad && p.y < b.y + b.height + pad;
  const candidates = points.filter((p) => !fresh.has(p.id)
    && inside(p, box, -40)
    && !blocked.some((b) => inside(p, b, 24))
    && points.every((q) => q === p || Math.hypot(q.x - p.x, q.y - p.y) > 11));
  candidates.sort((a, b) => Math.hypot(a.x - near.x, a.y - near.y) - Math.hypot(b.x - near.x, b.y - near.y));
  const chosen = candidates[0];
  if (!chosen) throw new Error('No paper on the plate is clear enough to point at');
  return chosen;
}

/**
 * Wait on the run with its sources in view, then open its Map tab. Only the
 * network wait is sped up; the pointer and the scroll to the tab keep their
 * own pace. Opening the tab reads the map again and places the new papers.
 */
async function finishOnTheMap(d: Demo, speed: number): Promise<void> {
  await expect(d.win.locator('.run[data-run]')).toBeVisible({ timeout: 30_000 });
  await d.hover(d.win.getByRole('region', { name: 'Sources' }));
  await d.faster(speed, () => completed(d.win));
  await mapTab(d);
}

/** Wait for a run's record to settle, and require that it completed. */
async function completed(win: Page): Promise<void> {
  const run = win.locator('.run[data-run]');
  await expect(run).toBeVisible({ timeout: 30_000 });
  await expect(run).not.toHaveAttribute('data-status', 'running', { timeout: 240_000 });
  const status = await run.getAttribute('data-status');
  if (status !== 'completed') throw new Error(`The run ended ${status}; record this demo again rather than show it`);
}

test('Today', async () => {
  const d = await Demo.open(demo('today'), { theme: 'dark' });
  try {
    const { win } = d;
    // Today draws in when it is opened, so the card lifts over another place.
    await go(win, '/library');
    await d.roll();
    await d.titleCard();
    await d.hold(300);
    await d.click(sections(win).getByRole('link', { name: 'Today' }));
    const canvas = win.locator('.today .plate-canvas');
    await expect(canvas).toHaveAttribute('data-view', /.+/, { timeout: 60_000 });
    await d.hold(2600);

    // A paper under the pointer, then opened beside the map.
    const box = (await canvas.boundingBox())!;
    const chosen = await quietPaper(win, canvas, { x: box.x + box.width * 0.3, y: box.y + box.height * 0.36 },
      [win.locator('.cartouche'), win.locator('.plate-tools')]);
    await d.glide(chosen.x + 26, chosen.y - 20);
    await d.hold(300);
    await d.clickAt(chosen.x, chosen.y);
    const panel = win.locator(`section[data-map-paper="${chosen.id}"]`);
    await expect(panel).toBeVisible();
    await d.hold(500);
    await d.hover(panel.locator('.map-paper-title'));
    await d.hold(2200);
    await d.click(panel.getByRole('button', { name: 'Back to the list' }));
    await d.hold(600);

    // A filter: one watch's papers lit, the rest dimmed.
    const bar = win.getByRole('group', { name: 'Find and filter on the map' });
    await d.click(bar.getByRole('button', { name: /^Filters/ }));
    const filters = win.getByRole('dialog', { name: 'Filter What Is Lit on the Map' });
    await expect(filters).toBeVisible();
    await d.hold(400);
    await d.click(filters.getByRole('checkbox', { name: /Protein structure/ }));
    await expect(bar.getByRole('status')).toHaveText(/^Showing /);
    await d.hold(700);
    await win.keyboard.press('Escape');
    await d.glide(box.x + box.width * 0.6, box.y + box.height * 0.18);
    await d.hold(2400);
    await d.cut();
  } finally {
    await d.close();
  }
});

/** Ask the Sources, filled in as a person does: terms typed, then the sources chosen. */
async function ask(d: Demo, terms: string[], sources: string[]): Promise<void> {
  const { win } = d;
  const field = win.getByLabel('Search terms');
  await expect(field).toBeVisible();
  await d.click(field);
  for (const term of terms) {
    await d.type(term);
    await d.hold(200);
    await win.keyboard.press('Enter');
    await d.hold(300);
  }
  for (const source of sources) {
    // Filtering keeps a source above the fixed form footer, which otherwise
    // covers the lower rows of the full-height catalog while scrolling.
    const filter = win.getByRole('searchbox', { name: 'Filter the sources by name' });
    await d.click(filter);
    await win.keyboard.press('Meta+A');
    await d.type(source);
    const choice = win.locator(`.source[data-source="${source}"] input`);
    await d.click(choice);
    await expect(choice).toBeChecked();
    await d.hold(100);
  }
  const filter = win.getByRole('searchbox', { name: 'Filter the sources by name' });
  await d.click(filter);
  await win.keyboard.press('Meta+A');
  await win.keyboard.press('Backspace');
  await expect(win.locator('.source input:checked')).toHaveCount(sources.length);
}

/**
 * The run's Map tab, and the map read again, which is what places the run's
 * papers: until then the run's small map counts them from the map as it was
 * read before they arrived.
 */
async function mapTab(d: Demo): Promise<void> {
  const read = d.win.waitForResponse((r) => new URL(r.url()).pathname === '/api/map' && r.ok(), { timeout: 30_000 });
  await d.click(d.win.getByRole('tab', { name: 'Map' }));
  await read;
}

test('A Deep Dive', async () => {
  const d = await Demo.open(demo('deep-dive'));
  try {
    const { win } = d;
    await d.roll();
    await d.titleCard();
    await d.hold(300);
    await d.press('Meta+D', ['⌘', 'D'], 'New Deep Dive');
    await expect(win.getByRole('heading', { name: 'Ask the Sources', level: 1 })).toBeVisible();
    await expect(win.getByRole('button', { name: 'Deep Dive', exact: true })).toHaveAttribute('aria-pressed', 'true');
    await d.hold(300);
    await ask(d, ['hypergraph'], ['arxiv']);
    await d.click(win.locator('.ask-go button[type="submit"]'));
    // The run as it goes; then, as it finishes, its own map.
    await finishOnTheMap(d, 3);
    const plate = win.locator('.run-panel canvas').first();
    await expect(plate).toBeVisible({ timeout: 30_000 });
    await d.reveal(plate);
    const box = (await plate.boundingBox())!;
    await d.glide(box.x + box.width * 0.45, box.y + box.height * 0.42);
    await d.hold(1000);
    d.still();
    await d.hold(1200);
    await d.click(win.getByRole('tab', { name: 'Papers' }));
    const papers = win.locator('.paper-row');
    await expect(papers.first()).toBeVisible();
    await d.reveal(papers.nth(3));
    await d.hover(papers.nth(1));
    await d.hold(2200);
    await d.cut();
  } finally {
    await d.close();
  }
});

test('A Deep Sweep', async () => {
  const d = await Demo.open(demo('deep-sweep'));
  try {
    const { win } = d;
    await go(win, '/watches');
    await d.roll();
    await d.titleCard();
    await d.hold(300);
    await d.press('Meta+Shift+D', ['⇧', '⌘', 'D'], 'New Deep Sweep');
    await expect(win.getByRole('button', { name: 'Deep Sweep', exact: true })).toHaveAttribute('aria-pressed', 'true');
    await d.hold(300);
    await ask(d, ['AlphaFold'], ['arxiv', 'europepmc', 'openalex']);
    await d.click(win.locator('.ask-go button[type="submit"]'));
    // Each source's line changes as its answer arrives. A Deep Dive shows a run's map; this one shows
    // how each source answered, then the report.
    await expect(win.locator('.run[data-run]')).toBeVisible({ timeout: 30_000 });
    const sources = win.getByRole('region', { name: 'Sources' });
    await d.hover(sources);
    await d.faster(12, () => completed(win));
    await d.hold(800);
    d.still();
    await d.hold(1000);
    await d.click(win.getByRole('tab', { name: 'Report' }));
    const report = win.locator('.record-text.is-report');
    await expect(report).toBeVisible();
    await d.reveal(report);
    await d.hover(report);
    await d.hold(2000);
    await d.cut();
  } finally {
    await d.close();
  }
});

/** Highly accurate protein structure prediction with AlphaFold (Nature, 2021), published under CC BY 4.0. */
const LOOKUP_DOI = '10.1038/s41586-021-03819-2';

test('Look Up a Paper', async () => {
  const d = await Demo.open(demo('look-up'));
  try {
    const { win } = d;
    await d.roll();
    await d.titleCard();
    await d.hold(300);
    await d.click(sections(win).getByRole('link', { name: 'Search' }));
    await d.click(win.getByRole('navigation', { name: 'Search' }).getByRole('link', { name: 'Look Up a Paper' }));
    await expect(win.getByRole('heading', { name: 'Look Up a Paper', level: 1 })).toBeVisible();
    await d.hold(400);
    // A DOI typed in: what it reads as, and which sources can be asked by one.
    const query = win.locator('[data-find="query"]');
    await d.click(query);
    await d.type(LOOKUP_DOI);
    const reads = win.locator('[data-find="reads"]');
    await expect(reads).toHaveAttribute('data-kind', 'doi', { timeout: 30_000 });
    await d.hover(reads);
    await d.hold(900);
    await d.hover(win.getByRole('group', { name: 'The sources to ask' }));
    await d.hold(1400);
    await d.click(win.locator('[data-find="go"]'));
    // Each source's answer, then the paper they found.
    const result = win.locator('[data-find="result"]');
    await d.faster(4, () => expect(result).toBeVisible({ timeout: 240_000 }));
    const found = Number(await result.getAttribute('data-found'));
    if (!(found > 0)) throw new Error('No source found the paper; record this demo again rather than show it');
    await d.reveal(result);
    await d.hover(result.locator('.find-source[data-outcome="found"]').first());
    await d.hold(1600);
    d.still();
    const paper = win.locator('[data-find="paper"]');
    await d.reveal(paper);
    await d.hover(paper);
    await d.hold(1400);
    await d.caption('In Chrome, Save to resmon sends a paper here');
    await d.hold(2400);
    await d.cut();
  } finally {
    await d.close();
  }
});

test('Watches', async () => {
  const d = await Demo.open(demo('watches'));
  try {
    const { win } = d;
    await go(win, '/watches');
    await expect(win.locator('[data-editor="new"]')).toBeVisible();
    await d.roll();
    await d.titleCard();
    await d.hold(300);
    await d.click(win.locator('[data-editor="new"]'));
    await expect(win.locator('.source[data-source="arxiv"]')).toBeVisible({ timeout: 60_000 });
    await d.hold(300);
    await d.click(win.locator('#watch-name'));
    await d.type('Protein language models');
    await d.click(win.locator('#watch-terms'));
    await d.type('protein language model');
    await win.keyboard.press('Enter');
    await d.hold(300);
    await d.click(win.locator('.source[data-source="arxiv"] input'));
    await expect(win.locator('.source[data-source="arxiv"] input')).toBeChecked();
    await d.click(win.locator('.source[data-source="biorxiv"] input'));
    await expect(win.locator('.source[data-source="biorxiv"] input')).toBeChecked();
    // What It Will Do, said beside the form, then saved.
    await d.hover(win.locator('[data-will="asks"]'));
    await d.hold(1500);
    await d.click(win.getByRole('button', { name: 'Save Watch' }));
    await expect(win.locator('.watch-page [data-editor="said"]')).toBeVisible({ timeout: 30_000 });
    await d.hold(1900);
    await d.click(sections(win).getByRole('link', { name: 'Watches' }));
    await d.hold(400);
    await d.click(win.getByRole('navigation', { name: 'Watches' }).getByRole('link', { name: 'Calendar' }));
    await expect.poll(() => win.evaluate(() => window.location.hash)).toBe('#/watches/calendar');
    await d.hold(600);
    await d.glide(720, 470);
    await d.hold(2200);
    await d.cut();
  } finally {
    await d.close();
  }
});

test('Library', async () => {
  const d = await Demo.open(demo('library'));
  try {
    const { win } = d;
    await go(win, '/library?show=files');
    // The first licensed paper is checked for the pages the reader films;
    // the gallery's order need not be the order the files were imported.
    const [paper] = JSON.parse(readFileSync(path.join(collectionDir(), 'library.json'), 'utf8')) as { arxiv_id: string }[];
    if (!paper) throw new Error('The collection has no licensed Library paper');
    const file = win.locator('article[data-file]').filter({ has: win.getByRole('heading', { name: `${paper.arxiv_id}.pdf`, exact: true }) });
    await expect(file).toBeVisible({ timeout: 30_000 });
    await d.roll();
    await d.titleCard();
    await d.hold(300);
    await d.hover(file);
    await d.hold(900);
    await d.click(file.getByRole('button', { name: 'Read', exact: true }));
    const reader = win.getByRole('region', { name: 'PDF reader' });
    await expect(reader.locator('.ev-sheet[data-page="1"][data-drawn="true"]')).toBeVisible({ timeout: 60_000 });
    await d.hold(700);
    await d.click(reader.getByRole('button', { name: 'Focus' }));
    await expect(reader).toHaveAttribute('data-focus', 'true');
    await d.hold(800);
    // Scrolled through the pages, then every page at once.
    await d.glide(720, 520);
    await d.wheel(650, 18);
    await d.hold(600);
    await d.click(reader.getByRole('button', { name: 'All Pages' }));
    await expect(reader.locator('button.ev-thumb').first().locator('img')).toBeVisible({ timeout: 30_000 });
    await d.hold(1200);
    await d.click(reader.locator('button.ev-thumb[data-page="2"]'));
    await expect(reader.locator('.ev-sheet[data-page="2"][data-drawn="true"]')).toBeVisible({ timeout: 30_000 });
    await d.hold(700);
    // A sentence selected with the mouse.
    const line = reader.locator('.ev-sheet[data-page="2"] .textLayer span').filter({ hasText: /\w{4,}.{30,}/ }).nth(6);
    const box = (await line.boundingBox())!;
    await d.glide(box.x + 2, box.y + box.height / 2);
    await d.hold(200);
    await win.mouse.down();
    const steps = 24;
    for (let i = 1; i <= steps; i++) {
      await win.mouse.move(box.x + 2 + (box.width - 4) * (i / steps), box.y + box.height / 2);
      await d.hold(26);
    }
    await win.mouse.up();
    await expect.poll(() => win.evaluate(() => window.getSelection()?.toString().trim() ?? '')).not.toBe('');
    await d.hold(2600);
    await d.cut();
  } finally {
    await d.close();
  }
});

/** The question Ask is filmed answering, about the demo collection's own papers. */
const ASK_QUESTION = 'Which papers in my collection use diffusion models for protein structure? Name three, with their dates.';

test('Ask', async () => {
  const codex = process.env.RESMON_DEMO_CODEX;
  test.skip(!codex, 'RESMON_DEMO_CODEX names the signed-in codex command; see the note at the top of this file.');
  const d = await Demo.open(demo('ask'));
  try {
    const { win } = d;
    // The codex command, as Settings › AI names it.
    await send(win, '/api/settings/ai', 'PUT', { settings: { ai_provider: 'codex', ai_cli_path: codex } });
    await d.roll();
    await d.titleCard();
    await d.hold(300);
    await d.click(sections(win).getByRole('link', { name: 'Ask' }));
    const pane = win.getByRole('region', { name: 'Conversation' });
    await expect(pane.getByRole('heading', { name: 'New Conversation' })).toBeVisible({ timeout: 30_000 });
    // Codex chosen for this conversation. A select's menu is the system's own and is not filmed, so the
    // pointer rests on it while the choice is made.
    const connection = pane.getByLabel('Connection', { exact: true });
    await expect(connection.locator('option', { hasText: 'Codex' })).toHaveCount(1, { timeout: 30_000 });
    await d.hover(connection);
    await d.hold(500);
    await connection.selectOption('codex_cli:codex');
    const signIn = pane.locator('.conv-compose [data-ai="sign-in"]');
    await expect(signIn).toHaveAttribute('data-state', 'signed_in', { timeout: 30_000 });
    await d.hover(pane.locator('[data-ask="connection-reason"]'));
    await d.hold(1500);
    const composer = pane.getByLabel('Message the Assistant');
    await d.click(composer);
    await d.type(process.env.RESMON_DEMO_ASK_TEXT ?? ASK_QUESTION);
    await d.hold(400);
    await d.click(pane.getByRole('button', { name: 'Send', exact: true }));
    // The tools it reads the collection with, then the answer, which is the model's own.
    const answers = pane.locator('.conv-msg[data-role="assistant"]');
    await d.faster(4, async () => {
      await expect(answers).toHaveCount(1, { timeout: 300_000 });
      await expect(pane.locator('.conv-working')).toHaveCount(0, { timeout: 300_000 });
    });
    const answer = answers.first();
    if (await pane.locator('.conv-failed').count()) throw new Error('The Ask turn failed; record this demo again rather than show it');
    await d.reveal(answer);
    await d.hover(answer.locator('.conv-text'));
    await d.hold(2200);
    d.still();
    await d.hover(answer.locator('.conv-cost'));
    await d.hold(2400);
    await d.cut();
  } finally {
    await d.close();
  }
});

test('Health', async () => {
  const d = await Demo.open(demo('health'));
  try {
    const { win } = d;
    await d.roll();
    await d.titleCard();
    await d.hold(300);
    await d.click(sections(win).getByRole('link', { name: 'Health' }));
    await expect(win.locator('[data-health="legend"]')).toBeVisible({ timeout: 30_000 });
    await d.hold(1300);
    // A source's mark on one run, and what it says; then a source that could not be asked.
    const arxiv = win.locator('tr[data-source="arxiv"] button[data-health="cell"][data-state="answered"]');
    await d.click(arxiv.last());
    await d.hold(2000);
    await d.click(win.locator('tr[data-source="core"] button[data-health="cell"][data-state="could_not_be_asked"]').last());
    await d.hold(2200);
    await d.click(win.getByRole('link', { name: /^Watchdog/ }));
    const finding = win.getByRole('heading', { name: /CORE has no API key configured/ });
    await expect(finding).toBeVisible({ timeout: 30_000 });
    await d.hold(500);
    await d.hover(finding);
    await d.hold(3000);
    await d.cut();
  } finally {
    await d.close();
  }
});

test('Getting Around', async () => {
  const d = await Demo.open(demo('getting-around'));
  try {
    const { win } = d;
    await go(win, '/watches');
    await d.roll();
    await d.titleCard();
    await d.hold(300);
    // The palette: a place by name.
    await d.press('Meta+K', ['⌘', 'K'], 'Search Commands');
    await expect(win.getByRole('dialog', { name: 'Search Commands' })).toBeVisible();
    await d.hold(500);
    await d.type('calendar');
    await d.hold(600);
    await win.keyboard.press('Enter');
    await expect.poll(() => win.evaluate(() => window.location.hash)).toBe('#/watches/calendar');
    await d.hold(1100);
    // The shortcut sheet, and a shortcut pressed from it.
    await d.press('Shift+Slash', ['?'], 'Keyboard Shortcuts');
    const sheet = win.getByRole('dialog', { name: 'Keyboard Shortcuts' });
    await expect(sheet).toBeVisible();
    await d.hold(1500);
    d.still();
    await d.hold(800);
    await d.press('Meta+4', ['⌘', '4'], 'Runs');
    await expect(sheet).toBeHidden();
    await expect.poll(() => win.evaluate(() => window.location.hash)).toBe('#/runs');
    await d.hold(1100);
    // Back with two fingers, as a trackpad sends it, and back again with ⌘[. The
    // pointer rests beside the page's title, clear of anything that scrolls sideways.
    const title = (await win.locator('main.stage h1').first().boundingBox())!;
    await d.glide(title.x + title.width + 220, title.y + title.height / 2);
    await d.hold(200);
    await d.caption('Two-finger swipe');
    for (let i = 0; i < 16; i++) {
      await win.mouse.wheel(-20, 0);
      await d.hold(16);
    }
    await expect.poll(() => win.evaluate(() => window.location.hash)).toBe('#/watches/calendar');
    await d.hold(1300);
    await d.press('Meta+BracketLeft', ['⌘', '['], 'Back');
    await expect.poll(() => win.evaluate(() => window.location.hash)).toBe('#/watches');
    await d.hold(2000);
    await d.cut();
  } finally {
    await d.close();
  }
});
