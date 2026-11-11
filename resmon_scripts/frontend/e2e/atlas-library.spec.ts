/**
 * Atlas: the Library as one gallery, in the real app.
 *
 * A collection of synthetic papers on four subjects, a watch's run that found
 * them, and fourteen saved to read. The gallery draws their covers from the
 * collection's map; a PDF linked to one draws its first page instead, and that
 * page is kept by the engine beside the database. A PDF opens in the reader
 * outside Evidence; a Markdown file and a TeX file open in the rich view with
 * their math drawn. A paper and a file are removed and put back with Undo; a
 * file in a project is asked about first. The Library folder is moved in the
 * Finder's place, found again, and moved by resmon. Select mode marks papers
 * read. Files are dropped on the page.
 *
 * **Scripted:** the native folder chooser (`dialog.showOpenDialog` answers
 * with this spec's folders, one call after another), the system's opener,
 * Finder, and Trash (`shell.openPath`, `shell.showItemInFolder` and
 * `shell.trashItem` record what they were handed and touch nothing). Every
 * folder is this spec's own temporary folder. No network.
 *
 * Each step of the walk is logged with the time it began (`LIBRARY WALK
 * 960x640 16:04:01.022 +5.8 s …`) and held to a time of its own, inside the
 * test's, so a walk that stalls fails with a sentence naming the step. It is
 * followed by where the window stood: its address and title, whether Atlas drew
 * its frame and which heading it shows, the engine's health asked through the
 * page and from here, the requests still waiting, every window and its size,
 * and what the app wrote. Whatever state a walk stops in, the app is closed in
 * bounded time and what it started is stopped.
 */
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { test, expect, _electron as electron, type ElectronApplication, type Page } from '@playwright/test';
import { ATLAS_LANDMARK, FRONTEND_ROOT, SCREENSHOT_DIR, atlasEnv, launchEnv, registerStateDir } from './fixtures/resmon-app';
import { inView, shelfHolds } from './fixtures/gallery';
import { writePdf, type PdfLine } from './fixtures/pdf';
import { resize } from './fixtures/maps';
import { closeWithin, removeStateDir } from './fixtures/cleanup';
import { capture, stepsWithin, tellWhere, watchWindow, type Watched } from './fixtures/steps';

const SEED = String.raw`
import json, os, sys
sys.path.insert(0, sys.argv[1])
from implementation_scripts.database import (init_db, get_connection, insert_document, insert_routine, insert_execution,
    link_execution_document, update_execution_status)
from implementation_scripts import reading_queue
path = os.environ["RESMON_DB_PATH"]
init_db(path)
conn = get_connection(path)
subjects = {
  "surface code": ["Below-threshold error correction with a distance-7 surface code", "Leakage reduction units for superconducting qubits at scale",
    "Decoding correlated errors with graph neural networks", "Magic state distillation with fewer ancillas", "Lattice surgery schedules for a logical processor",
    "Real-time decoding of the surface code on an FPGA", "Erasure qubits make the surface code cheaper", "Biased noise and the XZZX surface code"],
  "mixture of experts": ["Sparse mixture-of-experts routing under distribution shift", "Expert choice routing for language models",
    "Load balancing losses in sparse transformers", "Router collapse in mixture of experts training", "Distilling experts into a dense student",
    "Token dropping in sparse expert layers", "Calibrating routers with unlabeled data", "Scaling laws for fine-grained experts"],
  "base editing": ["Base editing corrects a pathogenic MYBPC3 variant in cardiomyocytes", "Prime editing in human hepatocytes",
    "Off-target effects of adenine base editors", "Delivering base editors with lipid nanoparticles", "Base editing in non-dividing neurons",
    "Cytosine base editors with narrower windows", "Correcting sickle cell disease by base editing", "Measuring bystander edits at scale"],
  "radio interferometry": ["Diffusion models as priors for radio interferometric imaging", "Calibrating the Very Large Array with neural fields",
    "Sparse recovery of extended radio emission", "Wide-field imaging with w-stacking revisited", "Bayesian deconvolution beyond CLEAN",
    "Radio frequency interference flagging with transformers", "Imaging the galactic center at 3 GHz", "Uncertainty in interferometric images"],
}
names = ["Priya Raman, Tomas Echeverria, Wen Liu", "Lena Vogt, Samuel Achterberg, Ines Carvalho", "Hannah Okafor, Daniel Reyes, Mei Tanaka",
         "Aisha Bello, Jonas Lindqvist", "Marcus Ilunga, Yuki Sato", "Ruth Okonkwo, Jakob Feldmann, Hiro Matsuda"]
sources = ["arxiv", "crossref", "pubmed", "openalex"]
watch = insert_routine(conn, {"name": "quantum-error-correction", "schedule_cron": "0 6 * * *", "parameters": json.dumps({"keywords": ["qubit"]})})
run = insert_execution(conn, {"execution_type": "automated_sweep", "routine_id": watch, "parameters": "{}", "start_time": "2026-11-03T06:00:00"})
search = insert_execution(conn, {"execution_type": "deep_dive", "parameters": "{}", "start_time": "2026-11-02T09:00:00"})
ids = []
n = 0
for subject, titles in subjects.items():
    for title in titles:
        words = subject + " " + title.lower()
        doc = insert_document(conn, {"source_repository": sources[n % 4], "external_id": f"lib-{n}", "title": title,
            "authors": names[n % len(names)], "abstract": ("We study " + words + ". ") * 6,
            "publication_date": f"2026-{(n % 9) + 1:02d}-{(n % 27) + 1:02d}", "url": f"https://example.org/paper/{n}",
            "categories": "cs.LG" if subject == "mixture of experts" else "quant-ph" if subject == "surface code" else "",
            "metadata_hash": f"lib-{n}"})
        link_execution_document(conn, run if subject == "surface code" else search, doc)
        ids.append(doc)
        n += 1
update_execution_status(conn, run, "completed", end_time="2026-11-03T06:01:00")
update_execution_status(conn, search, "completed", end_time="2026-11-02T09:01:00")
conn.commit()
saved = ids[0:6] + ids[8:12] + ids[16:18] + ids[24:26] + ids[28:32]
for i, doc in enumerate(saved):
    reading_queue.save(conn, doc)
    conn.execute("UPDATE reading_queue SET saved_at=?, updated_at=? WHERE document_id=?",
                 (f"2026-11-0{1 + i % 4} 0{i % 9}:00:00", f"2026-11-0{1 + i % 4} 0{i % 9}:00:00", doc))
conn.commit()
for doc in saved[-4:]:
    reading_queue.set_status(conn, doc, "read")
print(json.dumps({"ids": ids, "saved": saved}))
`;

