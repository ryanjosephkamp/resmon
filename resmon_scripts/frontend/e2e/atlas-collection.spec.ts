/**
 * Atlas: the collection, a paper, and the reading queue, in the real app.
 *
 * A seeded corpus of three papers: two records of the same work from two
 * sources (they share a DOI and are linked as near-duplicates) and one other,
 * all collected by one run. Followed through what a reader does with them:
 * search the collection, see the same work labeled and fold it without the
 * count moving, open a paper and read why it is there, save it to read, mark
 * it read and take it out of the queue, and save another from its run. With
 * no embedding model, the collection says why it offers no ranking by meaning,
 * and its link opens Settings → AI at Embeddings. A second case seeds more
 * papers than the search counts and reads the cap said beside the number.
 *
 * The journeys J09, J10, J12 and J28 drive the same screens through
 * `journeys/drivers/atlas.ts`, including ranking by meaning against a
 * loopback embedder; this spec is the part that runs on every pull request.
 * No network is involved: nothing here asks a source.
 */
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { test, expect, _electron as electron } from '@playwright/test';
import { FRONTEND_ROOT, SCREENSHOT_DIR, launchEnv, registerStateDir } from './fixtures/resmon-app';

const SEED = String.raw`
import json, os, sys
sys.path.insert(0, sys.argv[1])
from implementation_scripts.database import (init_db, get_connection, insert_document, insert_execution,
    link_execution_document, record_execution_source, update_execution_status)
path = os.environ["RESMON_DB_PATH"]
init_db(path)
conn = get_connection(path)
ids = []
for n, (source, title, doi) in enumerate((
    ("arxiv", "Perovskite solar cells that keep their efficiency", "10.5555/same-work"),
    ("crossref", "Perovskite solar cells that keep their efficiency", "10.5555/same-work"),
    ("arxiv", "Light-emitting diodes from layered crystals", None),
)):
    ids.append(insert_document(conn, {
        "source_repository": source, "external_id": f"e2e-{n}", "title": title, "doi": doi,
        "authors": "Ada Fixture, Ben Fixture", "publication_date": "2026-10-01",
        "abstract": f"{title}. An authored abstract for the suite, not a published one.",
        "metadata_hash": f"e2e-{n}",
    }))
conn.execute("INSERT INTO document_links (document_a, document_b, kind, score, method) "
             "VALUES (?, ?, 'near_duplicate', NULL, 'shared_doi')", (ids[0], ids[1]))
run = insert_execution(conn, {"execution_type": "deep_dive", "start_time": "2026-10-28T00:00:00Z",
    "parameters": json.dumps({"repository": "arxiv", "query": "perovskite", "keywords": ["perovskite"]})})
for doc in ids:
    link_execution_document(conn, run, doc)
record_execution_source(conn, run, "arxiv", "ok", result_count=3, zero_reason=None)
update_execution_status(conn, run, "completed", end_time="2026-10-28T00:00:09Z", result_count=3, new_result_count=3)
conn.commit()
print(json.dumps({"ids": ids, "run": run}))
`;

