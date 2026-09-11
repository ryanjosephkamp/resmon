import React from 'react';

export interface ChoiceRequest {
  version: 1; runtime: 'claude_cli' | 'api_key'; provider: string;
  model: string | null; effort: string | null;
}
export interface SavedChoices {
  version: number; runtime: string; provider: string; requested_model: string | null;
  requested_effort: string | null; model_basis: string; effort_basis: string;
  binding_basis: string; created_at_utc?: string;
}
export interface UnreadableChoices { unreadable: true }
export interface ModelReport { sequence: number; model: string; source: string; observed_at_utc: string }
export interface TurnChoices {
  user_message_id: number; assistant_message_id: number | null; version: number;
  requested: SavedChoices | UnreadableChoices; reported: ModelReport[] | UnreadableChoices; created_at_utc: string;
}
export interface ChoicesDescriptor {
  version: number; default_request: ChoiceRequest | null; default_error: string | null;
  connections: { runtime: ChoiceRequest['runtime'] | null; provider: string; label: string;
    implemented: boolean; available: boolean; reason: string; effort_supported: boolean }[];
  claude_aliases: string[]; claude_efforts: string[]; limitations: string;
}

export const ChoiceSummary: React.FC<{ choices?: SavedChoices | UnreadableChoices | null }> = ({ choices }) => (
  <div className="assistant-choice-summary">
    {!choices ? 'Historical settings: unknown.' : 'unreadable' in choices ? 'Saved choices: unreadable.' : <>
      <strong>Requested</strong>: {choices.provider} · {choices.requested_model ?? 'CLI default (unknown)'}
      {' · Effort: '}{choices.runtime === 'api_key' ? 'Not supported by this adapter' : choices.requested_effort ?? 'CLI default (unknown)'}
      <div>Fixed for this conversation. Runtime-reported effort: not available.</div>
    </>}
  </div>
);

export const ComposerChoices: React.FC<{
  descriptor: ChoicesDescriptor; value: ChoiceRequest | null; onChange: (choice: ChoiceRequest) => void;
  disabled?: boolean;
}> = ({ descriptor, value, onChange, disabled }) => {
  const connection = descriptor.connections.find(c => c.runtime === value?.runtime && c.provider === value?.provider);
  const api = value?.runtime === 'api_key';
  return <fieldset className="assistant-choices" disabled={disabled}>
    <legend>Choices for this conversation</legend>
    <label>Connection
      <select aria-label="Connection" value={value ? `${value.runtime}:${value.provider}` : ''} onChange={event => {
        const c = descriptor.connections.find(item => `${item.runtime}:${item.provider}` === event.target.value);
        if (c?.runtime && c.implemented) onChange({ version: 1, runtime: c.runtime, provider: c.provider,
          model: c.runtime === value?.runtime ? value.model : null, effort: c.runtime === 'claude_cli' && value?.runtime === 'claude_cli' ? value.effort : null });
      }}>
        <option value="" disabled>Choose a connection</option>
        {descriptor.connections.map(c => <option key={c.provider} value={`${c.runtime}:${c.provider}`} disabled={!c.implemented}>
          {c.label}{!c.implemented ? ' — adapter unavailable' : !c.available ? ' — setup needed' : ''}
        </option>)}
      </select>
    </label>
    {value && <>
      <label>Model
        <input aria-label="Model" list={api ? undefined : 'assistant-claude-aliases'} maxLength={512}
          value={value.model ?? ''} placeholder={api ? 'Explicit model ID required' : 'Blank: omit flag; CLI default unknown'}
          onChange={event => onChange({ ...value, model: event.target.value || null })} />
        {!api && <datalist id="assistant-claude-aliases">{descriptor.claude_aliases.map(alias => <option key={alias} value={alias} />)}</datalist>}
      </label>
      {api ? <p>Effort: Not supported by this adapter</p> : <label>Effort
        <select aria-label="Effort" value={value.effort ?? ''} onChange={event => onChange({ ...value, effort: event.target.value || null })}>
          <option value="">CLI default (omit flag)</option>
          {descriptor.claude_efforts.map(effort => <option key={effort} value={effort}>{effort}</option>)}
        </select>
      </label>}
    </>}
    {connection && <p>{connection.reason}</p>}
    {!value && descriptor.default_error && <p>{descriptor.default_error}</p>}
    <details><summary>What these choices establish</summary><p>{descriptor.limitations}</p>
      <p>Model IDs are explicit requests. Claude suggestions are aliases, not an account-verified compatibility matrix. Changing these choices does not save global defaults.</p>
    </details>
  </fieldset>;
};
