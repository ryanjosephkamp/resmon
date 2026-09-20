/**
 * P9 — the third-party surfaces, and the one that is no longer here.
 *
 * Every other assertion in `e2e/` is scoped by `isOwnOrigin()` to
 * `http://127.0.0.1:*`, and that scoping is what makes the suite a signal
 * rather than a coin flip: an origin resmon does not own emits its own console
 * output and leaves its own requests in flight, and no change to this
 * repository can fix either. The cost of the scoping is that a surface resmon
 * renders but does not own is invisible to the smoke suite, so each one gets a
 * positive check here instead — "nothing failed" and "it loaded" are different
 * claims.
 *
 * **P9a used to be the YouTube embeds, and the embeds are gone.** The Tutorials
 * tab rendered one privacy-enhanced `youtube-nocookie.com` <iframe> per section
 * with a video (seventeen of them), and P9a scrolled to each one, waited for
 * the frame, and asked the player inside it whether it had actually mounted —
 * because a removed, private or region-blocked video still answers with 200 and
 * renders "Video unavailable". It was a good check of a thing that should not
 * have been there: opening the tab handed somebody else's service a request per
 * video, and a merge gate could only be green while that service was reachable
 * from the runner.
 *
 * So the videos are linked now, not embedded, and the check inverts. P9a below
 * is the same name for the opposite property: **no request to YouTube at all
 * while the Tutorials tab renders**, which is not something the origin-scoped
 * smoke suite can see either. P9c is the other half — the links still work, and
 * they leave through the shell rather than navigating this window.
 *
 * P9b, the blog `<webview>`, is unchanged: it is still a real third-party
 * surface, and it still skips rather than going red when this machine cannot
 * reach the network. Failing there would make the suite red for the one reason
 * the scoping existed to avoid.
 */
import { test, expect } from './fixtures/resmon-app';
import { installIpcGuards, readGuards, NOTHING_ESCAPED } from './fixtures/ipc-guards';

test.describe.configure({ mode: 'serial' });

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

/** Any host with `youtube` or `ytimg` in it — the embed host, the watch host,
 * the poster-image host and the player CDN all match, and so does anything new
 * that a future thumbnail might reach for. */
const YOUTUBE_HOST = /youtube|ytimg|youtu\.be/i;

test('P9a: the Tutorials tab sends nothing to YouTube', async ({ win, goto }) => {
  // The renderer's own request stream, unscoped — this is the one place in the
  // suite that deliberately looks at somebody else's origin, and here it is
  // looking for the absence of one. Both events are collected: a request that
  // was made and then failed is still a request that was made.
  const seen: { phase: string; kind: string; url: string }[] = [];
  let phase = 'before';
  const onRequest = (r: { url(): string }) => {
    if (YOUTUBE_HOST.test(r.url())) seen.push({ phase, kind: 'request', url: r.url() });
  };
  const onFailed = (r: { url(): string }) => {
    if (YOUTUBE_HOST.test(r.url())) seen.push({ phase, kind: 'requestfailed', url: r.url() });
  };
  win.on('request', onRequest);
  win.on('requestfailed', onFailed);

  try {
    phase = 'tutorials';
    await goto('/about-resmon/tutorials');

    // Scroll the whole tab, because the embeds were lazy: Chromium only fetched
    // an iframe near the viewport, and the first version of the old P9a missed
    // fourteen of seventeen for exactly that reason. An embed that came back
    // would come back the same way, so the check reads the page the way a
    // reader does.
    const height = await win.evaluate(() => {
      const main = document.querySelector('.app-main') ?? document.body;
      return main.scrollHeight;
    });
    for (let y = 0; y < height; y += 600) {
      await win.mouse.wheel(0, 600);
      await win.waitForTimeout(60);
    }
    await win.waitForTimeout(1000);

    // The denominator, read from the DOM rather than written here: how many
    // sections the tab rendered, and how many external links it offers.
    const rendered = await win.evaluate(() => ({
      sections: document.querySelectorAll('.tutorial-section').length,
      iframes: document.querySelectorAll('iframe, webview, object, embed').length,
      links: [...document.querySelectorAll('a[href]')]
        .map((a) => a.getAttribute('href') ?? '')
        .filter((h) => /^https?:/i.test(h)).length,
    }));
    console.log('P9a TUTORIALS RENDERED', JSON.stringify(rendered));
    console.log('P9a YOUTUBE REQUESTS', JSON.stringify(seen));

    expect(rendered.sections).toBeGreaterThan(20);
    // Every section is either a video link or a placeholder, plus the one
    // playlist link at the top, so the link count is bounded by the sections.
    expect(rendered.links).toBeGreaterThan(0);
    expect(rendered.links).toBeLessThanOrEqual(rendered.sections + 1);
    expect(rendered.iframes).toBe(0);
    expect(seen, `the Tutorials tab reached YouTube:\n${JSON.stringify(seen, null, 2)}`)
      .toEqual([]);
  } finally {
    win.off('request', onRequest);
    win.off('requestfailed', onFailed);
  }
});

