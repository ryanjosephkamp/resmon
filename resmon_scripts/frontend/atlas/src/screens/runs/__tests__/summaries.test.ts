import { restartFacts, type ProgressEvent } from '../model';
import { runSummaries, type RunAiLane } from '../summaries';

const CUSTOM = 'Custom endpoint · authored-model';

const choice = (patch: Record<string, unknown> = {}): ProgressEvent => ({
  type: 'ai_choice', enabled: true, lane_source: 'run', adjusted: [], length: 'standard', tone: 'technical',
  lanes: [{ label: CUSTOM, kind: 'api_key', provider: 'custom', model: 'authored-model' }], ...patch,
} as unknown as ProgressEvent);

const lane = (patch: Partial<RunAiLane>): RunAiLane => ({
  lane_index: 0, lane_label: CUSTOM, lane_kind: 'api_key', provider: 'custom', model: 'authored-model',
  credential_alias: 'custom_llm_api_key', outcome: 'ok', error_kind: null, http_status: null, safe_message: null,
  docs_attempted: 2, docs_succeeded: 2, started_at: '2026-10-29 08:00:00', ended_at: '2026-10-29 08:00:05', ...patch,
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
    expect(restartFacts({ parameters: '{}', execution_type: 'automated_sweep', ...interrupted }).ai)
      .toBe('This run recorded no attempt to summarize, so Restart does not summarize.');
    // Still running, or with no lane record at all, nothing is inferred.
    expect(runSummaries({ status: 'running', ai_lanes: [] }, []).head).toBe('Not recorded with this run.');
    expect(runSummaries({ status: 'interrupted' }, []).head).toBe('Not recorded with this run.');
  });

  test('on, and nothing summarized, says why rather than looking like a quiet success', () => {
    const fromSettings = choice({ lane_source: 'settings' });
    expect(runSummaries({ status: 'completed', result_count: 0, ai_lanes: [] }, [fromSettings]).note)
      .toBe('This run found no papers, so there was nothing to summarize.');
    expect(runSummaries({ status: 'cancelled', result_count: 4, ai_lanes: [] }, [fromSettings]).note)
      .toBe('The run ended (cancelled) before any paper was summarized.');
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
        lane({ lane_label: 'Ollama · llama3', outcome: 'partial', docs_succeeded: 1, safe_message: 'one abstract was refused' }),
        lane({ lane_label: 'Codex', outcome: 'skipped', docs_attempted: 0, docs_succeeded: 0 }),
        lane({ lane_label: 'Claude Code', outcome: 'running' }),
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

describe('what Restart does with summaries, where the run’s lanes are known', () => {
  const base = { parameters: '{}', execution_type: 'deep_dive', routine_id: null };
  test('a run that tried says Restart will, with today’s settings and not this run’s own', () => {
    expect(restartFacts({ ...base, ai_lanes: [lane({})] }).ai)
      .toBe('This run tried to summarize, so Restart does too, with what Settings › AI holds now. A connection or wording set for this run alone is not carried over.');
    expect(restartFacts({ ...base, ai_lanes: [] }).ai).toBe('This run recorded no attempt to summarize, so Restart does not summarize.');
  });
});
