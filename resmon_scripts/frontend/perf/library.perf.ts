/**
 * The Library with a few hundred papers and files: how soon the first covers
 * are on screen, and how smoothly the page scrolls, while first-page pictures
 * are being drawn and once they are kept.
 *
 * Skipped unless `RESMON_PERF_LIBRARY` is set, so `python -m perf run` is
 * unchanged. Each run seeds an isolated collection (`RESMON_PERF_LIBRARY_PAPERS`
 * papers, every one saved to read) and a Library folder in its own temporary
 * folder (`RESMON_PERF_LIBRARY_FILES` small PDFs), starts the app over it, and
 * measures each shelf twice: on the first visit and on a second one. A shelf
 * is timed from the address changing to its first card, and scrolled from the
 * top at a steady speed, one scroll position per animation frame, recording
 * each frame's interval and every long task (over 50 ms) on the page's thread.
 *
 * `RESMON_PERF_FRONTEND` can name another build's `frontend/` folder, which is
 * how the list the gallery replaced is measured the same way (its rows are
 * `.queue-row` and `button.library-file`). Numbers are specific to the machine.
 */
import { test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { launchApp } from './app';
import { writePdf } from '../e2e/fixtures/pdf';

const SPEED_PX_S = 3_000;
const SCROLL_MS = 8_000;

const SEED = String.raw`
import json, os, sys
sys.path.insert(0, sys.argv[1])
from implementation_scripts.database import init_db, get_connection
from implementation_scripts import library
path, papers, pdf, folder, files = os.environ["RESMON_DB_PATH"], int(sys.argv[2]), sys.argv[3], sys.argv[4], int(sys.argv[5])
init_db(path)
conn = get_connection(path)
words = ["routing", "experts", "qubits", "surface", "editing", "cardiomyocytes", "interferometry", "priors", "lattice", "muon"]
conn.executemany(
    "INSERT INTO documents (source_repository, external_id, title, authors, abstract, publication_date, metadata_hash) VALUES (?,?,?,?,?,?,?)",
    [("arxiv", f"perf-{n}", f"Paper {n} on {words[n % 10]} and {words[(n * 3) % 10]}", "Ada Fixture, Grace Fixture",
      " ".join(words[(n + k) % 10] for k in range(40)), f"2026-{(n % 12) + 1:02d}-01", f"perf-{n}") for n in range(papers)])
conn.executemany("INSERT INTO reading_queue (document_id, status, saved_at, updated_at) VALUES (?, 'to_read', ?, ?)",
    [(i, f"2026-10-{(i % 28) + 1:02d} 09:00:00", f"2026-10-{(i % 28) + 1:02d} 09:00:00") for (i,) in conn.execute("SELECT id FROM documents")])
conn.commit()
vault = None
if files:
    vault = library.create_vault(conn, folder)["vault"]["vault_id"]
    raw = open(pdf, "rb").read()
    for n in range(files):
        with library.Import(conn, vault, f"paper-{n:04d}.pdf") as upload:
            upload.write(raw + f"\n% perf copy {n}\n".encode())
            upload.finish()
print(json.dumps({"vault": vault}))
`;

interface Visit { firstCardMs: number; settledMs: number | null; frames: number[]; longTasks: number[]; drawnBefore: number; drawnAfter: number; cards: number }

function quantile(values: number[], q: number): number {
  if (!values.length) return NaN;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(q * (sorted.length - 1)))] ?? NaN;
}

function summary(v: Visit): Record<string, number | null> {
  return {
    firstCardMs: v.firstCardMs, settledMs: v.settledMs, cardsInPage: v.cards,
    picturesDrawnBeforeScroll: v.drawnBefore, picturesDrawnAfterScroll: v.drawnAfter,
    frames: v.frames.length, frameP50: quantile(v.frames, 0.5), frameP95: quantile(v.frames, 0.95),
    frameMax: v.frames.length ? Math.max(...v.frames) : NaN,
    framesOver33_3: v.frames.filter((f) => f > 33.4).length / Math.max(1, v.frames.length),
    longTasks: v.longTasks.length, longestTaskMs: v.longTasks.length ? Math.max(...v.longTasks) : 0,
  };
}

