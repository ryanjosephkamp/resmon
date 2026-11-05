/**
 * Scrolling Search › Your collection's list, over a large collection.
 *
 * `python -m perf scale` runs this with `RESMON_PERF_SCROLL_CORPUS` set to a
 * seeded collection (100,000 papers); without it the case is skipped, so
 * `python -m perf run` is unchanged. Each run starts the app isolated over a
 * copy of the collection, opens the list, and reads `RESMON_PERF_SCROLL_ROWS`
 * rows into it the way a person would: by scrolling to its end where the list
 * reads the next page itself, or by pressing Show more where it does not.
 * Then it scrolls the list from the top at a steady speed, setting the scroll
 * position once per animation frame, and records every frame's interval and
 * every long task (over 50 ms) on the page's main thread. A frame over 16.7 ms
 * is one a 60 Hz display shows late.
 *
 * What it does not measure: a display's own refresh, the compositor's work
 * (frames are timed on the page's thread), or scrolling by a trackpad's
 * momentum, which the compositor does without the page. Numbers are specific
 * to the machine.
 */
import { test } from '@playwright/test';
import type { Page } from '@playwright/test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { cloneFile, launchApp } from './app';

const SPEED_PX_S = 6_000;
const SCROLL_MS = 15_000;

interface Scrolled { frames: number[]; longTasks: number[]; px: number }

/** Read rows into the list until it holds `wanted`; how long that took, and the long tasks it caused. */
async function readRows(win: Page, wanted: number): Promise<{ ms: number; rows: number; longTasks: number[]; virtual: boolean }> {
  const virtual = await win.locator('.result-list.virtual').count() > 0;
  await win.evaluate(() => {
    const w = window as unknown as { __longTasks: number[] };
    w.__longTasks = [];
    new PerformanceObserver((list) => { for (const e of list.getEntries()) w.__longTasks.push(e.duration); })
      .observe({ type: 'longtask' });
  });
  const started = Date.now();
  const read = async () => (virtual
    ? Number(await win.locator('.result').last().getAttribute('aria-posinset'))
    : await win.locator('.result').count());
  while (await read() < wanted) {
    if (virtual) {
      await win.locator('section.results .index-scroll').evaluate((el) => { el.scrollTop = el.scrollHeight; });
      await win.waitForTimeout(50);
    } else {
      const more = win.getByRole('button', { name: 'Show more' });
      await more.click({ timeout: 60_000 });
      await win.waitForFunction(() => !document.querySelector('.btn.more[disabled]'), undefined, { timeout: 60_000 });
    }
    if (Date.now() - started > 600_000) throw new Error('reading rows took over ten minutes');
  }
  const ms = Date.now() - started;
  const longTasks = await win.evaluate(() => (window as unknown as { __longTasks: number[] }).__longTasks);
  return { ms, rows: await read(), longTasks, virtual };
}

/** Scroll the list from the top at a steady speed for a while, timing each frame on the page's thread. */
async function scrollList(win: Page): Promise<Scrolled> {
  return win.evaluate(async ({ speed, duration }) => {
    const el = document.querySelector('section.results .index-scroll') as HTMLElement;
    el.scrollTop = 0;
    await new Promise((resolve) => setTimeout(resolve, 500));
    const longTasks: number[] = [];
    const observer = new PerformanceObserver((list) => { for (const e of list.getEntries()) longTasks.push(e.duration); });
    observer.observe({ type: 'longtask' });
    const frames: number[] = [];
    let px = 0;
    await new Promise<void>((resolve) => {
      let start = 0;
      let last = 0;
      const step = (now: number) => {
        if (!start) { start = now; last = now; }
        else { frames.push(now - last); last = now; }
        const target = ((now - start) / 1000) * speed;
        el.scrollTop = target;
        px = el.scrollTop;
        const end = el.scrollTop + el.clientHeight >= el.scrollHeight - 2;
        if (now - start >= duration || end) resolve(); else requestAnimationFrame(step);
      };
      requestAnimationFrame(step);
    });
    observer.disconnect();
    return { frames, longTasks, px };
  }, { speed: SPEED_PX_S, duration: SCROLL_MS });
}

function quantile(values: number[], q: number): number {
  if (!values.length) return NaN;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(q * (sorted.length - 1)))] ?? NaN;
}

test('scrolling the collection list over a large collection', async () => {
  const corpus = process.env.RESMON_PERF_SCROLL_CORPUS;
  test.skip(!corpus, 'RESMON_PERF_SCROLL_CORPUS is not set; python -m perf scale sets it');
  test.setTimeout(60 * 60 * 1000);
  const outFile = process.env.RESMON_PERF_SCROLL_OUT as string;
  const wanted = Number(process.env.RESMON_PERF_SCROLL_ROWS || '3000');
  const runs = Number(process.env.RESMON_PERF_RUNS || '3');
  const work = process.env.RESMON_PERF_WORK || fs.mkdtempSync(path.join(os.tmpdir(), 'resmon-perf-scroll-'));
  const samples: Record<string, unknown>[] = [];

  for (let run = 0; run < runs; run += 1) {
    const state = path.join(work, `scroll-${run}`);
    fs.rmSync(state, { recursive: true, force: true });
    fs.mkdirSync(state, { recursive: true });
    cloneFile(corpus as string, path.join(state, 'resmon.db'));
    const { app, win } = await launchApp(state);
    try {
      await win.evaluate(() => { window.location.hash = '#/search'; });
      await win.locator('.count-sentence').waitFor({ timeout: 180_000 });
      const count = (await win.locator('.count-sentence').textContent())?.trim() ?? '';
      const read = await readRows(win, wanted);
      const scrolled = await scrollList(win);
      const domRows = await win.locator('.result').count();
      const heapMb = await win.evaluate(() => {
        const memory = (performance as unknown as { memory?: { usedJSHeapSize: number } }).memory;
        return memory ? memory.usedJSHeapSize / 2 ** 20 : null;
      });
      const frames = scrolled.frames;
      samples.push({
        count,
        virtual: read.virtual,
        rowsRead: read.rows,
        readMs: read.ms,
        readLongTasks: read.longTasks.length,
        readLongestTaskMs: read.longTasks.length ? Math.max(...read.longTasks) : 0,
        domRowsAfter: domRows,
        heapMb,
        scrolledPx: scrolled.px,
        frames: frames.length,
        frameP50: quantile(frames, 0.5),
        frameP95: quantile(frames, 0.95),
        frameP99: quantile(frames, 0.99),
        frameMax: frames.length ? Math.max(...frames) : NaN,
        framesOver16_7: frames.filter((f) => f > 16.7 + 1).length / Math.max(1, frames.length),
        // Late against the display's own pace: over half again the median frame (a missed refresh).
        framesLate: frames.filter((f) => f > 1.5 * quantile(frames, 0.5)).length / Math.max(1, frames.length),
        framesOver33_3: frames.filter((f) => f > 33.4).length / Math.max(1, frames.length),
        scrollLongTasks: scrolled.longTasks.length,
        scrollLongestTaskMs: scrolled.longTasks.length ? Math.max(...scrolled.longTasks) : 0,
      });
    } finally {
      await app.close();
      fs.rmSync(state, { recursive: true, force: true });
    }
    if (outFile) fs.writeFileSync(outFile, JSON.stringify({ wanted, speedPxS: SPEED_PX_S, scrollMs: SCROLL_MS, samples }, null, 2));
  }
});
