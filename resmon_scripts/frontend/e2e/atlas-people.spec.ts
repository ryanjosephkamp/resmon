/**
 * Atlas: People, in the real app.
 *
 * A seeded corpus: one person watched with an affiliation and no ORCID, and
 * two papers matched to them, one by name and affiliation and one by name
 * alone. Followed through what a person does: read the list and its chip,
 * start a new person and watch the warning change as an affiliation and then
 * an ORCID are typed, save, read a person's matches with their bases, see the
 * bases on the collection's rows, and read whether each source can be asked
 * about an author where sources are chosen.
 *
 * The journeys J07 and J08 drive the same screens through
 * `journeys/drivers/atlas.ts`; this spec is the part that runs on every pull
 * request, and the one that reaches recorded matches, which J07's keyword run
 * cannot produce.
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
from implementation_scripts.database import init_db, get_connection, insert_document
from implementation_scripts import watch_profiles as wp
path = os.environ["RESMON_DB_PATH"]
init_db(path)
conn = get_connection(path)
person = wp.create_profile(conn, {"kind": "person", "display_name": "Ada Fixture",
    "names": [{"value": "Ada Fixture"}, {"value": "A. Fixture"}], "affiliations": ["University of Somewhere"]})
docs = [insert_document(conn, {
    "source_repository": "arxiv", "external_id": f"people-{n}", "title": title, "authors": "Ada Fixture, Ben Other",
    "publication_date": "2026-10-01", "abstract": "An authored abstract.", "metadata_hash": f"people-{n}"})
    for n, title in enumerate(("Perovskite films by a named author", "Light-emitting diodes by the same name"))]
for doc, basis in zip(docs, ("name+affiliation", "name_only")):
    conn.execute("INSERT INTO watch_profile_matches (document_id, profile_id, basis, matched_author, evidence) "
                 "VALUES (?, ?, ?, 'Ada Fixture', ?)", (doc, person["id"], basis, f"seeded for the suite: {basis}"))
conn.commit()
print(json.dumps({"person": person["id"], "docs": docs}))
`;

test('People: the warning while typing, a person\'s matches and their bases, and which sources can be asked', async () => {
  test.setTimeout(240_000);
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'resmon-e2e-atlas-people-'));
  const env: Record<string, string> = { ...launchEnv(stateDir, true), RESMON_UI: 'atlas' };
  const seeded = spawnSync(env.RESMON_PYTHON ?? 'python3', ['-c', SEED, path.join(FRONTEND_ROOT, '..')], { env, encoding: 'utf8' });
  expect(seeded.status, seeded.stderr).toBe(0);
  const { person, docs } = JSON.parse(seeded.stdout.trim().split('\n').pop() ?? '{}') as { person: number; docs: number[] };

  const app = await electron.launch({
    args: ['.', `--user-data-dir=${path.join(stateDir, 'electron-user-data')}`],
    cwd: FRONTEND_ROOT, env, colorScheme: null, timeout: 180_000,
  });
  registerStateDir(stateDir);
  try {
    const win = await app.firstWindow({ timeout: 180_000 });
    const problems: string[] = [];
    win.on('pageerror', (e) => problems.push(e.message));
    await win.getByRole('navigation', { name: 'Sections' }).getByRole('link', { name: 'Watches' }).click();
    await win.getByRole('navigation', { name: 'Watches' }).getByRole('link', { name: 'People' }).click();
    await expect(win.getByRole('heading', { name: 'People', level: 1 })).toBeVisible({ timeout: 60_000 });

    // The list says what a match can mean without the person being opened.
    const row = win.locator(`.person[data-profile="${person}"]`);
    await expect(row.locator('.basis-chip')).toHaveText('name + affiliation');

    // The help states what a source that cannot be asked does.
    await win.locator('details.place-help summary').click();
    await expect(win.locator('.place-help-body')).toContainText('cannot be asked about a person');

    // A new person: the warning is the saved profile's sentence, and it changes as the form does.
    await win.getByRole('button', { name: 'New person' }).click();
    const warning = win.locator('[data-people="warning"]');
    await win.locator('#person-name').fill('Ben Other');
    await expect(warning).toContainText('every match will be name-only');
    await win.locator('#person-affiliations').fill('Another Institute');
    await expect(warning).toContainText('never by identity');
    await win.locator('#person-orcid').fill('0000-0002-1825-0097');
    await expect(warning).toHaveAttribute('data-state', 'clear');
    await win.locator('#person-orcid').fill('');
    await win.locator('form.person-editor').screenshot({ path: path.join(SCREENSHOT_DIR, 'atlas-people-editor.png') });
    // ⌘Enter (Ctrl+Enter) in any of the person's fields saves them, as Save person does.
    await win.locator('#person-affiliations').press('ControlOrMeta+Enter');
    await expect(win.locator('.person').filter({ hasText: 'Ben Other' }).locator('.basis-chip')).toHaveText('name + affiliation');

    // A person's matches, each with the basis it matched on and the author string it matched.
    await row.locator('.watch-name').click();
    const page = win.locator(`.person-page[data-profile="${person}"]`);
    await expect(page.locator('[data-people="counts"]')).toHaveText('2 matches: 1 name + affiliation, 1 name only');
    await expect(page.locator('.match')).toHaveCount(2);
    await expect(page.locator(`.match[data-document="${docs[1]}"] .basis-chip`)).toHaveText('name only');
    await expect(page.locator(`.match[data-document="${docs[1]}"] .match-author`)).toHaveText('as Ada Fixture');
    await expect(page.locator('[data-people="basis-warning"]')).toContainText('never by identity');
    fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });
    await win.screenshot({ path: path.join(SCREENSHOT_DIR, 'atlas-person.png') });

    // The collection carries the same bases on its rows.
    await win.getByRole('navigation', { name: 'Sections' }).getByRole('link', { name: 'Search' }).click();
    await expect(win.locator(`.result[data-document="${docs[0]}"] .result-people .basis-chip`)).toHaveText('name + affiliation');
    await expect(win.locator(`.result[data-document="${docs[1]}"] .result-people .basis-chip`)).toHaveText('name only');

    // Where sources are chosen, each says whether it can be asked about an author.
    await win.evaluate(() => { window.location.hash = '#/search/ask'; });
    await expect(win.locator('.source[data-source="biorxiv"] [data-author-query]')).toHaveText('cannot be asked about an author');
    await expect(win.locator('.source[data-source="arxiv"] [data-author-query]')).toHaveText('can be asked about an author');

    expect(problems).toEqual([]);
  } finally {
    await app.close();
    fs.rmSync(stateDir, { recursive: true, force: true });
  }
});
