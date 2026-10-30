import {
  composeChain, laneWords, planLimits, readChain, routeSentence, storedSummary, summaryChanged, summaryPayload,
  type AiSettings,
} from '../summaryLanes';
import {
  embeddedWords, estimateWords, indexWords, missingWords, nothingToEmbedWords, orderProviders, outcomeWords,
  progressWords, providerLabel, ranking, rebuiltWords, type EmbeddingStatus, type ProviderAnswer,
} from '../embeddingWords';

const STORED: AiSettings = {
  ai_chain: '', ai_cli_path: '', ai_custom_base_url: '', ai_custom_header_prefix: 'Bearer', ai_default_models: '',
  ai_effort: '', ai_extraction_goals: '', ai_local_endpoint: '', ai_local_model: '', ai_model: '', ai_provider: '',
  ai_show_audit_prefix: '', ai_subscription_doc_cap: '', ai_summary_length: '', ai_temperature: '', ai_tone: '',
};

/** A chain as the classic Settings stores it: a command first, then a key and a local model. */
const CLASSIC_CHAIN = [
  { kind: 'subscription', provider: 'claude_code', model: 'sonnet', binary_path: '/opt/claude', effort: 'high', doc_cap: 20, batch_size: 3 },
  { kind: 'api_key', provider: 'openai', model: 'gpt-4o-mini', label: 'OpenAI · gpt-4o-mini' },
  { kind: 'local', provider: 'local', model: 'llama3', endpoint: 'http://127.0.0.1:11500', future_field: 'kept' },
];
const chained = (chain: unknown, extra: Partial<AiSettings> = {}): AiSettings => ({
  ...STORED, ai_provider: 'claude_code', ai_model: 'sonnet', ...extra, ai_chain: JSON.stringify(chain),
});

describe('the summary chain, read as the engine reads it', () => {
  test('entries the engine skips are skipped, and the first usable lane is the main one', () => {
    const { entries, unreadable } = readChain(JSON.stringify([
      'not a lane', { kind: 'telepathy', provider: 'x' }, { kind: 'api_key' }, { kind: ' API_KEY ', provider: 'OpenAI', model: ' gpt ' },
      { kind: 'subscription', provider: 'codex', doc_cap: '0', batch_size: 'two' },
    ]));
    expect(unreadable).toBe(false);
    expect(entries.map((e) => e.lane)).toEqual([
      { kind: 'api_key', provider: 'openai', model: 'gpt', endpoint: null, base_url: null, binary_path: null, effort: null, doc_cap: null, batch_size: null },
      { kind: 'subscription', provider: 'codex', model: null, endpoint: null, base_url: null, binary_path: null, effort: null, doc_cap: null, batch_size: null },
    ]);
  });

  test('a chain with nothing usable in it is ignored by the engine, and said to be', () => {
    expect(readChain('{not json')).toEqual({ entries: [], unreadable: true });
    expect(readChain('{"kind": "api_key"}')).toEqual({ entries: [], unreadable: true });
    expect(readChain('[]')).toEqual({ entries: [], unreadable: true });
    expect(readChain('')).toEqual({ entries: [], unreadable: false });
    const summary = storedSummary({ ...STORED, ai_provider: 'openai', ai_model: 'gpt-4o', ai_chain: '[{"kind": 1}]' });
    expect(summary.unreadable).toBe(true);
    expect(summary.form.ai_provider).toBe('openai');
  });

  test('the form starts from the chain’s first lane, not from the single keys it overrides', () => {
    const stored = chained(CLASSIC_CHAIN, { ai_provider: 'openai', ai_model: 'stale', ai_cli_path: '/stale/claude' });
    const summary = storedSummary(stored);
    expect(summary.form).toEqual({
      ai_provider: 'claude_code', ai_model: 'sonnet', ai_cli_path: '/opt/claude', ai_effort: 'high',
      ai_custom_base_url: '', ai_local_endpoint: '',
    });
    expect(summary.fallbacks.map((f) => f.lane.provider)).toEqual(['openai', 'local']);
    expect(planLimits(stored)).toEqual({ batch: 3, cap: 20 });
  });

  test('Ollama with no chain reads ai_local_model first, as the engine does', () => {
    const summary = storedSummary({ ...STORED, ai_provider: 'local', ai_model: 'old', ai_local_model: 'llama3', ai_local_endpoint: 'http://h:1' });
    expect(summary.form.ai_model).toBe('llama3');
    expect(summary.form.ai_local_endpoint).toBe('http://h:1');
  });
});

