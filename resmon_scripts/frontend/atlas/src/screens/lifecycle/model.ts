/**
 * What has happened to a paper since resmon found it: a retraction, a
 * registered concern, a correction, a preprint that reached a journal, a newer
 * version.
 *
 * resmon never says any of this on its own authority. Every event is a notice
 * a service registered, shown as a link to that notice, in the upstream's own
 * words (a "Correction" is never called a retraction, and a "Retraction" is
 * never softened), with who registered it where the service says. Severity is
 * three levels and only the first is an alarm: a correction is normal
 * scholarly upkeep, and coloring it like a retraction would teach a reader to
 * ignore the color.
 *
 * Silence is the other half. A paper with nothing recorded may have been
 * checked and found unchanged, or never asked about, or asked about while the
 * service was down; the sentences here keep those apart, and a check that
 * could not reach a service never reads as one that found nothing.
 */
import type { components } from '../../api/schema';
import { instantOf } from '../health/model';
import { count, number, when } from '../today/format';

export type LifecycleEvent = components['schemas']['LifecycleEvent'];
export type LifecycleFinding = components['schemas']['LifecycleFinding'];
export type LifecycleReport = components['schemas']['LifecycleReport'];
export type LifecycleCoverage = components['schemas']['LifecycleCoverage'];
export type LifecycleRunResult = components['schemas']['LifecycleRunResult'];
export type LifecycleCheckState = components['schemas']['LifecycleCheckState'];
export type ProfileLifecycle = components['schemas']['WatchProfileLifecycle'];
export type ProfileFinding = components['schemas']['WatchProfileLifecycleFinding'];
export type Severity = LifecycleEvent['severity'];

/** The corpus report and the run, read by the Watchdog. */
export const LIFECYCLE_KEY = ['lifecycle'] as const;
/** The events for a set of papers: `[LIFECYCLE_FOR, ids]`. */
export const LIFECYCLE_FOR = 'lifecycle-for';
/** One person's findings: `[PROFILE_LIFECYCLE, id]`. */
export const PROFILE_LIFECYCLE = 'profile-lifecycle';

/**
 * The bounds the engine puts on a check, as `lifecycle.py` sets them, so the
 * screen can say them in numbers. `test_lifecycle.py` reads this object and
 * fails when a number here stops agreeing with the engine's.
 */
export const CHECK_FACTS = {
  perCheck: 1000,
  crossrefBatch: 40,
  crossrefPerSecond: 10,
  arxivBatch: 50,
  biorxivPerSecond: 2,
  recheckDays: 30,
} as const;

/** The words before each notice. Only the first is an alarm. */
export const SEVERITY_WORDS: Record<Severity, string> = {
  critical: 'Withdrawn from the record',
  caution: 'Concern registered',
  informational: 'Changed since you found it',
};

export const SEVERITY_MEANING: Record<Severity, string> = {
  critical: 'A retraction, withdrawal, or removal: the paper has been taken out of the scholarly record. Read the notice.',
  caution: 'An expression of concern was registered. It is explicitly not a retraction.',
  informational: 'A correction, a newer version, or a preprint that reached a journal: normal scholarly upkeep, not a warning.',
};

/** Who registered the notice, where the service says; otherwise which service reported it. */
export function provenanceWords(event: Pick<LifecycleEvent, 'provider' | 'provider_source'>): string | null {
  if (event.provider_source === 'retraction-watch') return 'via Retraction Watch';
  if (event.provider_source === 'publisher') return 'registered by the publisher';
  if (event.provider === 'crossref') return 'via Crossref';
  if (event.provider === 'biorxiv') return 'via bioRxiv';
  if (event.provider === 'arxiv') return 'via arXiv';
  return null;
}

/** The notice's own label, verbatim; its kind only when the service gave none. */
export function noticeLabel(event: Pick<LifecycleEvent, 'label' | 'kind'>): string {
  return event.label?.trim() || event.kind;
}

const DAY = new Intl.DateTimeFormat('en-US', { month: 'long', day: 'numeric', year: 'numeric' });