/** A paper's first page, set as a preprint is: the title large, the authors, the abstract, and two columns. */
function paperPdf(title: string[], authors: string, body: string): Buffer {
  const lines: PdfLine[] = [];
  let y = 700;
  for (const t of title) { lines.push({ x: 92, y, size: 17, text: t }); y -= 22; }
  y -= 6;
  lines.push({ x: 160, y, size: 10.5, text: authors }); y -= 30;
  lines.push({ x: 280, y, size: 11, text: 'Abstract' }); y -= 18;
  for (let i = 0; i < 9; i += 1) { lines.push({ x: 108, y, size: 9, text: body.slice(i * 78, i * 78 + 78) }); y -= 12; }
  y -= 16;
  lines.push({ x: 72, y, size: 11, text: '1  Introduction' }); y -= 16;
  for (let i = 0; i < 24; i += 1) {
    lines.push({ x: 72, y, size: 8.5, text: body.slice((i * 47) % 400, (i * 47) % 400 + 46) });
    lines.push({ x: 320, y, size: 8.5, text: body.slice((i * 53) % 400, (i * 53) % 400 + 46) });
    y -= 11;
  }
  lines.push({ x: 20, y: 300, size: 14, text: 'arXiv:2611.01847v1' });
  return writePdf([{ lines }, { lines: [{ x: 72, y: 700, size: 12, text: 'Page two of the paper.' }] }]);
}

const BODY = 'Sparse mixture-of-experts models route each token to a small subset of experts, which makes their behavior under distribution shift hard to predict. We study how learned routers respond when inputs move away from the pretraining data, and we propose a calibration step that re-estimates router temperatures from a few hundred unlabeled examples. ';

const MARKDOWN = `# Reading notes, November

Routing under shift, from **Raman et al.**: entropy falls in the *middle* layers first.

## The calibration

The router's temperature $\\tau$ rescales the logits, and the loss is

$$
\\mathcal{L}(\\tau) = -\\sum_{i=1}^{n} \\log \\frac{e^{z_i/\\tau}}{\\sum_j e^{z_j/\\tau}}
$$

- [x] Read the paper
- [ ] Try it on our 8-expert checkpoint

| Layer | Entropy |
|---|---:|
| 4 | 2.31 |
| 12 | 0.87 |

> A link is your association. <https://example.org/notes>
`;

const TEX = String.raw`\section{Closure}
% The stress tensor, as in the draft.
The stress tensor $\tau_{ij}$ satisfies
\begin{equation}
  \nabla \cdot \tau = \rho \frac{D u}{D t}
\end{equation}
and the energy $E = \frac{1}{2} \int |u|^2 \, dx$ is conserved.
`;


/** Kept back from each test's timeout for saying where a stall stood and for the teardown. */
const TEARDOWN_MS = 60_000;

async function saveShot(win: Page, name: string): Promise<void> {
  fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });
  await win.screenshot({ path: path.join(SCREENSHOT_DIR, `library-${name}.png`), animations: 'disabled' });
}

async function chooseNext(app: ElectronApplication, folder: string): Promise<void> {
  await app.evaluate(({ dialog }, chosen) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [chosen] });
  }, folder);
}