test('P9c: a tutorial link leaves through the shell, not through this window', async ({
  app, win, goto,
}) => {
  // The guards replace every OS-facing call in the main process with a counter
  // and every preload IPC handler with a counting stub, so this observes the
  // renderer's click arriving in the *main process* — out of process, over the
  // real IPC channel — without a browser opening and without a byte leaving
  // the machine. `ipc-stubs.spec.ts` runs earlier in the same worker and has
  // already installed them; re-installing resets the counters.
  await installIpcGuards(app);
  const windowsBefore = app.windows().length;
  const urlBefore = win.url();

  const seen: string[] = [];
  const onRequest = (r: { url(): string }) => {
    if (YOUTUBE_HOST.test(r.url())) seen.push(r.url());
  };
  win.on('request', onRequest);

  try {
    await goto('/about-resmon/tutorials');
    const before = await readGuards(app);

    const link = win.locator('[data-testid="tutorial-playlist-link"]');
    const href = await link.getAttribute('href');
    console.log('P9c PLAYLIST HREF', href);
    expect(href).toMatch(/^https:\/\/www\.youtube\.com\/watch_videos\?video_ids=/);

    await link.scrollIntoViewIfNeeded();
    await link.click();
    await win.waitForTimeout(500);

    const after = await readGuards(app);
    console.log('P9c GUARDS', JSON.stringify({
      openPath: after.stubbed.openPath - before.stubbed.openPath,
      target: after.lastArgs.openPathTarget,
      escaped: after.escaped,
    }));

    // The URL reached the main process on the channel the preload bridge
    // exposes, and it is the playlist URL the tab rendered.
    expect(after.stubbed.openPath - before.stubbed.openPath).toBe(1);
    expect(after.lastArgs.openPathTarget).toBe(href);

    // And nothing else happened: no new window, no navigation of this one, no
    // request to YouTube, and nothing reached the operating system.
    expect(app.windows().length).toBe(windowsBefore);
    expect(win.url()).toBe(urlBefore);
    expect(seen, `clicking the link fetched from YouTube:\n${JSON.stringify(seen)}`).toEqual([]);
    expect(after.escaped).toEqual(NOTHING_ESCAPED);

    // The per-section link takes the same road.
    const watch = win.locator('[data-testid^="tutorial-watch-"]').first();
    const watchHref = await watch.getAttribute('href');
    expect(watchHref).toMatch(/^https:\/\/www\.youtube\.com\/watch\?v=/);
    await watch.scrollIntoViewIfNeeded();
    await watch.click();
    await win.waitForTimeout(300);
    const third = await readGuards(app);
    expect(third.stubbed.openPath - after.stubbed.openPath).toBe(1);
    expect(third.lastArgs.openPathTarget).toBe(watchHref);
    expect(app.windows().length).toBe(windowsBefore);
    expect(win.url()).toBe(urlBefore);
  } finally {
    win.off('request', onRequest);
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
