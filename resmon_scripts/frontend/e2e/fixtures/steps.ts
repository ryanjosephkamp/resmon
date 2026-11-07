/**
 * A test's steps, each logged with when it began and held to a time of its
 * own and to the test's, less the time kept for teardown: a stall fails the
 * step it is in, with a sentence that names it, while there is still time to
 * say where things stood and to put everything away.
 *
 * Each line is led by the spec's own prefix and the time the step began
 * (`SERVICE STARTING 14:45:16.204 +1.6 s …`), so a run's log reads as the
 * test's own account of itself. `run` is given the step's time, for a
 * Playwright wait to be held to it as well, so a launch that times out is
 * stopped by Playwright itself. `tellWhere` then says where the window stood,
 * from what `watchWindow` and `capture` collected.
 */
import * as fs from 'fs';
import * as path from 'path';
import type { ElectronApplication, Locator, Page, Request } from '@playwright/test';
import { ATLAS_LANDMARK } from './resmon-app';

export interface Steps {
  /** One line in the log, with the time it was said. */
  say: (line: string) => void;
  /** Run one step: `what` names it in the log and in its failure; `limitMs` is its own time. */
  step: <T>(what: string, limitMs: number, run: (ms: number) => Promise<T>) => Promise<T>;
}

/**
 * The steps of a test whose timeout is `testTimeoutMs`, keeping `teardownMs`
 * of it back for what the test does once it has passed or failed.
 */
export function stepsWithin(prefix: string, testTimeoutMs: number, teardownMs: number): Steps {
  const begun = Date.now();
  const deadline = begun + testTimeoutMs - teardownMs;
  const since = (): string => `${((Date.now() - begun) / 1000).toFixed(1)} s`;
  const say = (line: string): void => {
    console.log(`${prefix} ${new Date().toISOString().slice(11, 23)} +${since()} ${line}`);
  };
  const step = async <T>(what: string, limitMs: number, run: (ms: number) => Promise<T>): Promise<T> => {
    const ms = Math.max(1_000, Math.min(limitMs, deadline - Date.now()));
    say(what);
    const work = run(ms);
    // A step given up on may still settle later, with nobody waiting for it.
    work.catch(() => { /* reported below while the step is waited for */ });
    const begunStep = Date.now();
    let timer: NodeJS.Timeout | undefined;
    const stalled = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error(`Stalled at "${what}": not done after `
        + `${Math.round((Date.now() - begunStep) / 1000)} s, ${since()} into the test.`)), ms + 5_000);
    });
    try {
      return await Promise.race([work, stalled]);
    } catch (error) {
      // The step's own error, its message led by the step it failed in.
      if (error instanceof Error && !error.message.startsWith('Stalled at ')) {
        const named = `Failed at "${what}", ${since()} into the test: ${error.message}`;
        if (error.stack?.includes(error.message)) error.stack = error.stack.replace(error.message, named);
        error.message = named;
      }
      throw error;
    } finally {
      clearTimeout(timer);
    }
  };
  return { say, step };
}

/** What a launch writes, from the moment it is up: stdout alone, and stdout and stderr as they came. */
export function capture(app: ElectronApplication): { out: () => string; all: () => string } {
  const out: string[] = [];
  const all: string[] = [];
  const child = app.process();
  child.stdout?.on('data', (chunk: Buffer) => { out.push(chunk.toString()); all.push(chunk.toString()); });
  child.stderr?.on('data', (chunk: Buffer) => { all.push(chunk.toString()); });
  return { out: () => out.join(''), all: () => all.join('') };
}

