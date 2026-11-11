import { Fragment } from 'react';

/** Preserve a name's text while allowing line breaks after its separators. */
export function WordBreaks({ text }: { text: string }) {
  const parts = text.split(/(?<=[_/-])/);
  return <>{parts.map((part, i) => <Fragment key={i}>{part}{i < parts.length - 1 && <wbr />}</Fragment>)}</>;
}