describe('the summary chain, written back', () => {
  test('a change to the main lane keeps every fallback exactly as it was stored, and the cap and batch size', () => {
    const stored = chained(CLASSIC_CHAIN);
    const { form, fallbacks } = storedSummary(stored);
    const payload = summaryPayload(stored, { ...form, ai_model: 'opus' }, fallbacks);
    const written = JSON.parse(payload.ai_chain!) as Record<string, unknown>[];
    expect(written[0]).toEqual({
      kind: 'subscription', provider: 'claude_code', model: 'opus', binary_path: '/opt/claude', effort: 'high', doc_cap: 20, batch_size: 3,
    });
    expect(written.slice(1)).toEqual(CLASSIC_CHAIN.slice(1));
    expect(payload.ai_provider).toBe('claude_code');
    expect(payload.ai_model).toBe('opus');
    expect(payload.ai_cli_path).toBe('/opt/claude');
  });

  test('the round trip: what is written reads back as the form and fallbacks that wrote it', () => {
    const stored = chained(CLASSIC_CHAIN);
    const { form, fallbacks } = storedSummary(stored);
    const next = { ...form, ai_effort: 'low' };
    const after: AiSettings = { ...stored, ...summaryPayload(stored, next, fallbacks) };
    const again = storedSummary(after);
    expect(again.form).toEqual(next);
    expect(again.fallbacks.map((f) => f.raw)).toEqual(CLASSIC_CHAIN.slice(1));
    expect(summaryChanged(after, next, fallbacks)).toBe(false);
    expect(summaryChanged(stored, next, fallbacks)).toBe(true);
  });

  test('a removed fallback is gone from the chain, and the rest keep their order', () => {
    const stored = chained(CLASSIC_CHAIN);
    const { form, fallbacks } = storedSummary(stored);
    const kept = fallbacks.filter((f) => f.lane.provider !== 'openai');
    expect(summaryChanged(stored, form, kept)).toBe(true);
    const written = JSON.parse(composeChain(form, kept, stored)) as Record<string, unknown>[];
    expect(written.map((lane) => lane.provider)).toEqual(['claude_code', 'local']);
    expect(written[1]).toEqual(CLASSIC_CHAIN[2]);
  });

  test('no chain where it would say nothing the single keys do not; a command always gets one', () => {
    const plain = { ...STORED, ai_provider: 'openai', ai_model: 'gpt-4o' };
    expect(composeChain(storedSummary(plain).form, [], plain)).toBe('');
    expect(composeChain({ ...storedSummary(plain).form, ai_provider: '' }, [], plain)).toBe('');
    const legacyCommand = { ...STORED, ai_provider: 'codex', ai_cli_path: '/bin/codex', ai_subscription_doc_cap: '30' };
    expect(JSON.parse(composeChain(storedSummary(legacyCommand).form, [], legacyCommand))).toEqual([
      { kind: 'subscription', provider: 'codex', binary_path: '/bin/codex', doc_cap: 30 },
    ]);
    // Moving the main lane to a key with fallbacks still stored writes the key lane first.
    const stored = chained(CLASSIC_CHAIN);
    const { fallbacks } = storedSummary(stored);
    const toKey = { ...storedSummary(stored).form, ai_provider: 'custom', ai_model: 'm', ai_custom_base_url: 'https://e/v1' };
    expect(JSON.parse(composeChain(toKey, fallbacks, stored))[0]).toEqual({
      kind: 'api_key', provider: 'custom', model: 'm', credential_alias: 'custom_llm_api_key', base_url: 'https://e/v1',
    });
  });

  test('Ollama’s model goes to both keys it is read from, so a stale one cannot win', () => {
    const stored = { ...STORED, ai_provider: 'local', ai_local_model: 'stale' };
    const payload = summaryPayload(stored, { ...storedSummary(stored).form, ai_model: 'llama3', ai_local_endpoint: 'http://h:2' }, []);
    expect(payload).toMatchObject({ ai_model: 'llama3', ai_local_model: 'llama3', ai_local_endpoint: 'http://h:2', ai_chain: '' });
    expect(summaryPayload({ ...STORED, ai_provider: 'openai' }, storedSummary({ ...STORED, ai_provider: 'openai' }).form, []))
      .not.toHaveProperty('ai_local_model');
  });

  test('each fallback in a sentence, saying when a run will skip it', () => {
    const [key, local] = storedSummary(chained(CLASSIC_CHAIN)).fallbacks;
    expect(laneWords(key!.lane)).toBe('OpenAI · gpt-4o-mini, with your OpenAI key');
    expect(laneWords(local!.lane)).toBe('Ollama · llama3, on http://127.0.0.1:11500');
    const [main] = readChain(JSON.stringify([{ kind: 'subscription', provider: 'codex' }, { kind: 'api_key', provider: 'xai' }])).entries;
    expect(laneWords(main!.lane)).toBe('Codex · the command’s default model, on your ChatGPT plan');
    expect(laneWords({ ...key!.lane, model: null })).toBe('OpenAI, with no model set, so a run skips it');
  });
});

