import React from 'react';

/**
 * What has happened to a paper since resmon found it.
 *
 * The governing rule, and the reason this component is as plain as it is:
 * **resmon never asserts a lifecycle event on its own authority.** Every badge
 * renders the notice as a link, and the link text is the upstream's own label
 * verbatim — "Retraction", "Expression of concern", "Correction" — never a
 * paraphrase resmon invented. A false retraction flag is defamatory, and the
 * only defensible form of the claim is "the publisher registered this, here it
 * is, read it yourself".
 *
 * Severities are deliberately three, and only the first is alarming:
 *
 *   critical       the paper was withdrawn from the record
 *   caution        a concern was registered — explicitly not a retraction
 *   informational  a correction, a new version, a preprint reaching a journal
 *
 * A correction is normal scholarly upkeep. Colouring it like a retraction would
 * train users to ignore the colour, and then the retraction goes unread too.
 */

export interface LifecycleEvent {
  kind: string;
  severity: 'critical' | 'caution' | 'informational';
  label: string | null;
  notice_doi: string | null;
  notice_url: string;
  notice_date: string | null;
  detail: string | null;
  provider: string;
  provider_source: string | null;
}

const SEVERITY_PREFIX: Record<LifecycleEvent['severity'], string> = {
  critical: 'Withdrawn from the record',
  caution: 'Concern registered',
  informational: 'Changed since you found it',
};

/** Who registered the notice, when Crossref tells us. */
const sourceLabel = (event: LifecycleEvent): string | null => {
  if (event.provider_source === 'retraction-watch') return 'via Retraction Watch';
  if (event.provider_source === 'publisher') return 'registered by the publisher';
  if (event.provider === 'biorxiv') return 'via bioRxiv';
  if (event.provider === 'arxiv') return 'via arXiv';
  return null;
};

interface Props {
  events: LifecycleEvent[];
  /** Null when this paper has never been checked. */
  checkedAt?: string | null;
  /** Renders the "not checked yet" note. Off in dense lists. */
  showUnchecked?: boolean;
}

const LifecycleBadge: React.FC<Props> = ({ events, checkedAt, showUnchecked }) => {
  if (!events || events.length === 0) {
    // Silence here is ambiguous — it means either "nothing has happened to this
    // paper" or "nobody has ever looked". Only the second is worth saying, and
    // only where there is room to say it.
    if (showUnchecked && !checkedAt) {
      return (
        <p className="lifecycle-unchecked">
          Not yet checked for retractions or updates.
        </p>
      );
    }
    return null;
  }

  return (
    <ul className="lifecycle-events">
      {events.map((event) => {
        const source = sourceLabel(event);
        return (
          <li
            key={`${event.kind}:${event.notice_url}`}
            className={`lifecycle-event lifecycle-${event.severity}`}
          >
            <span className="lifecycle-chip">{SEVERITY_PREFIX[event.severity]}</span>
            {/*
              The label is the publisher's wording, not ours. The link is
              mandatory — the backend refuses to store an event without one —
              so this anchor can never render without a destination.
            */}
            <a
              href={event.notice_url}
              target="_blank"
              rel="noreferrer noopener"
              className="lifecycle-notice"
            >
              {event.label || event.kind}
            </a>
            {event.notice_date && (
              <span className="lifecycle-date">{event.notice_date}</span>
            )}
            {source && <span className="lifecycle-source">{source}</span>}
            {event.detail && <span className="lifecycle-detail">{event.detail}</span>}
          </li>
        );
      })}
    </ul>
  );
};

export default LifecycleBadge;
