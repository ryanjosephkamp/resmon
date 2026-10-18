/**
 * URL helpers.
 *
 * The site is served from ``/resmon/``, not from the root, and getting that
 * wrong is invisible in a local preview of a single page and obvious the moment
 * someone clicks a link on the published site. So nothing here writes a path by
 * hand: every internal href goes through ``url()``.
 */

/** ``/resmon`` — from ``astro.config.mjs``, with any trailing slash removed. */
export const BASE: string = import.meta.env.BASE_URL.replace(/\/$/, '');

/** The origin the in-app Blog tab locks its embedded reader to. */
export const SITE_ORIGIN = 'https://ryanjosephkamp.github.io';

/** ``/updates/`` -> ``/resmon/updates/``. Already-absolute URLs pass through. */
export function url(path: string): string {
  if (/^[a-z]+:/i.test(path) || path.startsWith('//')) return path;
  return `${BASE}${path.startsWith('/') ? '' : '/'}${path}`;
}

/** The absolute form, which the feed and the canonical link element need. */
export function absoluteUrl(path: string): string {
  return `${SITE_ORIGIN}${url(path)}`;
}

export const GITHUB_REPO = 'https://github.com/ryanjosephkamp/resmon';
export const GITHUB_RELEASES = `${GITHUB_REPO}/releases`;
