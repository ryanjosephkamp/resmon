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

export type LaneKind = 'api_key' | 'local' | 'subscription';

export interface FallbackLane {
  kind: LaneKind;
  provider: string;
  model: string;
  endpoint?: string;
  base_url?: string;
  /** Subscription lanes only: full path to the CLI, when the user sets one. */
  binary_path?: string;
  /** Subscription lanes only: documents this lane may handle in one run. */
  doc_cap?: number;
  /** Subscription lanes only: documents sent in one CLI call. */
  batch_size?: number;
  /**
   * Subscription lanes only: the CLI's own reasoning-effort level.
   *
   * Deliberately absent from api_key lanes. None of the eight BYOK providers
   * shares an effort parameter, so a control here that did nothing for most of
   * them would claim a capability resmon cannot deliver.
   */
  effort?: string;
}

/** What the CLI can honestly offer for models and effort levels. */
export interface SubscriptionCatalog {
  models: string[];
  /** How this list was obtained — rendered, because it is a different claim
   *  for each CLI. claude has no models command and these are documented
   *  aliases; codex reports a real catalog. */
  provenance: string;
  /** Per-model effort levels, where the CLI reports them per model. */
  efforts: Record<string, string[]>;
  default_efforts: Record<string, string>;
  error: string;
}

/** What the CLI-detection endpoint reports for one provider. */
export interface CliStatus {
  provider: string;
  path: string | null;
  how: string;
  found: boolean;
  tried: string[];
  detail: string;
}

/** The default per-run document cap, mirroring ai_lanes.DEFAULT_SUBSCRIPTION_DOC_CAP. */
const DEFAULT_DOC_CAP = 25;

const FALLBACK_PROVIDERS: { value: string; label: string; kind: LaneKind }[] = [
  { value: 'anthropic', label: 'Anthropic', kind: 'api_key' },
  { value: 'openai', label: 'OpenAI', kind: 'api_key' },
  { value: 'google', label: 'Google', kind: 'api_key' },
  { value: 'xai', label: 'xAI', kind: 'api_key' },
  { value: 'meta', label: 'Meta (Together)', kind: 'api_key' },
  { value: 'deepseek', label: 'DeepSeek', kind: 'api_key' },
  { value: 'alibaba', label: 'Alibaba', kind: 'api_key' },
  { value: 'local', label: 'Ollama (local)', kind: 'local' },
  // 1.8c. These drive the CLI the user already installed and logged into, so
  // the work is billed to their existing plan rather than to a metered key.
  { value: 'claude_code', label: 'Claude Code (your Claude plan)', kind: 'subscription' },
  { value: 'codex', label: 'Codex (your ChatGPT plan)', kind: 'subscription' },
];

const kindFor = (provider: string): LaneKind =>
  FALLBACK_PROVIDERS.find((p) => p.value === provider)?.kind ?? 'api_key';

interface Props {
  lanes: FallbackLane[];
  onChange: (lanes: FallbackLane[]) => void;
  /** Label of the primary lane, shown as the head of the chain. */
  primaryLabel: string;
  disabled?: boolean;
  /** Detection results from /api/settings/ai/cli-status, when loaded. */
  cliStatus?: CliStatus[];
  /** Per-provider model/effort catalogs, once loaded. */
  catalogs?: Record<string, SubscriptionCatalog>;
  /** Ask the parent to load the catalog for one subscription provider. */
  onLoadCatalog?: (provider: string, binaryPath?: string) => void;
}

