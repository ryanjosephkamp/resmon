/**
 * P9 — the two surfaces the rest of the suite is deliberately blind to.
 *
 * Every other assertion in `e2e/` is scoped by `isOwnOrigin()` to
 * `http://127.0.0.1:*`, and that scoping is what makes the suite a signal
 * rather than a coin flip: About resmon embeds six `youtube-nocookie.com`
 * iframes and a GitHub Pages `<webview>`, and both emit console errors and
 * leave requests in flight that no change to this repository can fix. The
 * spike recorded the cost of that scoping plainly — **a broken YouTube embed or
 * a broken blog webview is invisible to the smoke suite** — and left the
 * decision to this phase.
 *
 * The decision is the positive check. "Nothing failed" and "it loaded" are
 * different claims, and only the second one can be made about somebody else's
 * origin without also inheriting their noise: an `ERR_ABORTED` when the user
 * navigates away says nothing about whether the embed works, while an HTTP
 * error status on the embed document does.
 *
 * **An HTTP status is not enough, and that is why this reads the frame.** A
 * YouTube video that has been removed, made private, or blocked in a region
 * still answers the embed request with **200** and renders "Video unavailable"
 * inside the player — so a status check would call a dead tutorial healthy.
 * Playwright can evaluate inside a cross-origin frame in Chromium, so each
 * embed is asked directly whether its player mounted, whether YouTube put an
 * error in it, and what the video is called. A removed video is a
 * `.ytp-error`; a wrong id is a title of bare "YouTube".
 *
 * **The embeds are lazy, and the first version of this missed it.** Chromium
 * only fetches an iframe near the viewport: 17 embeds are rendered and 3 load.
 * Each one is scrolled into view in turn, which is also what a reader does.
 *
 * **And it does not turn a network outage into a red build.** A machine that
 * cannot reach the origin at all skips, printing what it did not verify —
 * the same shape `default-behaviour.spec.ts` uses for the window manager.
 * Failing there would make the suite red for the one reason the scoping
 * existed to avoid.
 */
import { test, expect } from './fixtures/resmon-app';

test.describe.configure({ mode: 'serial' });

const YOUTUBE = 'youtube-nocookie.com';
const BLOG_ORIGIN = 'https://ryanjosephkamp.github.io';

/**
 * Chromium error texts that mean *this machine could not reach the network*,
 * as opposed to *the resource is wrong*. Only these skip.
 *
 * `net::ERR_ABORTED` is deliberately **not** here: it is the navigation-away
 * abort the spike measured 2–6 of per run, and it is neither a failure nor a
 * reason to stop asserting — it is simply not evidence either way.
 */
const OFFLINE = [
  'ERR_NAME_NOT_RESOLVED',
  'ERR_INTERNET_DISCONNECTED',
  'ERR_CONNECTION_REFUSED',
  'ERR_CONNECTION_TIMED_OUT',
  'ERR_CONNECTION_RESET',
  'ERR_ADDRESS_UNREACHABLE',
  'ERR_PROXY_CONNECTION_FAILED',
  'ERR_TIMED_OUT',
];

function looksOffline(text: string): boolean {
  return OFFLINE.some((e) => text.includes(e));
}

interface EmbedReport {
  src: string;
  loaded: boolean;
  hasPlayer: boolean;
  hasError: boolean;
  title: string;
  errorText: string;
}

