import { restartFacts, type ProgressEvent } from '../model';
import { aiChoiceOf, laneSentence, needsSignIn, runSummaries, type RunAiLane } from '../summaries';

const CUSTOM = 'Custom endpoint · authored-model';

const choice = (patch: Record<string, unknown> = {}): ProgressEvent => ({
  type: 'ai_choice', enabled: true, lane_source: 'run', adjusted: [], length: 'standard', tone: 'technical',
  lanes: [{ label: CUSTOM, kind: 'api_key', provider: 'custom', model: 'authored-model' }], ...patch,
} as unknown as ProgressEvent);

const lane = (patch: Partial<RunAiLane>): RunAiLane => ({
  lane_index: 0, lane_label: CUSTOM, lane_kind: 'api_key', provider: 'custom', model: 'authored-model',
  credential_alias: 'custom_llm_api_key', outcome: 'ok', error_kind: null, http_status: null, safe_message: null,
  docs_attempted: 2, docs_succeeded: 2, started_at: '2026-10-29 08:00:00', ended_at: '2026-10-29 08:00:05',
  answered_by: [], ...patch,
});

describe('whether a run summarized, with what, and how it went', () => {
  test('a lane set for the run, its wording, and what the lane did', () => {
    const said = runSummaries(
      { status: 'completed', result_count: 2, ai_lanes: [lane({})] },
      [{ type: 'execution_start' }, choice({ adjusted: ['length', 'temperature'], length: 'brief' })],
    );
    expect(said.on).toBe(true);
    expect(said.head).toBe(`On, with ${CUSTOM}, set for this run. Asked for brief length, technical tone. Its length and temperature were set for this run.`);
    expect(runSummaries({ status: 'completed', routine_id: 4, ai_lanes: [] }, [choice({ adjusted: ['tone'] })]).head)
      .toBe(`On, with ${CUSTOM}, set for its watch. Asked for standard length, technical tone. Its tone was set for its watch.`);
    expect(said.lanes).toEqual([`${CUSTOM}: summarized 2 of 2 papers.`]);
    expect(said.note).toBeNull();
  });

  test('off is said as off, and not as a run with no record', () => {
    expect(runSummaries({ status: 'completed', ai_lanes: [] }, [choice({ enabled: false, lanes: [] })]))
      .toEqual({ on: false, head: 'Off for this run.', lanes: [], note: null });
    expect(runSummaries({ status: 'completed', ai_lanes: [] }, []))
      .toEqual({ on: null, head: 'This run recorded no attempt to summarize, and not whether it was set to.', lanes: [], note: null });
    // A run from before the choice was recorded still says what its lanes did.
    expect(runSummaries({ status: 'completed', ai_lanes: [lane({})] }, []).on).toBe(true);
  });

  test('an interrupted run with no lane says no attempt was made before it stopped, as Restart does', () => {
    const interrupted = { status: 'interrupted', routine_id: null, ai_lanes: [] };
    const said = runSummaries(interrupted, []);
    expect(said).toEqual({
      on: null, head: 'This run recorded no attempt to summarize before it stopped, and not whether it was set to.', lanes: [], note: null,
    });
    // Beside it, Restart's line says the same thing, not its opposite.
    expect(restartFacts({ execution_type: 'automated_sweep', ...interrupted }, null).ai)
      .toBe('This run recorded neither what it was set to nor an attempt to summarize, so Restart does not summarize.');
    // Still running, or with no lane record at all, nothing is inferred.
    expect(runSummaries({ status: 'running', ai_lanes: [] }, []).head).toBe('Not recorded with this run.');
    expect(runSummaries({ status: 'interrupted' }, []).head).toBe('Not recorded with this run.');
  });

  test('on, and nothing summarized, says why rather than looking like a quiet success', () => {
    const fromSettings = choice({ lane_source: 'settings' });
    expect(runSummaries({ status: 'completed', result_count: 0, ai_lanes: [] }, [fromSettings]).note)
      .toBe('This run found no papers, so there was nothing to summarize.');
    expect(runSummaries({ status: 'cancelled', result_count: 4, ai_lanes: [] }, [fromSettings]).note)
      .toBe('The run ended (canceled) before any paper was summarized.');
    expect(runSummaries({ status: 'running', ai_lanes: [] }, [fromSettings]).note)
      .toBe('Summaries are written once the run has its papers.');
    expect(runSummaries({ status: 'completed', ai_lanes: [] }, [choice({ lanes: [] })]).head)
      .toBe('On, but no provider was set up in Settings › AI, so no summary was written.');
    expect(runSummaries({ status: 'completed', ai_lanes: [] }, [fromSettings]).head).toMatch(/, from Settings › AI\./);
  });

  test('each lane’s outcome in its own words, with the reason it recorded', () => {
    const said = runSummaries({
      status: 'completed', ai_lanes: [
        lane({ outcome: 'failed', docs_attempted: 0, docs_succeeded: 0, safe_message: 'No API key is stored.' }),
        lane({ lane_index: 1, lane_label: 'Ollama · llama3', outcome: 'partial', docs_succeeded: 1, safe_message: 'one abstract was refused' }),
        lane({ lane_index: 2, lane_label: 'Codex', outcome: 'skipped', docs_attempted: 0, docs_succeeded: 0 }),
        lane({ lane_index: 3, lane_label: 'Claude Code', outcome: 'running' }),
      ],
    }, [choice()]);
    expect(said.lanes).toEqual([
      `${CUSTOM}: could not be used: No API key is stored.`,
      'Ollama · llama3: summarized 1 of 2 papers; one abstract was refused.',
      'Codex: not needed, because an earlier connection covered every paper.',
      'Claude Code: was summarizing when the run stopped.',
    ]);
  });
});

