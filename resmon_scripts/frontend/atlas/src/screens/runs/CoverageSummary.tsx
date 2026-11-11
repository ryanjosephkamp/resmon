import { Fragment } from 'react';
import './coverageSummary.css';

/**
 * Lay out the engine's sentences without recomposing them. Only a named
 * source's complete in-part or stopped sentence is separated; unfamiliar wording stays
 * intact, including any qualification after the source accounts.
 */
export function CoverageSummary({ summary, names }: { summary: string; names: readonly string[] }) {
  const accounts = names.flatMap((name) => [
    { start: summary.indexOf(`${name} answered in part: `), ending: '; the older ones were not read.' },
    { start: summary.indexOf(`${name} was stopped by you; `), ending: 'It did not finish answering.' },
  ]).filter((account) => account.start >= 0).sort((a, b) => a.start - b.start);
  const parts: string[] = [];
  let at = 0;
  for (const { start, ending } of accounts) {
    if (start < at) continue;
    const end = summary.indexOf(ending, start);
    if (end < 0) continue;
    const before = summary.slice(at, start).trim();
    if (before) parts.push(before);
    at = end + ending.length;
    parts.push(summary.slice(start, at));
  }
  if (at < summary.length) parts.push(summary.slice(at).trim());
  return (
    <div className="coverage-summary" data-coverage-summary>
      {parts.map((part, i) => <Fragment key={i}><p className="coverage-sentence">
        {part.split(/((?:January|February|March|April|May|June|July|August|September|October|November|December) \d{1,2}, \d{4}|\b\d[\d,]*)/g)
          .map((text, n) => /\d/.test(text) && /^(?:\d|[A-Z][a-z]+ \d)/.test(text)
            ? <strong className="num" key={n}>{text}</strong> : text)}
      </p>{i < parts.length - 1 ? ' ' : null}</Fragment>)}
    </div>
  );
}
