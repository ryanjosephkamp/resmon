/**
 * The Blog tab against the feed this repository actually publishes.
 *
 * `BlogTab.tsx` fetches `https://ryanjosephkamp.github.io/resmon/feed.xml` on
 * every tab open and builds its post list from it. That list is the only way
 * to reach a post from inside the app: there is no pagination, no search and
 * no second route. So the feed is a shipped interface between two things that
 * are versioned separately — `site/` builds it, the renderer consumes it — and
 * until now nothing exercised the consuming half.
 *
 * The site has its own check (`site/scripts/verify-output.mjs`), but it works
 * by running a *copy* of `parseAtomFeed` pinned by hash. A copy pinned by hash
 * proves the copy has not drifted. It does not prove the component renders
 * what the copy parses, and the gap between those two is where a feed change
 * would land: a feed the parser reads correctly and the component then shows
 * ten of.
 *
 * These cases use `docs/feed.xml` from the repository rather than a fixture.
 * A fixture would be a feed written to pass, and the question is whether the
 * published one works. Nothing here hard-codes how many posts there are — the
 * expectation is counted out of the file — so this stays true as posts are
 * added and goes red if the component ever starts dropping entries.
 */
import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { readFileSync } from 'fs';
import { join } from 'path';

import BlogTab from '../components/AboutResmon/BlogTab';

/** `resmon_scripts/frontend/src/__tests__` -> the repository root. */
const REPO_ROOT = join(__dirname, '..', '..', '..', '..');
const PUBLISHED_FEED = join(REPO_ROOT, 'docs', 'feed.xml');

/** The origin BlogTab.tsx locks its reader to. */
const BLOG_ORIGIN = 'https://ryanjosephkamp.github.io';

const publishedFeed = (): string => readFileSync(PUBLISHED_FEED, 'utf8');

/**
 * Everything from the first `<entry>` on.
 *
 * The feed carries a `<title>` and a `rel="alternate"` `<link>` of its own
 * before the first entry, and both look exactly like an entry's. Reading from
 * the whole document picks the feed-level ones up as if they were a post's,
 * which is how the origin-lock case below first passed while rewriting
 * nothing a reader would ever click.
 */
const entriesSection = (xml: string): string => xml.slice(xml.indexOf('<entry>'));

/** Undo the five escapes the feed writes, so a title compares as it renders. */
const unescapeXml = (value: string): string =>
  value
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');

/** Each entry's title, in document order, read out of the feed. */
const entryTitles = (xml: string): string[] =>
  Array.from(entriesSection(xml).matchAll(/<title type="html">([^<]*)<\/title>/g)).map((match) =>
    unescapeXml(match[1]),
  );

/**
 * Each entry's preview text, as the component will render it.
 *
 * `parseAtomFeed` takes `<summary>`'s text, strips tags, collapses whitespace,
 * trims and cuts at 240 characters. Reproduced here from the feed's bytes so
 * that the length of the cut is asserted rather than assumed: a component that
 * cut at 24 instead renders a plausible-looking list of shortened previews and
 * is otherwise indistinguishable from a correct one.
 *
 * `cdata()` in `site/src/pages/feed.xml.ts` splits a literal `]]>` across two
 * sections, so the markers are removed rather than matched as a single pair.
 */
const entrySummaries = (xml: string): string[] =>
  Array.from(entriesSection(xml).matchAll(/<summary type="html">([\s\S]*?)<\/summary>/g)).map(
    (match) =>
      unescapeXml(match[1].split('<![CDATA[').join('').split(']]>').join(''))
        .replace(/<[^>]+>/g, '')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 240),
  );

/**
 * Each entry's `rel="alternate"` href, in document order, read out of the feed.
 *
 * This is the field that becomes the `<webview>` src, which is the whole
 * reason the origin lock exists.
 */
const entryHrefs = (xml: string): string[] =>
  Array.from(
    entriesSection(xml).matchAll(/<link href="([^"]+)" rel="alternate"/g),
  ).map((match) => unescapeXml(match[1]));

