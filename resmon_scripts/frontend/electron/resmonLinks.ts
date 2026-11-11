/**
 * `resmon://` links: how another program, such as the Save to resmon browser
 * extension, asks resmon to look a paper up.
 *
 * Any web page can open a `resmon://` link, so one does nothing on its own: it
 * opens Search › Look Up a Paper with the paper's DOI, arXiv id, PMID, or title
 * filled in, and the page it came from named. Nothing is asked of a source,
 * and nothing is saved, until the person presses Find and chooses what to do
 * with what was found. Every other link is refused.
 *
 *   resmon://find?q=<a DOI, an arXiv id, a PMID, or a title>&from=<the web page>
 */
import { isWebAddress } from './webLinks';

export const RESMON_SCHEME = 'resmon';

/** Look Up a Paper's own limit on what is typed into it. */
const MOST_TYPED = 500;
const MOST_FROM = 2048;

/** The page a `resmon://` link opens (a hash route), or null for a link resmon does not answer. */
export function routeOfResmonLink(link: string): string | null {
  if (typeof link !== 'string' || link.length > 8192) return null;
  let url: URL;
  try {
    url = new URL(link);
  } catch {
    return null;
  }
  if (url.protocol !== `${RESMON_SCHEME}:`) return null;
  // `resmon://find?…` names the action as its host, and `resmon:find?…` as its path; a link with both is refused.
  if (url.hostname && url.pathname !== '' && url.pathname !== '/') return null;
  const action = (url.hostname || url.pathname).replace(/^\/+|\/+$/g, '').toLowerCase();
  if (action !== 'find') return null;
  const typed = (url.searchParams.get('q') ?? '').replace(/\s+/g, ' ').trim();
  if (!typed || typed.length > MOST_TYPED) return null;
  const params = new URLSearchParams({ q: typed });
  const from = (url.searchParams.get('from') ?? '').trim();
  if (from && from.length <= MOST_FROM && isWebAddress(from)) params.set('from', from);
  return `/search/find?${params.toString()}`;
}

/**
 * Whether this copy of resmon may make itself the system's handler for `resmon://` links: only the app whose
 * program is named resmon (`resmon`, `resmon.exe`), never a copy built under another name, such as "resmon walk"
 * for a walk-through, which would take the links from the resmon a person installed.
 */
export function ownsResmonLinks(executablePath: string): boolean {
  const program = executablePath.split(/[\\/]/).pop() ?? '';
  return program.replace(/\.exe$/i, '').toLowerCase() === RESMON_SCHEME;
}

/** The `resmon://` link a launch was given on its command line (Windows and Linux), or null. */
export function resmonLinkIn(argv: readonly string[]): string | null {
  return argv.find((arg) => arg.toLowerCase().startsWith(`${RESMON_SCHEME}:`)) ?? null;
}
