# What this folder is

The surface of the Jekyll site as it was served, captured from
`https://ryanjosephkamp.github.io/resmon/` on October 18, 2026, before anything in
`docs/` was changed. Once `docs/` was rebuilt the old output was gone, so this is the
only record of what the site used to serve, and it is the thing the new output is
checked against.

| File | What it is |
|---|---|
| `jekyll-feed.xml` | `GET /resmon/feed.xml`, byte for byte as GitHub Pages served it. 97,035 bytes, 10 `<entry>` elements. |
| `jekyll-urls.txt` | Every path under `/resmon/` that the live index page linked to, 54 of them, plus `/resmon/api-contract/openapi.json`, which the index did not link but which the site served and the repository's own documents point at. 55 paths; each returned HTTP 200 at capture time. |

`scripts/verify-output.mjs` reads both and compares them against the built site. It is
not a smoke test: for the feed it runs the app's own parsing function — copied out of
resmon 2.3's `BlogTab.tsx` — over the old feed and
the new one, and diffs the five fields the app actually reads, entry by entry.

Do not regenerate these files. A capture taken after the change would be a capture of the
change, and would assert nothing.
