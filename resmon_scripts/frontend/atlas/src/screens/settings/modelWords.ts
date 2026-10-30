/**
 * Words for the model a command was asked for and the one that answered.
 *
 * The pickers offer aliases (`haiku`, `opus`) that each command resolves to
 * its newest model when it runs, so the version is known only once an answer
 * reports it. The engine names a reported id ("Haiku 5.5") and remembers which
 * model last answered each alias; these words put the two side by side and
 * never claim a version that no answer reported.
 */
import { answer, engine } from '../../api/client';
import type { components } from '../../api/schema';
import { listWords } from './summaryChoice';

export type LastAnswered = components['schemas']['AiLastAnsweredEntry'];

export const LAST_ANSWERED_KEY = ['ai-last-answered'] as const;
export const readLastAnswered = async (): Promise<LastAnswered[]> =>
  (await answer(engine().GET('/api/ai/last-answered'))).entries;

/** The aliases the claude command documents, used where the engine's list is not to hand. */
export const CLAUDE_ALIASES: readonly string[] = ['fable', 'opus', 'sonnet', 'haiku'];

/** The entry for this command and requested model, if an answer has reported one. */
export function lastFor(entries: readonly LastAnswered[] | undefined, provider: string, requested: string): LastAnswered | undefined {
  return entries?.find((e) => e.provider === provider && e.requested === requested);
}

const capitalized = (word: string): string => word.charAt(0).toUpperCase() + word.slice(1);

/**
 * One option in a model picker. A Claude alias says what it resolves to in
 * general, and which model it was when it last answered, if one has:
 * "haiku: the newest Haiku (Haiku 5.5 when it last answered)". The blank
 * choice is the command's default, with the same addition. Any other model
 * is its own id.
 */
export function modelOptionWords(provider: string, model: string, last: LastAnswered | undefined,
  aliases: readonly string[] = CLAUDE_ALIASES): string {
  const when = last ? ` (${last.name} when it last answered)` : '';
  if (!model) return `The command’s default${when}`;
  if (provider === 'claude_code' && aliases.includes(model)) return `${model}: the newest ${capitalized(model)}${when}`;
  return last && last.name !== model ? `${model} (${last.name} when it last answered)` : model;
}

/** The models a summary lane's command reported, in a sentence: "Haiku 4.5", "Haiku 4.5 and Sonnet 4.5". */
export function answeredNames(models: readonly { name: string }[] | undefined): string {
  return listWords((models ?? []).map((m) => m.name));
}
