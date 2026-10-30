import { frames, type Choices, type TurnEvent } from '../askApi';
import {
  answerFooterWords, answeredWords, applyEvent, callText, choiceProblem, costWords, describeCall, failureTitle, firstChoice,
  reportWords, requestedWords, savedCalls, shortToolName, startLive,
} from '../askModel';
import type { TurnChoices } from '../askApi';

const choices = (over: Partial<Choices> = {}): Choices => ({
  version: 1, default_request: null, default_error: null, claude_aliases: ['opus', 'sonnet', 'haiku'],
  claude_efforts: ['low', 'medium', 'high'], limitations: 'Local prerequisites are not authentication.',
  connections: [
    { runtime: 'claude_cli', provider: 'claude_code', label: 'Claude Code', implemented: true, available: false,
      reason: 'Claude CLI executable not found.', effort_supported: true },
    { runtime: 'api_key', provider: 'custom', label: 'custom', implemented: true, available: true,
      reason: 'Key configured; authentication and model acceptance are unverified.', effort_supported: false, family: 'openai_chat' },
    { runtime: null, provider: 'local', label: 'Ollama', implemented: false, available: false,
      reason: 'No tool calling.', effort_supported: false },
  ],
  ...over,
} as Choices);

test('frames: whole events only, heartbeats and malformed frames dropped, the partial frame kept', () => {
  const { events, rest } = frames(
    ': heartbeat\n\nevent: assistant\ndata: {"type":"text_delta","text":"Hel"}\n\n'
    + 'data: not json\n\ndata: {"no":"type"}\n\ndata: {"type":"done"',
  );
  expect(events).toEqual([{ type: 'text_delta', text: 'Hel' }]);
  expect(rest).toBe('data: {"type":"done"');
  expect(frames(`${rest}}\n\n`).events).toEqual([{ type: 'done' }]);
});

test('a live turn: text and calls go to one assistant message, results mark their own call, cards queue', () => {
  const events: TurnEvent[] = [
    { type: 'turn_choices', session_id: 7, user_message_id: 40, requested: {
      version: 1, runtime: 'claude_cli', provider: 'claude_code', requested_model: 'm-1', requested_effort: 'high',
      model_basis: 'explicit', effort_basis: 'explicit', binding_basis: 'new' } as never },
    { type: 'turn_model_report', session_id: 7, user_message_id: 40,
      reported: { model: 'm-1', source: 'claude_system_init_model', observed_at_utc: 't' } },
    { type: 'text_delta', text: 'Looking' },
    { type: 'tool_call', tool_name: 'mcp__resmon__list_sources', tool_use_id: 'a', input: {} },
    { type: 'tool_call', tool_name: 'mcp__resmon__create_routine', tool_use_id: 'b', input: { name: 'R' } },
    { type: 'tool_result', tool_use_id: 'a', is_error: false },
    { type: 'permission_request', request_id: 'p1', tool_name: 'mcp__resmon__create_routine', input: { name: 'R' } },
    { type: 'text_delta', text: ' now.' },
    { type: 'something_new', text: 'never drawn' },
  ];
  const live = events.reduce(applyEvent, startLive(7, 'Make a watch'));
  expect(live.messages).toEqual([
    { role: 'user', text: 'Make a watch', calls: [] },
    { role: 'assistant', text: 'Looking now.', calls: [
      { name: 'mcp__resmon__list_sources', input: {}, id: 'a', outcome: 'ok' },
      { name: 'mcp__resmon__create_routine', input: { name: 'R' }, id: 'b' },
    ] },
  ]);
  expect(live.cards).toEqual([{ requestId: 'p1', tool: 'mcp__resmon__create_routine', input: { name: 'R' } }]);
  expect(live.turns).toHaveLength(1);
  expect(live.turns[0].reported).toEqual([{ sequence: 1, model: 'm-1', source: 'claude_system_init_model', observed_at_utc: 't' }]);
});

test('an event about another conversation is not drawn in this one', () => {
  const live = applyEvent(startLive(7, 'hi'), { type: 'turn_choices', session_id: 8, user_message_id: 1, requested: {} as never });
  expect(live.turns).toEqual([]);
});

test('an error event is kept, with the engine’s own words or a plain fallback', () => {
  expect(applyEvent(startLive(1, 'x'), { type: 'error', message: 'The claude CLI stopped with exit code 3' }).error)
    .toBe('The claude CLI stopped with exit code 3');
  expect(applyEvent(startLive(1, 'x'), { type: 'error' }).error).toBe('The turn failed without saying why.');
});

test('a card holds the exact call, and its sentence never describes a tool it does not know', () => {
  const input = { name: 'Journey routine', schedule: '0 7 * * 1', repositories: ['arxiv'] };
  expect(callText('mcp__resmon__create_routine', input)).toBe(`create_routine(${JSON.stringify(input, null, 2)})`);
  expect(describeCall('mcp__resmon__create_routine', input)).toBe('Create a watch called “Journey routine”, switched off');
  expect(describeCall('mcp__resmon__erase_everything', {})).toBe('Run erase_everything');
  expect(shortToolName('list_sources')).toBe('list_sources');
});

