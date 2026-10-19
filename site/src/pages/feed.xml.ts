import type { APIRoute } from 'astro';
import { getCollection } from 'astro:content';
import { renderMarkdown } from '../lib/markdown';
import { postPath, xmlSchemaUtc, byDateDescending } from '../lib/posts';
import { absoluteUrl } from '../lib/urls';

/**
 * The Atom feed, at `/resmon/feed.xml`.
 *
 * This file is a shipped interface, not a nicety. `docs/_config.yml` said so in
 * as many words — "the in-app Blog tab fetches and parses this file on every
 * tab open" — and `BlogTab.tsx` is the consumer. It reads, per `<entry>`:
 *
 *   - the first `<title>`                      -> the post list's row label
 *   - a `<link>` with `rel="alternate"`        -> the `<webview>` src and the
 *     (or no rel at all), its `href`              "Open in browser" target.
 *                                                 **An href that does not start
 *                                                 with `https://ryanjosephkamp.github.io`
 *                                                 is dropped from the list.**
 *   - `<id>`, falling back to the href         -> the row's stable identity
 *   - `<published>`, falling back to `<updated>` -> the date, and the sort order
 *   - `<summary>`, falling back to `<content>` -> the preview, tags stripped,
 *                                                 whitespace collapsed, first
 *                                                 240 characters
 *
 * It reads nothing else. It does not read the feed-level elements, the author,
 * or the category. It parses with `DOMParser(..., 'application/xml')` and
 * returns an empty list if the document reports a parse error, and it collects
 * `entry` elements by tag name — so the feed must stay **Atom**. An RSS 2.0
 * feed, whose items are `<item>`, would parse without error and produce an
 * empty post list: the tab would look like a blog with no posts rather than
 * like something broken.
 *
 * Everything below is therefore shaped to match what the old `jekyll-feed`
 * output contained, element for element, including the two details that are
 * easy to get wrong:
 *
 *   - `<id>` has **no** trailing slash while `<link href>` has one. That was
 *     Jekyll's doing, and the id is the app's stable key; changing it would
 *     make all 10 entries look new to anything that had seen the feed before.
 *   - `<summary>` is the post's first block, rendered then stripped of tags —
 *     not the whole post. Because the app prefers `<summary>`, dropping it
 *     would silently change every preview line in the app's post list.
 *
 * The one element that no longer matches is the entry count, and that is the
 * subject of FEED_LIMIT below.
 */

/**
 * How many posts the feed carries. Every one of them.
 *
 * `jekyll-feed` publishes the 10 most recent posts unless `feed.posts_limit`
 * says otherwise, and the old `_config.yml` never said otherwise. Nobody chose
 * 10; it was a plugin default nobody had read. The consequence was that the
 * in-app Blog tab — which has no pagination and no other way to reach a post —
 * listed 10 of the updates and silently withheld the rest. The Astro migration
 * held the number at 10 on purpose, so that a change claiming to preserve the
 * feed did not also alter it; this is that change, made on its own.
 *
 * There is no cap now rather than a larger one, because any cap is the same
 * bug with a bigger number: the app's post list is the whole feed, so a post
 * outside the limit is a post the owner cannot open from inside the app.
 *
 * The cost is size. The app fetches this file on every open of **About resmon
 * -> Blog**, and each entry carries the post's full rendered HTML in
 * `<content>`. Measured on the 27 posts as they stand, that is roughly a
 * quarter of a megabyte against the 10-entry feed's 91 KB — one uncompressed
 * fetch of a static file from GitHub Pages, which serves it gzipped. It is
 * worth re-reading if the post count grows by an order of magnitude; the lever
 * to reach for then is dropping `<content>` from older entries, not a limit,
 * because `<summary>` is what the app's list actually displays.
 */
const FEED_LIMIT = Number.POSITIVE_INFINITY;

/** From the old `_config.yml`, verbatim. */
const FEED_TITLE = 'resmon';
const FEED_SUBTITLE =
  'Updates, release notes, and announcements for the resmon research-monitoring app.';
const FEED_AUTHOR = 'Ryan Kamp';

