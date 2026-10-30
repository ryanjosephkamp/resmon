import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { answer, engine } from '../../api/client';
import type { components } from '../../api/schema';
import { useSources } from '../sources/SourceCatalog';

type Step = components['schemas']['OnboardingStep'];

export const ONBOARDING_KEY = ['onboarding'] as const;

/**
 * Where each step leads, and what to call it. Written here rather than served
 * by the engine so that every destination is a route this renderer has.
 */
const STEPS: Record<string, { to: string; title: string; action: string }> = {
  agent_cli: { to: '/settings/ai', title: 'Use an AI plan you already pay for', action: 'Settings › AI' },
  ai_key: { to: '/settings/ai', title: 'Or bring an API key', action: 'Settings › AI' },
  repository_key: { to: '/settings/sources', title: 'Add a key for a source that wants one', action: 'Settings › Sources' },
};

/**
 * A step's mark, with the words a screen reader reads. `null` is "could not
 * check", never "no". A command is only ever found (the engine looks for it
 * and does not run it), which is less than a key that is stored, so it has a
 * neutral mark of its own rather than the done mark.
 */
export function stepMark(step: Pick<Step, 'id' | 'done'>): { label: 'done' | 'found' | 'not done' | 'could not check'; state: string } {
  if (step.done === null || step.done === undefined) return { label: 'could not check', state: 'unknown' };
  if (!step.done) return { label: 'not done', state: 'no' };
  return step.id === 'agent_cli' ? { label: 'found', state: 'found' } : { label: 'done', state: 'yes' };
}

/**
 * The one card a fresh install shows, where the map of its papers will be.
 *
 * **Facts, not a wizard.** Each line is something the engine can see (a
 * command found, a key slot filled), and none claims that anything works:
 * resmon cannot tell whether a command is signed in or a key accepted until
 * the first paper goes through it, and the card says so. **Nothing is
 * required**, and it says that too. The engine decides when the card shows:
 * while there are no papers, runs or watches, until it is skipped.
 *
 * Skip waits for the engine to record the dismissal before the card goes, so
 * "it disappeared" and "it will not come back" are the same claim.
 */
export function FirstRun() {
  const client = useQueryClient();
  const state = useQuery({ queryKey: ONBOARDING_KEY, queryFn: () => answer(engine().GET('/api/onboarding')) });
  const skip = useMutation({
    mutationFn: () => answer(engine().POST('/api/onboarding/dismiss')),
    onSuccess: () => client.invalidateQueries({ queryKey: ONBOARDING_KEY }),
  });
  const { sources } = useSources();
  // Counted from the catalog: the sources that need no key at all.
  const keyless = sources.filter((entry) => entry.api_key_requirement !== 'required').length;
  if (!state.data?.show) return null;
  return (
    <section className="first-run" aria-labelledby="first-run-title" data-today="first-run">
      <div className="first-run-head">
        <h2 id="first-run-title">Getting started</h2>
        <button type="button" className="btn sm" disabled={skip.isPending} onClick={() => skip.mutate()}>Skip</button>
      </div>
      <p className="first-run-lede">
        resmon has not run anything yet. {keyless
          ? `It searches ${keyless} sources with no AI and no keys at all`
          : 'Searching needs no AI at all'}: each step below is optional, and each makes it do more.
      </p>
      <ul className="first-run-steps">
        {state.data.steps.map((step) => {
          const where = STEPS[step.id];
          if (!where) return null;
          const m = stepMark(step);
          return (
            <li key={step.id} data-step={step.id}>
              <span className="first-run-mark" data-state={m.state} role="img" aria-label={m.label} title={m.label} />
              <span className="first-run-text">
                <strong>{where.title}</strong>
                <span>{step.detail}</span>
              </span>
              <Link className="btn sm" to={where.to}>{where.action}</Link>
            </li>
          );
        })}
      </ul>
      <p className="first-run-foot">
        Found and configured are not the same as working: resmon cannot tell whether a command is signed in, or a
        key accepted, until the first paper goes through it.
      </p>
      {skip.isError && <p className="field-error" role="alert">That was not saved, so the card stays. Try again.</p>}
    </section>
  );
}
