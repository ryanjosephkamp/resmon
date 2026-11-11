import { useQuery } from '@tanstack/react-query';
import { answer, engine } from '../api/client';
import { ENGINE_POLL_MS, engineState, identityOf, type EngineIdentity } from './engineIdentity';

/**
 * One line under the top bar when the engine behind this window is no longer
 * the one it opened on, with Reload; or when which engine it is cannot be
 * read. It never reloads on its own: what is on screen stays until the person
 * chooses. The engine it opened on is read once, when the window opens; the
 * latest is Health › This engine's reading, asked again every thirty seconds
 * while the window is in front.
 */
export function EngineNotice() {
  const health = useQuery({
    queryKey: ['health'],
    queryFn: () => answer(engine().GET('/api/health')),
    refetchInterval: ENGINE_POLL_MS,
  });
  const opened = useQuery({
    queryKey: ['engine opened on'],
    queryFn: () => answer(engine().GET('/api/health')),
    staleTime: Infinity,
    gcTime: Infinity,
  });
  const first: EngineIdentity | null = opened.data === undefined ? null : identityOf(opened.data);
  const latest = health.isError ? null : health.data === undefined ? undefined : identityOf(health.data);
  const state = engineState(first, latest);
  if (state === 'same') return null;
  return (
    <p className="engine-notice" role="status" data-engine={state}>
      {state === 'changed'
        ? <>The engine behind this window changed. <button type="button" className="btn sm" onClick={() => window.location.reload()}>Reload</button></>
        : 'Which engine is behind this window cannot be read right now.'}
    </p>
  );
}