/** Print what a launch wrote, under the spec's prefix, its last part when it wrote a lot. */
export function tellWrote(prefix: string, who: string, text: string): void {
  const kept = text.length > 16_000 ? text.slice(-16_000) : text;
  const part = kept.length < text.length ? ` (the last ${kept.length} of ${text.length} characters)` : '';
  console.log(`${prefix} ${who} WROTE${part}:\n${kept.trimEnd() || '(nothing)'}`);
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** What a window did from the moment it opened: its uncaught errors, its console errors, and its requests. */
export interface Watched {
  problems: string[];
  consoleErrors: string[];
  failed: string[];
  pending: Map<Request, number>;
}

const where = (url: string): string => url.replace(/^http:\/\/127\.0\.0\.1:\d+/, '');

/** Watch a window from now on, for saying where it stood if a step stalls. */
export function watchWindow(win: Page): Watched {
  const watched: Watched = { problems: [], consoleErrors: [], failed: [], pending: new Map() };
  win.on('pageerror', (e) => watched.problems.push(e.message));
  win.on('console', (msg) => { if (msg.type() === 'error') watched.consoleErrors.push(msg.text().slice(0, 300)); });
  win.on('request', (request) => watched.pending.set(request, Date.now()));
  win.on('requestfinished', (request) => watched.pending.delete(request));
  win.on('requestfailed', (request) => {
    watched.pending.delete(request);
    watched.failed.push(`${request.method()} ${where(request.url())}: ${request.failure()?.errorText ?? 'unknown'}`);
  });
  return watched;
}

/** An answer within `ms`, or a sentence saying there was none, so saying where things stood cannot itself stall. */
function within<T>(ms: number, what: () => Promise<T>): Promise<T | string> {
  return Promise.race([
    what().catch((error: unknown) => `failed: ${error instanceof Error ? error.message.split('\n')[0] : String(error)}`),
    sleep(ms).then(() => `no answer within ${ms / 1000} s`),
  ]);
}

/** The control a step was acting on, named as the step names it. */
export interface Target { name: string; locator: Locator }

/** What there was to see when a step stopped. Each part is optional: a step can stop before there is a window. */
export interface Stood {
  app: ElectronApplication | null;
  win: Page | null;
  /** The launch's state folder, for the engine's port file. */
  stateDir: string;
  watched: Watched | null;
  wrote: (() => string) | null;
  target?: Target | null;
}

/**
 * Where a test stood when a step stopped, on a line led by `prefix`: the
 * window's address and title, whether Atlas drew its frame and which heading
 * it shows, the control the step was acting on (whether it is there, shown,
 * and enabled, and what is at its center), the engine's health asked through
 * the page's own fetch and from here, the requests still waiting, every window
 * and its size, and then what the app wrote.
 */
export async function tellWhere(prefix: string, stood: Stood): Promise<void> {
  const { app, win, stateDir, watched, wrote, target } = stood;
  const [page, control, pageHealth, windows, engineHealth] = await Promise.all([
    win ? within(5_000, () => win.evaluate((landmark) => ({
      href: window.location.href,
      hash: window.location.hash,
      title: document.title,
      readyState: document.readyState,
      historyLength: window.history.length,
      drawn: (document.getElementById('root')?.childElementCount ?? 0) > 0,
      frame: !!document.querySelector(landmark),
      headings: [...document.querySelectorAll('h1')].map((h) => h.textContent?.trim() ?? ''),
      alerts: [...document.querySelectorAll('[role="alert"]')].map((a) => a.textContent?.trim().slice(0, 200) ?? ''),
      dialogs: [...document.querySelectorAll('dialog[open], [role="dialog"]')].map((d) => d.getAttribute('aria-label') ?? d.textContent?.trim().slice(0, 80) ?? ''),
      stage: (document.querySelector('main.stage') as HTMLElement | null)?.innerText.trim().slice(0, 400) ?? null,
      viewport: [window.innerWidth, window.innerHeight],
    }), ATLAS_LANDMARK)) : 'no window',
    win && target ? within(5_000, async () => {
      const count = await target.locator.count();
      if (count === 0) return { name: target.name, exists: false };
      const first = target.locator.first();
      return {
        name: target.name,
        exists: true,
        count,
        visible: await first.isVisible(),
        enabled: await first.isEnabled().catch(() => null),
        ...await first.evaluate((el) => {
          const box = el.getBoundingClientRect();
          const at = document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2);
          const named = (node: Element | null) => (node
            ? `${node.tagName.toLowerCase()}${node.id ? `#${node.id}` : ''}${node.className && typeof node.className === 'string' ? `.${node.className.trim().split(/\s+/).join('.')}` : ''} "${(node.textContent ?? '').trim().slice(0, 60)}"`
            : null);
          return {
            box: [box.x, box.y, box.width, box.height].map(Math.round),
            atItsCenter: named(at),
            atItsCenterIsIt: !!at && (at === el || el.contains(at)),
          };
        }),
      };
    }) : null,
    win ? within(8_000, () => win.evaluate(async () => {
      const port = (window as unknown as { resmonAPI?: { getBackendPort(): string } }).resmonAPI?.getBackendPort();
      if (!port) return 'the page has no engine port';
      const begun = performance.now();
      const res = await e2eFetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(6_000) });
      return { port, status: res.status, ms: Math.round(performance.now() - begun), body: (await res.text()).slice(0, 300) };
    })) : 'no window',
    app ? within(5_000, () => app.evaluate(({ BrowserWindow, screen }) => ({
      workArea: screen.getPrimaryDisplay().workArea,
      windows: BrowserWindow.getAllWindows().map((w) => ({
        id: w.id, url: w.webContents.getURL(), bounds: w.getBounds(), content: w.getContentSize(),
        visible: w.isVisible(), focused: w.isFocused(), loading: w.webContents.isLoading(), crashed: w.webContents.isCrashed(),
      })),
    }))) : 'no app',
    within(8_000, async () => {
      // From here, by the port file the engine writes, so a page that does not answer does not hide the engine.
      const port = fs.readFileSync(path.join(stateDir, 'resmon.port'), 'utf8').trim();
      const begun = Date.now();
      const res = await e2eFetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(6_000) });
      return { port, status: res.status, ms: Date.now() - begun, body: (await res.text()).slice(0, 300) };
    }),
  ]);
  const now = Date.now();
  console.log(`${prefix} STATE ${JSON.stringify({
    pages: app ? app.windows().map((p) => p.url()) : null,
    page,
    control,
    pageHealth,
    engineHealth,
    windows,
    waiting: watched ? [...watched.pending].map(([request, at]) => `${request.method()} ${where(request.url())} for ${((now - at) / 1000).toFixed(1)} s`) : null,
    failed: watched?.failed ?? null,
    pageErrors: watched?.problems ?? null,
    consoleErrors: watched?.consoleErrors ?? null,
  })}`);
  if (wrote) tellWrote(prefix, 'THE APP', wrote());
}
