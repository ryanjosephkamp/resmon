# `site/` — the source of the project site

An [Astro](https://astro.build) site, built to static HTML and committed into
[`../docs/`](../docs/), which GitHub Pages publishes at
<https://ryanjosephkamp.github.io/resmon/>.

```bash
npm install                 # first time only
npm run build               # astro build, then copy into ../docs
npm run verify              # check the built output in ../docs
npm run preview             # serve ../docs the way GitHub Pages serves it
npm run dev                 # Astro's dev server, for iterating
node scripts/check-tokens.mjs   # fail on any design value written outside tokens.css
```

`npm run build` is the one that matters: it runs `astro build` into `dist/` and then
`scripts/sync-docs.mjs`, which copies `dist/` into `../docs/`. Commit `../docs/` along with
whatever you changed here — the published site is the committed output, not a build step on a
runner.

## What `npm run verify` checks

It reads `../docs/`, the directory GitHub Pages serves, and fails on any of these:

- `.nojekyll` is missing, or Jekyll scaffolding is in the output.
- A page ships a `<script>` tag.
- An internal link, a link written inside a document, or an image points at something the site
  does not serve, at a raw source file, or at a GitHub `blob` page.
- A source document (a guide page, a reference document, an API contract page) has no published
  page, or its page carries less of its text than the source holds.
- A page does not have exactly one `<h1>`.

CI also runs `node scripts/check-tokens.mjs`, and rebuilds the site to check that `../docs/` is
what these sources build.

## Layout

```
site/
├── astro.config.mjs          site + base + trailingSlash: the three that fix the URLs
├── public/                   copied verbatim into the output (.nojekyll, favicon, media/)
├── scripts/
│   ├── sync-docs.mjs         copy dist/ into ../docs, preserving the sources there
│   ├── verify-output.mjs     the checks on the built output in ../docs
│   ├── check-tokens.mjs      no design values outside tokens.css
│   ├── serve-docs.mjs        serve ../docs as GitHub Pages would
│   └── export_sources.py     write src/data/sources.json from the app's source catalog
└── src/
    ├── content.config.ts     three collections, two of them reading ../docs in place
    ├── content/guide/        the guide, one page per topic: the only content that lives here
    ├── data/                 sources.json (from the catalog) and run-record.json (a real run)
    ├── layouts/ components/  the page and document shells, the source listing's parts, the run record
    ├── lib/                  Markdown, URLs, the source catalog, document heads
    ├── pages/                routes
    └── styles/               tokens.css, then base.css built only from those tokens
```

**Most of the reference content is not in this directory.** The reference documents and the
API contract are read from `../docs/` where they already live, because the README and a Python
test both point at those paths. One copy, no drift. `src/content.config.ts` has the
reasoning per collection.

## Styling

Every color, space, size and duration is a custom property in `src/styles/tokens.css`, and
`scripts/check-tokens.mjs` fails on a hex literal, a color function, an absolute length or a
duration written anywhere else. Light and dark are both written out, and the dark ramp is
rebuilt rather than inverted. There is no theme toggle: `prefers-color-scheme` decides, so
there is no state to persist and no script to ship.

The site is set as a listing: white paper, near-black ink, hairlines between entries, and a
heavier rule under each section head. One ultramarine, the app icon's, is kept for the Download
action and keyboard focus; links are ink with an offset underline. Source states are drawn by
shape, never told apart by color alone. The two typefaces, Atkinson Hyperlegible Next and
Atkinson Hyperlegible Mono, are bundled from `@fontsource` and served from this site. Replacing
the values in `tokens.css` should still be enough to reskin the site; if it ever is not, that is
the bug to fix.

**The home page's facts have sources.** `src/data/sources.json` is written by
`scripts/export_sources.py` from `repo_catalog.py`, and
`resmon_scripts/verification_scripts/test_site_sources.py` fails when the two differ.
`src/data/run-record.json` is the app's own `GET /api/coverage/source-wall` from a real session,
exported unedited; its `provenance` field is printed on the page. The tour in `public/media/` was
recorded from the same session.

Content pages ship no client JavaScript — the verifier asserts that too.

## Dependencies

| Package | Why |
|---|---|
| `astro` | The static site generator: routing, layouts, content collections, the build. |
| `@astrojs/markdown-remark` | Astro's own Markdown processor, depended on explicitly so `src/lib/markdown.ts` can render every page through one processor. |
| `@fontsource/atkinson-hyperlegible-next`, `@fontsource/atkinson-hyperlegible-mono` *(dev)* | The site's two typefaces (SIL Open Font License), bundled into the build so pages fetch fonts from this site rather than a font CDN. |

Nothing is added to the application's runtime: this directory is a build-time tool and the
output is static files.