const FallbackChain: React.FC<Props> = ({
  lanes, onChange, primaryLabel, disabled, cliStatus, catalogs, onLoadCatalog,
}) => {
  const statusFor = (provider: string): CliStatus | undefined =>
    cliStatus?.find((s) => s.provider === provider);

  // "Where is the command?" is a question almost nobody has to answer, and the
  // paragraph explaining the search order was in everyone's way. It lives
  // behind Advanced now -- opened by default only for a lane whose CLI was not
  // found, which is exactly when it is the next thing to do.
  const [advancedOpen, setAdvancedOpen] = React.useState<Record<number, boolean>>({});
  const advancedIsOpen = (index: number, provider: string): boolean => {
    if (index in advancedOpen) return advancedOpen[index];
    const status = statusFor(provider);
    return status ? !status.found : false;
  };

  const effortsFor = (lane: FallbackLane): string[] => {
    const catalog = catalogs?.[lane.provider];
    if (!catalog) return [];
    if (lane.model && catalog.efforts[lane.model]) return catalog.efforts[lane.model];
    // No model chosen yet, or one the catalog does not know: offer the union
    // of what any listed model supports rather than nothing. The CLI rejects a
    // level its model does not take, and resmon passes that message through
    // rather than pre-judging it.
    const union = new Set<string>();
    Object.values(catalog.efforts).forEach((levels) => levels.forEach((l) => union.add(l)));
    return Array.from(union);
  };

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
                onChange={(e) => {
                  const kind = kindFor(e.target.value);
                  update(index, {
                    provider: e.target.value,
                    kind,
                    // Seed the cap when switching *into* a subscription lane so
                    // the guard is visible and editable rather than an
                    // invisible backend default. Cleared on the way out so a
                    // stale number cannot ride along on an API-key lane.
                    doc_cap: kind === 'subscription'
                      ? (lanes[index].doc_cap ?? DEFAULT_DOC_CAP)
                      : undefined,
                  });
                }}
              >
                {FALLBACK_PROVIDERS.map((p) => (
                  <option key={p.value} value={p.value}>{p.label}</option>
                ))}
              </select>

              {lane.kind === 'subscription' ? (
                <>
                  <select
                    className="form-select"
                    aria-label={`Fallback ${index + 1} model`}
                    value={lane.model}
                    disabled={disabled}
                    onChange={(e) => update(index, { model: e.target.value })}
                  >
                    <option value="">CLI default</option>
                    {/* Keep a saved value reachable even when it is not in the
                        catalog: the CLI may accept names resmon cannot list. */}
                    {lane.model
                      && !(catalogs?.[lane.provider]?.models || []).includes(lane.model) && (
                      <option value={lane.model}>{lane.model} (saved)</option>
                    )}
                    {(catalogs?.[lane.provider]?.models || []).map((m) => (
                      <option key={m} value={m}>{m}</option>
                    ))}
                  </select>
                  <button
                    type="button"
                    className="btn btn-sm"
                    aria-label={`Load ${lane.provider} models`}
                    disabled={disabled || !onLoadCatalog}
                    onClick={() => onLoadCatalog?.(lane.provider, lane.binary_path)}
                  >
                    Load models
                  </button>
                  <label style={{ display: 'inline-flex', alignItems: 'center', gap: '0.3rem' }}>
                    <span className="text-muted">effort</span>
                    <select
                      className="form-select"
                      aria-label={`Fallback ${index + 1} effort`}
                      value={lane.effort || ''}
                      disabled={disabled}
                      onChange={(e) => update(index, { effort: e.target.value || undefined })}
                    >
                      <option value="">CLI default</option>
                      {effortsFor(lane).map((level) => (
                        <option key={level} value={level}>{level}</option>
                      ))}
                    </select>
                  </label>
                </>
              ) : (
                <input
                  className="form-input"
                  aria-label={`Fallback ${index + 1} model`}
                  placeholder="model id"
                  value={lane.model}
                  disabled={disabled}
                  onChange={(e) => update(index, { model: e.target.value })}
                />
              )}

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

              {lane.kind === 'subscription' && (
                <>
                  <label style={{ display: 'inline-flex', alignItems: 'center', gap: '0.3rem' }}>
                    <span className="text-muted">max papers</span>
                    <input
                      className="form-input"
                      type="number"
                      min={1}
                      style={{ width: '5.5rem' }}
                      aria-label={`Fallback ${index + 1} document limit`}
                      value={lane.doc_cap ?? DEFAULT_DOC_CAP}
                      disabled={disabled}
                      onChange={(e) => {
                        const parsed = parseInt(e.target.value, 10);
                        update(index, {
                          doc_cap: Number.isFinite(parsed) && parsed > 0
                            ? parsed
                            : undefined,
                        });
                      }}
                    />
                  </label>
                </>
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

            {lane.kind === 'api_key' && (
              <p className="text-muted" style={{ margin: '0.2rem 0 0' }}>
                Uses the {lane.provider} key stored on the Repositories page. If
                none is stored, resmon records that this lane was skipped rather
                than failing the run.
              </p>
            )}

            {lane.kind === 'subscription' && (
              <div style={{ margin: '0.2rem 0 0' }}>
                <p className="text-muted" style={{ margin: 0 }}>
                  <strong>This spends your own plan.</strong> resmon runs the{' '}
                  {lane.provider === 'codex' ? 'Codex' : 'Claude Code'} command
                  you already installed and signed into, so every paper this
                  lane summarizes draws on the same{' '}
                  {lane.provider === 'codex' ? 'ChatGPT' : 'Claude'} usage
                  window you use for your own work, and it is slower than an API
                  key. Papers are sent ten at a time in one call rather than one
                  session each. This run will send it{' '}
                  <strong>at most {lane.doc_cap ?? DEFAULT_DOC_CAP} papers</strong>;
                  anything past that goes to the next lane. resmon never sees or
                  stores your sign-in.
                </p>
                {statusFor(lane.provider) && (
                  <p
                    className="text-muted"
                    style={{ margin: '0.2rem 0 0' }}
                    data-testid={`cli-status-${lane.provider}`}
                  >
                    {statusFor(lane.provider)!.found ? '✓ ' : '⚠ '}
                    {statusFor(lane.provider)!.detail}
                    {!statusFor(lane.provider)!.found && (
                      <> Looked in: {statusFor(lane.provider)!.tried.join(', ')}.</>
                    )}
                    {' '}
                    resmon has not checked whether you are signed in — that shows
                    up on the first paper, and is recorded on the run.
                  </p>
                )}

                <details
                  open={advancedIsOpen(index, lane.provider)}
                  onToggle={(e) => setAdvancedOpen({
                    ...advancedOpen,
                    [index]: (e.target as HTMLDetailsElement).open,
                  })}
                  style={{ marginTop: '0.3rem' }}
                >
                  <summary className="text-muted" style={{ cursor: 'pointer' }}>
                    Advanced
                  </summary>
                  <label className="form-label" style={{ marginTop: '0.3rem' }}>
                    Where is the <code>{lane.provider === 'codex' ? 'codex' : 'claude'}</code>{' '}
                    command?
                  </label>
                  <input
                    className="form-input"
                    aria-label={`Fallback ${index + 1} command path`}
                    placeholder={
                      lane.provider === 'codex'
                        ? '/Applications/ChatGPT.app/Contents/Resources/codex'
                        : '/Users/you/.local/bin/claude'
                    }
                    value={lane.binary_path || ''}
                    disabled={disabled}
                    onChange={(e) => update(index, { binary_path: e.target.value })}
                  />
                  <p className="text-muted" style={{ margin: '0.2rem 0 0' }}>
                    Only needed when resmon could not find the command on its
                    own. Leave it empty and resmon looks where the installers
                    put it, then on <code>PATH</code>.
                  </p>
                </details>
              </div>
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
