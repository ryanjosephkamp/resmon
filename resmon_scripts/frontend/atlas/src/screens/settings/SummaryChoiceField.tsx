import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { answer, engine } from '../../api/client';
import { ModelField, useModelList, type ModelQuery } from './ModelField';
import { choiceSentence, ownLane, type SummaryChoice } from './summaryChoice';
import {
  CLI_PROVIDERS, DEFAULT_GOALS, DEFAULT_TEMPERATURE, KEY_NAMES, LENGTHS, PROVIDERS, TONES, laneName, rememberedModels,
  temperatureProblem, wordingOf, type AiSettings,
} from './summaryLanes';

const labelOf = (options: readonly { value: string; label: string }[], value: string): string =>
  options.find((o) => o.value === value)?.label.split(/[,:]/)[0] ?? value;

/**
 * Whether a run (or every run of a watch) summarizes each paper, with which
 * connection, and how: the same choices as Settings › AI, each blank meaning
 * "as Settings › AI has it when the run starts". `whose` names what the
 * choice belongs to in its sentences ("this run", "this watch").
 */
export function SummaryChoiceField({ id, value, onChange, stored, whose, toggle }: {
  id: string;
  value: SummaryChoice;
  onChange: (next: SummaryChoice) => void;
  /** Settings › AI as stored; undefined while it is read. */
  stored: AiSettings | undefined;
  whose: string;
  /** The on/off control in the screen's own idiom: Search's checkbox, or the watch editor's switch. */
  toggle: 'checkbox' | 'switch';
}) {
  const models = useModelList();
  // Open at first where something is already set here; after that it is the person's to open and close.
  const [wordingOpen] = useState(() => !!(value.length || value.tone || value.temperature || value.extraction_goals));
  const credentials = useQuery({ queryKey: ['credentials'], queryFn: () => answer(engine().GET('/api/credentials')), enabled: value.on });
  const set = (patch: Partial<SummaryChoice>) => onChange({ ...value, ...patch });
  const own = value.lane === 'own';
  const wording = stored ? wordingOf(stored) : null;
  const slot = KEY_NAMES[value.provider];
  const keyState = slot ? credentials.data?.credentials[slot]?.status : undefined;
  const tempProblem = temperatureProblem(value.temperature);
  const query: ModelQuery = { provider: value.provider };
  if (stored && value.provider) {
    const lane = ownLane(value, stored);
    if (typeof lane.base_url === 'string') query.base_url = lane.base_url;
    if (value.provider === 'local') query.endpoint = typeof lane.endpoint === 'string' ? lane.endpoint : 'http://localhost:11434';
    if (typeof lane.binary_path === 'string') query.binary_path = lane.binary_path;
  }
  const remembered = stored ? rememberedModels(stored) : {};

  return (
    <div className="ai-choice" data-ai="choice" data-on={value.on}>
      {toggle === 'checkbox' ? (
        <label className="ai-choice-toggle">
          <input type="checkbox" checked={value.on} onChange={(e) => set({ on: e.target.checked })} />
          <span>Summarize each paper</span>
        </label>
      ) : (
        <button type="button" role="switch" aria-checked={value.on} className="switch" data-switch="ai_enabled"
          onClick={() => set({ on: !value.on })}>
          <span className="switch-track" aria-hidden="true"><span className="switch-knob" /></span>
          Summarize each paper
        </button>
      )}
      {value.on && (
        <>
          <div className="seg" role="group" aria-label="Which connection writes the summaries">
            <button type="button" aria-pressed={!own} onClick={() => set({ lane: 'settings', keptChain: null })}>
              As in Settings › AI
            </button>
            <button type="button" aria-pressed={own} onClick={() => set({ lane: 'own' })}>
              One for {whose}
            </button>
          </div>
          {own && (
            <div className="form-grid ai-choice-lane">
              <div className="form-field">
                <label className="form-label" htmlFor={`${id}-provider`}>Provider</label>
                <select id={`${id}-provider`} value={value.provider}
                  onChange={(e) => set({ provider: e.target.value, model: remembered[e.target.value] ?? '', keptChain: null })}>
                  <option value="">Choose a provider</option>
                  {PROVIDERS.map((p) => <option key={p.value} value={p.value}>{p.label}</option>)}
                  {value.provider && !PROVIDERS.some((p) => p.value === value.provider) && (
                    <option value={value.provider}>{value.provider} (saved)</option>
                  )}
                </select>
              </div>
              <ModelField id={`${id}-model`} provider={value.provider} value={value.model}
                onChange={(model) => set({ model, keptChain: null })} list={models} query={query} />
              {value.provider && !CLI_PROVIDERS.has(value.provider) && value.provider !== 'local' && (
                <p className="form-hint form-wide" data-ai="choice-key" data-state={keyState ?? 'unknown'}>
                  {keyState === 'absent'
                    ? `No ${laneName(value.provider)} key is stored, so a run with this connection writes no summary. Store one in Settings › AI.`
                    : `It uses the ${laneName(value.provider)} key stored in Settings › AI${value.provider === 'custom' ? ', at the endpoint set there' : ''}.`}
                </p>
              )}
              {value.provider === 'local' && (
                <p className="form-hint form-wide">It uses the Ollama endpoint set in Settings › AI, or this computer’s.</p>
              )}
            </div>
          )}
          <details className="ai-choice-wording" open={wordingOpen || undefined}>
            <summary>How each summary is written for {whose}</summary>
            <div className="form-grid">
              <label className="form-field" htmlFor={`${id}-length`}>
                <span className="form-label">Length</span>
                <select id={`${id}-length`} value={value.length} onChange={(e) => set({ length: e.target.value })}>
                  <option value="">As in Settings › AI{wording ? ` (${labelOf(LENGTHS, wording.ai_summary_length)})` : ''}</option>
                  {LENGTHS.map((l) => <option key={l.value} value={l.value}>{l.label}</option>)}
                </select>
              </label>
              <label className="form-field" htmlFor={`${id}-tone`}>
                <span className="form-label">Tone</span>
                <select id={`${id}-tone`} value={value.tone} onChange={(e) => set({ tone: e.target.value })}>
                  <option value="">As in Settings › AI{wording ? ` (${labelOf(TONES, wording.ai_tone)})` : ''}</option>
                  {TONES.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
                </select>
              </label>
              <label className="form-field" htmlFor={`${id}-temperature`}>
                <span className="form-label">Temperature</span>
                <input id={`${id}-temperature`} inputMode="decimal" value={value.temperature} autoComplete="off"
                  placeholder={`As in Settings › AI (${wording?.ai_temperature || DEFAULT_TEMPERATURE})`}
                  onChange={(e) => set({ temperature: e.target.value })} />
                {tempProblem && <span className="field-error" role="alert">{tempProblem}</span>}
              </label>
              <label className="form-field" htmlFor={`${id}-goals`}>
                <span className="form-label">What to draw out</span>
                <input id={`${id}-goals`} value={value.extraction_goals} autoComplete="off"
                  placeholder={`As in Settings › AI (${wording?.ai_extraction_goals || DEFAULT_GOALS})`}
                  onChange={(e) => set({ extraction_goals: e.target.value })} />
              </label>
            </div>
          </details>
        </>
      )}
      <p className="ask-lane" data-ai="choice-lanes">
        {!stored ? 'Reading Settings › AI.' : choiceSentence(value, stored, whose)}
        {value.on && <>{' '}A paper that cannot be summarized is kept without one, and the run’s log says why.</>}
        {' '}<Link to="/settings/ai">Settings › AI</Link>
      </p>
    </div>
  );
}

/** Why a choice cannot be used as it stands, or null. */
export function choiceProblem(value: SummaryChoice): string | null {
  if (!value.on) return null;
  if (value.lane === 'own' && !value.provider) return 'Choose the provider that writes the summaries, or use Settings › AI.';
  return temperatureProblem(value.temperature);
}
