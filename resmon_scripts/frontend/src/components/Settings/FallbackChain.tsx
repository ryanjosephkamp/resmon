import React from 'react';
import InfoTooltip from '../Help/InfoTooltip';

/**
 * The fallback lanes beneath the primary provider (1.8b).
 *
 * This is a controlled child on purpose. The stored `ai_chain` is the
 * *complete* ordered chain including lane 0, but lane 0 is already owned by the
 * provider form above — so the parent composes `[primary, ...fallbacks]` inside
 * its single Save. One writer, and lane 0 cannot drift out of step with the
 * provider the user can see selected.
 */

export interface FallbackLane {
  kind: 'api_key' | 'local';
  provider: string;
  model: string;
  endpoint?: string;
  base_url?: string;
}

/** Providers offerable as a fallback. Subscription lanes arrive in 1.8c. */
const FALLBACK_PROVIDERS: { value: string; label: string; kind: 'api_key' | 'local' }[] = [
  { value: 'anthropic', label: 'Anthropic', kind: 'api_key' },
  { value: 'openai', label: 'OpenAI', kind: 'api_key' },
  { value: 'google', label: 'Google', kind: 'api_key' },
  { value: 'xai', label: 'xAI', kind: 'api_key' },
  { value: 'meta', label: 'Meta (Together)', kind: 'api_key' },
  { value: 'deepseek', label: 'DeepSeek', kind: 'api_key' },
  { value: 'alibaba', label: 'Alibaba', kind: 'api_key' },
  { value: 'local', label: 'Ollama (local)', kind: 'local' },
];

const kindFor = (provider: string): 'api_key' | 'local' =>
  FALLBACK_PROVIDERS.find((p) => p.value === provider)?.kind ?? 'api_key';

interface Props {
  lanes: FallbackLane[];
  onChange: (lanes: FallbackLane[]) => void;
  /** Label of the primary lane, shown as the head of the chain. */
  primaryLabel: string;
  disabled?: boolean;
}

const FallbackChain: React.FC<Props> = ({ lanes, onChange, primaryLabel, disabled }) => {
  const update = (index: number, patch: Partial<FallbackLane>) => {
    const next = lanes.map((lane, i) => (i === index ? { ...lane, ...patch } : lane));
    onChange(next);
  };

  const add = () => {
    onChange([...lanes, { kind: 'local', provider: 'local', model: '' }]);
  };

  const remove = (index: number) => {
    onChange(lanes.filter((_, i) => i !== index));
  };

  const move = (index: number, delta: number) => {
    const target = index + delta;
    if (target < 0 || target >= lanes.length) return;
    const next = [...lanes];
    [next[index], next[target]] = [next[target], next[index]];
    onChange(next);
  };

  return (
    <div className="form-field">
      <label className="form-label">
        If that fails, try…
        <InfoTooltip text="Optional fallback providers, tried in order when the one above cannot produce a summary. A rejected key, an exhausted quota or a missing model retires that provider for the rest of the run; a single awkward abstract only falls through for that one paper. Every fallthrough is recorded with its reason on the execution." />
      </label>

      <p className="text-muted" style={{ marginTop: 0 }}>
        Leave this empty to use only the provider above — that is exactly how
        resmon behaved before fallbacks existed.
      </p>

      <ol className="chain-list" style={{ paddingLeft: '1.2rem', margin: '0.5rem 0' }}>
        <li className="chain-primary" style={{ marginBottom: '0.4rem' }}>
          <strong>{primaryLabel || 'No provider selected'}</strong>{' '}
          <span className="text-muted">— tried first</span>
        </li>

        {lanes.map((lane, index) => (
          <li key={index} style={{ marginBottom: '0.6rem' }}>
            <div
              className="chain-row"
              style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap', alignItems: 'center' }}
            >
              <select
                className="form-select"
                aria-label={`Fallback ${index + 1} provider`}
                value={lane.provider}
                disabled={disabled}
                onChange={(e) =>
                  update(index, {
                    provider: e.target.value,
                    kind: kindFor(e.target.value),
                  })
                }
              >
                {FALLBACK_PROVIDERS.map((p) => (
                  <option key={p.value} value={p.value}>{p.label}</option>
                ))}
              </select>

              <input
                className="form-input"
                aria-label={`Fallback ${index + 1} model`}
                placeholder="model id"
                value={lane.model}
                disabled={disabled}
                onChange={(e) => update(index, { model: e.target.value })}
              />

              {lane.provider === 'local' && (
                <input
                  className="form-input"
                  aria-label={`Fallback ${index + 1} endpoint`}
                  placeholder="http://localhost:11434"
                  value={lane.endpoint || ''}
                  disabled={disabled}
                  onChange={(e) => update(index, { endpoint: e.target.value })}
                />
              )}

              <button
                type="button"
                className="btn btn-secondary"
                aria-label={`Move fallback ${index + 1} up`}
                disabled={disabled || index === 0}
                onClick={() => move(index, -1)}
              >
                ↑
              </button>
              <button
                type="button"
                className="btn btn-secondary"
                aria-label={`Move fallback ${index + 1} down`}
                disabled={disabled || index === lanes.length - 1}
                onClick={() => move(index, 1)}
              >
                ↓
              </button>
              <button
                type="button"
                className="btn btn-secondary"
                aria-label={`Remove fallback ${index + 1}`}
                disabled={disabled}
                onClick={() => remove(index)}
              >
                Remove
              </button>
            </div>

            {lane.provider !== 'local' && (
              <p className="text-muted" style={{ margin: '0.2rem 0 0' }}>
                Uses the {lane.provider} key stored on the Repositories page. If
                none is stored, resmon records that this lane was skipped rather
                than failing the run.
              </p>
            )}
          </li>
        ))}
      </ol>

      <button type="button" className="btn btn-secondary" onClick={add} disabled={disabled}>
        Add a fallback
      </button>
    </div>
  );
};

export default FallbackChain;
export { FALLBACK_PROVIDERS, kindFor };