/** Escape for an XML text node or a double-quoted attribute value. */
function xmlEscape(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/**
 * Put arbitrary HTML inside a CDATA section.
 *
 * A literal `]]>` in the content would close the section early and leave the
 * rest of the feed as malformed XML — and a malformed feed does not degrade in
 * the app, it empties the post list, because `parseAtomFeed` returns `[]` the
 * moment `DOMParser` reports an error. Splitting the sequence across two
 * sections keeps the bytes the reader sees identical.
 */
function cdata(value: string): string {
  return `<![CDATA[${value.split(']]>').join(']]]]><![CDATA[>')}]]>`;
}

/** The feed's preview text: the first block of the post, rendered then flattened. */
function stripHtml(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<[^>]+>/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function categoriesOf(value: string | string[] | undefined): string[] {
  if (!value) return [];
  return Array.isArray(value) ? value : [value];
}

export const GET: APIRoute = async () => {
  const posts = (await getCollection('posts')).sort(byDateDescending).slice(0, FEED_LIMIT);

  const entries: string[] = [];
  for (const post of posts) {
    const body = post.body ?? '';
    const path = postPath(post.id, post.data.date);
    const href = absoluteUrl(path);
    // Jekyll's `post.id` is the permalink without its trailing slash, and the
    // feed's `<id>` was built from that. Reproduced exactly.
    const id = href.replace(/\/$/, '');
    const stamp = xmlSchemaUtc(post.data.date);
    const title = xmlEscape(post.data.title);

    // The whole post, from the same processor the post page uses.
    const { html } = await renderMarkdown(body, { from: 'docs/_posts' });

    // The excerpt: everything up to the first blank line, which is what Jekyll's
    // default `excerpt_separator` of "\n\n" produced.
    const firstBlock = body.replace(/^\s+/, '').split(/\n\s*\n/, 1)[0] ?? '';
    const { html: excerptHtml } = await renderMarkdown(firstBlock, { from: 'docs/_posts' });
    const summary = stripHtml(excerptHtml);

    const categoryElements = categoriesOf(post.data.categories)
      .map((term) => `<category term="${xmlEscape(term)}" />`)
      .join('');

    entries.push(
      `<entry>` +
        `<title type="html">${title}</title>` +
        `<link href="${xmlEscape(href)}" rel="alternate" type="text/html" title="${title}" />` +
        `<published>${stamp}</published>` +
        `<updated>${stamp}</updated>` +
        `<id>${xmlEscape(id)}</id>` +
        `<content type="html" xml:base="${xmlEscape(href)}">${cdata(html)}</content>` +
        `<author><name>${xmlEscape(FEED_AUTHOR)}</name></author>` +
        categoryElements +
        (summary ? `<summary type="html">${cdata(summary)}</summary>` : '') +
        `</entry>`,
    );
  }

  /*
   * The feed-level `<updated>` is the newest post's timestamp, where Jekyll
   * wrote the build time. That is the one deliberate change to a feed element:
   * a build clock makes every rebuild produce a different file, so the feed
   * showed up as a diff in every commit and the bytes could never be compared
   * between two builds. Nothing reads this element — not the app, and not the
   * Atom conformance rules beyond requiring it to be present and well formed.
   */
  const newest = posts[0] ? xmlSchemaUtc(posts[0].data.date) : xmlSchemaUtc(new Date(0));

  const xml =
    `<?xml version="1.0" encoding="utf-8"?>` +
    `<feed xmlns="http://www.w3.org/2005/Atom">` +
    `<generator uri="https://astro.build/">Astro</generator>` +
    `<link href="${xmlEscape(absoluteUrl('/feed.xml'))}" rel="self" type="application/atom+xml" />` +
    `<link href="${xmlEscape(absoluteUrl('/'))}" rel="alternate" type="text/html" />` +
    `<updated>${newest}</updated>` +
    `<id>${xmlEscape(absoluteUrl('/feed.xml'))}</id>` +
    `<title type="html">${xmlEscape(FEED_TITLE)}</title>` +
    `<subtitle>${xmlEscape(FEED_SUBTITLE)}</subtitle>` +
    `<author><name>${xmlEscape(FEED_AUTHOR)}</name></author>` +
    entries.join('') +
    `</feed>`;

  return new Response(xml, {
    headers: { 'Content-Type': 'application/xml; charset=utf-8' },
  });
};
