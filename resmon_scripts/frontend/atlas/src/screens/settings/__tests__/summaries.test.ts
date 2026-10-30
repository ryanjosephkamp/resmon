import {
  baseUrlProblem, composeChain, effortsFor, entryOf, laneRaw, laneWords, limitProblem, limitsOf, moveFallback, readChain,
  rememberedModels, storedSummary, summaryChanged, summaryPayload, switchProvider, temperatureProblem, wordingOf,
  type AiSettings,
} from '../summaryLanes';
import {
  NO_CHOICE, choiceLanes, choiceOf, choiceSentence, overrideOf, settingsLanes, stateSentence, wordingSet, type SummaryChoice,
} from '../summaryChoice';

const STORED: AiSettings = {
  ai_chain: '', ai_cli_path: '', ai_custom_base_url: '', ai_custom_header_prefix: 'Bearer', ai_default_models: '',
  ai_effort: '', ai_extraction_goals: '', ai_local_endpoint: '', ai_local_model: '', ai_model: '', ai_provider: '',
  ai_show_audit_prefix: '', ai_subscription_doc_cap: '', ai_summary_length: '', ai_temperature: '', ai_tone: '',
};
const ENDPOINT = 'http://127.0.0.1:4141/v1';
/** Settings › AI with a custom endpoint first and a local model after it. */
const WITH_CHAIN: AiSettings = {
  ...STORED, ai_provider: 'custom', ai_model: 'authored-model', ai_custom_base_url: ENDPOINT,
  ai_chain: JSON.stringify([
    { kind: 'api_key', provider: 'custom', model: 'authored-model', credential_alias: 'custom_llm_api_key', base_url: ENDPOINT },
    { kind: 'local', provider: 'local', model: 'llama3' },
  ]),
};

describe('a lane typed on the screen, as the engine will read it', () => {
  test('each kind keeps only the fields it uses, and nothing blank', () => {
    expect(laneRaw({ provider: 'openai', model: ' gpt-4o ', base_url: 'https://x', endpoint: 'http://y', doc_cap: '9' }))
      .toEqual({ kind: 'api_key', provider: 'openai', model: 'gpt-4o', credential_alias: 'openai_api_key' });
    expect(laneRaw({ provider: 'custom', model: 'm', base_url: ENDPOINT }))
      .toEqual({ kind: 'api_key', provider: 'custom', model: 'm', credential_alias: 'custom_llm_api_key', base_url: ENDPOINT });
    expect(laneRaw({ provider: 'local', model: 'qwen3', endpoint: '' })).toEqual({ kind: 'local', provider: 'local', model: 'qwen3' });
    expect(laneRaw({ provider: 'codex', model: '', cli_path: '/bin/codex', effort: 'high', doc_cap: '12', batch_size: 'x' }))
      .toEqual({ kind: 'subscription', provider: 'codex', binary_path: '/bin/codex', effort: 'high', doc_cap: 12 });
    expect(entryOf({ provider: '', model: 'm' })).toBeNull();
    expect(entryOf({ provider: 'xai', model: 'grok-4' })?.lane).toMatchObject({ kind: 'api_key', provider: 'xai', model: 'grok-4' });
  });

  test('a fallback moves one place at a time, and not past either end', () => {
    expect(moveFallback(['a', 'b', 'c'], 2, -1)).toEqual(['a', 'c', 'b']);
    expect(moveFallback(['a', 'b', 'c'], 0, 1)).toEqual(['b', 'a', 'c']);
    expect(moveFallback(['a', 'b'], 0, -1)).toEqual(['a', 'b']);
    expect(moveFallback(['a', 'b'], 1, 1)).toEqual(['a', 'b']);
  });

  test('a custom endpoint names where it is, not a key called “a custom API”', () => {
    const [first] = readChain(WITH_CHAIN.ai_chain).entries;
    expect(laneWords(first!.lane)).toBe(`Custom endpoint · authored-model, at ${ENDPOINT}, with its key`);
  });
});

