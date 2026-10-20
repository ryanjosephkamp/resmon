import React, { useEffect, useRef, useState } from 'react';

declare const api: { load: () => Promise<string> };

/**
 * Rule two. The effect has a dependency, so it can re-run without the
 * component unmounting — and on a re-run the body sets `alive` back to true
 * on the line after the cleanup cleared it. The cleanup therefore cancels
 * only a true unmount, and whether that is safe depends on a `key` in
 * whichever file renders this.
 */
export default function CleanupThatCancelsNothing({ subject }: { subject: string }) {
  const alive = useRef(false);
  const [text, setText] = useState('');
  useEffect(() => {
    alive.current = true;
    void api.load().then((value) => { if (alive.current) setText(value); });
    return () => { alive.current = false; };
  }, [subject]);
  return <p>{text}</p>;
}
