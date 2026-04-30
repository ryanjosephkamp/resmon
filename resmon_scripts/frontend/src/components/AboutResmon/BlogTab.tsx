import React, { useEffect, useMemo, useRef, useState } from 'react';
import PageHelp from '../Help/PageHelp';

/**
 * Blog tab — embeds the public resmon blog hosted at
 * ``https://ryanjosephkamp.github.io/resmon/`` (GitHub Pages + Jekyll, served
 * out of the ``docs/`` folder of the ``ryanjosephkamp/resmon`` repository).
 *
 * Architecture:
 *   1. On mount, the component fetches the Jekyll-generated Atom feed
 *      (``/feed.xml``) and parses it client-side via ``DOMParser``. The
 *      resulting ``BlogPost[]`` drives a left-pane "Posts" list that always
 *      reflects the current state of the live blog without an app re-release.
 *   2. The right pane is an Electron ``<webview>`` whose ``src`` is set to
 *      the selected post's URL (or, on first load, to the blog's index page).
 *      The ``webviewTag`` preference is enabled in ``electron/main.ts``, and
 *      a ``will-attach-webview`` hook there scrubs node integration / preload
 *      so the embedded page cannot reach the host's IPC bridge.
 *   3. The webview is origin-locked to ``BLOG_ORIGIN`` at the React layer:
 *      every ``src`` we set is validated to start with that origin, and
 *      ``new-window`` / ``will-navigate`` events that target a different
 *      origin are routed to the user's default browser through
 *      ``window.resmonAPI.openPath`` instead of being followed inside the
 *      embed. This keeps the embed strictly read-only against the blog and
 *      prevents the user from accidentally browsing the wider web inside
 *      the app shell.
 *
 * Feed fetch failures fall back to a single embedded view of the blog index
 * plus an "Open in browser" button; nothing on this tab requires network
 * connectivity to render the chrome.
 *
 * No credentials, cookies, or telemetry are involved. The only outbound
 * network call from this tab is a public ``GET`` of ``/feed.xml`` and the
 * GitHub Pages page loads inside the webview itself.
 */

// Public origin of the GitHub Pages blog. Hard-coded by design — this is the
// only URL the embedded webview is permitted to load.
const BLOG_ORIGIN = 'https://ryanjosephkamp.github.io';
const BLOG_INDEX_URL = `${BLOG_ORIGIN}/resmon/`;
const BLOG_FEED_URL = `${BLOG_ORIGIN}/resmon/feed.xml`;

interface BlogPost {
  /** Stable identifier from the Atom <id> element (or the post URL as a fallback). */
  id: string;
  title: string;
  /** Absolute URL of the post on the GitHub Pages site. */
  link: string;
  /** ISO-8601 publication timestamp, when present. */
  published: string | null;
  /** Optional plain-text summary extracted from the feed. */
  summary: string;
}

type FeedState =
  | { status: 'loading' }
  | { status: 'ready'; posts: BlogPost[] }
  | { status: 'error'; message: string };

// Augment JSX to declare the Electron ``<webview>`` element. Electron exposes
// it as a custom HTML element, so React needs an explicit intrinsic-element
// declaration to type-check ``src`` / ``partition`` / event handlers.
declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace JSX {
    interface IntrinsicElements {
      webview: React.DetailedHTMLProps<
        React.HTMLAttributes<HTMLElement> & {
          src?: string;
          partition?: string;
          useragent?: string;
        },
        HTMLElement
      >;
    }
  }
}

/**
 * Parse a Jekyll/Atom feed XML string into a ``BlogPost[]``. Tolerates a
 * missing ``<summary>`` and supports both ``<published>`` and ``<updated>``
 * timestamps. Returns ``[]`` if the document cannot be parsed.
 */
