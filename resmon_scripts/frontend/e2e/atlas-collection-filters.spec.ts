/**
 * Atlas: Search › Your collection narrowed by its filters and exported whole,
 * in the real app.
 *
 * A seeded collection of seven papers over three sources, with authors,
 * categories, and publication dates (one undated). Filtered the way a reader
 * does it, through the menus themselves: a source, then a category, then an
 * author, then a date and words. At each step the numbers beside the values
 * and the rows of the list are held to what the engine answers for the same
 * filters, not to numbers written here. The filtered set is exported through
 * the save dialog (the destination is the one thing scripted) and the file is
 * read back. Then Analytics: a chart's source row opens the collection with
 * that filter set, shown in the menu as ticked, and taken off like any other.
 * A second case seeds more papers than an export holds and reads the cap said
 * before saving, then the file.
 *
 * No network is involved: nothing here asks a source.
 */
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { test, expect, _electron as electron, type ElectronApplication, type Page } from '@playwright/test';
import { FRONTEND_ROOT, SCREENSHOT_DIR, launchEnv, registerStateDir } from './fixtures/resmon-app';

const SEED = String.raw`
import json, os, sys
sys.path.insert(0, sys.argv[1])
from implementation_scripts.database import init_db, get_connection, insert_document
path = os.environ["RESMON_DB_PATH"]
init_db(path)
conn = get_connection(path)
papers = (
    ("arxiv", "Perovskite cells that last outdoors", "Ada Fixture, Ben Fixture", "cond-mat.mtrl-sci, physics.app-ph", "2026-09-10"),
    ("arxiv", "Perovskite films held at high heat", "Ada Fixture", "cond-mat.mtrl-sci", "2026-08-02"),
    ("crossref", "Tandem perovskite modules in the field", "Cy Example", "physics.app-ph", "2026-07-15"),
    ("crossref", "Layered crystals for light-emitting diodes", "Ben Fixture", "cond-mat.mtrl-sci", "2026-05-20"),
    ("pubmed", "Lead near perovskite plants", "Dee Example", "q-bio", "2026-03-01"),
    ("arxiv", "Light from layered crystals", "Cy Example", "physics.optics", "2025-11-30"),
    ("crossref", "An undated perovskite note", "Ada Fixture", "physics.app-ph", None),
)
for n, (source, title, authors, categories, published) in enumerate(papers):
    insert_document(conn, {
        "source_repository": source, "external_id": f"filters-{n}", "title": title, "authors": authors,
        "categories": categories, "publication_date": published, "doi": f"10.5555/filters.{n}",
        "abstract": f"{title}. An authored abstract for the suite, not a published one.",
        "metadata_hash": f"filters-{n}",
    })
conn.commit()
`;

interface Filters { query?: string | null; sources?: string[]; categories?: string[]; authors?: string[]; date_from?: string | null; date_to?: string | null }
interface FacetValue { value: string; count: number }
interface Facets { sources: FacetValue[]; categories: FacetValue[]; authors: FacetValue[]; max_values: number }
interface Page50 { total: number; total_is_capped: boolean; results: { id: number; doi: string | null }[] }