describe('the main lane’s details, written where a run reads them', () => {
  test('a command’s limits are typed on the form and written into its lane and its single key', () => {
    const stored = { ...STORED, ai_provider: 'claude_code' };
    const form = { ...storedSummary(stored).form, doc_cap: '20', batch_size: '3' };
    expect(limitsOf(form)).toEqual({ batch: 3, cap: 20 });
    expect(limitsOf({ doc_cap: '', batch_size: '' })).toEqual({ batch: 5, cap: 50 });
    const payload = summaryPayload(stored, form, []);
    expect(JSON.parse(payload.ai_chain!)).toEqual([{ kind: 'subscription', provider: 'claude_code', doc_cap: 20, batch_size: 3 }]);
    expect(payload.ai_subscription_doc_cap).toBe('20');
    expect(limitProblem('0')).toBe('A whole number above zero.');
    expect(limitProblem('')).toBeNull();
  });

  test('how each summary is written is saved with the lane, blank length and tone reading as the defaults', () => {
    expect(wordingOf(STORED)).toEqual({ ai_summary_length: 'standard', ai_tone: 'technical', ai_temperature: '', ai_extraction_goals: '' });
    const stored = { ...STORED, ai_provider: 'openai', ai_model: 'gpt-4o' };
    const { form } = storedSummary(stored);
    expect(summaryChanged(stored, form, [])).toBe(false);
    const wording = { ...wordingOf(stored), ai_summary_length: 'brief', ai_temperature: ' 0.4 ', ai_extraction_goals: 'methods' };
    expect(summaryChanged(stored, form, [], wording)).toBe(true);
    expect(summaryPayload(stored, form, [], wording)).toMatchObject({
      ai_summary_length: 'brief', ai_tone: 'technical', ai_temperature: '0.4', ai_extraction_goals: 'methods',
    });
  });

  test('a temperature from 0 to 1, and an endpoint that does not send the key in the clear', () => {
    expect(temperatureProblem('')).toBeNull();
    expect(temperatureProblem('0.7')).toBeNull();
    expect(temperatureProblem('1.5')).toBe('A temperature is a number from 0 to 1.');
    expect(temperatureProblem('warm')).toBe('A temperature is a number from 0 to 1.');
    expect(baseUrlProblem('https://api.example.com/v1')).toBeNull();
    expect(baseUrlProblem('http://127.0.0.1:4141/v1')).toBeNull();
    expect(baseUrlProblem('http://[::1]:4141/v1')).toBeNull();
    expect(baseUrlProblem('http://api.example.com/v1')).toMatch(/^Plain HTTP is used only on this computer/);
    expect(baseUrlProblem('api.example.com')).toMatch(/^An endpoint is a whole address/);
  });

  test('each provider comes back with the model it was last saved with, and nothing of another provider’s', () => {
    const stored = { ...STORED, ai_provider: 'claude_code', ai_cli_path: '/opt/claude', ai_effort: 'high',
      ai_default_models: JSON.stringify({ openai: 'gpt-4o-mini', broken: 3 }) };
    const start = storedSummary(stored).form;
    expect(rememberedModels(stored)).toEqual({ openai: 'gpt-4o-mini' });
    const toOpenai = switchProvider(start, 'openai', start, rememberedModels(stored));
    expect(toOpenai).toMatchObject({ ai_provider: 'openai', ai_model: 'gpt-4o-mini', ai_cli_path: '', ai_effort: '' });
    expect(switchProvider(start, 'codex', start, {})).toMatchObject({ ai_model: '', ai_cli_path: '', doc_cap: '' });
    expect(switchProvider(toOpenai, 'claude_code', start, {})).toEqual(start);
    // Saving remembers the model for its provider, without dropping the others.
    const payload = summaryPayload(stored, { ...toOpenai, ai_model: 'gpt-4.1' }, []);
    expect(JSON.parse(payload.ai_default_models!)).toEqual({ openai: 'gpt-4.1' });
    expect(summaryPayload(stored, toOpenai, [])).not.toHaveProperty('ai_default_models');
    expect(rememberedModels({ ...STORED, ai_default_models: '{not json' })).toEqual({});
  });

  test('a provider that is not a command carries no cap, so a saved switch away from a command reads back as saved', () => {
    const command = { ...STORED, ai_provider: 'claude_code', ai_subscription_doc_cap: '20' };
    const start = storedSummary(command).form;
    expect(start.doc_cap).toBe('20');
    const form = { ...switchProvider(start, 'openai', start, {}), ai_model: 'gpt-4o' };
    const after = { ...command, ...summaryPayload(command, form, []) };
    expect(storedSummary(after).form.doc_cap).toBe('');
    expect(summaryChanged(after, form, [])).toBe(false);
  });

  test('effort levels: the model’s own, else every level listed, else the ones known without a list', () => {
    const catalog = { models: ['a', 'b'], efforts: { a: ['low', 'high'], b: ['medium'] } };
    expect(effortsFor(catalog, 'a', ['x'])).toEqual(['low', 'high']);
    expect(effortsFor(catalog, 'c', ['x'])).toEqual(['low', 'high', 'medium']);
    expect(effortsFor(null, '', ['low', 'max'])).toEqual(['low', 'max']);
    expect(effortsFor({ models: ['m'] }, 'm', [])).toEqual([]);
  });

  test('fallbacks added and reordered on the screen are what the chain stores', () => {
    const { form, fallbacks } = storedSummary(WITH_CHAIN);
    const added = entryOf({ provider: 'openai', model: 'gpt-4o-mini' })!;
    const chain = JSON.parse(composeChain(form, moveFallback([...fallbacks, added], 1, -1))) as Record<string, unknown>[];
    expect(chain.map((lane) => lane.provider)).toEqual(['custom', 'openai', 'local']);
    expect(summaryChanged(WITH_CHAIN, form, [...fallbacks, added])).toBe(true);
  });
});

