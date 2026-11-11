/**
 * Web links: where one opens, and what the link window's address field makes
 * of what is typed into it. Kept apart from `main.ts` so it is tested without
 * a window.
 *
 * The choices are the engine's (`/api/web-links`); a window's renderer reads
 * them and hands them to the main process (`resmon:web-links`), which opens
 * the links.
 */
import { createHash } from 'crypto';

export type WebLinkSearch =
  | 'duckduckgo' | 'google' | 'bing' | 'brave' | 'startpage' | 'ecosia'
  | 'google_scholar' | 'semantic_scholar';

export interface WebLinkSettings {
  open_in: 'resmon' | 'browser';
  new: 'window' | 'tab';
  search: WebLinkSearch;
}

export const DEFAULT_WEB_LINKS: WebLinkSettings = { open_in: 'resmon', new: 'window', search: 'duckduckgo' };

/** Each search's name, as Settings and the address field's placeholder say it, and the address its words go to. */
export const SEARCHES: Readonly<Record<WebLinkSearch, { name: string; address: string }>> = {
  duckduckgo: { name: 'DuckDuckGo', address: 'https://duckduckgo.com/?q=' },
  google: { name: 'Google', address: 'https://www.google.com/search?q=' },
  bing: { name: 'Bing', address: 'https://www.bing.com/search?q=' },
  brave: { name: 'Brave Search', address: 'https://search.brave.com/search?q=' },
  startpage: { name: 'Startpage', address: 'https://www.startpage.com/sp/search?query=' },
  ecosia: { name: 'Ecosia', address: 'https://www.ecosia.org/search?q=' },
  google_scholar: { name: 'Google Scholar', address: 'https://scholar.google.com/scholar?q=' },
  semantic_scholar: { name: 'Semantic Scholar', address: 'https://www.semanticscholar.org/search?q=' },
};

/** The choices a renderer sent, or null when they are not ones the engine stores. */
export function readWebLinks(value: unknown): WebLinkSettings | null {
  if (!value || typeof value !== 'object') return null;
  const { open_in, new: how, search } = value as Record<string, unknown>;
  if (open_in !== 'resmon' && open_in !== 'browser') return null;
  if (how !== 'window' && how !== 'tab') return null;
  if (typeof search !== 'string' || !Object.prototype.hasOwnProperty.call(SEARCHES, search)) return null;
  return { open_in, new: how, search: search as WebLinkSearch };
}

/**
 * How a link someone followed opens: in their own browser, or in resmon's,
 * as a window or, on macOS, a tab. Only macOS draws window tabs, so a tab
 * asked for elsewhere is a window.
 */
export function linkOpening(settings: WebLinkSettings, platform: NodeJS.Platform): 'browser' | 'window' | 'tab' {
  if (settings.open_in === 'browser') return 'browser';
  return settings.new === 'tab' && platform === 'darwin' ? 'tab' : 'window';
}

export function isWebAddress(url: string): boolean {
  try {
    const { protocol } = new URL(url);
    return protocol === 'http:' || protocol === 'https:';
  } catch {
    return false;
  }
}