/** The engine, asked by the suite with the token, as a person's screen would never be. */
async function engine<T>(win: Page, route: string, body: Filters & Record<string, unknown>): Promise<T> {
  return win.evaluate(async ({ r, b }) => {
    const port = (window as unknown as { resmonAPI: { getBackendPort(): string } }).resmonAPI.getBackendPort();
    const res = await e2eFetch(`http://127.0.0.1:${port}${r}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b),
    });
    if (!res.ok) throw new Error(`${r} answered HTTP ${res.status}`);
    return await res.json() as unknown;
  }, { r: route, b: body }) as Promise<T>;
}

const filtersOf = (f: Filters) => ({ query: null, sources: [], categories: [], authors: [], date_from: null, date_to: null, ...f });

/** A group's menu as the screen draws it: each value, its number as written, and whether it is ticked. */
async function drawn(win: Page, key: string) {
  return win.locator(`.facet-menu[data-facet="${key}"] li[data-value]`).evaluateAll((items) => items.map((li) => ({
    value: li.getAttribute('data-value') ?? '',
    count: li.querySelector('.facet-count')?.textContent?.trim() ?? '',
    chosen: (li.querySelector('input') as HTMLInputElement).checked,
  })));
}

/** The same group as the engine counts it for these filters; a ticked value it does not list is a 0 there. */
async function counted(win: Page, field: 'sources' | 'categories' | 'authors', f: Filters) {
  const facets = await engine<Facets>(win, '/api/explorer/facets', filtersOf(f));
  const chosen = filtersOf(f)[field] as string[];
  const rows = facets[field].map((v) => ({ value: v.value, count: v.count.toLocaleString('en-US'), chosen: chosen.includes(v.value) }));
  for (const value of chosen) if (!rows.some((r) => r.value === value)) rows.push({ value, count: '0', chosen: true });
  return rows;
}

async function searched(win: Page, f: Filters): Promise<Page50> {
  return engine<Page50>(win, '/api/explorer/search', { ...filtersOf(f), sort: 'newest', limit: 50 });
}

/** The list and its count, held to the engine's search for the same filters. */
async function expectList(win: Page, f: Filters, sentence: string) {
  const page = await searched(win, f);
  await expect(win.locator('.count-sentence')).toHaveText(sentence, { timeout: 30_000 });
  await expect(win.locator('section.results')).toHaveAttribute('aria-busy', 'false', { timeout: 30_000 });
  expect(await win.locator('.result').evaluateAll((items) => items.map((i) => Number(i.getAttribute('data-document')))))
    .toEqual(page.results.map((r) => r.id));
  return page;
}

async function openMenu(win: Page, key: string) {
  await win.locator(`.facet-trigger[data-facet="${key}"]`).click();
  const menu = win.locator(`.facet-menu[data-facet="${key}"]`);
  await expect(menu).toBeVisible();
  return menu;
}

const downloadTo = (app: ElectronApplication, target: string) => app.evaluate(({ BrowserWindow }, where) => {
  BrowserWindow.getAllWindows()[0].webContents.session.once('will-download', (_e, item) => {
    item.setSavePath(where as string);
  });
}, target);

const contents = (file: string) => (fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '');

test('the collection narrowed through its filters, counted, exported, and opened from a chart', async () => {
  test.setTimeout(300_000);
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'resmon-e2e-atlas-filters-'));
  const env: Record<string, string> = { ...launchEnv(stateDir, true), RESMON_UI: 'atlas' };
  const seeded = spawnSync(env.RESMON_PYTHON ?? 'python3', ['-c', SEED, path.join(FRONTEND_ROOT, '..')], { env, encoding: 'utf8' });
  expect(seeded.status, seeded.stderr).toBe(0);

  const app = await electron.launch({
    args: ['.', `--user-data-dir=${path.join(stateDir, 'electron-user-data')}`],
    cwd: FRONTEND_ROOT, env, colorScheme: null, timeout: 180_000,
  });
  registerStateDir(stateDir);
  try {
    const win = await app.firstWindow({ timeout: 180_000 });
    const problems: string[] = [];
    win.on('pageerror', (e) => problems.push(e.message));
    await win.getByRole('navigation', { name: 'Sections' }).getByRole('link', { name: 'Search' }).click();
    await expect(win.getByRole('heading', { name: 'Your collection', level: 1 })).toBeVisible({ timeout: 60_000 });
    await expectList(win, {}, '7 papers in your collection');
    await expect(win.locator('[data-collection="export"]')).toContainText('Export these 7 papers as');

    // — a source: every source counted in the whole collection, two ticked ------
    let menu = await openMenu(win, 'source');
    await expect(menu.locator('.facet-caption')).toHaveText(
      'Each number counts the papers from that source in your collection. Tick several to see papers from any of them.');
    await expect.poll(() => drawn(win, 'source')).toEqual(await counted(win, 'sources', {}));
    expect(await drawn(win, 'source')).toEqual([
      { value: 'arxiv', count: '3', chosen: false },
      { value: 'crossref', count: '3', chosen: false },
      { value: 'pubmed', count: '1', chosen: false },
    ]);
    await menu.locator('li[data-value="arxiv"] input').click();
    await expect(menu.locator('li[data-value="arxiv"] input')).toBeChecked();
    await menu.locator('li[data-value="crossref"] input').click();
    await expect(win).toHaveURL(/#\/search\?source=arxiv&source=crossref$/);
    let f: Filters = { sources: ['arxiv', 'crossref'] };
    await expectList(win, f, '6 papers matching your filters');
    // A group's own ticks do not move its numbers: they count under everything else.
    await expect.poll(() => drawn(win, 'source')).toEqual(await counted(win, 'sources', f));
    await expect(win.locator('.facet-trigger[data-facet="source"] .facet-n')).toHaveText('2');
    await win.keyboard.press('Escape');
    await expect(menu).toBeHidden();

    // — a category: counted within those sources, one ticked ----------------------
    menu = await openMenu(win, 'category');
    await expect(menu.locator('.facet-caption')).toContainText('Each number counts the papers in that category that match your other filters.');
    await expect.poll(() => drawn(win, 'category')).toEqual(await counted(win, 'categories', f));
    expect((await drawn(win, 'category')).map((r) => r.value)).not.toContain('q-bio');
    await menu.locator('li[data-value="physics.app-ph"] input').click();
    f = { ...f, categories: ['physics.app-ph'] };
    const narrowed = await expectList(win, f, '3 papers matching your filters');
    await expect.poll(() => drawn(win, 'category')).toEqual(await counted(win, 'categories', f));
    fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });
    await win.screenshot({ path: path.join(SCREENSHOT_DIR, 'atlas-collection-filters.png') });
    await win.keyboard.press('Escape');
    await expect(win.locator('[data-collection="filters"] .term')).toHaveText(['From arXiv', 'From CrossRef', 'In physics.app-ph']);

    // — the export: every paper the count counts, through the save dialog ---------
    const exports = win.locator('[data-collection="export"]');
    await expect(exports).toContainText('Export these 3 papers as');
    await expect(win.locator('[data-collection="export-note"]')).toHaveCount(0);
    const bib = path.join(stateDir, 'collection.bib');
    await downloadTo(app, bib);
    await exports.getByRole('button', { name: 'BibTeX', exact: true }).click();
    await expect.poll(() => [...contents(bib).matchAll(/^@\w+\{/gm)].length, { timeout: 30_000 }).toBe(3);
    const dois = [...contents(bib).matchAll(/^ {2}doi = \{(.+)\},?$/gm)].map((m) => m[1]).sort();
    expect(dois).toEqual(narrowed.results.map((r) => r.doi).sort());
    await expect(win.locator('[data-collection="exported"]'))
      .toHaveText('3 papers into resmon-collection.bib; the save dialog asks where it goes.');
    await win.screenshot({ path: path.join(SCREENSHOT_DIR, 'atlas-collection-export.png') });

    // — an author, and taking it off again by its chip -----------------------------
    menu = await openMenu(win, 'author');
    await expect.poll(() => drawn(win, 'author')).toEqual(await counted(win, 'authors', f));
    await menu.locator('li[data-value="Ada Fixture"] input').click();
    await expectList(win, { ...f, authors: ['Ada Fixture'] }, '2 papers matching your filters');
    await win.keyboard.press('Escape');
    await win.locator('[data-filter="author"] button').click();
    await expectList(win, f, '3 papers matching your filters');

    // — a date: the undated paper leaves, and the chip says the day in words ------
    menu = await openMenu(win, 'published');
    await menu.getByLabel('From').fill('2026-06-01');
    f = { ...f, date_from: '2026-06-01' };
    await expectList(win, f, '2 papers matching your filters');
    await win.screenshot({ path: path.join(SCREENSHOT_DIR, 'atlas-collection-dates.png') });
    await win.keyboard.press('Escape');
    await expect(win.locator('[data-filter="from"]')).toHaveText('Published from June 1, 2026');

    // — words: they narrow the counts too, and a ticked source with none says 0 ----
    await win.getByLabel('Search your collection').fill('tandem');
    await win.getByLabel('Search your collection').press('Enter');
    f = { ...f, query: 'tandem' };
    await expectList(win, f, '1 paper matching your filters and these words');
    menu = await openMenu(win, 'source');
    await expect(menu.locator('.facet-caption')).toContainText('that match your words and your other filters');
    await expect.poll(() => drawn(win, 'source')).toEqual(await counted(win, 'sources', f));
    expect(await drawn(win, 'source')).toContainEqual({ value: 'arxiv', count: '0', chosen: true });
    await win.keyboard.press('Escape');
    await expect(exports).toContainText('Export this paper as');

    // — Clear all takes every filter off and leaves the words ----------------------
    await win.locator('[data-collection="filters"]').getByRole('button', { name: 'Clear all' }).click();
    await expect(win.locator('[data-collection="filters"]')).toHaveCount(0);
    await expectList(win, { query: 'tandem' }, '1 paper match');

    // — a chart's source row opens the collection with that filter set -------------
    await win.getByRole('navigation', { name: 'Sections' }).getByRole('link', { name: 'Health' }).click();
    await win.getByRole('navigation', { name: 'Health' }).getByRole('link', { name: 'Analytics' }).click();
    await win.locator('[data-analytics="sources"] .bar-row[data-source="crossref"] a.bar-name').click({ timeout: 60_000 });
    await expect(win.getByRole('heading', { name: 'Your collection', level: 1 })).toBeVisible({ timeout: 30_000 });
    expect(await win.evaluate(() => window.location.hash)).toBe('#/search?source=crossref');
    await expect(win.locator('[data-filter="source"]')).toHaveText('From CrossRef');
    await expectList(win, { sources: ['crossref'] }, '3 papers matching your filters');
    // The same state as ticking it: the menu shows it ticked, and another can join it.
    menu = await openMenu(win, 'source');
    await expect(win.locator('.facet-trigger[data-facet="source"] .facet-n')).toHaveText('1');
    await expect.poll(() => drawn(win, 'source')).toEqual(await counted(win, 'sources', { sources: ['crossref'] }));
    await menu.locator('li[data-value="arxiv"] input').click();
    await expect(win).toHaveURL(/#\/search\?source=crossref&source=arxiv$/);
    await expectList(win, { sources: ['crossref', 'arxiv'] }, '6 papers matching your filters');
    await win.keyboard.press('Escape');
    // And the chart's filter comes off like any other, leaving the one ticked here.
    await win.locator('[data-filter="source"][data-value="crossref"] button').click();
    await expect(win).toHaveURL(/#\/search\?source=arxiv$/);
    await expectList(win, { sources: ['arxiv'] }, '3 papers matching your filters');

    expect(problems).toEqual([]);
  } finally {
    await app.close();
    fs.rmSync(stateDir, { recursive: true, force: true });
  }
});

/** More papers than one export holds, the five oldest dated before the rest. */
const MANY = String.raw`
import os, sys
sys.path.insert(0, sys.argv[1])
from implementation_scripts.database import init_db, get_connection
path = os.environ["RESMON_DB_PATH"]
init_db(path)
conn = get_connection(path)
conn.executemany(
    "INSERT INTO documents (source_repository, external_id, title, abstract, publication_date, metadata_hash) "
    "VALUES ('arxiv', ?, ?, 'An authored abstract about perovskite films.', ?, ?)",
    [(f"e2e-many-{n}", f"Oldest perovskite film {n}" if n < 5 else f"Perovskite film {n}",
      f"2020-01-0{n + 1}" if n < 5 else "2026-10-01", f"e2e-many-{n}") for n in range(10005)],
)
conn.commit()
`;

test('an export the engine caps says so before it is saved, and the file holds what it said', async () => {
  test.setTimeout(240_000);
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'resmon-e2e-atlas-export-cap-'));
  const env: Record<string, string> = { ...launchEnv(stateDir, true), RESMON_UI: 'atlas' };
  const seeded = spawnSync(env.RESMON_PYTHON ?? 'python3', ['-c', MANY, path.join(FRONTEND_ROOT, '..')], { env, encoding: 'utf8' });
  expect(seeded.status, seeded.stderr).toBe(0);

  const app = await electron.launch({
    args: ['.', `--user-data-dir=${path.join(stateDir, 'electron-user-data')}`],
    cwd: FRONTEND_ROOT, env, colorScheme: null, timeout: 180_000,
  });
  registerStateDir(stateDir);
  try {
    const win = await app.firstWindow({ timeout: 180_000 });
    const problems: string[] = [];
    win.on('pageerror', (e) => problems.push(e.message));
    await win.getByRole('navigation', { name: 'Sections' }).getByRole('link', { name: 'Search' }).click();
    await expect(win.getByRole('heading', { name: 'Your collection', level: 1 })).toBeVisible({ timeout: 60_000 });
    await expect(win.locator('.count-sentence')).toContainText('10,000+ papers in your collection', { timeout: 60_000 });

    // Said before anything is saved: the file's size, and that the rest is left out.
    const exports = win.locator('[data-collection="export"]');
    await expect(exports).toContainText('Export the newest 10,000 as');
    await expect(win.locator('[data-collection="export-note"]')).toHaveText(
      'An export holds at most 10,000 papers, so this file will hold the newest 10,000 of the 10,000+ that match; '
      + 'narrow the filters to reach the rest.');
    await win.screenshot({ path: path.join(SCREENSHOT_DIR, 'atlas-collection-export-cap.png') });

    const csv = path.join(stateDir, 'collection.csv');
    await downloadTo(app, csv);
    await exports.getByRole('button', { name: 'CSV', exact: true }).click();
    await expect(win.locator('[data-collection="exported"]'))
      .toHaveText('10,000 papers into resmon-collection.csv; the save dialog asks where it goes.', { timeout: 60_000 });
    await expect.poll(() => contents(csv).trimEnd().split('\n').length, { timeout: 60_000 }).toBe(10_001);
    expect(contents(csv), 'the newest were kept and the oldest left out').not.toContain('Oldest perovskite film');
    expect(problems).toEqual([]);
  } finally {
    await app.close();
    fs.rmSync(stateDir, { recursive: true, force: true });
  }
});
