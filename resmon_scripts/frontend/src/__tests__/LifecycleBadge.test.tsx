/**
 * Lifecycle badges — never assert, always link, never over-color.
 *
 * A false retraction flag is defamatory, so the interface has exactly one
 * defensible form of the claim: *the publisher registered this, here is the
 * notice, read it yourself*. These tests hold that shape.
 *
 * The second thing they hold is the severity discipline. A correction is normal
 * scholarly upkeep. If it renders like a retraction, users learn to ignore the
 * color — and then the retraction goes unread too, which is the exact failure
 * the feature exists to prevent.
 */

import React from 'react';
import { render, screen } from '@testing-library/react';
import LifecycleBadge, { LifecycleEvent } from '../components/Explain/LifecycleBadge';

const RETRACTION: LifecycleEvent = {
  kind: 'retraction',
  severity: 'critical',
  label: 'Retraction',
  notice_doi: '10.1016/s0140-6736(10)60175-4',
  notice_url: 'https://doi.org/10.1016/s0140-6736(10)60175-4',
  notice_date: '2010-02-06',
  detail: null,
  provider: 'crossref',
  provider_source: 'retraction-watch',
};

const CORRECTION: LifecycleEvent = {
  kind: 'correction',
  severity: 'informational',
  label: 'Correction',
  notice_doi: '10.1016/s0140-6736(04)15715-2',
  notice_url: 'https://doi.org/10.1016/s0140-6736(04)15715-2',
  notice_date: '2004-03-06',
  detail: null,
  provider: 'crossref',
  provider_source: 'retraction-watch',
};

const CONCERN: LifecycleEvent = {
  ...RETRACTION,
  kind: 'expression_of_concern',
  severity: 'caution',
  label: 'Expression of concern',
  provider_source: 'publisher',
};

const PUBLISHED: LifecycleEvent = {
  kind: 'preprint_published',
  severity: 'informational',
  label: 'Published in a journal',
  notice_doi: '10.1126/science.abb2507',
  notice_url: 'https://doi.org/10.1126/science.abb2507',
  notice_date: '2020-02-11',
  detail: 'Cite the published version where you can — it is the one that was peer reviewed.',
  provider: 'biorxiv',
  provider_source: null,
};

describe('LifecycleBadge', () => {
  test('the notice is always a link the reader can open', async () => {
    render(<LifecycleBadge events={[RETRACTION]} />);

    const link = screen.getByRole('link', { name: 'Retraction' });
    expect(link).toHaveAttribute('href', RETRACTION.notice_url);
    expect(link).toHaveAttribute('target', '_blank');
  });

  test("the publisher's own wording is used, not a paraphrase", () => {
    render(<LifecycleBadge events={[CONCERN]} />);

    // Not "Retracted", not "Warning" — what the publisher actually registered.
    expect(screen.getByRole('link', { name: 'Expression of concern' }))
      .toBeInTheDocument();
  });

  test('who registered the notice is shown', () => {
    render(<LifecycleBadge events={[RETRACTION]} />);
    expect(screen.getByText('via Retraction Watch')).toBeInTheDocument();
  });

  test('a publisher-registered concern is attributed to the publisher', () => {
    render(<LifecycleBadge events={[CONCERN]} />);
    expect(screen.getByText('registered by the publisher')).toBeInTheDocument();
  });

  test('a correction does not render like a retraction', () => {
    const { container } = render(<LifecycleBadge events={[CORRECTION]} />);

    expect(container.querySelector('.lifecycle-critical')).toBeNull();
    expect(container.querySelector('.lifecycle-informational')).not.toBeNull();
    expect(screen.getByText('Changed since you found it')).toBeInTheDocument();
  });

  test('a concern is graded between the two, never as a withdrawal', () => {
    const { container } = render(<LifecycleBadge events={[CONCERN]} />);

    expect(container.querySelector('.lifecycle-critical')).toBeNull();
    expect(container.querySelector('.lifecycle-caution')).not.toBeNull();
    expect(screen.getByText('Concern registered')).toBeInTheDocument();
  });

  test('two updates of different severity on one paper are not flattened', () => {
    const { container } = render(
      <LifecycleBadge events={[RETRACTION, CORRECTION]} />,
    );

    expect(container.querySelectorAll('.lifecycle-critical')).toHaveLength(1);
    expect(container.querySelectorAll('.lifecycle-informational')).toHaveLength(1);
  });

  test('a preprint reaching a journal points at the published article', () => {
    render(<LifecycleBadge events={[PUBLISHED]} />);

    expect(screen.getByRole('link', { name: 'Published in a journal' }))
      .toHaveAttribute('href', 'https://doi.org/10.1126/science.abb2507');
    expect(screen.getByText(/peer reviewed/)).toBeInTheDocument();
  });

  test('a paper with nothing recorded renders nothing at all', () => {
    // In a dense result list, "nothing to report" is best said with silence.
    const { container } = render(
      <LifecycleBadge events={[]} checkedAt="2026-08-20T10:00:00Z" />,
    );
    expect(container.firstChild).toBeNull();
  });

  test('an unchecked paper can say so rather than implying it is clean', () => {
    // Silence is ambiguous: "nothing happened" and "nobody looked" are
    // different, and where there is room the second should be said.
    render(<LifecycleBadge events={[]} checkedAt={null} showUnchecked />);

    expect(screen.getByText(/Not yet checked/)).toBeInTheDocument();
  });

  test('a checked paper with nothing recorded stays silent even when asked', () => {
    const { container } = render(
      <LifecycleBadge events={[]} checkedAt="2026-08-20T10:00:00Z" showUnchecked />,
    );
    expect(container.firstChild).toBeNull();
  });
});