describe('what Restart does with summaries: as the run was set to, not as far as it got', () => {
  const base = { execution_type: 'deep_dive', routine_id: null };
  const SAME = 'so Restart does too, with what Settings › AI holds now. A connection or wording set for this run alone '
    + 'is not carried over.';

  test('a run set to summarize that failed before any summary is restarted with summaries on', () => {
    // Its ai_choice said on; it stopped before a lane was tried, so it has none.
    const failed = { ...base, status: 'failed', result_count: 0, ai_lanes: [] };
    expect(runSummaries(failed, [choice({ enabled: true })]).on).toBe(true);
    expect(restartFacts(failed, aiChoiceOf([choice({ enabled: true })])?.enabled ?? null).ai)
      .toBe(`This run was set to summarize, ${SAME}`);
  });

  test('a run set not to summarize is restarted with summaries off, whatever its lanes', () => {
    expect(restartFacts({ ...base, ai_lanes: [] }, false).ai).toBe('This run was set not to summarize, so Restart does not either.');
  });

  test('a run from before the choice was recorded is read from its lanes, as the engine reads it', () => {
    expect(restartFacts({ ...base, ai_lanes: [lane({})] }, null).ai).toBe(`This run tried to summarize, ${SAME}`);
    expect(restartFacts({ ...base, ai_lanes: [] }, null).ai)
      .toBe('This run recorded neither what it was set to nor an attempt to summarize, so Restart does not summarize.');
    expect(restartFacts(base, null).ai).toBe('This run did not record what it was set to, so Restart summarizes only if it '
      + 'recorded an attempt to, with what Settings › AI holds now.');
  });

  test('while its events are not read yet, nothing is claimed past what its lanes show', () => {
    expect(restartFacts({ ...base, ai_lanes: [lane({})] }).ai).toBe(`This run tried to summarize, ${SAME}`);
    expect(restartFacts({ ...base, ai_lanes: [] }).ai)
      .toBe('Restart summarizes only if this run was set to, with what Settings › AI holds now.');
  });
});

describe('which model wrote the summaries, and a lane that needs a sign-in', () => {
  const claude = (patch: Partial<RunAiLane>) => lane({
    lane_label: 'Claude Code · haiku', lane_kind: 'subscription', provider: 'claude_code', model: 'haiku',
    credential_alias: null, ...patch,
  });

  test('a lane says which model its command reported writing its summaries', () => {
    expect(laneSentence(claude({ answered_by: [{ model: 'claude-haiku-5-5', name: 'Haiku 5.5', calls: 2 }] }), false))
      .toBe('Claude Code · haiku: summarized 2 of 2 papers. Written by Haiku 5.5.');
    expect(laneSentence(claude({
      outcome: 'partial', docs_succeeded: 1, safe_message: 'One paper timed out.',
      answered_by: [{ model: 'claude-haiku-5-5', name: 'Haiku 5.5', calls: 1 }, { model: 'claude-haiku-4-5', name: 'Haiku 4.5', calls: 1 }],
    }), false)).toBe('Claude Code · haiku: summarized 1 of 2 papers; One paper timed out. Written by Haiku 5.5 and Haiku 4.5.');
  });

  test('nothing is said about the model where the command reported none, or wrote nothing', () => {
    expect(laneSentence(claude({}), false)).toBe('Claude Code · haiku: summarized 2 of 2 papers.');
    expect(laneSentence(claude({
      outcome: 'failed', docs_succeeded: 0, answered_by: [{ model: 'claude-haiku-5-5', name: 'Haiku 5.5', calls: 1 }],
    }), false)).toBe('Claude Code · haiku: summarized none of 2 papers.');
  });

  test('only a command that said it is not signed in is offered the sign-in', () => {
    expect(needsSignIn(claude({ outcome: 'failed', error_kind: 'cli_auth' }))).toBe(true);
    expect(needsSignIn(claude({ outcome: 'failed', error_kind: 'cli_auth', provider: 'codex' }))).toBe(true);
    expect(needsSignIn(claude({ outcome: 'failed', error_kind: 'quota' }))).toBe(false);
    expect(needsSignIn(lane({ outcome: 'failed', error_kind: 'cli_auth' }))).toBe(false);
  });
});

describe('a connection that summarized nothing says why', () => {
  const ANTHROPIC = 'Anthropic · claude-haiku-4-5-20251001';
  test('the first connection, unusable, gives its own reason, and the run says nothing was written', () => {
    const unusable = lane({
      lane_label: ANTHROPIC, provider: 'anthropic', outcome: 'skipped', docs_attempted: 0, docs_succeeded: 0,
      safe_message: 'No API key is stored for Anthropic.',
    });
    expect(laneSentence(unusable, false)).toBe(`${ANTHROPIC}: could not be used: No API key is stored for Anthropic.`);
    const said = runSummaries({ status: 'completed', result_count: 10, ai_lanes: [unusable] }, [choice({ lane_source: 'settings' })]);
    expect(said.note).toBe('No summary was written for this run.');
  });

  test('a later connection that was never reached is not needed, and the first one never is', () => {
    expect(laneSentence(lane({ lane_index: 1, outcome: 'skipped', docs_attempted: 0, docs_succeeded: 0 }), false))
      .toBe(`${CUSTOM}: not needed, because an earlier connection covered every paper.`);
    expect(laneSentence(lane({ lane_index: 0, outcome: 'skipped', docs_attempted: 0, docs_succeeded: 0 }), false))
      .toBe(`${CUSTOM}: summarized no paper, and recorded no reason.`);
  });
});