/** Serve `xml` to the component's one `fetch`, as GitHub Pages would. */
function serveFeed(xml: string): jest.Mock {
  const stub = jest.fn().mockResolvedValue({
    ok: true,
    status: 200,
    text: async () => xml,
  });
  (global as unknown as { fetch: unknown }).fetch = stub;
  return stub;
}

/** The post list, once the fetch has resolved and the component has rendered. */
async function renderedRows(): Promise<HTMLLIElement[]> {
  render(<BlogTab />);
  const list = await screen.findByLabelText('Blog posts');
  await waitFor(() => expect(list.querySelectorAll('li').length).toBeGreaterThan(0));
  return Array.from(list.querySelectorAll('li'));
}

/** What the embedded reader is currently pointed at. */
const readerSrc = (): string =>
  document.querySelector('webview')?.getAttribute('src') ?? '';

describe('BlogTab, against the published feed', () => {
  afterEach(() => {
    delete (global as unknown as { fetch?: unknown }).fetch;
  });

  it('renders one row per entry in docs/feed.xml, carrying the entry title', async () => {
    const xml = publishedFeed();

    /*
     * Counted with a regex over the bytes while the component counts with
     * `getElementsByTagName` over a parsed DOM. Two different routes to the
     * same number is the point: a regex cannot share a parsing mistake with a
     * DOM traversal, so agreement means something.
     *
     * The greater-than-zero line is load-bearing. The two routes can only go
     * blind together by both finding nothing — a feed that namespaced its
     * elements as `<atom:entry>` would be missed by this regex and by the
     * component's `getElementsByTagName('entry')` alike, and without this line
     * the case would pass vacuously at 0 === 0.
     *
     * The regex can also be wrong in the other direction, and that is the
     * direction to be wrong in: a post whose prose contains the literal
     * `<entry ` would be counted here and not by the DOM, failing red on a
     * feed that is fine. The feed has 11 CDATA sections and this blog does
     * write about its own feed machinery, so that is a real possibility
     * rather than a theoretical one. A confusing red is recoverable; a green
     * that means nothing is not.
     */
    const entriesInFile = (xml.match(/<entry[\s>]/g) ?? []).length;
    expect(entriesInFile).toBeGreaterThan(0);

    serveFeed(xml);
    const rows = await renderedRows();

    // The published feed has carried 10 entries and is about to carry 27, and
    // neither number is the property. "None of them is dropped" is.
    expect(rows).toHaveLength(entriesInFile);

    /*
     * And one assertion about what is *in* a row, because the count and the
     * order together still pass for a component that renders every post as
     * "(untitled)" — `parseAtomFeed`'s fallback when a title is missing, and
     * what the whole list would read if the title lookup ever broke.
     */
    const titles = entryTitles(xml);
    expect(titles).toHaveLength(entriesInFile);
    expect(rows[0].textContent).toContain(titles[0]);

    /*
     * And the preview, at its full length. `.slice(0, 240)` is the one number
     * in `parseAtomFeed` that can be wrong by a lot and still look right: a
     * list of previews cut at 24 reads as a list of previews. The expected
     * text comes out of the feed through the same four steps the component
     * applies, so this asserts the cut rather than restating it.
     */
    const summaries = entrySummaries(xml);
    expect(summaries[0].length).toBeGreaterThan(24);
    expect(rows[0].textContent).toContain(summaries[0]);
  });

  it('puts the newest post first', async () => {
    serveFeed(publishedFeed());
    const rows = await renderedRows();

    const stamps = Array.from(publishedFeed().matchAll(/<published>([^<]+)<\/published>/g)).map(
      (match) => Date.parse(match[1]),
    );
    const newest = new Date(Math.max(...stamps));
    const expected = newest.toLocaleDateString(undefined, {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
    });

    expect(rows[0].textContent).toContain(expected);
  });

  it('fetches the feed once per mount, from the locked origin', async () => {
    const stub = serveFeed(publishedFeed());
    await renderedRows();

    expect(stub).toHaveBeenCalledTimes(1);
    expect(stub.mock.calls[0][0]).toBe(`${BLOG_ORIGIN}/resmon/feed.xml`);
  });

  it('opens each row at its own post, on the locked origin', async () => {
    /*
     * The field every other case here takes on trust.
     *
     * A row is a `<button>`, not an anchor: the link reaches the DOM only as
     * the `<webview>`'s `src`, after `handleSelect` has checked it against the
     * origin. So nothing about the rendered list says where a row goes, and a
     * component that parsed every entry with `link: ''` would render the right
     * number of rows, in the right order, with the right titles, and send a
     * reader nowhere when they clicked one. The count, the order and the title
     * cases all pass against exactly that.
     *
     * Asserting "every src is on the locked origin" would not catch it either,
     * and that is worth spelling out: `handleSelect` *refuses* a link off the
     * origin, so an empty link leaves the reader wherever it was — the blog
     * index, which is on the locked origin. The assertion has to be that each
     * click moves the reader to that row's own post.
     */
    const xml = publishedFeed();
    const hrefs = entryHrefs(xml);
    expect(hrefs.length).toBeGreaterThan(0);

    serveFeed(xml);
    const rows = await renderedRows();
    expect(rows).toHaveLength(hrefs.length);

    const indexUrl = `${BLOG_ORIGIN}/resmon/`;
    expect(readerSrc()).toBe(indexUrl);

    const opened: string[] = [];
    for (const row of rows) {
      const button = row.querySelector('button');
      expect(button).not.toBeNull();
      fireEvent.click(button as HTMLButtonElement);
      opened.push(readerSrc());
    }

    // Every post reachable, each at its own URL, and none of them the index
    // the reader started on — which is what an empty or refused link leaves.
    expect(new Set(opened)).toEqual(new Set(hrefs));
    expect(opened).not.toContain(indexUrl);
    for (const src of opened) expect(src.startsWith(BLOG_ORIGIN)).toBe(true);
  });

  it('drops an entry whose link leaves the locked origin', async () => {
    /*
     * The origin lock is a security property, not a formatting one: the href
     * from each entry becomes the `<webview>` src. An entry pointing somewhere
     * else has to disappear from the list rather than be rendered and refused
     * later. Built by rewriting one entry of the real feed, so the rest of the
     * document stays exactly as published.
     */
    const xml = publishedFeed();
    const entriesInFile = (xml.match(/<entry[\s>]/g) ?? []).length;

    // Inside the first `<entry>`, not the feed-level `<link rel="self">` that
    // precedes it — rewriting that one changes no row, which is how the first
    // draft of this case passed with 10 rows while claiming to have removed one.
    const firstEntryAt = xml.indexOf('<entry>');
    const head = xml.slice(0, firstEntryAt);
    const tail = xml
      .slice(firstEntryAt)
      .replace(/<link href="https:\/\/ryanjosephkamp\.github\.io/, '<link href="https://example.invalid');
    const hijacked = head + tail;
    expect(hijacked).not.toBe(xml);

    serveFeed(hijacked);
    const rows = await renderedRows();

    expect(rows).toHaveLength(entriesInFile - 1);
    expect(rows.map((row) => row.textContent).join(' ')).not.toContain('example.invalid');
  });

  it('shows an empty list, not a crash, when the feed is RSS instead of Atom', async () => {
    /*
     * The hazard `site/src/pages/feed.xml.ts` is written around. RSS parses
     * without error and has no `<entry>` elements, so the tab would look like
     * a blog with no posts rather than like something broken — which is why
     * the feed has to stay Atom and why this is pinned here as well as there.
     */
    serveFeed(
      '<?xml version="1.0"?><rss version="2.0"><channel><title>resmon</title>' +
        '<item><title>Update 26</title>' +
        '<link>https://ryanjosephkamp.github.io/resmon/2026/09/21/resmon-update-26/</link>' +
        '</item></channel></rss>',
    );

    render(<BlogTab />);
    const list = await screen.findByLabelText('Blog posts');
    await waitFor(() => expect(global.fetch).toHaveBeenCalled());
    expect(list.querySelectorAll('li')).toHaveLength(0);
  });

  it('reports an error rather than an empty blog when the fetch fails', async () => {
    (global as unknown as { fetch: unknown }).fetch = jest
      .fn()
      .mockResolvedValue({ ok: false, status: 503, text: async () => '' });

    render(<BlogTab />);
    expect(await screen.findByText(/503/)).toBeInTheDocument();
  });
});
