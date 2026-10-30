/**
 * Atlas: bringing people in and out, in the real app. The starter set that
 * ships with resmon, a person exported as a file, and a file of people
 * imported.
 *
 * A seeded collection with one person, Ada Fixture, carrying an ORCID and
 * where it came from. Followed through what a person does: open the starter
 * set and add one of its people, then find them marked as already watched;
 * export Ada from her page through the real download; import that file, with
 * a second entry the engine cannot read, and read the sentence naming both;
 * and choose a file that is not JSON. Each step is held to what the engine
 * stored, read back over its own routes. No network: nothing here asks a
 * source.
 */
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { test, expect, _electron as electron, type Page } from '@playwright/test';
import { FRONTEND_ROOT, SCREENSHOT_DIR, launchEnv, registerStateDir } from './fixtures/resmon-app';

const SEED = String.raw`
import json, os, sys
sys.path.insert(0, sys.argv[1])
from implementation_scripts.database import init_db, get_connection
from implementation_scripts import watch_profiles as wp
path = os.environ["RESMON_DB_PATH"]
init_db(path)
conn = get_connection(path)
person = wp.create_profile(conn, {"kind": "person", "display_name": "Ada Fixture",
    "names": [{"value": "Ada Fixture"}, {"value": "A. Fixture"}],
    "identifiers": {"orcid": {"value": "0000-0002-1825-0097", "cited": "an authored fixture, not a real record"}},
    "affiliations": ["University of Somewhere"], "field_hints": ["graph learning"], "notes": "Seeded for the suite."})
print(json.dumps({"person": person["id"]}))
`;

interface Profile {
  id: number; display_name: string; names: { value: string; script?: string }[];
  identifiers: Record<string, { value: string; cited?: string }>; affiliations: string[]; field_hints: string[];
  notes: string | null;
}

async function api<T>(win: Page, route: string, asText = false): Promise<T> {
  return win.evaluate(async ([r, text]) => {
    const port = (window as unknown as { resmonAPI: { getBackendPort(): string } }).resmonAPI.getBackendPort();
    const res = await e2eFetch(`http://127.0.0.1:${port}${r}`);
    return text ? res.text() : res.json();
  }, [route, asText] as const) as Promise<T>;
}

