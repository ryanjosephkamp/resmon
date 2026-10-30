/**
 * @jest-environment ./jest.easternZoneEnvironment.js
 */

/*
 * West of Greenwich on purpose: a notice's date read as UTC midnight and
 * shown in local time lands on the day before, which is visibly wrong here.
 */
import { render } from '@testing-library/react';
import { LifecycleMarks } from '../LifecycleMarks';
import {
  SEVERITY_MEANING, SEVERITY_WORDS, chunks, countsWords, coverageSentences, findingsByPaper, lastRunLines,
  noticeDay, noticeLabel, paperState, provenanceWords, quietSentence,
  type LifecycleCoverage, type LifecycleEvent, type LifecycleFinding, type LifecycleRunResult,
} from '../model';

const NOW = new Date('2026-10-29T18:00:00Z');

function event(over: Partial<LifecycleEvent> = {}): LifecycleEvent {
  return {
    document_id: 7, kind: 'retraction', severity: 'critical', notice_key: '10.1/notice', label: 'Retraction',
    notice_doi: '10.1/notice', notice_url: 'https://doi.org/10.1/notice', notice_date: '2010-02-06', detail: null,
    provider: 'crossref', provider_source: 'retraction-watch', first_seen_at: '2026-10-29 12:00:00', ...over,
  };
}

function coverage(over: Partial<LifecycleCoverage> = {}): LifecycleCoverage {
  return {
    corpus: 10, checked: 0, no_identifier: 0, errored: 0, unchecked: 10, last_checked_at: null,
    recheck_after_days: 30, ...over,
  };
}

function run(over: Partial<LifecycleRunResult> = {}): LifecycleRunResult {
  return {
    checked_now: 0, outcomes: { ok: 0, no_identifier: 0, error: 0 }, remaining: 0, errors: [], unanswered: [],
    stopped: false, not_asked: 0, checked_at: '2026-10-29T17:30:00Z', ...over,
  };
}

describe('a notice, in the words of whoever registered it', () => {
  test('three severities, each with its own words, and a concern is said not to be a retraction', () => {
    expect(new Set(Object.values(SEVERITY_WORDS)).size).toBe(3);
    expect(SEVERITY_MEANING.caution).toMatch(/not a retraction/);
    expect(SEVERITY_MEANING.informational).toMatch(/not a warning/);
  });

  test('the label is the service\'s own, never reworded; the kind only when it gave none', () => {
    expect(noticeLabel(event({ label: 'Correction', kind: 'correction' }))).toBe('Correction');
    expect(noticeLabel(event({ label: null, kind: 'expression_of_concern' }))).toBe('expression_of_concern');
    expect(noticeLabel(event({ label: '  ', kind: 'withdrawal' }))).toBe('withdrawal');
  });

  test('who registered it, where Crossref says, else which service reported it', () => {
    expect(provenanceWords({ provider: 'crossref', provider_source: 'retraction-watch' })).toBe('via Retraction Watch');
    expect(provenanceWords({ provider: 'crossref', provider_source: 'publisher' })).toBe('registered by the publisher');
    expect(provenanceWords({ provider: 'crossref', provider_source: null })).toBe('via Crossref');
    expect(provenanceWords({ provider: 'biorxiv', provider_source: null })).toBe('via bioRxiv');
    expect(provenanceWords({ provider: 'arxiv', provider_source: null })).toBe('via arXiv');
    expect(provenanceWords({ provider: 'somewhere', provider_source: null })).toBeNull();
  });

  test('a notice\'s date is the day the service gave, in US words, in any time zone', () => {
    expect(noticeDay('2010-02-06')).toBe('February 6, 2010');
    expect(noticeDay('2020-03')).toBe('2020-03');
    expect(noticeDay(null)).toBeNull();
  });
});