test('the collection, a paper, and the reading queue', async () => {
  test.setTimeout(240_000);
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'resmon-e2e-atlas-collection-'));
  const env: Record<string, string> = { ...launchEnv(stateDir, true), RESMON_UI: 'atlas' };
  const seeded = spawnSync(env.RESMON_PYTHON ?? 'python3', ['-c', SEED, path.join(FRONTEND_ROOT, '..')], { env, encoding: 'utf8' });
  expect(seeded.status, seeded.stderr).toBe(0);
  const { ids, run } = JSON.parse(seeded.stdout.trim().split('\n').pop() ?? '{}') as { ids: number[]; run: number };
  const [pairA, pairB, other] = ids as [number, number, number];

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
    const results = win.locator('section.results');
    await expect(results).toHaveAttribute('aria-busy', 'false', { timeout: 60_000 });

    // The whole collection, the same work labeled from both sides.
    await expect(win.locator('.count-sentence')).toHaveText('3 papers in your collection');
    // No embedding model: no ranking control, and the sentence in its place says why.
    await expect(win.getByRole('group', { name: 'Order' })).toHaveCount(0);
    await expect(win.locator('[data-collection="ranking"]')).toHaveText(
      'Ranking by meaning is off: no embedding model is set up, so none of your 3 papers has a vector. '
      + 'Set one up in Settings → AI → Embeddings.',
    );
    await expect(win.locator('.result')).toHaveCount(3);
    await expect(win.locator(`.result[data-document="${pairA}"] .result-links li`)).toHaveText(['also appears in crossref — same DOI']);
    await expect(win.locator(`.result[data-document="${pairB}"] .result-links li`)).toHaveText(['also appears in arxiv — same DOI']);

    // Folding hides a row in this view only: the count does not move.
    await win.getByLabel('Fold the same work into one row').check();
    await expect(win.locator('.result')).toHaveCount(2);
    await expect(win.locator(`.result[data-document="${pairA}"]`)).toBeVisible();
    await expect(win.locator('.collapse-note')).toContainText('Nothing was removed');
    await expect(win.locator('.count-sentence')).toHaveText('3 papers in your collection');
    await win.getByLabel('Fold the same work into one row').uncheck();
    await expect(win.locator('.result')).toHaveCount(3);

    // A query narrows the list.
    await win.getByLabel('Search your collection').fill('crystals');
    await win.getByLabel('Search your collection').press('Enter');
    await expect(win.locator('.count-sentence')).toHaveText('1 paper match');
    await expect(win.locator('.result .result-title')).toHaveText(['Light-emitting diodes from layered crystals']);

    // A paper: the record, why it is here, and saving it to read.
    await win.locator('.result .result-title').first().click();
    const paper = win.locator(`.paper[data-paper="${other}"]`);
    await expect(paper).toBeVisible();
    await expect(win.locator('.paper-abstract')).toContainText('An authored abstract');
    await expect(win.locator('.why .why-limits-label')).toHaveText('What resmon cannot see');
    await expect(win.locator('.why .why-limits li').first()).toBeVisible();
    await win.getByRole('button', { name: 'Save to read' }).click();
    await expect(win.locator('.paper-actions')).toHaveAttribute('data-queue', 'to_read');
    await expect(win.locator('.paper-actions .queue-state')).toHaveText('In the reading queue · To read');
    fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });
    await win.screenshot({ path: path.join(SCREENSHOT_DIR, 'atlas-paper.png') });

    // The queue: there under To read, marked read, then removed.
    await win.getByRole('navigation', { name: 'Sections' }).getByRole('link', { name: 'Library' }).click();
    await expect(win.getByRole('heading', { name: 'Reading queue', level: 1 })).toBeVisible();
    const row = win.locator(`.queue-row[data-document="${other}"]`);
    await expect(row.locator('.queue-state')).toHaveText('To read');
    await row.getByRole('button', { name: 'Mark read' }).click();
    await expect(win.locator(`.queue-row[data-document="${other}"]`)).toHaveCount(0);
    await win.getByRole('group', { name: 'Show' }).getByRole('button', { name: /^Read/ }).click();
    await expect(row.locator('.queue-state')).toHaveText('Read');
    await row.getByRole('button', { name: 'Remove' }).click();
    await expect(row).toHaveCount(0);
    await expect(win.locator('.queue-empty')).toHaveText('Nothing is marked read yet.');

    // Saving from the run that collected it.
    await win.evaluate((id) => { window.location.hash = `#/runs/${id}`; }, run);
    await win.getByRole('tab', { name: 'Papers' }).click();
    const fromRun = win.locator(`.paper-row[data-document="${pairA}"]`);
    await fromRun.getByRole('button', { name: 'Save to read' }).click();
    await expect(fromRun).toHaveAttribute('data-queue', 'to_read');
    await expect(fromRun.locator('.queue-state')).toHaveText('Saved · To read');

    // The way to ranking by meaning leads somewhere: Settings → AI, opened at Embeddings.
    await win.getByRole('navigation', { name: 'Sections' }).getByRole('link', { name: 'Search' }).click();
    await win.locator('[data-collection="ranking"]').getByRole('link', { name: 'Set one up in Settings → AI → Embeddings' }).click();
    await expect(win.getByRole('heading', { name: 'Embeddings', level: 3 })).toBeFocused({ timeout: 30_000 });
    await expect(win.locator('section.embeddings')).toBeInViewport();
    await expect(win.locator('section.embeddings [data-embeddings="missing"] dd'))
      .toHaveText('3 papers: no embedding model is set up to make vectors.');
    expect(await win.evaluate(() => window.location.hash), 'the request to focus is cleared once used').toBe('#/settings/ai');

    expect(problems).toEqual([]);
  } finally {
    await app.close();
    fs.rmSync(stateDir, { recursive: true, force: true });
  }
});

/** More papers than the search counts, written in one transaction: no authors or categories, so no facet rows. */
const MANY = String.raw`
import os, sys
sys.path.insert(0, sys.argv[1])
from implementation_scripts.database import init_db, get_connection
path = os.environ["RESMON_DB_PATH"]
init_db(path)
conn = get_connection(path)
conn.executemany(
    "INSERT INTO documents (source_repository, external_id, title, abstract, publication_date, metadata_hash) "
    "VALUES ('arxiv', ?, ?, 'An authored abstract about perovskite films.', '2026-10-01', ?)",
    [(f"e2e-many-{n}", f"Perovskite film {n}", f"e2e-many-{n}") for n in range(10005)],
)
conn.commit()
`;

test('a count the search stopped at its cap says so beside the number', async () => {
  test.setTimeout(240_000);
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'resmon-e2e-atlas-cap-'));
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

    // The whole collection: the cap, and the collection's own count of every record.
    await expect(win.locator('.count-sentence')).toHaveText(
      '10,000+ papers in your collection · Search stops counting at 10,000; your collection holds 10,005 papers in all.',
      { timeout: 60_000 },
    );
    // A search: the cap alone, because the collection's count is not a count of these matches.
    await win.getByLabel('Search your collection').fill('perovskite');
    await win.getByLabel('Search your collection').press('Enter');
    await expect(win.locator('.count-sentence')).toHaveText('10,000+ papers match · Search stops counting at 10,000.', { timeout: 60_000 });
    await expect(win.locator('[data-collection="ranking"]')).toContainText('none of your 10,005 papers has a vector');
    expect(problems).toEqual([]);
  } finally {
    await app.close();
    fs.rmSync(stateDir, { recursive: true, force: true });
  }
});