describe('the ways Ask can run, claiming only what was checked', () => {
  test('a command that was found is not said to run: sign-in and the model are unverified', () => {
    const said = routeSentence('claude_cli', true, 'Found where the installer puts it: /Users/x/.local/bin/claude', true);
    expect(said).toBe('Found where the installer puts it: /Users/x/.local/bin/claude. Sign-in and model acceptance are unverified until the first message.');
    expect(said).not.toMatch(/can run/);
  });

  test('a key keeps the engine’s own caveat, and what cannot run says so', () => {
    expect(routeSentence('api_key', true, 'Whether the key is accepted is not known until the first turn.', false))
      .toBe('Whether the key is accepted is not known until the first turn.');
    expect(routeSentence('claude_cli', false, 'Claude CLI executable not found', true)).toBe('cannot run. Claude CLI executable not found.');
    expect(routeSentence('codex_cli', false, 'Codex is not offered for the assistant.', false)).toBe('Codex is not offered for the assistant.');
  });
});

const STATUS: EmbeddingStatus = {
  run: { running: false, model: null, processed: 0, total: 0, skipped_no_text: 0, started_at: null, finished_at: null, cancelled: false, reason: null },
  coverage: { embedded: 0, total: 16065, model: null },
  extension: { extension: 'v0.1.9', reason: null },
  index: { model: null, dims: null, rows: 0 },
  lane: null,
  capability: { available: false, extension: 'v0.1.9', reason: 'The vector extension is loaded, but nothing is embedded yet.', model: null, indexed: 0 },
};
const LANE = {
  kind: 'local', provider: 'local', model: 'nomic-embed-text', endpoint: 'http://localhost:11434', base_url: null,
  credential_alias: null, batch_size: 32, dims: 768, input_limit: null,
};
const withModel = (embedded: number, rows: number, extra: Partial<EmbeddingStatus> = {}): EmbeddingStatus => ({
  ...STATUS, lane: LANE,
  coverage: { embedded, total: 16065, model: 'nomic-embed-text' },
  index: { model: rows ? 'nomic-embed-text' : null, dims: rows ? 768 : null, rows },
  capability: { ...STATUS.capability, available: rows > 0, model: 'nomic-embed-text', indexed: rows },
  ...extra,
});

