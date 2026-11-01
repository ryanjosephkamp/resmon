# `site/` — the source of the project site

An [Astro](https://astro.build) site, built to static HTML and committed into
[`../docs/`](../docs/), which GitHub Pages publishes at
<https://ryanjosephkamp.github.io/resmon/>.

```bash
npm install                 # first time only
npm run build               # astro build, then copy into ../docs
npm run verify              # check the result against the captured live site
npm run preview             # serve ../docs the way GitHub Pages serves it
npm run dev                 # Astro's dev server, for iterating
node scripts/check-tokens.mjs   # fail on any design value written outside tokens.css
```

`npm run build` is the one that matters: it runs `astro build` into `dist/` and then
`scripts/sync-docs.mjs`, which copies `dist/` into `../docs/`. Commit `../docs/` along with
whatever you changed here — the published site is the committed output, not a build step on a
runner.

## The constraint everything here is shaped by

**The app fetches this site's feed.** `resmon_scripts/frontend/src/components/AboutResmon/BlogTab.tsx`
does a public `GET` of `https://ryanjosephkamp.github.io/resmon/feed.xml` every time a user
opens **About resmon → Blog**, parses it with `DOMParser`, and builds the post list from it. It
also loads the site's pages into an Electron `<webview>` that is locked to that origin.

So three things are fixed, and `scripts/verify-output.mjs` asserts all three against
`capture/`, which holds the live site exactly as it was served before any of this existed:

1. **`/feed.xml` is Atom, at that path.** Not a redirect — the app parses the bytes. Not RSS:
   the app collects `<entry>` elements, and an RSS feed's `<item>` elements would parse
   cleanly into an empty post list. The captured feed carried 10 entries because
   `jekyll-feed`'s default said so and nobody had overridden it; this one carries all 27,
   because the Blog tab has no pagination and a post outside the feed is a post the owner
   cannot open from inside the app. The verifier asserts both halves of that: every post in
   `docs/_posts` has an entry, **and** the captured 10 are still the first 10, in order, in
   every field the app reads.
2. **All 27 post permalinks resolve** at `/:year/:month/:day/:slug/`, with the day taken from
   the front-matter date in UTC. `src/lib/posts.ts` explains why that is not the file name's
   date for three of the 27.
3. **The five fields the app reads from each entry are unchanged** — `id`, `title`, `link`,
   `published` and the 240-character `summary`. The verifier runs the component's own
   `parseAtomFeed`, copied into it, over the old feed and the new one and diffs them.

`capture/` is not regenerable. It was taken before `docs/` was rebuilt, and a capture taken
afterwards would assert nothing.

## Layout

```
site/
├── astro.config.mjs          site + base + trailingSlash: the three that fix the URLs
├── capture/                  the live Jekyll site, as evidence
├── public/                   copied verbatim into the output (.nojekyll, favicon, media/)
├── scripts/
│   ├── sync-docs.mjs         copy dist/ into ../docs, preserving the sources there
│   ├── verify-output.mjs     the acceptance check against capture/
│   ├── check-tokens.mjs      no design values outside tokens.css
│   ├── serve-docs.mjs        serve ../docs as GitHub Pages would
│   ├── export_sources.py     write src/data/sources.json from the app's source catalog
│   └── split-readme.mjs      the one-shot README split, kept as its audit trail
└── src/
    ├── content.config.ts     four collections, three of them reading ../docs in place
    ├── content/guide/        the only content that lives here: the README, split up
    ├── data/                 sources.json (from the catalog) and run-record.json (a real run)
    ├── layouts/ components/  the page and document shells, the source listing's parts, the run record
    ├── lib/                  dates and permalinks, Markdown, URLs, document heads
    ├── pages/                routes, including feed.xml.ts
    └── styles/               tokens.css, then base.css built only from those tokens
```

**Most of the content is not in this directory.** The posts, the reference documents and the
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
| `@astrojs/markdown-remark` | Astro's own Markdown processor, depended on explicitly so `src/lib/markdown.ts` can render the post pages and the feed's `<content>` through one processor instead of two that could drift. |
| `@xmldom/xmldom` *(dev)* | A `DOMParser` for Node, so `verify-output.mjs` can run the app's own feed parser rather than an approximation of it. Not shipped. |
| `@fontsource/atkinson-hyperlegible-next`, `@fontsource/atkinson-hyperlegible-mono` *(dev)* | The site's two typefaces (SIL Open Font License), bundled into the build so pages fetch fonts from this site rather than a font CDN. |

Nothing is added to the application's runtime: this directory is a build-time tool and the
output is static files.
