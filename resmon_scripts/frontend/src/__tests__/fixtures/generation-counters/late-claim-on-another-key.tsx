import React, { useState } from 'react';
import { useRuns } from '../../../hooks/useRuns';

declare const api: { load: () => Promise<string> };

/**
 * Rule three. `open` claims the selection key before it suspends and holds
 * that ticket, which is how an operation is supposed to start. `remove`
 * claims the same key *after* its await, holding only its own — so it
 * invalidates whatever run owns the selection by then, including that run's
 * release of whatever its ticket gates.
 */
export default function LateClaimOnAnotherKey() {
  const runs = useRuns();
  const [text, setText] = useState('');
  const open = async () => {
    const ticket = runs.begin('selection');
    const value = await api.load();
    if (runs.current('selection', ticket)) setText(value);
  };
  const remove = async () => {
    const ticket = runs.begin('remove');
    await api.load();
    if (runs.current('remove', ticket)) {
      runs.begin('selection');
      setText('');
    }
  };
  return <div>
    <button type="button" onClick={() => void open()}>Open</button>
    <button type="button" onClick={() => void remove()}>Remove</button>
    <p>{text}</p>
  </div>;
}
