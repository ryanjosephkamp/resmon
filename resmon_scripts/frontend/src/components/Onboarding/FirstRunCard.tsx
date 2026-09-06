import React from 'react';
import { Link } from 'react-router-dom';
import { apiClient } from '../../api/client';

/**
 * The one card a fresh install shows, on the Dashboard, and then never again.
 *
 * **A checklist of facts, not a wizard.** Every line reports something the
 * backend can actually see — a CLI on the PATH, a key slot with something in it
 * — and no line claims a lane *works*. resmon cannot tell whether a CLI is
 * signed in or a key is valid without spending one, and 1.8.5 settled the rule
 * this follows: proposing is not promising. A step the keyring will not answer
 * for (`done: null`) says it could not check, rather than telling someone to
 * add a key they already have.
 *
 * **Nothing here is required.** resmon searches 25 sources with no AI and no
 * keys at all, and the card says so, because a getting-started list that reads
 * as a set of prerequisites is a list that makes the app look like it needs
 * them.
 *
 * It shows while the corpus, the executions and the routines are all empty, and
 * stops for ever the moment any of them is not — or when the person dismisses
 * it. That decision is the backend's; this component renders `show`.
 */

interface Step {
  id: 'agent_cli' | 'ai_key' | 'repository_key';
  /** `null` means resmon could not check — not "no". */
  done: boolean | null;
  detail: string;
}

interface OnboardingState {
  show: boolean;
  dismissed: boolean;
  counts: { documents: number; executions: number; routines: number };
  steps: Step[];
}

/**
 * Where each step sends you, and what to call it. The route is written here
 * rather than served by the backend so that it is typed and so that
 * `FirstRunCard.test.tsx` can assert every destination against `routes.ts` —
 * the one route table. A link the app cannot serve is then a failing test
 * rather than a dead end on the first screen a new user sees.
 */
export const STEP_DESTINATIONS: Record<Step['id'], { to: string; title: string; action: string }> = {
  agent_cli: {
    to: '/settings/ai',
    title: 'Use an AI subscription you already pay for',
    action: 'Open Settings → AI',
  },
  ai_key: {
    to: '/settings/ai',
    title: 'Or bring an API key',
    action: 'Open Settings → AI',
  },
  repository_key: {
    to: '/repositories',
    title: 'Add a key for a source that wants one',
    action: 'Open Repositories',
  },
};

const MARK: Record<string, { glyph: string; label: string }> = {
  yes: { glyph: '✓', label: 'done' },
  no: { glyph: '·', label: 'not done' },
  unknown: { glyph: '?', label: 'could not check' },
};

function markOf(done: boolean | null): { glyph: string; label: string } {
  if (done === null || done === undefined) return MARK.unknown;
  return done ? MARK.yes : MARK.no;
}

const FirstRunCard: React.FC = () => {
  const [state, setState] = React.useState<OnboardingState | null>(null);
  const [hidden, setHidden] = React.useState(false);

  React.useEffect(() => {
    let cancelled = false;
    apiClient.get<OnboardingState>('/api/onboarding')
      .then((body) => { if (!cancelled) setState(body); })
      // A card that cannot load is a card that does not appear. It is the least
      // important thing on the page and must never be the reason the Dashboard
      // shows an error.
      .catch(() => { if (!cancelled) setState(null); });
    return () => { cancelled = true; };
  }, []);

  const dismiss = React.useCallback(() => {
    setHidden(true);
    void apiClient.post('/api/onboarding/dismiss', {}).catch(() => {
      /* it is gone for this session either way; the next launch will retry */
    });
  }, []);

  if (!state || !state.show || hidden) return null;

  return (
    <div className="card first-run" data-testid="first-run-card">
      <div className="first-run-head">
        <h2>Getting started</h2>
        <button type="button" className="btn btn-sm btn-secondary" onClick={dismiss}>
          Skip
        </button>
      </div>

      <p className="first-run-lede">
        resmon has not run anything yet. It searches 25 sources with no AI and no
        keys at all — everything below is optional, and each one makes it do more.
      </p>

      <ul className="first-run-steps">
        {state.steps.map((step) => {
          const destination = STEP_DESTINATIONS[step.id];
          if (!destination) return null;
          const mark = markOf(step.done);
          return (
            <li key={step.id} data-testid={`first-run-step-${step.id}`}>
              <span
                className={`first-run-mark first-run-mark--${mark.label.replace(/ /g, '-')}`}
                aria-label={mark.label}
                title={mark.label}
              >
                {mark.glyph}
              </span>
              <span className="first-run-text">
                <strong>{destination.title}</strong>
                <span className="first-run-detail">{step.detail}</span>
              </span>
              <Link className="btn btn-sm btn-secondary" to={destination.to}>
                {destination.action}
              </Link>
            </li>
          );
        })}
      </ul>

      <p className="first-run-foot">
        Found and configured are not the same as working: resmon cannot tell
        whether a command is signed in, or a key accepted, until the first paper
        goes through it.
      </p>
    </div>
  );
};

export default FirstRunCard;
