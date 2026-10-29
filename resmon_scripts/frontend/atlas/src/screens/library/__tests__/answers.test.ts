import { canonical, citedText, terminal, type Source } from '../answersApi';
import { citationLabel, firstChoice, requestedWords, reportedWords, usageWords } from '../answersModel';

/** A selected range of a page: codepoints 10 to 35, starting with an emoji, so UTF-16 and codepoints differ. */
const source = (over: Partial<Source> = {}): Source => ({
  source_id: 'S01', original_name: 'paper.pdf', page_number: 2, start_codepoint: 10, end_codepoint: 35,
  text: '\u{1F989} owl and a comet ☄, kept', ...over,
} as Source);

test('canonical JSON is the engine’s: sorted keys, compact, literal Unicode, integers only', () => {
  expect(canonical({ b: 1, a: ['é', null, true] })).toBe('{"a":["é",null,true],"b":1}');
  expect(canonical({ z: { y: 'x\n' } })).toBe('{"z":{"y":"x\\n"}}');
  expect(() => canonical({ n: 1.5 })).toThrow();
  expect(() => canonical({ s: '\uD800' })).toThrow();
});

test('a citation is its source’s text at exactly its codepoint range, or it is not one', () => {
  const s = source();
  expect(Array.from(s.text)).toHaveLength(25);
  expect(citedText([s], { source_id: 'S01', start_codepoint: 10, end_codepoint: 14, quote: '' })).toBe('\u{1F989} ow');
  expect(citedText([s], { source_id: 'S01', start_codepoint: 12, end_codepoint: 15, quote: '' })).toBe('owl');
  expect(citedText([s], { source_id: 'S02', start_codepoint: 12, end_codepoint: 15, quote: '' })).toBeNull();
  expect(citedText([s], { source_id: 'S01', start_codepoint: 9, end_codepoint: 15, quote: '' })).toBeNull();
  expect(citedText([s], { source_id: 'S01', start_codepoint: 30, end_codepoint: 36, quote: '' })).toBeNull();
  expect(citedText([s], { source_id: 'S01', start_codepoint: 15, end_codepoint: 15, quote: '' })).toBeNull();
});

test('only admitted and running are not final', () => {
  expect(['admitted', 'running'].map(terminal)).toEqual([false, false]);
  expect(['succeeded', 'refused', 'failed', 'cancelled', 'interrupted'].every(terminal)).toBe(true);
});

test('asked for and reported are said apart, and a token count is never a cost', () => {
  const requested = { version: 1, runtime: 'api_key', provider: 'custom', requested_model: 'm-1', requested_effort: null,
    model_basis: 'explicit', effort_basis: 'not_supported', binding_basis: 'new' } as const;
  expect(requestedWords(requested)).toBe('a custom API, m-1, effort not supported');
  expect(requestedWords({ ...requested, runtime: 'claude_cli', provider: 'claude_code', requested_model: null }))
    .toBe('Claude Code, its default model (not known here), effort its default (not known here)');
  expect(reportedWords([])).toBe('No model was reported.');
  expect(reportedWords([{ model: 'r-1', source: 'api_response_model', observed_at_utc: '' }, { model: 'r-1', source: 'api_response_model', observed_at_utc: '' }]))
    .toBe('Reported model: r-1.');
  expect(usageWords(null)).toBe('No usage was reported. Billing is unknown.');
  expect(usageWords({ reported: { input_tokens: 0, output_tokens: 12 }, provenance: 'runtime_report', billing: 'unknown' }))
    .toBe('Reported tokens: 0 input, 12 output. Billing is unknown.');
});

test('the composer starts from the settings default, else the first connection that can run', () => {
  const connection = (provider: string, available: boolean) => ({
    runtime: 'api_key' as const, provider, label: provider, implemented: true, available, reason: '', effort_supported: false,
  });
  const base = { version: 1 as const, default_error: null, claude_aliases: [], claude_efforts: [], limitations: '' };
  expect(firstChoice({ ...base, default_request: null, connections: [connection('openai', false), connection('custom', true)] }))
    .toEqual({ version: 1, runtime: 'api_key', provider: 'custom', model: null, effort: null });
  expect(firstChoice({ ...base, default_request: null, connections: [connection('openai', false)] })).toBeNull();
});

test('a citation’s control names its source, file and page', () => {
  expect(citationLabel(source())).toBe('S01 · paper.pdf · page 2');
});