describe('how much has been checked', () => {
  test('an empty collection has nothing to check', () => {
    expect(coverageSentences(coverage({ corpus: 0, unchecked: 0 }), NOW)).toEqual([
      'Your collection is empty, so there is nothing to check.',
    ]);
  });

  test('nothing checked says so, rather than anything about the papers', () => {
    expect(coverageSentences(coverage(), NOW)).toEqual(['None of your 10 papers has been checked yet.']);
  });

  test('every part of the collection is named, and none is folded into the checked', () => {
    const lines = coverageSentences(coverage({
      checked: 5, no_identifier: 1, errored: 2, unchecked: 2, last_checked_at: '2026-10-29 17:30:00',
    }), NOW);
    expect(lines).toEqual([
      '5 of your 10 papers have been checked.',
      '2 have not been asked about yet.',
      '1 carries no DOI and no arXiv version number, so there is nothing to ask about it.',
      '2 could not be checked: a service failed on them, and they are asked about again after 30 days.',
      'Last checked today at 1:30 PM. A paper is asked about again after 30 days.',
    ]);
  });
});

describe('the last check, in its own terms', () => {
  test('a check a service did not answer says which, for how many, and why, and never that nothing was found', () => {
    const { headline, lines } = lastRunLines(run({
      remaining: 3,
      unanswered: [{ service: 'crossref', name: 'Crossref', papers: 3, reason: 'Crossref answered HTTP 503' }],
    }), coverage(), NOW);
    expect(headline).toBe('The check today at 1:30 PM could not check a single paper.');
    expect(lines.map((l) => l.text)).toEqual([
      'Crossref did not answer for 3 papers (Crossref answered HTTP 503). They stay unchecked, not cleared, and are '
        + 'asked about again on the next check.',
      '3 papers are still waiting to be checked.',
    ]);
    expect([headline, ...lines.map((l) => l.text)].join(' ')).not.toMatch(/nothing (was )?(found|recorded|changed)|no paper due/i);
  });

  test('a stopped check says how many it checked and how many it never asked about', () => {
    const { headline, lines } = lastRunLines(run({
      stopped: true, checked_now: 1, outcomes: { ok: 1, no_identifier: 0, error: 0 }, not_asked: 1, remaining: 1,
    }), coverage(), NOW);
    expect(headline).toBe('Stopped today at 1:30 PM, with 1 paper checked.');
    expect(lines).toEqual([{ key: 'not-asked', text: '1 paper it had selected was not asked about, and stays unchecked.' }]);
  });

  test('a paper with nothing to ask about is never counted as checked', () => {
    const unaskable = run({
      checked_now: 1, outcomes: { ok: 0, no_identifier: 1, error: 0 },
      unanswered: [{ service: 'crossref', name: 'Crossref', papers: 2, reason: 'Server disconnected without sending a response.' }],
    });
    const { headline, lines } = lastRunLines(unaskable, coverage(), NOW);
    expect(headline).toBe('The check today at 1:30 PM could not check a single paper.');
    expect(lines[0]).toEqual({
      key: 'no-identifier',
      text: '1 paper carries no DOI and no arXiv version number, so there was nothing to ask about it; it is counted '
        + 'apart, never as clear.',
    });
    expect(lastRunLines(run({ checked_now: 2, outcomes: { ok: 0, no_identifier: 2, error: 0 } }), coverage(), NOW).headline)
      .toBe('The check today at 1:30 PM had nothing it could ask about.');
  });

  test('a check with nothing due says why, with the engine\'s own interval', () => {
    expect(lastRunLines(run(), coverage({ checked: 10, unchecked: 0, recheck_after_days: 30 }), NOW).headline)
      .toBe('The check today at 1:30 PM found no paper due: each has been asked about in the last 30 days, or carries nothing to ask about.');
    expect(lastRunLines(run(), coverage({ corpus: 0, unchecked: 0 }), NOW).headline)
      .toBe('The check today at 1:30 PM had nothing to check: your collection is empty.');
  });

  test('papers a service failed on part-way are named, with what went wrong', () => {
    const { headline, lines } = lastRunLines(run({
      checked_now: 4, outcomes: { ok: 2, no_identifier: 0, error: 2 },
      errors: [{ document_id: 3, title: 'A preprint', error: 'bioRxiv answered HTTP 500' }, { document_id: 9, title: null, error: null }],
    }), coverage(), NOW);
    expect(headline).toBe('Checked 2 papers today at 1:30 PM.');
    expect(lines.find((l) => l.key === 'errors')?.text).toBe(
      '2 papers could not be checked because a service failed on them part-way: “A preprint” (bioRxiv answered HTTP 500); '
        + 'paper 9 (no reason given).',
    );
  });
});

