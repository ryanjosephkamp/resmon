import React from 'react';
import WhyThisPaper from '../Explain/WhyThisPaper';
import { QueuedDocument } from '../../api/readingQueue';

/**
 * One stored paper, rendered the same way wherever the reading feature shows
 * it: the Papers tab of a run, and the Reading queue.
 *
 * The two views were written from one component on purpose. A paper that looks
 * different in the list you saved it from and the list you saved it into makes
 * a user check whether it is the same paper, and it is — the same corpus row,
 * under the same id.
 *
 * Everything rendered here is a field the source returned and resmon stored.
 * It is untrusted text (B12 / `AGENTS.md`): React escapes it, no field is
 * passed to `dangerouslySetInnerHTML`, and the only place a stored string
 * becomes an attribute is `href`, which is why `url` is rendered as a link only
 * when it is `http`/`https` — a `javascript:` URL in a metadata field would
 * otherwise become a clickable script.
 */

interface Props {
  document: QueuedDocument;
  /**
   * The execution the paper is being looked at from, when there is one, so the
   * evidence panel can say what *this run* matched rather than only what the
   * corpus knows. `WhyThisPaper` takes the corpus-local document id either way
   * — never an execution id, which is a different number space entirely.
   */
  executionId?: number;
  /** Buttons for this paper: Save, or Read / Unread / Remove. */
  actions?: React.ReactNode;
  /** Rendered before the title — the selection checkbox, where there is one. */
  lead?: React.ReactNode;
  /** A dated line under the title, e.g. "Saved 2026-09-08 · Read 2026-09-09". */
  note?: React.ReactNode;
}

/** `http`/`https` only; anything else is shown as text rather than linked. */
function safeHref(url: string | null): string | null {
  if (!url) return null;
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? url : null;
  } catch {
    return null;
  }
}

const PaperCard: React.FC<Props> = ({ document: d, executionId, actions, lead, note }) => {
  const href = safeHref(d.url);
  return (
    <li className="reading-item" data-testid={`paper-${d.id}`}>
      <div className="reading-item-head">
        {lead}
        <h3 className="reading-item-title">
          {href ? (
            <a href={href} target="_blank" rel="noreferrer noopener">{d.title}</a>
          ) : d.title}
        </h3>
        {actions && <div className="reading-item-actions">{actions}</div>}
      </div>
      {note && <p className="reading-item-note">{note}</p>}
      <p className="explorer-meta">
        <span className="explorer-source">{d.source_repository}</span>
        {d.publication_date && <span>{d.publication_date}</span>}
        {d.doi && <span className="explorer-doi">{d.doi}</span>}
      </p>
      {d.authors && <p className="explorer-authors">{d.authors}</p>}
      {d.abstract && <p className="explorer-abstract">{d.abstract}</p>}
      {d.categories && (
        <p className="reading-item-cats">
          {d.categories.split(',').map((c) => c.trim()).filter(Boolean).map((c) => (
            <span key={c} className="explorer-chip">{c}</span>
          ))}
        </p>
      )}
      <div className="explorer-explain">
        <WhyThisPaper documentId={d.id} executionId={executionId} />
      </div>
    </li>
  );
};

export default PaperCard;