test('requested and reported are two claims, and an unnamed model is not guessed', () => {
  const bound = {
    version: 1, runtime: 'claude_cli', provider: 'claude_code', requested_model: null, requested_effort: null,
    model_basis: 'runtime_default', effort_basis: 'runtime_default', binding_basis: 'new', created_at_utc: 't',
  } as never;
  expect(requestedWords(bound)).toBe('Claude Code · the default model (not known here) · effort default (not known here)');
  expect(requestedWords({ ...(bound as object), runtime: 'api_key', provider: 'custom', requested_model: 'm-2' } as never))
    .toBe('a custom API · m-2 · effort not supported by this connection');
  expect(requestedWords(null)).toMatch(/^Not recorded/);
  expect(requestedWords({ unreadable: true } as never)).toMatch(/^Unreadable/);
  expect(reportWords({ model: 'm-1', source: 'api_response_model' })).toBe('m-1, named in the provider’s reply');
  expect(reportWords({ model: 'm-1', source: 'future_source' })).toBe('m-1, future_source');
});

test('a cost nobody reported is not zero', () => {
  expect(costWords(null)).toBe('Cost not reported');
  expect(costWords(undefined)).toBe('Cost not reported');
  expect(costWords(0)).toBe('Reported cost $0.0000, not an invoice');
});

test('the composer starts from the settings default, else the first connection that can run', () => {
  expect(firstChoice(choices())).toEqual({ version: 1, runtime: 'api_key', provider: 'custom', model: null, effort: null });
  const fixed = { version: 1, runtime: 'claude_cli', provider: 'claude_code', model: 'opus', effort: 'low' } as const;
  expect(firstChoice(choices({ default_request: fixed as never }))).toEqual(fixed);
  expect(firstChoice(undefined)).toBeNull();
  // The engine refuses a choice with any key but these five; a reply that carries more is not passed on.
  const wider = { ...fixed, observed_at: 'later' };
  expect(Object.keys(firstChoice(choices({ default_request: wider as never })) ?? {}).sort())
    .toEqual(['effort', 'model', 'provider', 'runtime', 'version']);
});

test('a choice cannot be sent to an unavailable connection, or to an API connection with no model', () => {
  const c = choices();
  expect(choiceProblem(c, null)).toBe('Choose a connection first.');
  expect(choiceProblem(c, { version: 1, runtime: 'claude_cli', provider: 'claude_code', model: null, effort: null }))
    .toBe('Claude CLI executable not found.');
  expect(choiceProblem(c, { version: 1, runtime: 'api_key', provider: 'custom', model: ' ', effort: null }))
    .toMatch(/needs a model ID/);
  expect(choiceProblem(c, { version: 1, runtime: 'api_key', provider: 'custom', model: 'm', effort: null })).toBeNull();
});

test('saved tool calls are drawn only when they are the shape resmon writes', () => {
  const message = (tool_calls: unknown) => ({ tool_calls } as never);
  expect(savedCalls(message(null))).toEqual([]);
  expect(savedCalls(message([{ name: 'list_sources', input: {} }]))).toEqual([{ name: 'list_sources', input: {} }]);
  expect(savedCalls(message({ unreadable: true }))).toBeNull();
  expect(savedCalls(message([{ input: {} }]))).toBeNull();
});

describe('which model answered, said beside what was asked for', () => {
  const requested = {
    version: 1, runtime: 'claude_cli', provider: 'claude_code', requested_model: 'haiku', requested_effort: 'high',
    model_basis: 'explicit', effort_basis: 'explicit', binding_basis: 'new',
  } as TurnChoices['requested'];
  const turn = (name: string | null, over: Partial<TurnChoices> = {}): TurnChoices => ({
    user_message_id: 1, assistant_message_id: 2, version: 1, created_at_utc: 't', requested, reported: [],
    answered_by: name ? { model: `id-${name}`, name, source: 'claude_result_model_usage' } : null, failure: null, ...over,
  } as TurnChoices);

  test('the header names the answering model, and says "last" when answers came from more than one', () => {
    expect(answeredWords([turn('Haiku 5.5'), turn(null), turn('Haiku 5.5')])).toBe('answered by Haiku 5.5');
    expect(answeredWords([turn('Haiku 4.5'), turn('Haiku 5.5')])).toBe('last answered by Haiku 5.5');
    expect(answeredWords([turn(null)])).toBeNull();
    expect(requestedWords(requested, answeredWords([turn('Haiku 5.5')])))
      .toBe('Claude Code · haiku (answered by Haiku 5.5) · effort high');
    expect(requestedWords(requested)).toBe('Claude Code · haiku · effort high');
  });

  test('an answer’s footer: the model it reported, the effort asked for, and the cost', () => {
    expect(answerFooterWords(turn('Haiku 5.5'), 0.0123)).toBe('Haiku 5.5 · high effort · Reported cost $0.0123, not an invoice');
    expect(answerFooterWords(turn(null), null)).toBe('Model not reported · high effort · Cost not reported');
    expect(answerFooterWords(turn('Opus 5.5', { requested: { ...requested, requested_effort: null } as TurnChoices['requested'] }), null))
      .toBe('Opus 5.5 · default effort · Cost not reported');
    // A message saved before turns were kept has no turn to read.
    expect(answerFooterWords(undefined, 0.5)).toBe('Reported cost $0.5000, not an invoice');
  });

  test('a report names its model where the id is recognized, and keeps the id beside it', () => {
    expect(reportWords({ model: 'claude-haiku-5-5', source: 'claude_result_model_usage', name: 'Haiku 5.5' }))
      .toBe('Haiku 5.5 (claude-haiku-5-5), billed for this answer, as the Claude CLI reported');
    expect(reportWords({ model: 'haiku', source: 'claude_system_init_model', name: 'haiku' }))
      .toBe('haiku, announced by the Claude CLI as it started');
  });

  test('a turn with no answer is headed as that, and a stopped one as stopped', () => {
    expect(failureTitle('cli_auth')).toBe('No answer');
    expect(failureTitle('failed')).toBe('No answer');
    expect(failureTitle('stopped')).toBe('Stopped before it answered');
  });
});
