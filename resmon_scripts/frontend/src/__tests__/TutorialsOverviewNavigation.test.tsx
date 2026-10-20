/**
 * The in-app overview has to describe this application.
 *
 * "Full App Overview" is the first thing a reader opens, and its first
 * instruction tells them what the sidebar contains. It told them to "use the
 * ten top-level pages" and named ten, while the installed sidebar carried
 * nineteen — Explorer, Library, Evidence, Watch Profiles and five more had
 * arrived since somebody typed the sentence, and nothing compared the two.
 *
 * The denominator here is `NAV_ITEMS`, imported rather than written down, so
 * these assertions move with the sidebar instead of becoming the next stale
 * number. A page added to the sidebar and left out of the overview fails this
 * file; so does a page removed from the sidebar and left in the prose.
 *
 * What this file does *not* assert is that the overview is well written. It
 * asserts that it is true.
 */

import React from 'react';
import { render } from '@testing-library/react';
import '@testing-library/jest-dom';
import { MemoryRouter } from 'react-router-dom';
import TutorialsTab, { sections } from '../components/AboutResmon/TutorialsTab';
import { NAV_ITEMS } from '../components/Layout/navItems';

/** The overview section's instruction list, as the component holds it. */
function overviewInstructions(): string[] {
  const overview = sections.find((s) => s.anchor === 'full-app');
  if (!overview) throw new Error('No full-app overview section');
  return overview.instructions;
}

/** Everything the overview's instructions say, as one rendered string. */
function renderedOverviewText(): string {
  render(
    <MemoryRouter initialEntries={['/about-resmon/tutorials']}>
      <TutorialsTab />
    </MemoryRouter>,
  );
  // By id rather than by heading text: the heading text also appears in the
  // table of contents at the top of the tab, and matching that instead would
  // read a link label while claiming to read the section.
  const panel = document.getElementById('tutorial-full-app');
  if (!panel) throw new Error('No rendered section for the full-app overview');
  return (panel.textContent ?? '').replace(/\s+/g, ' ');
}

describe('Full App Overview — the navigation it describes is the one that ships', () => {
  test('the sidebar list is non-trivial, so the assertions below mean something', () => {
    // A guard on the guard: an empty NAV_ITEMS would make "every destination
    // is named" vacuously true.
    expect(NAV_ITEMS.length).toBeGreaterThan(10);
    expect(new Set(NAV_ITEMS.map((i) => i.label)).size).toBe(NAV_ITEMS.length);
  });

  test('names every sidebar destination, and none that is not one', () => {
    const text = renderedOverviewText();
    const missing = NAV_ITEMS.map((i) => i.label).filter((label) => !text.includes(label));
    expect(missing).toEqual([]);
  });

  test('the count it states is the number of destinations there are', () => {
    const instruction = overviewInstructions().find((line) => line.includes('left sidebar'));
    expect(instruction).toBeDefined();
    expect(instruction).toContain(`${NAV_ITEMS.length} top-level pages`);
    // The word form is how the sentence went stale the first time: "ten"
    // could not be checked against anything, so nothing checked it.
    expect(instruction).not.toMatch(/\b(ten|eleven|twelve|nineteen|twenty)\b/i);
  });

  test('the enumeration is in sidebar order', () => {
    const instruction = overviewInstructions().find((line) => line.includes('left sidebar')) ?? '';
    const positions = NAV_ITEMS.map((i) => instruction.indexOf(i.label));
    expect(positions.every((p) => p >= 0)).toBe(true);
    expect([...positions].sort((a, b) => a - b)).toEqual(positions);
  });
});
