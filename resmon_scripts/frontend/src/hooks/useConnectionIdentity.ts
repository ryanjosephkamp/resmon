import { useCallback, useEffect, useRef, useState } from 'react';
import { ConnectionError, ConnectionObservation, fetchConnection } from '../api/connection';

type Status = 'checking' | 'connected' | 'offline' | 'identity_unavailable' | 'instance_mismatch';
interface State { status: Status; observation: ConnectionObservation | null; stale: boolean }

export function useConnectionIdentity() {
  const [state, setState] = useState<State>({ status: 'checking', observation: null, stale: false });
  const expected = useRef<string | undefined>(undefined);
  const sequence = useRef(0);
  const mounted = useRef(false);
  const check = useCallback(async (reaccept = false) => {
    // Every request takes a generation, including reaccept. A late success or
    // error from an earlier generation cannot rewrite the current observation.
    const request = ++sequence.current;
    setState(previous => ({ ...previous, status: 'checking', stale: !!previous.observation }));
    try {
      const observation = await fetchConnection(reaccept ? undefined : expected.current);
      if (!mounted.current || request !== sequence.current) return;
      if (observation.identity) expected.current = observation.identity.runtime_id;
      setState({ observation, status: observation.identity ? 'connected' : 'identity_unavailable', stale: false });
    } catch (error) {
      if (!mounted.current || request !== sequence.current) return;
      const status = error instanceof ConnectionError ? error.code : 'offline';
      setState(previous => ({ ...previous, status, stale: !!previous.observation }));
    }
  }, []);
  useEffect(() => {
    mounted.current = true;
    void check();
    const timer = setInterval(() => { void check(); }, 15000);
    return () => { mounted.current = false; ++sequence.current; clearInterval(timer); };
  }, [check]);
  return { ...state, refresh: () => { void check(); }, reaccept: () => { void check(true); } };
}
