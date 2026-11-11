import { useLayoutEffect, useState, type ReactNode } from 'react';

type Page = 'ask' | 'watch-editor';
interface HistoryState { sourceNotes?: Partial<Record<Page, boolean>> }
const choices = new Map<Page, boolean>();

function remember(page: Page, open: boolean): void {
  choices.set(page, open);
  const state = window.history.state as HistoryState | null;
  window.history.replaceState({ ...state, sourceNotes: { ...state?.sourceNotes, [page]: open } }, '');
}

/** Source details remembered in this window and its page history, including a reload. */
export function SourceNotes({ page, children }: { page: Page; children: ReactNode }) {
  const [open, setOpen] = useState(() => {
    const kept = (window.history.state as HistoryState | null)?.sourceNotes?.[page];
    return typeof kept === 'boolean' ? kept : choices.get(page) ?? false;
  });
  useLayoutEffect(() => remember(page, open), [page, open]);
  return (
    <details className="place-help source-notes" open={open}>
      <summary onClick={event => {
        // Native toggle is queued after the attribute changes. Store the choice
        // during activation so leaving or reloading immediately cannot lose it.
        event.preventDefault();
        remember(page, !open);
        setOpen(!open);
      }}>Source Limits and Keys</summary>
      <div className="place-help-body">{children}</div>
    </details>
  );
}
