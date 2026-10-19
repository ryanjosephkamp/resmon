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
import { render, screen, waitFor } from '@testing-library/react';
import { readFileSync } from 'fs';
import { join } from 'path';

import BlogTab from '../components/AboutResmon/BlogTab';

/** `resmon_scripts/frontend/src/__tests__` -> the repository root. */
const REPO_ROOT = join(__dirname, '..', '..', '..', '..');
const PUBLISHED_FEED = join(REPO_ROOT, 'docs', 'feed.xml');

const publishedFeed = (): string => readFileSync(PUBLISHED_FEED, 'utf8');

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

describe('BlogTab, against the published feed', () => {
  afterEach(() => {
    delete (global as unknown as { fetch?: unknown }).fetch;
  });

  it('renders one row per entry in docs/feed.xml, however many there are', async () => {
    const xml = publishedFeed();
    const entriesInFile = (xml.match(/<entry[\s>]/g) ?? []).length;
    expect(entriesInFile).toBeGreaterThan(0);

    serveFeed(xml);
    const rows = await renderedRows();

    // Counted out of the file, not written down here: the published feed has
    // carried 10 entries and is about to carry 27, and neither number is the
    // property. "None of them is dropped" is.
    expect(rows).toHaveLength(entriesInFile);
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
    expect(stub.mock.calls[0][0]).toBe('https://ryanjosephkamp.github.io/resmon/feed.xml');
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
