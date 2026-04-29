# resmon blog (`docs/`)

This folder is the source for the public resmon blog, published by GitHub Pages
at <https://ryanjosephkamp.github.io/resmon/> (configurable in the GitHub repo
settings → **Pages** → **Source** = "Deploy from a branch", **Branch** = `main`,
**Folder** = `/docs`).

## Layout

- `_config.yml` — Jekyll site configuration. Uses the `minima` theme and
  enables the `jekyll-feed` and `jekyll-seo-tag` plugins.
- `Gemfile` — pins `github-pages` and the two plugins for local previews via
  `bundle exec jekyll serve`. GitHub Pages itself builds the site server-side
  without using this Gemfile.
- `index.md` — the blog's landing page (`/resmon/`).
- `_posts/` — one Markdown file per blog post, named
  `YYYY-MM-DD-<slug>.md` per Jekyll convention.

## Authoring an update post

For each release update, create a new file in `_posts/` named
`YYYY-MM-DD-update-<N>.md` with the front-matter:

```yaml
---
layout: post
title: "Update <N> — <one-line summary>"
date: YYYY-MM-DD
categories: updates
---
```

Then paste the body of the corresponding
`.ai/updates/update_<DATE>/update_<DATE>.md` document below the front-matter
block. Embed any GIFs by placing them in `docs/assets/` and referencing them
with a relative path:

```markdown
![Calendar timezone fix](/resmon/assets/update-3-calendar-fix.gif)
```

Commit and push to the `main` branch; GitHub Pages will rebuild the site
within about a minute. The next time a user opens the
**About resmon → Blog** tab in the app, the new post will appear in the
left-hand list.

## Local preview (optional)

```bash
cd docs
bundle install
bundle exec jekyll serve
```

The site will be served at <http://127.0.0.1:4000/resmon/>.

## Why GitHub Pages

Choosing GitHub Pages keeps the resmon project credential-free (per the
`resmon_rules.md` constitution): there is no third-party blogging platform to
authenticate against, no API key to store, and no separate deployment
pipeline. Posts are committed alongside the rest of the source tree.