describe('summaries for one run or one watch', () => {
  const own = (patch: Partial<SummaryChoice>): SummaryChoice => ({ ...NO_CHOICE, on: true, lane: 'own', ...patch });

  test('a stored choice reads as the form: from its chain, or from a provider saved without one', () => {
    expect(choiceOf(false, null)).toEqual(NO_CHOICE);
    expect(choiceOf(true, '{"tone":"plain"}')).toMatchObject({ on: true, lane: 'settings', tone: 'plain', keptChain: null });
    expect(choiceOf(true, { provider: 'OpenAI', model: 'gpt-4o', temperature: 0.3 }))
      .toMatchObject({ lane: 'own', provider: 'openai', model: 'gpt-4o', temperature: '0.3', keptChain: null });
    const chain = JSON.stringify([{ kind: 'local', provider: 'local', model: 'qwen3' }, { kind: 'api_key', provider: 'xai', model: 'g' }]);
    expect(choiceOf(true, JSON.stringify({ provider: 'local', chain }))).toMatchObject({ lane: 'own', provider: 'local', model: 'qwen3', keptChain: chain });
    expect(choiceOf(true, 'not json')).toMatchObject({ on: true, lane: 'settings' });
  });

  test('a lane of its own is sent as the one-lane chain the engine runs, reached as Settings › AI reaches it', () => {
    const override = overrideOf(own({ provider: 'custom', model: 'authored-model', length: 'brief', temperature: ' 0.7 ' }), WITH_CHAIN);
    expect(override).toEqual({
      provider: 'custom', model: 'authored-model', length: 'brief', temperature: '0.7',
      chain: JSON.stringify([{ kind: 'api_key', provider: 'custom', model: 'authored-model', credential_alias: 'custom_llm_api_key', base_url: ENDPOINT }]),
    });
    const command = { ...STORED, ai_provider: 'claude_code', ai_cli_path: '/opt/claude' };
    expect(JSON.parse(overrideOf(own({ provider: 'claude_code', model: 'opus' }), command).chain as string))
      .toEqual([{ kind: 'subscription', provider: 'claude_code', model: 'opus', binary_path: '/opt/claude' }]);
    // A path to one command is not a path to the other.
    expect(JSON.parse(overrideOf(own({ provider: 'codex' }), command).chain as string)).toEqual([{ kind: 'subscription', provider: 'codex' }]);
  });

  test('as in Settings › AI sends only what is set here, keeps keys it does not know, and clears to nothing', () => {
    expect(overrideOf({ ...NO_CHOICE, on: true, tone: 'neutral' }, WITH_CHAIN, '{"provider":"openai","model":"x","future":1}'))
      .toEqual({ tone: 'neutral', future: 1 });
    expect(overrideOf({ ...NO_CHOICE, on: true }, WITH_CHAIN, null)).toEqual({});
    // A stored chain is sent back exactly until the lane is changed here.
    const kept = own({ provider: 'local', model: 'qwen3', keptChain: '[{"kind":"local","provider":"local","model":"qwen3"}]' });
    expect(overrideOf(kept, WITH_CHAIN).chain).toBe(kept.keptChain);
  });

  test('which lanes run, said in words that match the engine', () => {
    expect(settingsLanes(WITH_CHAIN).map((e) => e.lane.provider)).toEqual(['custom', 'local']);
    expect(settingsLanes({ ...STORED, ai_provider: 'openai', ai_model: 'gpt-4o' }).map((e) => e.lane.model)).toEqual(['gpt-4o']);
    expect(settingsLanes(STORED)).toEqual([]);
    expect(choiceLanes(own({ provider: 'xai', model: 'grok-4' }), WITH_CHAIN).map((e) => e.lane.provider)).toEqual(['xai']);

    expect(choiceSentence(NO_CHOICE, WITH_CHAIN, 'this run')).toBe('Off: the papers are found and kept, with no summary.');
    expect(choiceSentence({ ...NO_CHOICE, on: true }, WITH_CHAIN, 'this run'))
      .toBe(`With Custom endpoint · authored-model, at ${ENDPOINT}, with its key, then Ollama · llama3, on this computer, as Settings › AI holds them when a run starts.`);
    expect(choiceSentence(own({ provider: 'xai', model: 'grok-4' }), WITH_CHAIN, 'this watch'))
      .toBe('With xAI · grok-4, with your xAI key, set for this watch. The connections in Settings › AI are not tried.');
    expect(choiceSentence({ ...NO_CHOICE, on: true }, STORED, 'this run')).toMatch(/^Settings › AI has no provider chosen/);
    expect(wordingSet(own({ length: 'brief', extraction_goals: 'methods' }))).toEqual(['length', 'what to draw out']);
    // Where no switch beside it says whether it is on, the sentence does.
    expect(stateSentence(own({ provider: 'xai', model: 'grok-4' }), WITH_CHAIN, 'this watch')).toMatch(/^On, with xAI · grok-4, with your xAI key/);
    expect(stateSentence({ ...NO_CHOICE, on: true }, STORED, 'this watch')).toMatch(/^On, but Settings › AI has no provider chosen/);
    expect(stateSentence(NO_CHOICE, WITH_CHAIN, 'this watch')).toBe('Off: the papers are found and kept, with no summary.');
  });
});