function parseAtomFeed(xml: string): BlogPost[] {
  try {
    const doc = new DOMParser().parseFromString(xml, 'application/xml');
    if (doc.querySelector('parsererror')) return [];
    const entries = Array.from(doc.getElementsByTagName('entry'));
    const posts: BlogPost[] = [];
    for (const entry of entries) {
      const title = entry.getElementsByTagName('title')[0]?.textContent?.trim() ?? '(untitled)';
      // Atom: <link href="..." />. Prefer rel="alternate" if present.
      const links = Array.from(entry.getElementsByTagName('link'));
      const altLink = links.find((l) => (l.getAttribute('rel') ?? 'alternate') === 'alternate');
      const href = (altLink ?? links[0])?.getAttribute('href') ?? '';
      if (!href || !href.startsWith(BLOG_ORIGIN)) continue; // origin lock
      const id = entry.getElementsByTagName('id')[0]?.textContent?.trim() || href;
      const published =
        entry.getElementsByTagName('published')[0]?.textContent?.trim() ||
        entry.getElementsByTagName('updated')[0]?.textContent?.trim() ||
        null;
      const summaryRaw =
        entry.getElementsByTagName('summary')[0]?.textContent ||
        entry.getElementsByTagName('content')[0]?.textContent ||
        '';
      // Strip HTML tags and collapse whitespace for the list preview.
      const summary = summaryRaw.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim().slice(0, 240);
      posts.push({ id, title, link: href, published, summary });
    }
    // Newest first.
    posts.sort((a, b) => {
      const ta = a.published ? Date.parse(a.published) : 0;
      const tb = b.published ? Date.parse(b.published) : 0;
      return tb - ta;
    });
    return posts;
  } catch {
    return [];
  }
}

