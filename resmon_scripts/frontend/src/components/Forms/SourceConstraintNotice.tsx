import React from 'react';
import { RepoCatalogEntry } from '../../api/repositories';
import { advisoriesFor } from '../../lib/sourceConstraints';
import InfoTooltip from '../Help/InfoTooltip';

interface Props {
  /** The repositories currently selected, in the order the form holds them. */
  entries: (RepoCatalogEntry | undefined)[];
  /** The start date on this form, as typed. Empty when the window is open. */
  dateFrom?: string;
  /** The end date on this form, as typed. Empty when the window is open. */
  dateTo?: string;
  /**
   * Whether this form submits keywords at all. A watch routine follows a
   * person and sends none, so "resmon matches your terms itself" would be a
   * sentence about something that is not going to happen. The window and
   * record-filter notices still apply and are still shown.
   */
  keywordsApply?: boolean;
}

/**
 * What the selected sources will do to this query, said before it is sent.
 *
 * Until now a source's limitation was discovered by hitting it: a user picked
 * DBLP, set a window inside one calendar year, waited for the sweep and got a
 * zero with an explanation attached. The explanation was accurate and it
 * arrived after the wait. Everything in this panel is knowable the moment the
 * source is selected, so it is said then.
 *
 * Two rules keep it worth reading:
 *
 * - **Only sources with something to say appear.** Eleven of the twenty-seven
 *   catalog rows have no constraint at all, and with no date range set only
 *   three of the remaining sixteen have anything to add. A panel listing
 *   every selected source — most of them to say nothing is wrong — is a panel
 *   people stop seeing.
 * - **Where a window will actually be reshaped, the sentence names the dates
 *   it will become.** "DBLP will search all of 2025 and 2026" is something a
 *   user can act on; "year granularity" is a label they have to decode. The
 *   date sentence therefore changes as the date fields change, and
 *   disappears when the window is open, because with no dates there is
 *   nothing specific to promise.
 *
 * Missing API keys are deliberately absent: `RepoKeyStatus` sits on every
 * form that mounts this one and already says so, with a field to fix it.
 */
const SourceConstraintNotice: React.FC<Props> = ({
  entries,
  dateFrom = '',
  dateTo = '',
  keywordsApply = true,
}) => {
  const advisories = advisoriesFor(entries, dateFrom, dateTo)
    .map((advisory) => ({
      ...advisory,
      notices: keywordsApply
        ? advisory.notices
        : advisory.notices.filter((notice) => notice.kind !== 'keyword_search'),
    }))
    .filter((advisory) => advisory.window || advisory.notices.length > 0);
  if (advisories.length === 0) return null;

  return (
    <div className="form-field" data-testid="source-constraint-notice">
      <label className="form-label">
        Before you run this
        <InfoTooltip text="What the sources you have selected will do to this query. Only sources that will change something appear here; a source with nothing to say is left out. Full details for every source are on the Repositories & API Keys page." />
      </label>
      <ul className="repo-key-status-stack" style={{ margin: 0, paddingLeft: 0, listStyle: 'none' }}>
        {advisories.map((advisory) => (
          <li key={advisory.slug} style={{ marginBottom: 8 }} data-testid={`constraint-${advisory.slug}`}>
            <strong>{advisory.name}</strong>
            <ul style={{ margin: '2px 0 0', paddingLeft: 18 }}>
              {advisory.window && (
                <li data-testid={`constraint-window-${advisory.slug}`}>{advisory.window}</li>
              )}
              {advisory.notices.map((notice, index) => (
                <li key={`${notice.kind}-${index}`}>{notice.effect}</li>
              ))}
            </ul>
          </li>
        ))}
      </ul>
    </div>
  );
};

export default SourceConstraintNotice;
