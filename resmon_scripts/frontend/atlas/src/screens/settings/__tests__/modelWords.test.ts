import { answeredNames, lastFor, modelOptionWords, type LastAnswered } from '../modelWords';

const entry = (provider: string, requested: string, name: string): LastAnswered => ({
  provider, requested, model: `id-${name}`, name, where: 'ask', observed_at_utc: '2026-10-30T15:45:00+00:00',
});

describe('a model picker says what an alias is, and what it was when it last answered', () => {
  const entries = [entry('claude_code', 'haiku', 'Haiku 5.5'), entry('claude_code', '', 'Opus 5.5'),
    entry('codex', 'gpt-5.5', 'GPT-5.5')];

  test('an alias that has answered names the model it resolved to', () => {
    expect(modelOptionWords('claude_code', 'haiku', lastFor(entries, 'claude_code', 'haiku')))
      .toBe('haiku: the newest Haiku (Haiku 5.5 when it last answered)');
  });

  test('an alias that has not answered claims no version', () => {
    expect(modelOptionWords('claude_code', 'opus', lastFor(entries, 'claude_code', 'opus'))).toBe('opus: the newest Opus');
    expect(modelOptionWords('claude_code', 'fable', undefined)).toBe('fable: the newest Fable');
  });

  test('the command’s default says what answered for it, where something has', () => {
    expect(modelOptionWords('claude_code', '', lastFor(entries, 'claude_code', ''))).toBe('The command’s default (Opus 5.5 when it last answered)');
    expect(modelOptionWords('codex', '', lastFor(entries, 'codex', ''))).toBe('The command’s default');
  });

  test('a model that is not an alias is its own id', () => {
    expect(modelOptionWords('codex', 'gpt-5.5', undefined)).toBe('gpt-5.5');
    expect(modelOptionWords('claude_code', 'claude-sonnet-5-5', undefined)).toBe('claude-sonnet-5-5');
    // An alias only for the command that has it: Codex has no "haiku".
    expect(modelOptionWords('codex', 'haiku', undefined)).toBe('haiku');
  });

  test('the entry is the one for this command and requested model', () => {
    expect(lastFor(entries, 'codex', 'haiku')).toBeUndefined();
    expect(lastFor(undefined, 'claude_code', 'haiku')).toBeUndefined();
  });

  test('the models a lane reported, in a sentence', () => {
    expect(answeredNames([{ name: 'Haiku 5.5' }])).toBe('Haiku 5.5');
    expect(answeredNames([{ name: 'Haiku 5.5' }, { name: 'Haiku 4.5' }])).toBe('Haiku 5.5 and Haiku 4.5');
    expect(answeredNames([])).toBe('');
    expect(answeredNames(undefined)).toBe('');
  });
});
