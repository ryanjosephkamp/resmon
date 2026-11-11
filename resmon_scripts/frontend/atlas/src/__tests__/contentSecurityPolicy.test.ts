/**
 * Atlas's Content-Security-Policy, pinned directive by directive.
 *
 * The policy is the `<meta>` in `atlas/index.html`, which Vite copies into
 * the page the app loads. A CSP only fails in one direction anybody notices:
 * too tight, and something visibly breaks. Too loose breaks nothing, so a
 * directive widened for a moment stays widened unless a test holds the whole
 * list. This holds it: every directive, every source, and nothing unsafe.
 * Whether Chromium enforces it in the real window is
 * `e2e/renderer-csp.spec.ts`'s.
 */
import * as fs from 'fs';
import * as path from 'path';

const PAGE = path.join(__dirname, '..', '..', 'index.html');

function policy(): Record<string, string[]> {
  const html = fs.readFileSync(PAGE, 'utf8');
  const meta = /<meta\s+http-equiv="Content-Security-Policy"\s+content="([^"]+)"/.exec(html);
  if (!meta) throw new Error('atlas/index.html has no Content-Security-Policy meta tag');
  return Object.fromEntries(meta[1].split(';').map((part) => part.trim()).filter(Boolean).map((part) => {
    const [directive, ...sources] = part.split(/\s+/);
    return [directive, sources];
  }));
}

test('every directive and source is the one written here', () => {
  expect(policy()).toEqual({
    'default-src': ["'self'"],
    'script-src': ["'self'"],
    'worker-src': ["'self'"],
    'style-src': ["'self'"],
    'font-src': ["'self'"],
    'img-src': ["'self'", 'data:'],
    'connect-src': ['http://127.0.0.1:*'],
    'object-src': ["'none'"],
    'base-uri': ["'none'"],
    'form-action': ["'none'"],
  });
});

test('nothing unsafe, and no frame from anywhere', () => {
  const all = Object.values(policy()).flat();
  expect(all.filter((source) => source.startsWith("'unsafe-"))).toEqual([]);
  expect(policy()['frame-src']).toBeUndefined();
});