describe('what is embedded and what is missing, counted', () => {
  test('no model: nothing embedded, every paper missing, and ranking says why with somewhere to go', () => {
    expect(embeddedWords(STATUS)).toBe('None: no embedding model is set up.');
    expect(missingWords(STATUS)).toBe('16,065 papers: no embedding model is set up to make vectors.');
    const rank = ranking(STATUS);
    expect(rank).toEqual({
      available: false, action: 'Set one up in Settings → AI → Embeddings',
      sentence: 'Ranking by meaning is off: no embedding model is set up, so none of your 16,065 papers has a vector.',
    });
  });

  test('a model and nothing embedded yet: the count of papers without vectors, and that they are kept', () => {
    const status = withModel(0, 0);
    expect(embeddedWords(status)).toBe('0 of 16,065 papers, with nomic-embed-text.');
    expect(missingWords(status)).toBe('16,065 papers have no vector from nomic-embed-text yet. They are kept and searchable by their words, '
      + 'and are listed last when the collection is ranked by meaning.');
    expect(ranking(status)).toMatchObject({
      available: false, action: 'Embed them in Settings → AI → Embeddings',
      sentence: 'Ranking by meaning is off: none of your 16,065 papers has a vector from nomic-embed-text yet.',
    });
    expect(indexWords(status)).toBe('sqlite-vec v0.1.9, empty.');
  });

  test('vectors in the table and none in the index: ranking says so, and the index says to rebuild', () => {
    const status = withModel(15000, 0);
    expect(ranking(status).sentence).toBe('Ranking by meaning is off: 15,000 of your 16,065 papers have a vector from nomic-embed-text, '
      + 'but the similarity index holds none of them.');
    expect(ranking(status).action).toBe('Rebuild it in Settings → AI → Embeddings');
    expect(indexWords(status)).toBe('sqlite-vec v0.1.9, holding none of the 15,000 vectors from nomic-embed-text. Rebuild it below.');
    expect(indexWords(withModel(15000, 14000))).toBe('sqlite-vec v0.1.9, holding 14,000 of the 15,000 vectors from nomic-embed-text. Rebuild it below.');
  });

  test('ranking on, with the papers still missing counted and listed last', () => {
    const status = withModel(16000, 16000);
    expect(ranking(status)).toEqual({
      available: true, action: null,
      sentence: 'Ranking by meaning is on. 65 papers without a vector from nomic-embed-text are listed last.',
    });
    expect(indexWords(status)).toBe('sqlite-vec v0.1.9, holding 16,000 vectors, 768 dimensions each.');
    expect(missingWords(withModel(16065, 16065))).toBe('None.');
    expect(ranking(withModel(16065, 16065)).sentence).toBe('Ranking by meaning is on.');
  });

  test('a missing extension is named, with its reason, and the vectors are said to be kept', () => {
    const status = withModel(300, 0, {
      extension: { extension: null, reason: 'sqlite-vec is not installed.' },
      capability: { available: false, extension: null, reason: 'sqlite-vec is not installed.', model: 'nomic-embed-text', indexed: 0 },
    });
    expect(ranking(status).sentence).toBe('Ranking by meaning is off: the similarity index (sqlite-vec) did not load in this copy of resmon '
      + '(sqlite-vec is not installed). The 300 vectors from nomic-embed-text are kept.');
    expect(indexWords(status)).toMatch(/^Not loaded: sqlite-vec is not installed\. Nothing can be ranked by meaning/);
  });

  test('the last backfill’s papers with nothing to embed are counted as the reason they stay missing', () => {
    const status = withModel(16000, 16000, {
      run: { ...STATUS.run, model: 'nomic-embed-text', finished_at: '2026-10-29T20:00:00Z', processed: 120, total: 125, skipped_no_text: 5 },
    });
    expect(missingWords(status)).toContain('The last backfill found 5 papers with no title or abstract to embed; they stay missing.');
  });

  test('an empty collection is not a missing model', () => {
    const empty = { ...withModel(0, 0), coverage: { embedded: 0, total: 0, model: 'nomic-embed-text' } };
    expect(missingWords(empty)).toBe('None: your collection is empty.');
    expect(ranking(empty).action).toBeNull();
  });
});

