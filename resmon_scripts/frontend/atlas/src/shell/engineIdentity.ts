/**
 * Whether the engine answering this window is still the one it started with.
 *
 * The engine names itself on `/api/health`: a runtime id that is new each
 * time an engine starts, and the version of the contract it serves. A window
 * opened on one engine and now answered by another (the background service
 * restarted, say) is showing what the first one said; it says so, and a
 * person reloads when they choose. A reading that carries no identity this
 * version can read, or no reading at all, is said as that rather than taken
 * for either answer.
 */

/** What an engine says it is. */
export interface EngineIdentity {
  runtime: string;
  contract: number;
}

/** How often the shell asks, in milliseconds: rarely enough to cost nothing, often enough to be noticed. */
export const ENGINE_POLL_MS = 30_000;

/** The identity an `/api/health` answer carries, or null when it carries none this version can read. */
export function identityOf(health: unknown): EngineIdentity | null {
  const identity = (health as { identity?: { runtime_id?: unknown; contract_version?: unknown } } | null | undefined)?.identity;
  if (!identity || typeof identity.runtime_id !== 'string' || identity.runtime_id === '') return null;
  if (typeof identity.contract_version !== 'number') return null;
  return { runtime: identity.runtime_id, contract: identity.contract_version };
}

/** What the window says about its engine. */
export type EngineState = 'same' | 'changed' | 'unreadable';

/**
 * The window's engine, against the latest reading: `undefined` before the
 * first answer, `null` when the latest answer could not be read or named no
 * engine. Nothing is said before there is something to say.
 */
export function engineState(first: EngineIdentity | null, latest: EngineIdentity | null | undefined): EngineState {
  if (latest === undefined) return 'same';
  if (latest === null) return 'unreadable';
  if (first === null) return 'same';
  return first.runtime === latest.runtime && first.contract === latest.contract ? 'same' : 'changed';
}