/** A notice's date ("2010-02-06") as "February 6, 2010"; anything else as stored. */
export function noticeDay(stored: string | null | undefined): string | null {
  if (!stored) return null;
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(stored.trim());
  if (!match) return stored;
  // Built from its parts in local time, so the day is the day the service gave.
  return DAY.format(new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
}

/** Most serious first, as the engine orders them; a row needs only that order. */
export function bySeverity<T extends { severity: Severity | string }>(events: readonly T[]): T[] {
  const rank: Record<string, number> = { critical: 0, caution: 1, informational: 2 };
  return [...events].sort((a, b) => (rank[a.severity] ?? 3) - (rank[b.severity] ?? 3));
}

const it = (n: number, one: string, many: string) => (n === 1 ? one : many);

/**
 * How much of the collection the check has covered, one sentence a fact.
 *
 * The four counts partition the collection, and each is said: a paper that
 * carries nothing to ask about was never looked at, and one a service failed
 * on was not cleared, so neither is folded into the checked.
 */
export function coverageSentences(c: LifecycleCoverage, now: Date): string[] {
  if (c.corpus === 0) return ['Your collection is empty, so there is nothing to check.'];
  const out = [c.checked === 0
    ? `None of your ${count(c.corpus, 'paper')} has been checked yet.`
    : `${number(c.checked)} of your ${count(c.corpus, 'paper')} ${it(c.checked, 'has', 'have')} been checked.`];
  if (c.checked > 0 && c.unchecked > 0) {
    out.push(`${number(c.unchecked)} ${it(c.unchecked, 'has', 'have')} not been asked about yet.`);
  }
  if (c.no_identifier > 0) {
    out.push(`${number(c.no_identifier)} ${it(c.no_identifier, 'carries', 'carry')} no DOI and no arXiv version number, `
      + `so there is nothing to ask about ${it(c.no_identifier, 'it', 'them')}.`);
  }
  if (c.errored > 0) {
    out.push(`${number(c.errored)} could not be checked: a service failed on ${it(c.errored, 'it', 'them')}, `
      + `and ${it(c.errored, 'it is', 'they are')} asked about again after ${count(c.recheck_after_days, 'day')}.`);
  }
  const last = instantOf(c.last_checked_at);
  if (last) out.push(`Last checked ${when(last.toISOString(), now)}. A paper is asked about again after ${count(c.recheck_after_days, 'day')}.`);
  return out;
}

export interface RunLine { key: string; text: string }

/**
 * The account of the last check to finish: what it checked, what it could not
 * check and why, and whether it was stopped. "Checked" is said only of papers
 * a service answered for, as the coverage says it: a paper with nothing to ask
 * about was recorded without a request, and is said apart. A check that
 * checked nothing because a service did not answer says so first, never that
 * nothing changed.
 */
export function lastRunLines(last: LifecycleRunResult, coverage: LifecycleCoverage, now: Date): { headline: string; lines: RunLine[] } {
  const at = when(instantOf(last.checked_at)?.toISOString(), now);
  const looked = last.outcomes.ok;
  const unaskable = last.outcomes.no_identifier;
  let headline: string;
  if (last.stopped) {
    headline = `Stopped ${at}, with ${count(looked, 'paper')} checked.`;
  } else if (looked > 0) {
    headline = `Checked ${count(looked, 'paper')} ${at}.`;
  } else if (last.unanswered.length > 0 || last.errors.length > 0) {
    headline = `The check ${at} could not check a single paper.`;
  } else if (unaskable > 0) {
    headline = `The check ${at} had nothing it could ask about.`;
  } else if (coverage.corpus === 0) {
    headline = `The check ${at} had nothing to check: your collection is empty.`;
  } else {
    headline = `The check ${at} found no paper due: each has been asked about in the last `
      + `${count(coverage.recheck_after_days, 'day')}, or carries nothing to ask about.`;
  }

  const lines: RunLine[] = [];
  if (unaskable > 0) {
    lines.push({
      key: 'no-identifier',
      text: `${number(unaskable)} ${it(unaskable, 'paper carries', 'papers carry')} no DOI and no arXiv version number, `
        + `so there was nothing to ask about ${it(unaskable, 'it', 'them')}; ${it(unaskable, 'it is', 'they are')} `
        + 'counted apart, never as clear.',
    });
  }
  if (last.stopped && last.not_asked > 0) {
    lines.push({
      key: 'not-asked',
      text: `${number(last.not_asked)} ${it(last.not_asked, 'paper it had selected was', 'papers it had selected were')} `
        + `not asked about, and ${it(last.not_asked, 'stays', 'stay')} unchecked.`,
    });
  }
  for (const service of last.unanswered) {
    lines.push({
      key: `unanswered:${service.service}`,
      text: `${service.name} did not answer for ${count(service.papers, 'paper')}`
        + `${service.reason ? ` (${service.reason})` : ''}. `
        + `${it(service.papers, 'It stays', 'They stay')} unchecked, not cleared, and `
        + `${it(service.papers, 'is', 'are')} asked about again on the next check.`,
    });
  }
  if (last.errors.length > 0) {
    lines.push({
      key: 'errors',
      text: `${count(last.errors.length, 'paper')} could not be checked because a service failed on `
        + `${it(last.errors.length, 'it', 'them')} part-way: `
        + last.errors.map((e) => `${e.title ? `“${e.title}”` : `paper ${e.document_id}`} (${e.error ?? 'no reason given'})`).join('; ')
        + '.',
    });
  }
  if (!last.stopped && last.remaining > 0) {
    lines.push({
      key: 'remaining',
      text: `${number(last.remaining)} ${it(last.remaining, 'paper is', 'papers are')} still waiting to be checked.`,
    });
  }
  return { headline, lines };
}

/** What the absence of findings means, given how much was looked at. */
export function quietSentence(report: Pick<LifecycleReport, 'sufficient' | 'coverage'>): string {
  if (!report.sufficient) {
    return 'No paper has been checked yet, so the absence of anything below says nothing about your papers.';
  }
  const c = report.coverage;
  const rest = c.corpus - c.checked;
  return `Nothing has been recorded against the ${count(c.checked, 'paper')} checked.`
    + (rest > 0 ? ` The other ${number(rest)} ${it(rest, 'has', 'have')} not been cleared, by this or anything else.` : '');
}

/** The notices recorded, by severity: "1 withdrawn from the record, 2 changed since you found them". */
export function countsWords(counts: LifecycleReport['counts']): string {
  const parts = [
    counts.critical ? `${number(counts.critical)} withdrawn from the record` : '',
    counts.caution ? `${number(counts.caution)} with a concern registered` : '',
    counts.informational ? `${number(counts.informational)} changed since you found ${it(counts.informational, 'it', 'them')}` : '',
  ].filter(Boolean);
  const total = counts.critical + counts.caution + counts.informational;
  return `${count(total, 'notice')}: ${parts.join(', ')}`;
}

export interface PaperFindings {
  documentId: number;
  title: string;
  events: LifecycleFinding[];
}

/** The report's findings, one entry a paper, in the order the engine gave them. */
export function findingsByPaper(findings: readonly LifecycleFinding[]): PaperFindings[] {
  const papers = new Map<number, PaperFindings>();
  for (const finding of findings) {
    const entry = papers.get(finding.document_id)
      ?? { documentId: finding.document_id, title: finding.title, events: [] };
    entry.events.push(finding);
    papers.set(finding.document_id, entry);
  }
  return [...papers.values()];
}

/**
 * One paper's state, for its own page: what was recorded against it, or
 * whether it was checked and how that check ended, or that nobody has looked.
 */
export function paperState(events: readonly LifecycleEvent[], check: LifecycleCheckState | null | undefined, now: Date): string | null {
  if (events.length > 0) return null;
  if (!check) return 'Not yet checked for retractions or updates.';
  const at = when(instantOf(check.checked_at)?.toISOString(), now);
  if (check.status === 'ok') {
    return `Checked ${at}: nothing recorded. Crossref’s record of corrections and concerns is less complete than its `
      + 'record of retractions, so no concern recorded means less than no retraction recorded.';
  }
  if (check.status === 'no_identifier') {
    return `Looked at ${at}: it carries no DOI and no arXiv version number, so there was nothing to ask about it. `
      + 'That is not a clean result.';
  }
  return `The check ${at} could not be completed for this paper: a service failed on it. `
    + `It is asked about again after ${count(CHECK_FACTS.recheckDays, 'day')}.`;
}

/** Ids in the engine's limit per request, so a long list is read in several. */
export function chunks(ids: readonly number[], size = 500): number[][] {
  const out: number[][] = [];
  for (let i = 0; i < ids.length; i += size) out.push(ids.slice(i, i + size));
  return out;
}
