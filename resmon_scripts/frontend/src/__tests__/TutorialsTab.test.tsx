/**
 * The Tutorials tab embeds nothing, and every video it used to embed is still
 * reachable.
 *
 * Both halves matter and neither implies the other. Deleting the iframes is
 * easy to verify and easy to over-claim: a tab with no frames and no links
 * would pass "no iframe" while quietly losing seventeen walk-throughs. So the
 * second test counts the links against the same array the component renders
 * from, and the third checks the playlist URL is that array in order rather
 * than a string somebody typed once and stopped maintaining.
 *
 * The denominator throughout is `sections` — imported, not written here — so
 * a video added to or removed from the tab moves these assertions with it.
 */

import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import '@testing-library/jest-dom';
import { MemoryRouter } from 'react-router-dom';
import TutorialsTab, { sections, playlistUrl, watchUrl } from '../components/AboutResmon/TutorialsTab';

const withVideo = sections.filter((s) => s.youtubeId);
const withoutVideo = sections.filter((s) => !s.youtubeId);

function renderTab(): HTMLElement {
  const { container } = render(
    <MemoryRouter initialEntries={['/about-resmon/tutorials']}>
      <TutorialsTab />
    </MemoryRouter>,
  );
  return container;
}

describe('Tutorials tab', () => {
  test('the section list is non-trivial on both sides', () => {
    // A guard on the guard: if `sections` ever came back empty, "zero iframes"
    // and "every link present" would both pass against nothing at all.
    expect(sections.length).toBeGreaterThan(20);
    expect(withVideo.length).toBeGreaterThan(10);
    expect(withoutVideo.length).toBeGreaterThan(0);
  });

  test('renders no iframe for any section', () => {
    const container = renderTab();
    expect(container.querySelectorAll('iframe')).toHaveLength(0);
    // Named explicitly as well, because the embeds were `youtube-nocookie.com`
    // and a future <object>/<embed> would be the same mistake in a new tag.
    expect(container.querySelectorAll('object, embed, webview')).toHaveLength(0);
    expect(container.innerHTML).not.toContain('youtube-nocookie');
  });

  test('every section with a video has a link to it, and no section without one does', () => {
    const container = renderTab();
    const hrefs = [...container.querySelectorAll('a[href]')].map((a) => a.getAttribute('href'));

    // The complete set of external links: one per video, plus the playlist.
    expect(hrefs.sort()).toEqual(
      [...withVideo.map((s) => watchUrl(s.youtubeId as string)), playlistUrl()].sort(),
    );
    expect(hrefs).toHaveLength(withVideo.length + 1);

    for (const s of withVideo) {
      expect(screen.getByTestId(`tutorial-watch-${s.anchor}`))
        .toHaveAttribute('href', watchUrl(s.youtubeId as string));
    }
    for (const s of withoutVideo) {
      expect(screen.queryByTestId(`tutorial-watch-${s.anchor}`)).toBeNull();
      // The placeholder card and its caption stay, so a deep link to a section
      // whose video is not recorded yet still lands on something that says so.
      expect(screen.getByLabelText(s.mediaCaption)).toBeInTheDocument();
    }
  });

  test('the playlist link carries every video id, in section order', () => {
    renderTab();
    const link = screen.getByTestId('tutorial-playlist-link');
    const href = link.getAttribute('href') ?? '';
    expect(link).toHaveTextContent('Watch the walkthroughs on YouTube');
    expect(href).toBe(
      `https://www.youtube.com/watch_videos?video_ids=${
        withVideo.map((s) => s.youtubeId).join(',')}`,
    );
    // Order, spelled out separately: `join` would also pass if the array were
    // reversed and the expectation built from the same reversed array.
    const ids = href.split('video_ids=')[1].split(',');
    expect(ids).toEqual(sections.map((s) => s.youtubeId).filter(Boolean));
    expect(ids).toHaveLength(withVideo.length);
  });

  test('a click is handed to the shell bridge, not to the window', () => {
    const openPath = jest.fn(async () => '');
    window.resmonAPI = {
      getBackendPort: () => '12345',
      platform: 'test',
      versions: { node: 'test', electron: 'test' },
      openPath,
    };
    const openSpy = jest.spyOn(window, 'open').mockImplementation(() => null);
    try {
      renderTab();
      const event = new MouseEvent('click', { bubbles: true, cancelable: true });
      const link = screen.getByTestId('tutorial-playlist-link');
      fireEvent(link, event);
      expect(openPath).toHaveBeenCalledWith(playlistUrl());
      // The anchor's own navigation is suppressed once the bridge has it, and
      // the renderer never opens a window itself.
      expect(event.defaultPrevented).toBe(true);
      expect(openSpy).not.toHaveBeenCalled();

      const first = withVideo[0];
      fireEvent.click(screen.getByTestId(`tutorial-watch-${first.anchor}`));
      expect(openPath).toHaveBeenCalledWith(watchUrl(first.youtubeId as string));
    } finally {
      openSpy.mockRestore();
      delete window.resmonAPI;
    }
  });

  test('without the bridge the anchor keeps its own href rather than dying silently', () => {
    delete window.resmonAPI;
    const openSpy = jest.spyOn(window, 'open').mockImplementation(() => null);
    try {
      renderTab();
      const event = new MouseEvent('click', { bubbles: true, cancelable: true });
      fireEvent(screen.getByTestId('tutorial-playlist-link'), event);
      expect(event.defaultPrevented).toBe(false);
      expect(openSpy).not.toHaveBeenCalled();
    } finally {
      openSpy.mockRestore();
    }
  });
});
