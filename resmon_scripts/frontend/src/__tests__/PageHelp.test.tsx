/**
 * Page help defaults to collapsed.
 *
 * It used to open on first visit of every page, which meant help that
 * interrupted the thing it was helping with: a panel to scroll past or dismiss
 * once per page before you could see what you came for. The explicit choice is
 * still remembered per page, so opening it once keeps it open there.
 */

import React from 'react';
import { render, screen, fireEvent, act } from '@testing-library/react';
import PageHelp from '../components/Help/PageHelp';

const SECTIONS = [{ heading: 'What this page does', body: <p>Body text here.</p> }];

function renderHelp(storageKey = 'testpage') {
  return render(
    <PageHelp
      storageKey={storageKey}
      title="Test Page"
      summary="A one-line summary."
      sections={SECTIONS}
    />,
  );
}

describe('PageHelp', () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  test('is collapsed on first visit', () => {
    renderHelp();

    // The header is always present; the body is what should not be.
    expect(screen.getByText('Test Page')).toBeInTheDocument();
    expect(screen.queryByText('What this page does')).not.toBeInTheDocument();
  });

  test('opens when asked, and remembers that for the page', () => {
    const { unmount } = renderHelp('explorer');
    act(() => { fireEvent.click(screen.getByText('Test Page')); });
    expect(screen.getByText('What this page does')).toBeInTheDocument();

    unmount();
    renderHelp('explorer');
    expect(screen.getByText('What this page does')).toBeInTheDocument();
  });

  test('a page opened once does not open the others', () => {
    // The preference is per page, so opening the Explorer's help must not
    // re-expand every other page's.
    window.localStorage.setItem('resmon:pagehelp:explorer', 'open');
    renderHelp('analytics');

    expect(screen.queryByText('What this page does')).not.toBeInTheDocument();
  });

  test('a stored "closed" preference is still honoured', () => {
    window.localStorage.setItem('resmon:pagehelp:testpage', 'closed');
    renderHelp();

    expect(screen.queryByText('What this page does')).not.toBeInTheDocument();
  });
});
