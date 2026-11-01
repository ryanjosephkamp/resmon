/**
 * The renderer's Content-Security-Policy, enforced rather than spelled.
 *
 * Atlas's policy is the `<meta>` tag in `atlas/index.html`. Read as text, it
 * says nothing about whether the tag is still in the document the app loads,
 * whether the bundler rewrote it, or whether Chromium parsed it at all: a
 * policy with a typo in a directive name is ignored silently by the browser
 * and would still satisfy a text assertion.
 *
 * This spec asks the real Electron renderer. The policy names no `frame-src`,
 * so a frame falls back to `default-src 'self'`, and the claim is that a frame
 * from somewhere else is stopped. So: inject a YouTube iframe into the live
 * document and assert that Chromium raised a `securitypolicyviolation` whose
 * effective directive is `frame-src`, and that no request to a YouTube host
 * left the app.
 *
 * Its mutation: add `frame-src https://www.youtube-nocookie.com` to the policy
 * in a scratch copy of `atlas/index.html`, rebuild, and this case goes red: no
 * violation event, and a request to the YouTube host in the log.
 */
import { test, expect } from './fixtures/resmon-app';

test.use({ ui: 'atlas' });

const BLOCKED_FRAME = 'https://www.youtube-nocookie.com/embed/x';

interface Violation { violatedDirective: string; effectiveDirective: string; blockedURI: string; }

test('the renderer CSP blocks a YouTube frame, in the real window', async ({ win, goto }) => {
  await goto('/today');

  // Requests are collected from the Electron page itself, so a frame load that
  // the policy failed to stop would appear here even if no event fired.
  const youtubeRequests: string[] = [];
  const collect = (url: string) => {
    if (/youtube(-nocookie)?\.com/.test(url)) youtubeRequests.push(url);
  };
  win.on('request', (req) => collect(req.url()));
  win.on('requestfailed', (req) => collect(req.url()));

  const violations = await win.evaluate(async (src) => {
    const seen: { violatedDirective: string; effectiveDirective: string; blockedURI: string }[] = [];
    const onViolation = (event: SecurityPolicyViolationEvent) => {
      seen.push({
        violatedDirective: event.violatedDirective, effectiveDirective: event.effectiveDirective, blockedURI: event.blockedURI,
      });
    };
    document.addEventListener('securitypolicyviolation', onViolation);
    const frame = document.createElement('iframe');
    frame.src = src;
    frame.style.display = 'none';
    document.body.appendChild(frame);
    // The violation event is dispatched asynchronously; a microtask is not
    // enough and a fixed sleep is what the platform gives us here.
    await new Promise((resolve) => setTimeout(resolve, 1500));
    frame.remove();
    document.removeEventListener('securitypolicyviolation', onViolation);
    return seen;
  }, BLOCKED_FRAME) as Violation[];

  const frameViolations = violations.filter((v) => v.effectiveDirective === 'frame-src');
  expect(
    frameViolations.length,
    `no frame-src violation was raised for ${BLOCKED_FRAME}; the policy did not stop it. ` +
    `Events seen: ${JSON.stringify(violations)}`,
  ).toBeGreaterThan(0);
  expect(frameViolations[0].blockedURI).toContain('youtube-nocookie.com');

  // Blocked before the network, not after: the point of the directive is that
  // the third party is never told the app exists.
  expect(youtubeRequests, 'a request reached a YouTube host despite the policy').toEqual([]);
});
