import { useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { answer, engine } from '../../api/client';
import type { components } from '../../api/schema';
import { refusal } from './ProviderKey';

type Opened = components['schemas']['AiCliSignInOpened'];

/** Which lane's way of finding the command to check: a run's summaries, or Ask. */
export type SignInPurpose = 'summaries' | 'ask';

const NAMES: Record<string, string> = { claude_code: 'Claude Code', codex: 'Codex' };

export const signInKey = (provider: string, purpose: SignInPurpose, binaryPath = '') =>
  ['cli-sign-in', provider, purpose, binaryPath] as const;

/** The states in which signing in through the command is what to do next. */
const SIGN_IN_STATES = new Set(['signed_out', 'expired', 'unknown']);

/**
 * Whether Claude Code or Codex is signed in on this computer, and the way to
 * sign it in, through the command's own login.
 *
 * resmon never holds the sign-in: the command keeps it, and resmon runs the
 * command. So the check asks the command (its status command, no model call,
 * no cost), and Sign in opens the command's own login in a terminal, where the
 * browser sign-in happens between the person and the provider.
 *
 * `checkOnOpen` runs the check when this is drawn, which is what Settings ›
 * AI and the Ask composer do. Where a failure has already said the command is
 * not signed in, it is not run until Check again. Never on a timer, and the
 * answer is dropped when this leaves the screen.
 */
export function CliSignIn({ provider, purpose, binaryPath, checkOnOpen }: {
  provider: string;
  purpose: SignInPurpose;
  /** A fallback lane's own command, where it has one. */
  binaryPath?: string;
  checkOnOpen: boolean;
}) {
  const [asked, setAsked] = useState(checkOnOpen);
  const name = NAMES[provider] ?? provider;
  const path = binaryPath?.trim() || undefined;
  const check = useQuery({
    queryKey: signInKey(provider, purpose, path),
    queryFn: () => answer(engine().GET('/api/ai/cli/sign-in', {
      params: { query: { provider, purpose, ...(path ? { binary_path: path } : {}) } },
    })),
    enabled: asked,
    refetchOnMount: 'always',
    staleTime: 0,
    gcTime: 0,
    retry: false,
  });
  const open = useMutation({
    mutationFn: () => answer(engine().POST('/api/ai/cli/sign-in', {
      body: { provider, purpose, ...(path ? { binary_path: path } : {}) },
    })),
  });
  // Another screen may have asked the same question; what it was told is not
  // shown here until this one asks.
  const data = asked ? check.data : undefined;
  const fetching = asked && check.isFetching;
  const failed = asked && check.isError ? check.error : null;
  const state = data?.state;
  // Not offered while the first answer is on its way, so a signed-in command
  // does not flash a Sign in it does not need.
  const offer = state ? SIGN_IN_STATES.has(state) : !fetching;
  const again = () => {
    if (asked) void check.refetch();
    else setAsked(true);
  };
  return (
    <div className="ai-signin" role="group" aria-label={`${name} sign-in`} data-ai="sign-in"
      data-state={fetching ? 'checking' : state ?? (failed ? 'error' : 'unchecked')}>
      <div className="ai-signin-row">
        <p className="ai-signin-state" role="status">
          {fetching ? `Checking whether the ${name} command is signed in…`
            : failed ? `The engine did not check the sign-in (${refusal(failed)}).`
              : data?.message ?? ''}
        </p>
        <span className="ai-signin-actions">
          {offer && (
            <button type="button" className="btn sm" data-ai="sign-in-open" disabled={open.isPending}
              onClick={() => open.mutate()}>
              {open.isPending ? 'Opening' : 'Sign in'}
            </button>
          )}
          <button type="button" className="btn quiet sm" data-ai="sign-in-check" disabled={fetching} onClick={again}>
            Check again
          </button>
        </span>
      </div>
      {open.data && <OpenedNote opened={open.data} />}
      {open.error && <p className="field-error" role="alert">{refusal(open.error)}</p>}
      {offer && (
        <p className="ai-signin-hint">
          Sign in opens the {name} command’s own login. resmon does not see or keep the sign-in: the command keeps it.
        </p>
      )}
    </div>
  );
}

/** What Sign in did: a Terminal window asked for, or the command to run. */
function OpenedNote({ opened }: { opened: Opened }) {
  const [copied, setCopied] = useState<boolean | null>(null);
  if (opened.how !== 'copy') return <p className="ai-signin-said" role="status" data-ai="sign-in-opened">{opened.message}</p>;
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(opened.command);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  };
  return (
    <div className="ai-signin-said" data-ai="sign-in-command">
      <p>{opened.message}</p>
      <span className="ai-signin-command">
        <code>{opened.command}</code>
        <button type="button" className="btn sm" onClick={() => void copy()}>Copy</button>
      </span>
      {copied !== null && (
        <p role="status">{copied ? 'Copied.' : 'This window could not copy it. Select the command and copy it.'}</p>
      )}
    </div>
  );
}