test('People: the starter set, a person exported, and a file of people imported', async () => {
  test.setTimeout(240_000);
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'resmon-e2e-atlas-people-tools-'));
  const env: Record<string, string> = { ...launchEnv(stateDir, true), RESMON_UI: 'atlas' };
  const seeded = spawnSync(env.RESMON_PYTHON ?? 'python3', ['-c', SEED, path.join(FRONTEND_ROOT, '..')], { env, encoding: 'utf8' });
  expect(seeded.status, seeded.stderr).toBe(0);
  const { person } = JSON.parse(seeded.stdout.trim().split('\n').pop() ?? '{}') as { person: number };

  const app = await electron.launch({
    args: ['.', `--user-data-dir=${path.join(stateDir, 'electron-user-data')}`],
    cwd: FRONTEND_ROOT, env, colorScheme: null, timeout: 180_000,
  });
  registerStateDir(stateDir);
  try {
    const win = await app.firstWindow({ timeout: 180_000 });
    const problems: string[] = [];
    win.on('pageerror', (e) => problems.push(e.message));
    const sections = win.getByRole('navigation', { name: 'Sections' });
    await sections.waitFor({ timeout: 120_000 });
    await sections.getByRole('link', { name: 'Watches' }).click();
    await win.getByRole('navigation', { name: 'Watches' }).getByRole('link', { name: 'People' }).click();
    await expect(win.getByRole('heading', { name: 'People', level: 1 })).toBeVisible({ timeout: 60_000 });
    const people = async () => (await api<{ profiles: Profile[] }>(win, '/api/profiles')).profiles;

    // — the starter set: what is installed, added as it ships ---------------------------
    const starters = (await api<{ profiles: (Profile & { source_file: string })[] }>(win, '/api/profiles/starter')).profiles;
    expect(starters.length).toBeGreaterThan(0);
    await win.getByRole('button', { name: 'Starter set' }).click();
    const set = win.locator('[data-people="starter"]');
    await expect(set.locator('.starter-person .starter-name')).toHaveText(starters.map((s) => s.display_name));
    const chosen = starters[0]!;
    const entry = set.locator(`.starter-person[data-starter="${chosen.source_file}"]`);
    await expect(entry.locator('.match-evidence')).toHaveText(chosen.identifiers.orcid?.cited ?? '');
    await entry.getByRole('button', { name: 'Add', exact: true }).click();
    await expect(set.locator('[data-people="added"]')).toContainText(`Added ${chosen.display_name}.`);
    const added = (await people()).find((p) => p.display_name === chosen.display_name);
    expect(added, 'the starter person was not stored').toBeTruthy();
    // Stored exactly as it ships: the ORCID's citation and each spelling's script survive.
    expect({ names: added!.names, identifiers: added!.identifiers, affiliations: added!.affiliations, notes: added!.notes })
      .toEqual({ names: chosen.names, identifiers: chosen.identifiers, affiliations: chosen.affiliations, notes: chosen.notes });
    await expect(entry.getByRole('link', { name: 'In your people' })).toHaveAttribute('href', `#/watches/people/${added!.id}`);
    await expect(entry.getByRole('button', { name: 'Add', exact: true })).toHaveCount(0);
    await expect(win.locator(`.person[data-profile="${added!.id}"] .watch-name`)).toHaveText(chosen.display_name);
    fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });
    await win.screenshot({ path: path.join(SCREENSHOT_DIR, 'atlas-people-starter.png') });
    await win.getByRole('button', { name: 'Starter set' }).click();

    // — a person exported: the engine's bytes, through the real download -----------------
    await win.locator(`.person[data-profile="${person}"] .watch-name`).click();
    const file = path.join(stateDir, 'ada-fixture.json');
    await app.evaluate(({ BrowserWindow }, where) => {
      BrowserWindow.getAllWindows()[0].webContents.session.once('will-download', (_e, item) => {
        item.setSavePath(where as string);
      });
    }, file);
    await win.locator('[data-people="export"]').click();
    await expect(win.locator('[data-people="exported"]')).toContainText('ada-fixture.json');
    await expect.poll(() => (fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : ''), { timeout: 30_000 }).not.toBe('');
    const engineSaid = await api<string>(win, `/api/profiles/${person}/export`, true);
    expect(fs.readFileSync(file, 'utf8')).toBe(engineSaid);
    const exported = JSON.parse(engineSaid) as Record<string, unknown>;
    expect(exported).toMatchObject({ schema: 1, display_name: 'Ada Fixture' });
    expect(exported).not.toHaveProperty('id');

    // — that file imported, with an entry the engine cannot read --------------------------
    await win.locator('.person-page .back').click();
    const before = await people();
    const bundle = path.join(stateDir, 'people.json');
    fs.writeFileSync(bundle, JSON.stringify([exported, { kind: 'person', display_name: 'No schema here' }]));
    await win.locator('#people-import').setInputFiles(bundle);
    const reason = "This file has no 'schema' field, so resmon cannot tell what it is.";
    await expect(win.locator('[data-people="imported"]')).toHaveText(
      'Imported 1 person from people.json: Ada Fixture. It is added as a new person; resmon never merges an import with the '
        + `people you have. 1 entry could not be read: entry 2, ${reason}`, { timeout: 30_000 });
    const after = await people();
    expect(after).toHaveLength(before.length + 1);
    const copy = after.find((p) => !before.some((b) => b.id === p.id))!;
    expect({ display_name: copy.display_name, names: copy.names, identifiers: copy.identifiers,
      affiliations: copy.affiliations, field_hints: copy.field_hints, notes: copy.notes })
      .toEqual({ display_name: exported.display_name, names: exported.names, identifiers: exported.identifiers,
        affiliations: exported.affiliations, field_hints: exported.field_hints, notes: exported.notes });
    await expect(win.locator(`.person[data-profile="${copy.id}"] .watch-name`)).toHaveText('Ada Fixture');
    await win.screenshot({ path: path.join(SCREENSHOT_DIR, 'atlas-people-imported.png') });

    // — a file that is not JSON: refused here, by name, and nothing stored -----------------
    const notes = path.join(stateDir, 'notes.txt');
    fs.writeFileSync(notes, 'not a profile');
    await win.locator('#people-import').setInputFiles(notes);
    await expect(win.locator('[data-people="import-refused"]')).toHaveText('notes.txt is not JSON, so nothing was imported.');
    expect(await people()).toHaveLength(after.length);

    expect(problems).toEqual([]);
  } finally {
    await app.close();
    fs.rmSync(stateDir, { recursive: true, force: true });
  }
});
