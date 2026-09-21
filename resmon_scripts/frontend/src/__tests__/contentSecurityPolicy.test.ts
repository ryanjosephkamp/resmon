/**
 * The renderer's Content-Security-Policy is pinned, directive by directive.
 *
 * The policy is authored once, in `src/index.html`, and webpack copies that
 * file through `HtmlWebpackPlugin` as the renderer's template — so the `<meta>`
 * below is what the packaged app actually enforces, not a copy of it.
 *
 * **Why an allowlist and not a smoke test.** A CSP only ever fails in one
 * direction that anybody notices: too tight, and a feature visibly breaks, so
 * somebody reports it within a day. Too loose, and nothing happens at all —
 * the app works, no console error, no failing test, and the renderer has
 * quietly been allowed to frame a third-party document for as long as anyone
 * cares to look. The YouTube origins sat in `frame-src` for a release after the
 * embeds that needed them were removed, exactly like that.
 *
 * So this test asserts the *exact* set of sources per directive rather than
 * checking that the sources a feature needs are present. Adding an origin fails
 * here until it is added below, with a comment saying which feature loads it and
 * why nothing local would do. That is the point: the failure is the review.
 *
 * Removing an origin fails here too, which is the cheaper half — it makes the
 * removal deliberate rather than a merge artefact.
 */

import * as fs from 'fs';
import * as path from 'path';

const INDEX_HTML = path.join(__dirname, '..', 'index.html');

/**
 * Every directive the policy carries, and every source in it.
 *
 * Order does not matter to the browser and does not matter here; the sets are
 * compared sorted. A directive absent from this map must be absent from the
 * policy, and vice versa.
 */
const EXPECTED: Record<string, string[]> = {
  // Everything the renderer loads on the happy path is bundled and served from
  // the local renderer origin. The directives below are the named exceptions.
  'default-src': ["'self'"],
  'worker-src': ["'self'"],
  'script-src': ["'self'"],
  // styled-components and the vendored calendar CSS emit inline <style> blocks.
  'style-src': ["'self'", "'unsafe-inline'"],
  // FullCalendar ships its icon font inline as a data: URL inside its own CSS;
  // without this the chevrons render as tofu. See the comment in index.html.
  'font-src': ["'self'", 'data:'],
  // The Python backend on loopback (its port is chosen at runtime), and the
  // GitHub Pages site the blog reads from.
  'connect-src': ['http://127.0.0.1:*', 'https://ryanjosephkamp.github.io'],
  // One framed origin: the blog <webview>. The tutorial videos are links that
  // open in the user's own browser, not embeds, so no YouTube origin belongs
  // in either directive.
  'frame-src': ['https://ryanjosephkamp.github.io'],
  'child-src': ['https://ryanjosephkamp.github.io'],
};

/** Origins that must not appear anywhere in the policy, with why. */
const FORBIDDEN = [
  // PR134 replaced the youtube-nocookie embeds with local posters and links.
  'https://www.youtube-nocookie.com',
  'https://www.youtube.com',
];

/**
 * Pull the policy text out of the authored `<meta http-equiv>`.
 *
 * Deliberately a regex over the file rather than a DOM parse: the assertion is
 * about the bytes that ship, and a parser that tolerated a malformed attribute
 * would hide the one failure mode — a policy the browser does not read at all.
 */
function readPolicy(): string {
  const html = fs.readFileSync(INDEX_HTML, 'utf8');
  const meta = html.match(
    /<meta\s+http-equiv="Content-Security-Policy"\s+content="([^"]*)"\s*\/>/,
  );
  if (!meta) {
    throw new Error(
      'No <meta http-equiv="Content-Security-Policy" content="..."> in src/index.html. ' +
        'If the policy moved (to a webpack template, or to a response header in ' +
        'electron/main.ts), point this test at its new home rather than deleting it.',
    );
  }
  return meta[1];
}

/** `"a b; c d;"` -> `{ a: ['b'], c: ['d'] }`, sources sorted. */
function parse(policy: string): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const clause of policy.split(';')) {
    const parts = clause.trim().split(/\s+/).filter(Boolean);
    if (parts.length === 0) continue;
    const [name, ...sources] = parts;
    out[name] = [...sources].sort();
  }
  return out;
}

describe('renderer Content-Security-Policy', () => {
  const policy = readPolicy();
  const actual = parse(policy);

  test('carries exactly the directives listed here', () => {
    expect(Object.keys(actual).sort()).toEqual(Object.keys(EXPECTED).sort());
  });

  test.each(Object.keys(EXPECTED))('%s allows exactly the expected sources', (directive) => {
    expect(actual[directive]).toEqual([...EXPECTED[directive]].sort());
  });

  test.each(FORBIDDEN)('%s appears in no directive', (origin) => {
    expect(policy).not.toContain(origin);
  });

  test('no directive falls back to a wildcard', () => {
    // `*` or a bare scheme in any directive would make the allowlist above
    // decorative; `data:` under font-src is the one accepted exception.
    for (const [directive, sources] of Object.entries(actual)) {
      for (const source of sources) {
        if (directive === 'font-src' && source === 'data:') continue;
        expect(source).not.toBe('*');
        expect(source).not.toMatch(/^(https?|data|blob|filesystem):$/);
      }
    }
  });
});
