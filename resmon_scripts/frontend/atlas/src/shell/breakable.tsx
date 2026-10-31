import { Fragment, type ReactNode } from 'react';

/**
 * A name that may wrap where its own separators are. A watch named
 * `midnight_agents_arxiv_ai` is one word to the browser, so a narrow space
 * either overflows or cuts it at the end, and two watches that differ only
 * there look the same. A break opportunity after each `_`, `-`, `.` and `/`
 * lets it wrap at its parts instead, and the text itself is unchanged for
 * copying and for a screen reader.
 */
export function breakable(name: string): ReactNode {
  const parts = name.split(/(?<=[_\-./])/);
  if (parts.length < 2) return name;
  return parts.map((part, i) => (
    <Fragment key={i}>{i > 0 && <wbr />}{part}</Fragment>
  ));
}
