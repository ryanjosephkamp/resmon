import React from 'react';

/**
 * The card illustration for the Tutorials tab's "watch the whole set" link.
 *
 * Drawn here rather than fetched, and inline rather than imported as a file,
 * for three reasons that each came from something the embeds did wrong:
 *
 *   1. **No third-party request.** A YouTube poster image
 *      (``img.youtube.com/vi/<id>/…``) would put the request the embeds used
 *      to make straight back into the tab, and with it the cookie-less-but-
 *      still-logged fetch that the tab now exists to avoid. Nothing here
 *      leaves the app.
 *   2. **It follows the theme.** An ``asset/resource`` ``.svg`` is fetched as
 *      its own document and cannot read the page's custom properties, so it
 *      would be a light-mode rectangle sitting in a dark-mode panel. These
 *      shapes paint with ``var(--color-…)`` because they are part of the DOM.
 *   3. **It is testable.** Jest maps ``*.svg`` imports to a file stub, so a
 *      thumbnail behind an import is invisible to the renderer suite.
 *
 * Purely decorative: the card's heading and link carry the meaning, so this is
 * ``aria-hidden`` and the accessibility tree skips it.
 */
const TutorialsPlaylistThumbnail: React.FC = () => (
  <svg
    className="tutorial-playlist-thumb"
    viewBox="0 0 160 90"
    role="presentation"
    aria-hidden="true"
    focusable="false"
    data-testid="tutorial-playlist-thumbnail"
  >
    {/* Two offset cards behind the front one: the set, not a single video. */}
    <rect
      x="16" y="8" width="128" height="68" rx="6"
      fill="var(--color-surface)" stroke="var(--color-border)" strokeWidth="1"
      opacity="0.45"
    />
    <rect
      x="10" y="13" width="140" height="68" rx="6"
      fill="var(--color-surface)" stroke="var(--color-border)" strokeWidth="1"
      opacity="0.7"
    />
    <rect
      x="4" y="18" width="152" height="68" rx="6"
      fill="var(--color-bg)" stroke="var(--color-border)" strokeWidth="1"
    />
    {/* The play glyph, in the app's own accent rather than anyone's brand red. */}
    <circle cx="80" cy="52" r="17" fill="var(--color-accent)" opacity="0.14" />
    <circle
      cx="80" cy="52" r="17"
      fill="none" stroke="var(--color-accent)" strokeWidth="1.5"
    />
    <path d="M75 44.5 L89 52 L75 59.5 Z" fill="var(--color-accent)" />
  </svg>
);

export default TutorialsPlaylistThumbnail;
