// @ts-check
import { defineConfig } from 'astro/config';

/**
 * The site is published by GitHub Pages from the repository's ``docs/`` folder,
 * under the project path ``/resmon/``. Both halves of that matter:
 *
 *   - ``site`` + ``base`` together produce the absolute URLs the in-app Blog
 *     tab checks against. ``BlogTab.tsx`` refuses any feed entry whose link
 *     does not start with ``https://ryanjosephkamp.github.io``, so a wrong
 *     ``site`` here does not merely look wrong, it empties the app's post list.
 *   - ``trailingSlash: 'always'`` plus ``build.format: 'directory'`` reproduce
 *     Jekyll's ``/:year/:month/:day/:title/`` permalinks as real directories
 *     with an ``index.html`` inside, which is what GitHub Pages serves for a
 *     URL ending in a slash. Every one of the 27 published post URLs depends
 *     on this pair.
 *
 * ``outDir`` is a staging directory, not ``../docs``. ``docs/api-contract/``
 * holds generated files that a Python test regenerates and diffs
 * (``verification_scripts/test_api_contract.py``), and Astro empties its
 * ``outDir`` on every build, which would delete them. ``scripts/sync-docs.mjs``
 * copies this staging directory into ``docs/`` while preserving the Markdown
 * and JSON sources that live there.
 */
export default defineConfig({
  site: 'https://ryanjosephkamp.github.io',
  base: '/resmon',
  trailingSlash: 'always',
  outDir: './dist',
  build: {
    format: 'directory',
    // Astro's default is ``_astro``. GitHub Pages serves underscore-prefixed
    // directories only when ``.nojekyll`` is present; we write that file, but
    // a name that does not depend on it is one less thing to get wrong.
    assets: 'static',
  },
  // Content pages ship no client JavaScript at all, so there is nothing to
  // prefetch and nothing to hydrate.
  prefetch: false,
  devToolbar: { enabled: false },
});
