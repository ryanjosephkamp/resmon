import React, { useRef, useState } from 'react';

declare const api: { load: () => Promise<string> };

/**
 * Rule one. `refresh` claims its ticket and is correct. `page` reads the same
 * counter without claiming one, so it can never be the newest run of
 * anything: pressing Refresh while a page is in flight discards the page and
 * its refusal both, and nothing is written anywhere.
 */
export default function TicketWithoutAClaim() {
  const epoch = useRef(0);
  const [text, setText] = useState('');
  const refresh = async () => {
    const ticket = ++epoch.current;
    const value = await api.load();
    if (ticket === epoch.current) setText(value);
  };
  const page = async () => {
    const ticket = epoch.current;
    const value = await api.load();
    if (ticket === epoch.current) setText(value);
  };
  return <div>
    <button type="button" onClick={() => void refresh()}>Refresh</button>
    <button type="button" onClick={() => void page()}>Next page</button>
    <p>{text}</p>
  </div>;
}