test('P9a: every YouTube embed the Tutorials tab renders actually plays', async ({
  win, goto,
}) => {
  test.setTimeout(300_000);
  const failures: { url: string; failure: string }[] = [];
  const onFailed = (r: { url(): string; failure(): { errorText: string } | null }) => {
    if (r.url().includes(YOUTUBE)) {
      failures.push({ url: r.url(), failure: r.failure()?.errorText ?? 'unknown' });
    }
  };
  win.on('requestfailed', onFailed);

  try {
    await goto('/about-resmon/tutorials');

    // The denominator is what the page rendered, not a number written here.
    // `TutorialsTab.tsx` builds one iframe per step that has a `youtubeId`, so
    // a seventeenth video — or an eighteenth — is under this check the moment
    // it is added. The spike's report said six; there are seventeen.
    const iframes = win.locator(`iframe[src*="${YOUTUBE}"]`);
    const srcs = await iframes.evaluateAll(
      (els) => els.map((e) => (e as HTMLIFrameElement).src));
    console.log('P9a EMBEDS RENDERED', srcs.length);
    expect(srcs.length).toBeGreaterThan(0);

    const reports: EmbedReport[] = [];
    for (let i = 0; i < srcs.length; i += 1) {
      const src = srcs[i];
      // Lazy loading is per-viewport, so this is the reader's own action:
      // scroll to the video, then look at it.
      await iframes.nth(i).scrollIntoViewIfNeeded();
      let frame = null as ReturnType<typeof win.frames>[number] | null;
      const deadline = Date.now() + 20_000;
      while (Date.now() < deadline) {
        frame = win.frames().find((f) => f.url() === src) ?? null;
        if (frame) break;
        await win.waitForTimeout(250);
      }
      if (!frame) {
        reports.push({
          src, loaded: false, hasPlayer: false, hasError: false, title: '', errorText: '',
        });
        continue;
      }
      // The player mounts a tick or two after the document arrives.
      const probe = async () => frame.evaluate(() => ({
        title: document.title,
        hasPlayer: !!document.querySelector('.html5-video-player'),
        hasError: !!document.querySelector('.ytp-error'),
        errorText:
          (document.querySelector('.ytp-error-content-wrap') as HTMLElement | null)
            ?.innerText ?? '',
      }));
      let seen = await probe().catch(() => null);
      const playerDeadline = Date.now() + 15_000;
      while (Date.now() < playerDeadline && (!seen || (!seen.hasPlayer && !seen.hasError))) {
        await win.waitForTimeout(500);
        seen = await probe().catch(() => null);
      }
      reports.push({
        src,
        loaded: true,
        hasPlayer: seen?.hasPlayer ?? false,
        hasError: seen?.hasError ?? false,
        title: seen?.title ?? '',
        errorText: seen?.errorText ?? '',
      });
    }

    console.log('P9a EMBED REPORT', JSON.stringify(
      reports.map((r) => ({
        id: r.src.split('/embed/')[1]?.split('?')[0],
        loaded: r.loaded, player: r.hasPlayer, error: r.hasError, title: r.title,
      })), null, 1));
    if (failures.length) console.log('P9a EMBED REQUEST FAILURES', JSON.stringify(failures));

    const offline = failures.filter((f) => looksOffline(f.failure));
    if (reports.every((r) => !r.loaded) && (offline.length > 0 || reports.length > 0)) {
      console.log(
        `P9a NOT VERIFIED — this machine could not reach ${YOUTUBE}: `
        + JSON.stringify(offline.length ? offline : 'no embed frame ever appeared'),
      );
      test.skip(true, `cannot reach ${YOUTUBE} from this machine`);
    }

    const neverLoaded = reports.filter((r) => !r.loaded).map((r) => r.src);
    expect(neverLoaded, `embeds whose frame never appeared:\n${
      JSON.stringify(neverLoaded, null, 2)}`).toEqual([]);

    // The two things a 200 cannot tell you.
    const broken = reports.filter((r) => r.hasError || !r.hasPlayer);
    expect(broken, `embeds that did not produce a player:\n${
      JSON.stringify(broken, null, 2)}`).toEqual([]);
    // A removed or wrong id gives the embed document the bare title "YouTube";
    // a live video's title is the video's own.
    const untitled = reports.filter((r) => r.title.trim() === 'YouTube' || r.title.trim() === '');
    expect(untitled, `embeds with no video title — a wrong or withdrawn id:\n${
      JSON.stringify(untitled, null, 2)}`).toEqual([]);
  } finally {
    win.off('requestfailed', onFailed);
  }
});

test('P9b: the blog webview loaded the blog', async ({ app, win, goto }) => {
  // A `<webview>` is its own `WebContents`, not a frame of the page, so none of
  // this is visible from the renderer side. `web-contents-created` in the main
  // process is where it can be watched, and the listener has to be installed
  // before the tab is opened.
  await app.evaluate(async ({ app: a }) => {
    const store = { events: [] as { type: string; url: string; code?: number; desc?: string }[] };
    (globalThis as unknown as { __wv: typeof store }).__wv = store;
    a.on('web-contents-created', (_e, wc) => {
      if (wc.getType() !== 'webview') return;
      wc.on('did-finish-load', () => store.events.push({ type: 'finish', url: wc.getURL() }));
      wc.on('did-fail-load', (_ev, code, desc, url) => {
        store.events.push({ type: 'fail', url, code, desc });
      });
    });
  });

  await goto('/about-resmon/blog');

  const events = await (async () => {
    const deadline = Date.now() + 45_000;
    for (;;) {
      const got = await app.evaluate(async () =>
        (globalThis as unknown as {
          __wv: { events: { type: string; url: string; code?: number; desc?: string }[] };
        }).__wv.events);
      if (got.length > 0 || Date.now() > deadline) return got;
      await new Promise((r) => setTimeout(r, 500));
    }
  })();
  console.log('P9b WEBVIEW EVENTS', JSON.stringify(events));

  // It is attached at all — that much is independent of the network, and it is
  // what `webviewTag` and the `will-attach-webview` hook exist for.
  const attached = await app.evaluate(async ({ webContents }) =>
    webContents.getAllWebContents()
      .filter((wc) => wc.getType() === 'webview')
      .map((wc) => ({ url: wc.getURL(), crashed: wc.isCrashed() })));
  console.log('P9b WEBVIEW ATTACHED', JSON.stringify(attached));
  expect(attached.length).toBe(1);
  expect(attached[0].crashed).toBe(false);
  expect(attached[0].url).toContain(BLOG_ORIGIN);

  const hardFailures = events.filter(
    (e) => e.type === 'fail' && !(e.desc ?? '').includes('ERR_ABORTED'),
  );
  const offline = hardFailures.filter((e) => looksOffline(e.desc ?? ''));
  if (events.length === 0 || offline.length > 0) {
    console.log('P9b NOT VERIFIED — this machine could not reach the blog:',
      JSON.stringify(offline.length ? offline : 'no load event at all'));
    test.skip(true, `cannot reach ${BLOG_ORIGIN} from this machine`);
  }

  expect(hardFailures, `the blog webview failed to load:\n${JSON.stringify(hardFailures, null, 2)}`)
    .toEqual([]);
  expect(events.some((e) => e.type === 'finish' && e.url.startsWith(BLOG_ORIGIN))).toBe(true);
});