describe('a backfill: priced first, then counted while it runs and after', () => {
  test('the estimate says the papers, the tokens, and the money only where resmon has a price', () => {
    expect(estimateWords({ documents: 3, estimated_tokens: 210, cost_usd: 0, disk_bytes: null, disk_note: '', note: 'A local model runs on your machine and costs nothing to call.' }))
      .toBe('3 papers to embed, about 210 tokens. A local model runs on your machine and costs nothing to call.');
    expect(estimateWords({ documents: 16065, estimated_tokens: 4_000_000, cost_usd: 0.08, disk_bytes: 1, disk_note: '', note: 'At 0.02 USD per million input tokens' }))
      .toBe('16,065 papers to embed, about 4,000,000 tokens. About $0.08. At 0.02 USD per million input tokens.');
    expect(estimateWords({ documents: 1, estimated_tokens: 70, cost_usd: 0.0000014, disk_bytes: 1, disk_note: '', note: 'Priced.' }))
      .toContain('Less than $0.01.');
    expect(estimateWords({ documents: 0, estimated_tokens: 0, cost_usd: 0, disk_bytes: null, disk_note: '', note: '' }))
      .toBe('Nothing to embed: every paper with a title or an abstract has a vector.');
    expect(nothingToEmbedWords(5, 3)).toBe('2 other papers have no title or abstract, so there is nothing to embed for them.');
    expect(nothingToEmbedWords(3, 3)).toBeNull();
  });

  test('progress, a stop, a refusal, and a finish each say what happened', () => {
    const run = { ...STATUS.run, running: true, model: 'nomic-embed-text', total: 3000, processed: 64 };
    expect(progressWords(run)).toBe('Embedding with nomic-embed-text: 64 of 3,000 papers so far.');
    expect(progressWords({ ...run, total: 0 })).toBe('Starting: finding the papers with no vector from nomic-embed-text.');
    expect(outcomeWords(run)).toBeNull();
    const done = { ...run, running: false, finished_at: '2026-10-29T20:00:00Z' };
    expect(outcomeWords({ ...done, cancelled: true, reason: 'Cancelled. The documents already embedded keep their vectors.' }))
      .toBe('Stopped after 64 of 3,000 papers, as asked. The vectors made are kept; embedding again starts from the papers still missing.');
    expect(outcomeWords({ ...done, reason: 'nomic-embed-text is not an embedding model.' }))
      .toBe('Stopped after 64 of 3,000 papers: nomic-embed-text is not an embedding model.');
    expect(outcomeWords({ ...done, processed: 2998, skipped_no_text: 2 }))
      .toBe('Embedded 2,998 of 3,000 papers with nomic-embed-text. 2 papers had no title or abstract to embed.');
  });

  test('a rebuild reports what the index now holds, or why it could not', () => {
    expect(rebuiltWords({ ok: true, rebuilt: 3, dims: 8, reason: null })).toBe('Rebuilt: the index holds 3 vectors, 8 dimensions each.');
    expect(rebuiltWords({ ok: true, rebuilt: 0, dims: null, reason: "No documents are embedded with 'm'." })).toBe("No documents are embedded with 'm'.");
    expect(rebuiltWords({ ok: false, rebuilt: 0, dims: null, reason: 'sqlite-vec is not installed.' })).toBe('Not rebuilt: sqlite-vec is not installed.');
  });
});

describe('the providers, every one listed with its answer', () => {
  const answer = (provider: string, state: string): ProviderAnswer => ({
    provider, state, reason: '', evidence: null, offered: state !== 'no', default_model: null, suggested_models: [],
  });
  test('Ollama first, then those that embed, those unverified, and those that cannot', () => {
    const ordered = orderProviders([
      answer('anthropic', 'no'), answer('custom', 'unknown'), answer('openai', 'yes'), answer('local', 'yes'),
      answer('claude_code', 'no'), answer('google', 'yes'), answer('deepseek', 'unknown'),
    ]);
    expect(ordered.map(providerLabel)).toEqual([
      'Ollama, on this computer', 'Google', 'OpenAI', 'A custom endpoint — unverified', 'DeepSeek — unverified',
      'Anthropic — cannot embed', 'Claude Code — cannot embed',
    ]);
  });
});