const DOI = /^(?:doi:\s*)?(10\.\d{4,9}\/\S+)$/i;
const HOST_AND_PORT = /^[^\s/:]+:\d+(?:[/?#]|$)/;
const SCHEME = /^[a-z][a-z0-9+.-]*:/i;
const IPV4 = /^\d{1,3}(?:\.\d{1,3}){3}$/;
const DOMAIN = /^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$/i;

/**
 * Where the address field sends what was typed, or null for nothing typed.
 *
 * - A web address goes as typed: `https://…`, `http://…`, or one without its
 *   scheme (`arxiv.org/abs/…`, `localhost:8000`), which gets `https://`, or
 *   `http://` for `localhost` and a numeric address.
 * - A DOI (`10.1038/…`, or `doi:10.1038/…`) goes to doi.org.
 * - Anything else, including an address of another scheme (`file:`,
 *   `javascript:`), is searched for, with the search chosen in Settings.
 */
export function addressTarget(text: string, search: WebLinkSearch): string | null {
  const typed = text.trim();
  if (!typed) return null;
  const doi = DOI.exec(typed);
  if (doi) return `https://doi.org/${doi[1]}`;
  if (SCHEME.test(typed) && !HOST_AND_PORT.test(typed)) {
    if (isWebAddress(typed) && /^https?:\/\/[^/]/i.test(typed)) return new URL(typed).href;
  } else if (!/\s/.test(typed)) {
    const host = typed.split(/[/?#]/, 1)[0].replace(/:\d+$/, '');
    const local = /^localhost$/i.test(host) || IPV4.test(host);
    if (local || DOMAIN.test(host)) {
      try {
        return new URL(`${local ? 'http' : 'https'}://${typed}`).href;
      } catch {
        // Not an address after all: searched for below.
      }
    }
  }
  const engine = SEARCHES[search] ?? SEARCHES[DEFAULT_WEB_LINKS.search];
  return engine.address + encodeURIComponent(typed);
}

/** What the bar shows: the page's address and what can be done from it. */
export interface LinkBarState {
  url: string;
  canGoBack: boolean;
  canGoForward: boolean;
  loading: boolean;
  failed: boolean;
  /** The search's name, for the address field's placeholder. */
  searchName: string;
  /** What the page is doing, in words (`barStatus`): empty once it has loaded. */
  status: string;
}

export function barStatus(state: Pick<LinkBarState, 'url' | 'loading' | 'failed'>): string {
  if (state.failed) return 'The page could not be loaded.';
  if (state.loading && state.url) return 'Loading the page…';
  return '';
}

const escapeHtml = (text: string) => text.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

/** The bar's only script. It reaches the main process through `link-bar-preload.ts` and nothing else. */
const BAR_SCRIPT = `
const bar = window.linkBar;
const $ = (id) => document.getElementById(id);
const address = $('address');
let shown = address.value;
let editing = false;
const act = (action, text) => bar && bar.act(action, text);
$('back').addEventListener('click', () => act('back'));
$('forward').addEventListener('click', () => act('forward'));
$('reload').addEventListener('click', () => act($('reload').dataset.loading === 'true' ? 'stop' : 'reload'));
$('browser').addEventListener('click', () => act('browser'));
address.addEventListener('focus', () => address.select());
address.addEventListener('input', () => { editing = true; });
address.addEventListener('blur', () => { if (!editing) address.value = shown; });
address.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') {
    event.preventDefault();
    editing = false;
    address.value = shown;
    address.select();
  }
});
$('go').addEventListener('submit', (event) => {
  event.preventDefault();
  if (!address.value.trim()) return;
  editing = false;
  act('go', address.value);
  address.blur();
});
const show = (state) => {
  shown = state.url;
  if (!editing && document.activeElement !== address) address.value = state.url;
  address.placeholder = 'Search with ' + state.searchName + ' or type an address';
  $('back').disabled = !state.canGoBack;
  $('forward').disabled = !state.canGoForward;
  const reload = $('reload');
  reload.dataset.loading = String(state.loading && !!state.url);
  reload.setAttribute('aria-label', state.loading && state.url ? 'Stop' : 'Reload');
  reload.title = state.loading && state.url ? 'Stop loading' : reload.dataset.reloadTitle;
  $('browser').disabled = !/^https?:/i.test(state.url);
  $('status').textContent = state.status;
};
if (bar) {
  bar.onState(show);
  bar.onFocusAddress(() => { address.focus(); address.select(); });
  act('ready');
}
`;

/**
 * The link window's bar: Back, Forward, Reload (Stop while loading), the
 * address field, what the page is doing, and Open in Your Browser. A page of
 * its own, apart from the remote page's, allowed only its one script (by
 * hash) and inline styles.
 */
export function linkBarHtml(initial: { url: string; status: string; platform: NodeJS.Platform }): string {
  const hash = createHash('sha256').update(BAR_SCRIPT).digest('base64');
  const mac = initial.platform === 'darwin';
  const key = (letter: string) => (mac ? `⌘${letter}` : `Ctrl+${letter}`);
  const icon = (d: string, name = '') => `<svg${name ? ` class="${name}"` : ''} viewBox="0 0 16 16" width="16" height="16" aria-hidden="true"><path d="${d}" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
  const loading = initial.status === barStatus({ url: initial.url, loading: true, failed: false }) && initial.status !== '';
  return `<!doctype html><html lang="en"><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'sha256-${hash}'">
<title>Link</title>
<style>
:root{color-scheme:light dark}
body{margin:0;font:13px system-ui,-apple-system,sans-serif;background:Canvas;color:CanvasText}
header{height:52px;box-sizing:border-box;display:flex;align-items:center;gap:8px;padding:8px 12px;border-bottom:1px solid GrayText}
nav{display:flex;gap:2px;flex:none}
button{font:inherit;background:ButtonFace;color:ButtonText;border:1px solid ButtonBorder;border-radius:6px;padding:5px 10px;cursor:default}
nav button{display:grid;place-items:center;width:30px;height:30px;padding:0;background:transparent;border-color:transparent}
nav button:hover:not(:disabled){background:ButtonFace;border-color:ButtonBorder}
button:disabled{opacity:.45}
button:focus-visible,input:focus-visible{outline:2px solid Highlight;outline-offset:1px}
form{flex:1;min-width:0;display:flex}
input{flex:1;min-width:0;font:inherit;color:FieldText;background:Field;border:1px solid ButtonBorder;border-radius:6px;padding:6px 10px}
#status{flex:none;max-width:30%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
#status:empty{display:none}
#browser{flex:none}
#reload .stop-icon,#reload[data-loading="true"] .reload-icon{display:none}
#reload[data-loading="true"] .stop-icon{display:block}
</style>
<header>
<nav aria-label="Page">
<button id="back" type="button" aria-label="Back" title="Back (${key('[')})" disabled>${icon('M10 3 5 8l5 5')}</button>
<button id="forward" type="button" aria-label="Forward" title="Forward (${key(']')})" disabled>${icon('m6 3 5 5-5 5')}</button>
<button id="reload" type="button" data-reload-title="Reload (${key('R')})" data-loading="${loading}" aria-label="${loading ? 'Stop' : 'Reload'}" title="${loading ? 'Stop loading' : `Reload (${key('R')})`}">${icon('M13 8a5 5 0 1 1-1.6-3.7M13 2.5v3h-3', 'reload-icon')}${icon('m4 4 8 8m0-8-8 8', 'stop-icon')}</button>
</nav>
<form id="go" role="search"><input id="address" type="text" aria-label="Address" spellcheck="false" autocomplete="off" autocapitalize="off" value="${escapeHtml(initial.url)}" placeholder="Search or type an address"></form>
<span id="status" role="status">${escapeHtml(initial.status)}</span>
<button id="browser" type="button">Open in Your Browser</button>
</header>
<script>${BAR_SCRIPT}</script>
</html>`;
}