function formatDate(iso: string | null): string {
  if (!iso) return '';
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return '';
  const d = new Date(t);
  return d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

// Minimal subset of the Electron <webview> instance methods we use to drive
// browser-style Back / Forward / Reload controls. Declared inline to avoid
// pulling Electron type definitions into the renderer build.
interface WebviewElement extends HTMLElement {
  canGoBack: () => boolean;
  canGoForward: () => boolean;
  goBack: () => void;
  goForward: () => void;
  reload: () => void;
}

const BlogTab: React.FC = () => {
  const [feed, setFeed] = useState<FeedState>({ status: 'loading' });
  const [selectedLink, setSelectedLink] = useState<string>(BLOG_INDEX_URL);
  const [canGoBack, setCanGoBack] = useState<boolean>(false);
  const [canGoForward, setCanGoForward] = useState<boolean>(false);
  const webviewRef = useRef<HTMLElement | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);

  // Fetch and parse the Atom feed once on mount. We do not retry automatically;
  // the user can hit the "Refresh" button to re-fetch.
  const loadFeed = async (): Promise<void> => {
    setFeed({ status: 'loading' });
    try {
      const res = await fetch(BLOG_FEED_URL, { cache: 'no-store' });
      if (!res.ok) {
        setFeed({ status: 'error', message: `Feed returned HTTP ${res.status}.` });
        return;
      }
      const xml = await res.text();
      const posts = parseAtomFeed(xml);
      setFeed({ status: 'ready', posts });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Network error while fetching the feed.';
      setFeed({ status: 'error', message });
    }
  };

  useEffect(() => {
    void loadFeed();
  }, []);

  // Wire ``new-window`` and ``will-navigate`` listeners on the <webview> so
  // any link that escapes the blog origin opens in the user's default
  // browser instead of inside the embed. This is what implements the
  // "lock the embed to the blog origin" guarantee at runtime.
  useEffect(() => {
    const wv = webviewRef.current as
      | (HTMLElement & {
          addEventListener: (
            type: string,
            handler: (evt: { url?: string; preventDefault?: () => void }) => void,
          ) => void;
          removeEventListener: (
            type: string,
            handler: (evt: { url?: string; preventDefault?: () => void }) => void,
          ) => void;
        })
      | null;
    if (!wv) return;

    const isAllowed = (url: string | undefined): boolean =>
      typeof url === 'string' && url.startsWith(BLOG_ORIGIN);

    const onNewWindow = (evt: { url?: string; preventDefault?: () => void }) => {
      evt.preventDefault?.();
      if (evt.url && window.resmonAPI?.openPath) void window.resmonAPI.openPath(evt.url);
      else if (evt.url) window.open(evt.url, '_blank');
    };
    const onWillNavigate = (evt: { url?: string; preventDefault?: () => void }) => {
      if (!isAllowed(evt.url)) {
        evt.preventDefault?.();
        if (evt.url && window.resmonAPI?.openPath) void window.resmonAPI.openPath(evt.url);
      }
    };

    // Refresh the Back / Forward enablement after every committed navigation
    // inside the embed so the toolbar buttons reflect the live history stack.
    const refreshNavState = () => {
      const w = wv as unknown as WebviewElement;
      try {
        setCanGoBack(typeof w.canGoBack === 'function' ? w.canGoBack() : false);
        setCanGoForward(typeof w.canGoForward === 'function' ? w.canGoForward() : false);
      } catch {
        setCanGoBack(false);
        setCanGoForward(false);
      }
    };

    wv.addEventListener('new-window', onNewWindow);
    wv.addEventListener('will-navigate', onWillNavigate);
    wv.addEventListener('did-navigate', refreshNavState);
    wv.addEventListener('did-navigate-in-page', refreshNavState);
    wv.addEventListener('did-finish-load', refreshNavState);
    return () => {
      wv.removeEventListener('new-window', onNewWindow);
      wv.removeEventListener('will-navigate', onWillNavigate);
      wv.removeEventListener('did-navigate', refreshNavState);
      wv.removeEventListener('did-navigate-in-page', refreshNavState);
      wv.removeEventListener('did-finish-load', refreshNavState);
    };
  }, []);

  // Intercept the mouse "back" / "forward" buttons (X1 = button 3, X2 = button 4)
  // while the pointer is anywhere inside the Blog panel so they navigate the
  // embedded reader instead of popping the React router back to the previous
  // tab. The capture-phase listener on the panel element keeps the scope local
  // — clicks outside the panel still fall through to default browser behavior.
  useEffect(() => {
    const panel = panelRef.current;
    if (!panel) return;
    const onAuxClick = (evt: MouseEvent) => {
      if (evt.button !== 3 && evt.button !== 4) return;
      const wv = webviewRef.current as unknown as WebviewElement | null;
      if (!wv) return;
      evt.preventDefault();
      evt.stopPropagation();
      try {
        if (evt.button === 3 && typeof wv.canGoBack === 'function' && wv.canGoBack()) wv.goBack();
        if (evt.button === 4 && typeof wv.canGoForward === 'function' && wv.canGoForward()) wv.goForward();
      } catch {
        /* ignore — webview may not yet be attached */
      }
    };
    // ``mouseup`` is more portable than ``auxclick`` for X1/X2 buttons across
    // Electron versions. Use capture so we win against any descendant handler.
    panel.addEventListener('mouseup', onAuxClick, { capture: true });
    panel.addEventListener('auxclick', onAuxClick, { capture: true });
    return () => {
      panel.removeEventListener('mouseup', onAuxClick, { capture: true } as EventListenerOptions);
      panel.removeEventListener('auxclick', onAuxClick, { capture: true } as EventListenerOptions);
    };
  }, []);

  const handleSelect = (link: string) => {
    if (!link.startsWith(BLOG_ORIGIN)) return; // origin lock
    setSelectedLink(link);
  };

  const handleOpenInBrowser = () => {
    const url = selectedLink || BLOG_INDEX_URL;
    if (window.resmonAPI?.openPath) void window.resmonAPI.openPath(url);
    else window.open(url, '_blank');
  };

  const handleBack = () => {
    const wv = webviewRef.current as unknown as WebviewElement | null;
    try { if (wv && wv.canGoBack()) wv.goBack(); } catch { /* no-op */ }
  };
  const handleForward = () => {
    const wv = webviewRef.current as unknown as WebviewElement | null;
    try { if (wv && wv.canGoForward()) wv.goForward(); } catch { /* no-op */ }
  };
  const handleReload = () => {
    const wv = webviewRef.current as unknown as WebviewElement | null;
    try { wv?.reload(); } catch { /* no-op */ }
  };

  const posts: BlogPost[] = useMemo(
    () => (feed.status === 'ready' ? feed.posts : []),
    [feed],
  );

  return (
    <div className="settings-panel blog-panel" ref={panelRef}>
      <h2>Blog</h2>

      <PageHelp
        storageKey="about-resmon-blog"
        title="Blog"
        summary="Read the latest resmon updates and announcements without leaving the app."
        sections={[
          {
            heading: 'How this tab works',
            body: (
              <>
                <p>
                  This tab embeds the public resmon blog at
                  {' '}<code>{BLOG_INDEX_URL}</code>. The post list on the left is built
                  by fetching the blog's Atom feed at <code>/feed.xml</code> when the tab
                  opens, so it always reflects the current state of the live blog without
                  an app re-release.
                </p>
                <p>
                  Click a post in the list to load it on the right. Use <strong>Refresh</strong> to
                  re-fetch the feed, and <strong>Open in browser</strong> to open the current post
                  in your default browser.
                </p>
              </>
            ),
          },
          {
            heading: 'Privacy',
            body: (
              <p>
                The embedded view is locked to the blog's origin. Any link that points elsewhere
                opens in your default browser rather than inside this app. The app does not store
                any cookies or browsing history from the embed.
              </p>
            ),
          },
        ]}
      />

      <div className="blog-toolbar">
        <button
          type="button"
          className="btn btn-sm"
          onClick={handleBack}
          disabled={!canGoBack}
          aria-label="Back"
          title="Back"
          data-testid="blog-back"
        >
          ← Back
        </button>
        <button
          type="button"
          className="btn btn-sm"
          onClick={handleForward}
          disabled={!canGoForward}
          aria-label="Forward"
          title="Forward"
          data-testid="blog-forward"
        >
          Forward →
        </button>
        <button
          type="button"
          className="btn btn-sm"
          onClick={handleReload}
          aria-label="Reload page"
          title="Reload page"
          data-testid="blog-reload"
        >
          Reload
        </button>
        <button type="button" className="btn btn-sm" onClick={() => void loadFeed()} data-testid="blog-refresh">
          Refresh feed
        </button>
        <button type="button" className="btn btn-sm" onClick={handleOpenInBrowser} data-testid="blog-open-in-browser">
          Open in browser
        </button>
        <span className="blog-toolbar-spacer" />
        <span className="blog-source-note">
          Source: <code>{BLOG_INDEX_URL}</code>
        </span>
      </div>

      <div className="blog-layout">
        <aside className="blog-post-list" aria-label="Blog posts">
          {feed.status === 'loading' ? (
            <p className="blog-status">Loading posts…</p>
          ) : feed.status === 'error' ? (
            <div className="blog-status">
              <p>Could not load the blog feed.</p>
              <p className="form-error" role="alert">{feed.message}</p>
              <p>The embedded reader on the right is still showing the blog's index page.</p>
            </div>
          ) : posts.length === 0 ? (
            <p className="blog-status">No posts have been published yet.</p>
          ) : (
            <ul className="blog-post-items">
              {posts.map((p) => {
                const isActive = p.link === selectedLink;
                return (
                  <li key={p.id} className={`blog-post-item ${isActive ? 'is-active' : ''}`}>
                    <button
                      type="button"
                      className="blog-post-button"
                      onClick={() => handleSelect(p.link)}
                      aria-current={isActive ? 'true' : undefined}
                    >
                      <span className="blog-post-title">{p.title}</span>
                      {p.published ? (
                        <span className="blog-post-date">{formatDate(p.published)}</span>
                      ) : null}
                      {p.summary ? (
                        <span className="blog-post-summary">{p.summary}</span>
                      ) : null}
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </aside>

        <section className="blog-reader" aria-label="Blog reader">
          <webview
            ref={webviewRef as unknown as React.RefObject<HTMLElement>}
            src={selectedLink}
            partition="persist:resmon-blog"
            className="blog-webview"
          />
        </section>
      </div>
    </div>
  );
};

export default BlogTab;