describe('what no findings means', () => {
  test('before anything is checked, an empty list says nothing about the papers', () => {
    expect(quietSentence({ sufficient: false, coverage: coverage() })).toMatch(/says nothing about your papers/);
  });

  test('after a partial check, the rest are said not to be cleared', () => {
    expect(quietSentence({ sufficient: true, coverage: coverage({ checked: 4, unchecked: 6 }) }))
      .toBe('Nothing has been recorded against the 4 papers checked. The other 6 have not been cleared, by this or anything else.');
    expect(quietSentence({ sufficient: true, coverage: coverage({ checked: 10, unchecked: 0 }) }))
      .toBe('Nothing has been recorded against the 10 papers checked.');
  });

  test('the notices, counted by severity', () => {
    expect(countsWords({ critical: 1, caution: 0, informational: 2 }))
      .toBe('3 notices: 1 withdrawn from the record, 2 changed since you found them');
  });
});

test('findings are grouped by paper, in the engine\'s order', () => {
  const finding = (id: number, kind: string, severity: LifecycleEvent['severity']): LifecycleFinding => ({
    ...event({ document_id: id, kind, severity, notice_key: `${id}:${kind}` }),
    title: `Paper ${id}`, document_doi: null, source_repository: 'crossref', document_url: null, publication_date: null,
  });
  const grouped = findingsByPaper([finding(2, 'retraction', 'critical'), finding(5, 'correction', 'informational'),
    finding(2, 'correction', 'informational')]);
  expect(grouped.map((p) => [p.documentId, p.events.map((e) => e.kind)])).toEqual([
    [2, ['retraction', 'correction']],
    [5, ['correction']],
  ]);
});

describe('one paper, with nothing recorded against it', () => {
  test('each way a check can end is said apart, and never checking is said too', () => {
    expect(paperState([], null, NOW)).toBe('Not yet checked for retractions or updates.');
    expect(paperState([], { checked_at: '2026-10-29 17:30:00', status: 'ok' }, NOW))
      .toMatch(/^Checked today at 1:30 PM: nothing recorded\./);
    expect(paperState([], { checked_at: '2026-10-29 17:30:00', status: 'no_identifier' }, NOW))
      .toMatch(/nothing to ask about it\. That is not a clean result\.$/);
    expect(paperState([], { checked_at: '2026-10-29 17:30:00', status: 'error' }, NOW))
      .toMatch(/could not be completed for this paper: a service failed on it\. It is asked about again after 30 days\.$/);
    expect(paperState([event()], null, NOW)).toBeNull();
  });
});

test('a long list is read in the engine\'s 500 at a time', () => {
  const ids = Array.from({ length: 1201 }, (_, i) => i + 1);
  expect(chunks(ids).map((c) => c.length)).toEqual([500, 500, 201]);
  expect(chunks([])).toEqual([]);
});

describe('the marks on a paper', () => {
  test('each notice is a link to itself, under its own label, the most serious first', () => {
    const { container } = render(<LifecycleMarks events={[
      event({ kind: 'correction', severity: 'informational', label: 'Correction', notice_key: 'c', notice_url: 'https://doi.org/10.1/c' }),
      event(),
    ]} />);
    const marks = [...container.querySelectorAll('.life-mark')];
    expect(marks.map((m) => m.getAttribute('data-severity'))).toEqual(['critical', 'informational']);
    const notice = marks[0]!.querySelector('a.life-notice')!;
    expect(notice.textContent).toBe('Retraction');
    expect(notice.getAttribute('href')).toBe('https://doi.org/10.1/notice');
    expect(marks[0]!.textContent).toContain('Withdrawn from the record');
    expect(marks[0]!.textContent).toContain('February 6, 2010');
    expect(marks[0]!.textContent).toContain('via Retraction Watch');
  });

  test('the service\'s note is shown on the paper\'s own page, not on a row', () => {
    const noted = [event({ kind: 'preprint_published', severity: 'informational', detail: 'Cite the published version.' })];
    expect(render(<LifecycleMarks events={noted} />).container.textContent).not.toContain('Cite the published version.');
    expect(render(<LifecycleMarks events={noted} full />).container.textContent).toContain('Cite the published version.');
  });

  test('a paper with nothing recorded draws nothing', () => {
    expect(render(<LifecycleMarks events={[]} />).container.innerHTML).toBe('');
    expect(render(<LifecycleMarks />).container.innerHTML).toBe('');
  });
});