async function api<T>(win: Page, route: string, init?: { method?: string; body?: unknown }): Promise<T> {
  return win.evaluate(async ([r, i]) => {
    const port = (window as unknown as { resmonAPI: { getBackendPort(): string } }).resmonAPI.getBackendPort();
    const res = await e2eFetch(`http://127.0.0.1:${port}${r}`, {
      method: i?.method ?? 'GET',
      headers: { 'X-Resmon-Library': '1', ...(i?.body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
      ...(i?.body !== undefined ? { body: JSON.stringify(i.body) } : {}),
    });
    if (!res.ok) throw new Error(`${r} answered ${res.status}: ${await res.text()}`);
    return res.json();
  }, [route, init] as const) as Promise<T>;
}

/**
 * The whole walk, in a window of the size given (or the suite's own), a step
 * at a time. Only the walk in the suite's own window saves screenshots.
 */
async function walk(size: [number, number] | null, prefix: string, testTimeoutMs: number): Promise<void> {
  const { say, step } = stepsWithin(prefix, testTimeoutMs, TEARDOWN_MS);
  const shot = (win: Page, name: string) => (size ? Promise.resolve() : saveShot(win, name));
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'resmon-e2e-atlas-library-'));
  const first = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'resmon-e2e-library-first-')));
  const elsewhere = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'resmon-e2e-library-moved-')));
  const second = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'resmon-e2e-library-second-')));
  const staging = fs.mkdtempSync(path.join(os.tmpdir(), 'resmon-e2e-library-staging-'));
  const trash = fs.mkdtempSync(path.join(os.tmpdir(), 'resmon-e2e-library-trash-'));
  let app: ElectronApplication | null = null;
  let win: Page | null = null;
  let watched: Watched | null = null;
  let wrote: (() => string) | null = null;
  let passed = false;
  try {
    // Held to the screen a run is held to (RESMON_E2E_SCREEN), as CI's macOS runner holds it.
    const env = atlasEnv({ ...launchEnv(stateDir, true), ...(size ? { RESMON_E2E_WIDTH: String(size[0]), RESMON_E2E_HEIGHT: String(size[1]) } : {}) });
    say(`the collection is seeded, in ${stateDir}`);
    const seeded = spawnSync(env.RESMON_PYTHON ?? 'python3', ['-c', SEED, path.join(FRONTEND_ROOT, '..')], { env, encoding: 'utf8', timeout: 60_000 });
    expect(seeded.status, seeded.stderr).toBe(0);
    const { ids, saved } = JSON.parse(seeded.stdout.trim().split('\n').pop() ?? '{}') as { ids: number[]; saved: number[] };
    const files = {
      moe: path.join(staging, 'Raman-2026-sparse-moe-routing.pdf'),
      edit: path.join(staging, 'Okafor-2026-base-editing.pdf'),
      radio: path.join(staging, 'Bello-2026-radio-priors.pdf'),
      notes: path.join(staging, 'reading-notes-november.md'),
      tex: path.join(staging, 'closure-derivation.tex'),
      txt: path.join(staging, 'lab-meeting.txt'),
    };
    fs.writeFileSync(files.moe, paperPdf(['Sparse Mixture-of-Experts Routing', 'Under Distribution Shift'], 'Priya Raman   Tomas Echeverria   Wen Liu', BODY));
    fs.writeFileSync(files.edit, paperPdf(['Base Editing Corrects a Pathogenic MYBPC3', 'Variant in iPSC-Derived Cardiomyocytes'], 'Hannah Okafor   Daniel Reyes   Mei Tanaka', BODY));
    fs.writeFileSync(files.radio, paperPdf(['Diffusion Models as Priors for Inverse', 'Problems in Radio Interferometry'], 'Aisha Bello   Jonas Lindqvist', BODY));
    fs.writeFileSync(files.notes, MARKDOWN);
    fs.writeFileSync(files.tex, TEX);
    fs.writeFileSync(files.txt, 'Lab meeting, Friday, November 6\n\nAgenda\n1. Router collapse results\n2. Interferometry priors\n');

    const launched = await step('the app starts', 180_000, (ms) => electron.launch({
      args: ['.', `--user-data-dir=${path.join(stateDir, 'electron-user-data')}`],
      cwd: FRONTEND_ROOT, env, colorScheme: 'dark', timeout: ms,
    }));
    app = launched;
    registerStateDir(stateDir);
    wrote = capture(launched).all;
    say(`the app is up, pid ${launched.process().pid}`);
    await step('the opener, the Finder, and the Trash are scripted', 15_000, () => launched.evaluate(({ shell }, bin) => {
      const g = globalThis as unknown as { opened: string[]; revealed: string[]; trashed: string[] };
      g.opened = []; g.revealed = []; g.trashed = [];
      const nodeFs = (process as unknown as { mainModule: { require(m: string): typeof import('fs') } }).mainModule.require('fs');
      const nodePath = (process as unknown as { mainModule: { require(m: string): typeof import('path') } }).mainModule.require('path');
      shell.openPath = async (target: string) => { g.opened.push(target); return ''; };
      shell.openExternal = async (target: string) => { g.opened.push(target); };
      shell.showItemInFolder = (target: string) => { g.revealed.push(target); };
      // A stand-in for the Trash: the file is moved into this spec's own folder, never the person's Trash.
      shell.trashItem = async (target: string) => { g.trashed.push(target); nodeFs.renameSync(target, nodePath.join(bin, nodePath.basename(target))); };
    }, trash));
    const page = await step('the first window opens', 180_000, (ms) => launched.firstWindow({ timeout: ms }));
    win = page;
    watched = watchWindow(page);
    const { problems } = watched;
    // The window is the size asked for: no wider than it, so the gallery draws fewer cards than the shelf holds.
    if (size) expect(await step('the window is measured', 15_000, () => page.evaluate(() => window.innerWidth))).toBeLessThanOrEqual(size[0]);
    await step('Atlas draws its frame', 60_000, (ms) => page.locator(ATLAS_LANDMARK).waitFor({ timeout: ms }));
    await step('the window is sent to the Library', 15_000, () => page.evaluate(() => { window.location.hash = '#/library'; }));
    await step('the address is the Library\'s', 15_000,
      (ms) => page.waitForFunction(() => window.location.hash === '#/library', undefined, { timeout: ms }));

    // — To Read, as covers drawn from the map ------------------------------------------------
    await step('the Library\'s heading is drawn', 60_000,
      (ms) => expect(page.getByRole('heading', { name: 'Library', level: 1 })).toBeVisible({ timeout: ms }));
    const shelf = page.getByRole('group', { name: 'Show' });
    const cards = page.locator('article.card');
    await step('the shelf\'s first read: To Read is shown, holding 14', 30_000, async (ms) => {
      await expect(shelf.getByRole('button', { name: /To Read/ })).toHaveAttribute('aria-pressed', 'true', { timeout: ms });
      await expect(shelf.getByRole('button', { name: /To Read/ })).toContainText('14', { timeout: ms });
    });
    await step('the gallery\'s first read: its list holds 14', 30_000, (ms) => shelfHolds(page, 14, ms));
    // In the small window the gallery draws only some of the fourteen, which is what this walk is for.
    if (size) expect(await cards.count()).toBeLessThan(14);
    // The map is fitted in the background the first time it is asked for; the covers place each paper once it is.
    await step('the map\'s first read: fitted in the background', 120_000,
      (ms) => expect.poll(async () => (await api<{ state: string }>(page, '/api/map')).state, { timeout: ms }).toBe('ready'));
    await step('the covers place each paper, once the page is read again', 60_000, async (ms) => {
      await page.reload({ timeout: ms });
      await expect(page.locator('.cov[data-placed="true"]').first()).toBeVisible({ timeout: ms });
      await expect(cards.first().locator('.card-label')).toContainText(/From/);
      await shot(page, 'to-read-desktop');
      // A paper the watch's run found is labeled with the watch's name.
      await expect((await inView(page, `article.card[data-document="${saved[0]}"]`)).locator('.card-label .it')).toHaveText('quantum-error-correction');
    });

    await step('gallery arrows move by card and row, and Select All keeps the card focused', 60_000, async () => {
      await page.evaluate(() => { (document.querySelector('main.stage') as HTMLElement).scrollTop = 0; });
      const gallery = page.getByRole('list', { name: 'To Read: saved papers' });
      const columns = await gallery.locator('.gal-row').first().evaluate((row) => getComputedStyle(row).gridTemplateColumns.split(/\s+/).length);
      expect(Number(await gallery.getAttribute('data-columns'))).toBe(columns);
      const coverAt = (position: number) => gallery.locator(`.gal-cell[aria-posinset="${position}"] .thumb`);
      await coverAt(1).focus();
      await page.keyboard.press('ArrowRight');
      await expect(coverAt(2)).toBeFocused();
      await page.keyboard.press('ArrowDown');
      await expect(coverAt(columns + 2)).toBeFocused();
      // Both measured after the move: in a short window, Down scrolls the next row into view.
      const before = (await coverAt(2).boundingBox())!;
      const below = (await coverAt(columns + 2).boundingBox())!;
      expect(Math.abs(below.x - before.x)).toBeLessThan(2);
      expect(below.y).toBeGreaterThan(before.y);
      await page.keyboard.press('ArrowUp');
      await expect(coverAt(2)).toBeFocused();
      await page.keyboard.press('ArrowLeft');
      await expect(coverAt(1)).toBeFocused();
      await page.keyboard.press(process.platform === 'darwin' ? 'Meta+A' : 'Control+A');
      const bar = page.getByRole('group', { name: 'The picked cards' });
      await expect(bar).toContainText('14 of 14 picked');
      await expect(coverAt(1)).toBeFocused();
      expect(await page.evaluate(() => window.getSelection()?.toString() ?? '')).toBe('');
      await bar.getByRole('button', { name: 'Done' }).click();
    });

    // — the queue's remove, and its Undo, with the entry's own dates ----------------------------
    await step('a paper removed from To Read, and put back with Undo', 60_000, async () => {
      const target = saved[0]!;
      const before = await api<{ entries: { document_id: number; saved_at: string; status: string }[] }>(page, '/api/reading-queue?limit=200');
      const was = before.entries.find((e) => e.document_id === target)!;
      const card = await inView(page, `article.card[data-document="${target}"]`);
      await card.hover();
      await card.getByRole('button', { name: 'Remove from To Read' }).click();
      await expect(card).toHaveCount(0);
      const notice = page.locator('.lib-notice');
      await expect(notice).toContainText('from To Read.');
      await shot(page, 'remove-undo-notice');
      await notice.getByRole('button', { name: 'Undo' }).click();
      await shelfHolds(page, 14, 15_000);
      await inView(page, `article.card[data-document="${target}"]`);
      const after = await api<{ entries: { document_id: number; saved_at: string; status: string }[] }>(page, '/api/reading-queue?limit=200');
      expect(after.entries.find((e) => e.document_id === target)).toEqual(expect.objectContaining({ saved_at: was.saved_at, status: was.status }));
    });

    // — one Mark pending leaves the other cards' controls alone ------------------------------------
    await step('one Mark Read pending leaves the other cards alone', 60_000, async () => {
      await page.route('**/api/reading-queue/*', async (route) => {
        if (route.request().method() === 'PUT') await new Promise((r) => setTimeout(r, 1500));
        await route.continue();
      });
      const marking = await inView(page, `article.card[data-document="${saved[1]}"]`);
      // Another card drawn beside it, whichever the window shows.
      const other = page.locator(`article.card:not([data-document="${saved[1]}"])`).first();
      await marking.getByRole('button', { name: 'Mark Read' }).click();
      await expect(marking.getByRole('button', { name: 'Mark Read' })).toBeDisabled();
      await expect(other.getByRole('button', { name: 'Mark Read' })).toBeEnabled();
      await expect(marking).toHaveCount(0, { timeout: 15_000 });
      await page.unroute('**/api/reading-queue/*');
      await expect(shelf.getByRole('button', { name: /^Read/ })).toContainText('5');
    });

    // — select mode: pick a range, mark read ----------------------------------------------------
    await step('select mode marks a range read', 60_000, async () => {
      await page.getByRole('button', { name: 'Select', exact: true }).click();
      const bar = page.getByRole('group', { name: 'The picked cards' });
      await page.evaluate(() => { (document.querySelector('main.stage') as HTMLElement).scrollTop = 0; });
      await cards.nth(0).locator('.thumb').click();
      await cards.nth(2).locator('.thumb').click({ modifiers: ['Shift'] });
      await expect(bar).toContainText('3 of 13 picked');
      await shot(page, 'select-mode');
      await bar.getByRole('button', { name: 'Mark Read' }).click();
      await shelfHolds(page, 10, 15_000);
      await bar.getByRole('button', { name: 'Done' }).click();
      await expect(shelf.getByRole('button', { name: /^Read/ })).toContainText('8');
    });

    // — Your Files: a folder made, files imported, PDFs drawn and their pictures kept ------------------
    const { vault, root, byName } = await step('Your Files: the folder made, and six files imported', 120_000, async () => {
      await shelf.getByRole('button', { name: /Your Files/ }).click();
      await chooseNext(launched, first);
      await page.getByRole('button', { name: 'Choose Parent Folder' }).click();
      await page.getByRole('button', { name: 'Create the Library Here' }).click();
      const importer = page.getByLabel('Import PDF, TXT, MD, or TeX');
      await expect(importer).toBeEnabled({ timeout: 30_000 });
      await importer.setInputFiles([files.moe, files.edit, files.radio, files.notes, files.tex, files.txt]);
      await expect(page.locator('[data-library="imported"]')).toHaveText('6 files added. None was already in the Library.', { timeout: 60_000 });
      await shelfHolds(page, 6);
      const status = await api<{ vault: { vault_id: string; path: string } }>(page, '/api/library');
      const made = status.vault.path;
      expect(made).toBe(path.join(first, `resmon-library-${status.vault.vault_id}`));
      const listed = await api<{ files: { file_id: string; version_id: string; original_name: string; media_type: string }[] }>(
        page, `/api/library/files?expected_vault_id=${status.vault.vault_id}&limit=50`);
      return { vault: status.vault.vault_id, root: made, byName: Object.fromEntries(listed.files.map((f) => [f.original_name, f])) };
    });
    const moe = byName[path.basename(files.moe)]!;
    const txt = byName[path.basename(files.txt)]!;
    expect(byName[path.basename(files.tex)]!.media_type).toBe('text/x-tex');
    // Each PDF's first page, drawn once its card is in view, and kept beside the database.
    const pdfs = [files.moe, files.edit, files.radio].map((f) => byName[path.basename(f)]!.file_id);
    const picturesDir = `${path.join(stateDir, 'resmon.db')}-library-pictures`;
    await step('each PDF\'s first page drawn, and its picture kept', 300_000, async () => {
      for (const id of pdfs) {
        await expect((await inView(page, `article.card[data-file="${id}"]`)).locator('.sheet-pdf[data-drawn="true"] img')).toBeVisible({ timeout: 90_000 });
      }
      await expect.poll(() => (fs.existsSync(picturesDir) ? fs.readdirSync(picturesDir).length : 0), { timeout: 30_000 }).toBe(3);
      await expect((await inView(page, `article.card[data-file="${byName[path.basename(files.notes)]!.file_id}"]`)).locator('.sheet-text li').first()).toBeVisible();
      await page.evaluate(() => { (document.querySelector('main.stage') as HTMLElement).scrollTop = 0; });
      await shot(page, 'files-desktop');
    });

    // A second visit reads the kept pictures and draws nothing.
    await step('a second visit reads the kept pictures', 120_000, async (ms) => {
      await page.reload({ timeout: ms });
      for (const id of pdfs) {
        await expect((await inView(page, `article.card[data-file="${id}"]`)).locator('.sheet-pdf[data-drawn="true"] img')).toBeVisible({ timeout: 30_000 });
      }
      expect(fs.readdirSync(picturesDir)).toHaveLength(3);
    });

    // — a PDF linked to a saved paper: chosen by searching, and its cover becomes the first page -----
    const moeSelector = `article.card[data-file="${moe.file_id}"]`;
    const moeCard = page.locator(moeSelector);
    await step('a PDF linked to a saved paper, found by searching', 60_000, async () => {
      await (await inView(page, moeSelector)).getByRole('button', { name: 'Link to a Paper' }).click();
      const picker = page.getByRole('dialog', { name: /Link .* to a Paper/ });
      await picker.getByLabel('Find a paper by title, author, or words in it').fill('distribution shift');
      await picker.locator(`button[data-document="${ids[8]}"]`).click();
      await expect(picker).toHaveCount(0);
      await expect(moeCard.locator('.card-label')).toHaveText('Linked to 1 paper');
    });

    // — Read here for a PDF: the reader outside Evidence --------------------------------------------
    await step('a PDF read here, outside Evidence', 90_000, async () => {
      await moeCard.locator('.thumb').focus();
      await page.keyboard.press('Enter');
      await expect(page.getByRole('heading', { name: path.basename(files.moe), level: 1 })).toBeVisible();
      const reader = page.getByRole('region', { name: 'PDF reader' });
      await expect(reader.getByRole('status')).toHaveText(/^Page 1 of 2 rendered · PDF\.js 6\.3\.289/, { timeout: 60_000 });
      await expect(reader.getByRole('button', { name: 'All Pages' })).toBeVisible();
      await expect(page.locator('details.lib-record')).not.toHaveAttribute('open', '');
      await shot(page, 'pdf-reader');
      await page.goBack();
      await expect(moeCard.locator('.thumb')).toBeFocused();
      await page.keyboard.press('Enter');
      await expect(page.getByRole('heading', { name: path.basename(files.moe), level: 1 })).toBeVisible();
    });

    // — the rich view: Markdown with its math drawn, and the plain text beside it -------------------
    await step('the rich view: Markdown and TeX with their math drawn', 120_000, async () => {
      await page.evaluate((id) => { window.location.hash = `#/library/files/${id}`; }, byName[path.basename(files.notes)]!.file_id);
      const text = page.getByRole('region', { name: /The text of reading-notes/ });
      await expect(text.locator('.md-rich h2')).toHaveText('Reading notes, November');
      await expect(text.locator('.formula .katex').first()).toBeVisible({ timeout: 30_000 });
      await expect(text.locator('.rich-math .katex-display')).toHaveCount(1);
      await expect(text.locator('table td')).toContainText(['4', '2.31', '12', '0.87']);
      await expect(text.locator('a[href="https://example.org/notes"]')).toHaveCount(1);
      await shot(page, 'rich-markdown');
      await text.getByRole('button', { name: 'Plain Text' }).click();
      await expect(text.locator('.lib-lines li').first()).toHaveText('# Reading notes, November');
      await page.evaluate((id) => { window.location.hash = `#/library/files/${id}`; }, byName[path.basename(files.tex)]!.file_id);
      const tex = page.getByRole('region', { name: /The text of closure-derivation/ });
      await expect(tex.locator('.tex-rich .tx-cmd').first()).toHaveText('\\section');
      await expect(tex.locator('.tx-display .katex-display')).toHaveCount(1, { timeout: 30_000 });
      await expect(tex.locator('.tx-comment')).toHaveText('% The stress tensor, as in the draft.');
      await shot(page, 'rich-tex');
    });

    // — the saved paper's cover is the linked PDF's first page now ------------------------------------
    await step('the linked paper\'s cover is the PDF\'s first page', 60_000, async () => {
      const linked = await api<{ queue_status: string | null }>(page, `/api/documents/${ids[8]}`);
      await page.evaluate((show) => { window.location.hash = `#/library?show=${show}`; }, linked.queue_status ?? 'to_read');
      await expect((await inView(page, `article.card[data-document="${ids[8]}"]`)).locator('.sheet-pdf[data-drawn="true"] img')).toBeVisible({ timeout: 30_000 });
      await shot(page, `paper-with-pdf-${linked.queue_status ?? 'to_read'}`);
    });

    // — a file in a project with a note: asked first, removed with both, and Undo puts all back ------
    await step('a file in a project, asked about, removed with its note, and put back', 90_000, async () => {
      const project = await api<{ project: { project_id: string; revision: number } }>(page, '/api/evidence/projects',
        { method: 'POST', body: { expected_vault_id: vault, name: 'Router collapse' } });
      const added = await api<{ project: { revision: number } }>(page, `/api/evidence/projects/${project.project.project_id}/files`,
        { method: 'POST', body: { expected_vault_id: vault, expected_revision: project.project.revision, file_id: moe.file_id, version_id: moe.version_id } });
      await api(page, `/api/evidence/projects/${project.project.project_id}/notes`, { method: 'POST', body: {
        expected_vault_id: vault, expected_revision: added.project.revision, file_id: moe.file_id, version_id: moe.version_id,
        kind: 'note', body: 'Compare with our checkpoint.', anchor: null } });
      await page.evaluate(() => { window.location.hash = '#/library?show=projects'; });
      await shelfHolds(page, 1);
      await expect(page.locator('article.card.project .fan .sheet-pdf[data-drawn="true"]')).toHaveCount(1, { timeout: 30_000 });
      await shot(page, 'projects');
      await expect(page.getByRole('button', { name: 'New Project', exact: true })).toBeVisible();
      await page.evaluate(() => { window.location.hash = '#/library?show=files'; });
      await (await inView(page, moeSelector)).hover();
      await moeCard.getByRole('button', { name: 'Remove from Your Files' }).click();
      const confirm = page.getByRole('dialog', { name: /Remove Raman-2026/ });
      await expect(confirm).toContainText('Router collapse: its place in the project, 1 note');
      await shot(page, 'remove-confirm');
      await confirm.getByRole('button', { name: 'Remove It and These' }).click();
      await expect(moeCard).toHaveCount(0);
      expect(fs.existsSync(path.join(root, 'removed', moe.file_id))).toBe(true);
      expect(fs.existsSync(path.join(root, 'files', moe.file_id))).toBe(false);
      const fileNotice = page.locator('.lib-notice');
      await expect(fileNotice).toContainText('from Your Files.');
      await fileNotice.getByRole('button', { name: 'Undo' }).click();
      await shelfHolds(page, 6, 15_000);
      await inView(page, moeSelector);
      expect(fs.readFileSync(path.join(root, 'files', moe.file_id, `${moe.version_id}.pdf`))).toEqual(fs.readFileSync(files.moe));
      const notes = await api<{ notes: { body: string }[] }>(page, `/api/evidence/projects/${project.project.project_id}/notes?expected_vault_id=${vault}`);
      expect(notes.notes.map((n) => n.body)).toEqual(['Compare with our checkpoint.']);
    });

    // A lone text file is removed at once; Settings › Library holds it, and sends it to the Trash only when asked.
    await step('a lone text file removed, and sent to the Trash from Settings › Library', 60_000, async () => {
      await (await inView(page, `article.card[data-file="${txt.file_id}"]`)).getByRole('button', { name: 'Remove from Your Files' }).click();
      await expect(page.locator(`article.card[data-file="${txt.file_id}"]`)).toHaveCount(0);

      // — Settings › Library: the folder's path, and the removed file ---------------------------------
      await page.evaluate(() => { window.location.hash = '#/settings/library'; });
      await expect(page.locator('[data-library="path"]')).toHaveText(root);
      const removed = page.locator(`.lib-removed-list li[data-file="${txt.file_id}"]`);
      await expect(removed).toContainText('lab-meeting.txt');
      await shot(page, 'settings-library');
      await removed.getByRole('button', { name: 'Move to the Trash' }).click();
      await expect(removed).toHaveCount(0, { timeout: 15_000 });
      const trashed = await launched.evaluate(() => (globalThis as unknown as { trashed: string[] }).trashed);
      expect(trashed).toEqual([path.join(root, 'removed', txt.file_id, 'lab-meeting.txt')]);
      expect(fs.readFileSync(path.join(trash, 'lab-meeting.txt'), 'utf8')).toBe(fs.readFileSync(files.txt, 'utf8'));
      expect(fs.existsSync(path.join(root, 'removed', txt.file_id))).toBe(false);
    });

    // — the folder moved outside resmon: missing, found again, then moved by resmon ------------------
    await step('the folder moved outside resmon, found again, and moved by resmon', 120_000, async () => {
      const moved = path.join(elsewhere, path.basename(root));
      fs.renameSync(root, moved);
      await page.evaluate(() => { window.location.hash = '#/library?show=files'; });
      const missing = page.locator('[data-library="missing"]');
      await expect(missing).toContainText('The Library folder is not where it was', { timeout: 30_000 });
      await shot(page, 'folder-missing');
      await shelf.getByRole('button', { name: /To Read/ }).click();
      await expect(cards.first()).toBeVisible();
      await shelf.getByRole('button', { name: /Your Files/ }).click();
      await chooseNext(launched, elsewhere);
      await missing.getByRole('button', { name: 'Choose Where It Is Now' }).click();
      await shelfHolds(page, 5);
      await page.evaluate(() => { window.location.hash = '#/settings/library'; });
      await expect(page.locator('[data-library="path"]')).toHaveText(moved);
      await chooseNext(launched, second);
      await page.getByRole('button', { name: 'Move It to Another Folder' }).click();
      await expect(page.locator('[data-library="folder-said"]')).toHaveText(`Moved to ${path.join(second, path.basename(root))}.`, { timeout: 30_000 });
      expect(fs.existsSync(moved)).toBe(false);
      expect(fs.readFileSync(path.join(second, path.basename(root), 'files', moe.file_id, `${moe.version_id}.pdf`))).toEqual(fs.readFileSync(files.moe));
    });

    // — files dropped on the page are kept as Import Files keeps them ---------------------------------
    await step('a file dropped on the page is kept', 60_000, async () => {
      await page.evaluate(() => { window.location.hash = '#/library?show=files'; });
      await shelfHolds(page, 5);
      const dropped = await page.evaluateHandle(() => {
        const transfer = new DataTransfer();
        transfer.items.add(new File(['dropped on the page\n'], 'dropped-notes.txt', { type: 'text/plain' }));
        return transfer;
      });
      await page.dispatchEvent('.lib-page', 'dragover', { dataTransfer: dropped });
      await page.dispatchEvent('.lib-page', 'drop', { dataTransfer: dropped });
      await expect(page.locator('[data-library="imported"]')).toHaveText('1 file added. None was already in the Library.', { timeout: 30_000 });
      await shelfHolds(page, 6);
    });

    // — the narrowest window a Mac gives, and the phone-width reflow -----------------------------------
    await step('the narrowest window a Mac gives, and the phone-width reflow', 180_000, async () => {
      await page.evaluate(() => { window.location.hash = '#/library'; });
      await resize(launched, 1024, 800);
      await expect(cards.first()).toBeVisible();
      await shot(page, 'to-read-1024');
      for (const show of ['read', 'files', 'projects']) {
        await page.evaluate((s) => { window.location.hash = `#/library?show=${s}`; }, show);
        await expect(cards.first()).toBeVisible({ timeout: 30_000 });
        await shot(page, `${show}-1024`);
      }
      await page.evaluate(() => { window.location.hash = '#/settings/library'; });
      await expect(page.locator('[data-library="path"]')).toBeVisible();
      await shot(page, 'settings-library-1024');
      await page.evaluate((id) => { window.location.hash = `#/library/files/${id}`; }, byName[path.basename(files.notes)]!.file_id);
      await expect(page.locator('.md-rich .katex').first()).toBeVisible({ timeout: 30_000 });
      await shot(page, 'rich-markdown-1024');
      // The printed atlas: Your Files in the light theme, as the comps show it.
      await page.evaluate(() => { document.documentElement.dataset.theme = 'light'; window.location.hash = '#/library?show=files'; });
      await expect(cards.first()).toBeVisible({ timeout: 30_000 });
      await shot(page, 'files-light-1024');
      await page.evaluate(() => { document.documentElement.dataset.theme = 'dark'; window.location.hash = '#/library'; });
      await expect(cards.first()).toBeVisible({ timeout: 30_000 });
      await launched.evaluate(({ BrowserWindow }) => { BrowserWindow.getAllWindows()[0]?.setMinimumSize(390, 600); });
      await resize(launched, 430, 860);
      await expect(page.locator('.gal.narrow')).toBeVisible({ timeout: 15_000 });
      await expect(page.locator('.gal').first()).toHaveAttribute('data-columns', '2');
      await shot(page, 'to-read-narrow');
    });

    expect(problems).toEqual([]);
    say('done');
    passed = true;
  } finally {
    if (!passed) await tellWhere(prefix, { app, win, stateDir, watched, wrote });
    say('putting away what the test started');
    if (app) await closeWithin(app, prefix);
    // Every folder here was made by this spec, under the system's temporary folder.
    for (const dir of [stateDir, first, elsewhere, second, staging, trash]) removeStateDir(dir);
  }
}

const TITLE = 'Library: one gallery, covers, the PDF and rich readers, remove and undo, the folder moved and found, select, drop';

test(TITLE, async () => {
  test.setTimeout(420_000);
  await walk(null, 'LIBRARY WALK', 420_000);
});

// The gallery draws only the rows near the view, so the walk is taken again in the smallest window the app
// allows: everything it checks must hold whatever the window shows.
test(`${TITLE}, in a 960 by 640 window`, async () => {
  test.setTimeout(420_000);
  await walk([960, 640], 'LIBRARY WALK 960x640', 420_000);
});