async function visit(win: Page, hash: string, card: string, settled: string | null): Promise<Visit> {
  await win.evaluate(() => { window.location.hash = '#/today'; });
  await win.waitForTimeout(800);
  const started = Date.now();
  await win.evaluate((h) => { window.location.hash = h; }, hash);
  await win.locator(card).first().waitFor({ timeout: 120_000 });
  const firstCardMs = Date.now() - started;
  let settledMs: number | null = null;
  if (settled) {
    await win.locator(settled).first().waitFor({ timeout: 120_000 }).then(() => { settledMs = Date.now() - started; }).catch(() => undefined);
  }
  await win.waitForTimeout(1500);
  const drawnBefore = await win.locator('.sheet-pdf[data-drawn="true"]').count();
  const scrolled = await win.evaluate(async ({ speed, duration }) => {
    const el = document.querySelector('main.stage') as HTMLElement;
    el.scrollTop = 0;
    const longTasks: number[] = [];
    const observer = new PerformanceObserver((list) => { for (const e of list.getEntries()) longTasks.push(e.duration); });
    observer.observe({ type: 'longtask' });
    const frames: number[] = [];
    await new Promise<void>((resolve) => {
      let start = 0;
      let last = 0;
      const step = (now: number) => {
        if (!start) { start = now; last = now; } else { frames.push(now - last); last = now; }
        el.scrollTop = ((now - start) / 1000) * speed;
        const end = el.scrollTop + el.clientHeight >= el.scrollHeight - 2;
        if (now - start >= duration || end) resolve(); else requestAnimationFrame(step);
      };
      requestAnimationFrame(step);
    });
    observer.disconnect();
    return { frames, longTasks };
  }, { speed: SPEED_PX_S, duration: SCROLL_MS });
  const drawnAfter = await win.locator('.sheet-pdf[data-drawn="true"]').count();
  const cards = await win.locator(card).count();
  return { firstCardMs, settledMs, ...scrolled, drawnBefore, drawnAfter, cards };
}

test('the Library gallery with a few hundred papers and files', async () => {
  test.skip(!process.env.RESMON_PERF_LIBRARY, 'RESMON_PERF_LIBRARY is not set');
  test.setTimeout(60 * 60 * 1000);
  const papers = Number(process.env.RESMON_PERF_LIBRARY_PAPERS || '300');
  const files = Number(process.env.RESMON_PERF_LIBRARY_FILES || '300');
  const runs = Number(process.env.RESMON_PERF_RUNS || '3');
  const outFile = process.env.RESMON_PERF_LIBRARY_OUT;
  const old = !!process.env.RESMON_PERF_LIBRARY_OLD;
  const python = process.env.RESMON_PYTHON || 'python3';
  const backend = path.resolve(process.env.RESMON_PERF_FRONTEND || path.resolve(__dirname, '..'), '..');
  const samples: Record<string, unknown>[] = [];
  for (let run = 0; run < runs; run += 1) {
    // The real path: the Library opens each folder on the way without following a link, and /var is one on macOS.
    const work = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'resmon-perf-library-'));
    const state = path.join(work, 'state');
    const folder = path.join(work, 'folder');
    fs.mkdirSync(state); fs.mkdirSync(folder);
    const pdf = path.join(work, 'template.pdf');
    fs.writeFileSync(pdf, writePdf([{ lines: Array.from({ length: 40 }, (_, i) => ({ x: 72, y: 720 - i * 16, size: i ? 9 : 16, text: i ? `A line of the paper's text, number ${i}.` : 'A paper for the performance run' })) }]));
    const seeded = spawnSync(python, ['-c', SEED, backend, String(papers), pdf, folder, String(files)], {
      env: { ...process.env, RESMON_DB_PATH: path.join(state, 'resmon.db') }, encoding: 'utf8',
    });
    if (seeded.status !== 0) {
      fs.rmSync(work, { recursive: true, force: true });
      throw new Error(seeded.stderr);
    }
    const { app, win } = await launchApp(state);
    try {
      const sample: Record<string, unknown> = { run, build: old ? 'list' : 'gallery' };
      if (old) {
        sample.toReadFirst = summary(await visit(win, '#/library', '.queue-row', null));
        sample.filesFirst = summary(await visit(win, '#/library/files', 'button.library-file', null));
      } else {
        sample.toReadFirst = summary(await visit(win, '#/library', 'article.card', '.cov[data-placed="true"]'));
        sample.toReadAgain = summary(await visit(win, '#/library', 'article.card', '.cov[data-placed="true"]'));
        sample.filesFirst = summary(await visit(win, '#/library?show=files', 'article.card', '.sheet-pdf[data-drawn="true"]'));
        sample.filesAgain = summary(await visit(win, '#/library?show=files', 'article.card', '.sheet-pdf[data-drawn="true"]'));
        sample.picturesKept = fs.existsSync(path.join(state, 'resmon.db-library-pictures'))
          ? fs.readdirSync(path.join(state, 'resmon.db-library-pictures')).length : 0;
      }
      samples.push(sample);
      console.log('[library perf]', JSON.stringify(sample));
    } finally {
      await app.close();
      fs.rmSync(work, { recursive: true, force: true });
    }
    if (outFile) fs.writeFileSync(outFile, JSON.stringify({ papers, files, speedPxS: SPEED_PX_S, scrollMs: SCROLL_MS, samples }, null, 2));
  }
});
