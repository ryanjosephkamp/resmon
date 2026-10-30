/**
 * Summaries: the connections a run writes them with, as the engine reads them.
 *
 * The engine prefers a stored `ai_chain` (a JSON list of lanes) to the
 * single-provider keys (`ai_lanes.resolve_chain`): when one holds a usable
 * lane, its first lane is the one a run uses, and the rest are fallbacks tried
 * in order. So this screen reads the chain the same way, shows its first lane
 * in the form and the rest beside it, and writes a change into the chain as
 * well as the single keys. A form that wrote only the single keys would show a
 * change that no run makes.
 */
import type { components } from '../../api/schema';
import { providerWords } from '../ask/askModel';

export type AiSettings = components['schemas']['AiSettings'];

/** The two providers that are a command on this computer rather than an API. */
export const CLI_PROVIDERS = new Set(['claude_code', 'codex']);

/** The credential each provider's key is stored under (`llm_remote._ALIAS_FOR`). */
export const KEY_NAMES: Record<string, string> = {
  openai: 'openai_api_key', anthropic: 'anthropic_api_key', google: 'google_api_key', xai: 'xai_api_key',
  meta: 'meta_api_key', deepseek: 'deepseek_api_key', alibaba: 'alibaba_api_key', custom: 'custom_llm_api_key',
};

/** What a subscription lane sends at most per run when it names no cap (`ai_lanes.DEFAULT_SUBSCRIPTION_DOC_CAP`). */
export const DEFAULT_DOC_CAP = 50;
/** How many papers a subscription lane sends per call when it names no batch size (`DEFAULT_SUBSCRIPTION_BATCH_SIZE`). */
export const DEFAULT_BATCH = 5;

type LaneKind = 'subscription' | 'api_key' | 'local';
const LANE_KINDS: readonly string[] = ['subscription', 'api_key', 'local'];

/** One lane as the engine parses it (`ai_lanes._lane_from_entry`). */
export interface ChainLane {
  kind: LaneKind;
  provider: string;
  model: string | null;
  endpoint: string | null;
  base_url: string | null;
  binary_path: string | null;
  effort: string | null;
  doc_cap: number | null;
  batch_size: number | null;
}

/** A usable lane, and the object it was stored as, so a fallback is written back exactly as it was. */
export interface ChainEntry {
  lane: ChainLane;
  raw: Record<string, unknown>;
}

/** The form's fields: the first lane, in the single keys' names. */
export interface SummaryForm {
  ai_provider: string;
  ai_model: string;
  ai_cli_path: string;
  ai_effort: string;
  ai_custom_base_url: string;
  ai_local_endpoint: string;
}

export interface StoredSummary {
  form: SummaryForm;
  /** The chain's first lane, when a usable chain is stored. */
  primary: ChainEntry | null;
  /** The lanes after it, in the order a run tries them. */
  fallbacks: ChainEntry[];
  /** A chain is stored, and nothing in it is a lane the engine can use, so the engine ignores it. */
  unreadable: boolean;
}

export function laneKind(provider: string): LaneKind {
  if (CLI_PROVIDERS.has(provider)) return 'subscription';
  return provider === 'local' ? 'local' : 'api_key';
}

function text(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const said = String(value).trim();
  return said || null;
}

/** A whole number above zero, or null: what the engine honors for a cap or a batch size. */
function positive(value: unknown): number | null {
  const parsed = typeof value === 'number' ? Math.trunc(value)
    : /^\s*[+-]?\d+\s*$/.test(String(value ?? '')) ? Number.parseInt(String(value), 10) : Number.NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

/**
 * The stored chain's usable lanes, by the engine's own rules: an entry that
 * is not an object, names no known kind, or has no provider is skipped, and
 * the first usable lane is the main one.
 */
export function readChain(raw: string | null | undefined): { entries: ChainEntry[]; unreadable: boolean } {
  const stored = (raw ?? '').trim();
  if (!stored) return { entries: [], unreadable: false };
  let decoded: unknown;
  try {
    decoded = JSON.parse(stored);
  } catch {
    return { entries: [], unreadable: true };
  }
  if (!Array.isArray(decoded)) return { entries: [], unreadable: true };
  const entries: ChainEntry[] = [];
  for (const item of decoded) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
    const entry = item as Record<string, unknown>;
    const kind = String(entry.kind ?? '').trim().toLowerCase();
    const provider = String(entry.provider ?? '').trim().toLowerCase();
    if (!LANE_KINDS.includes(kind) || !provider) continue;
    entries.push({
      raw: entry,
      lane: {
        kind: kind as LaneKind, provider,
        model: text(entry.model), endpoint: text(entry.endpoint), base_url: text(entry.base_url),
        binary_path: text(entry.binary_path), effort: text(entry.effort),
        doc_cap: positive(entry.doc_cap), batch_size: positive(entry.batch_size),
      },
    });
  }
  return { entries, unreadable: entries.length === 0 };
}

/**
 * What a run uses now, as the form's starting values: the chain's first lane
 * where one is stored, else the single keys (for Ollama, `ai_local_model`
 * before `ai_model`, as `lane_from_legacy_settings` reads them). A field the
 * first lane's kind does not use keeps its stored single key.
 */
export function storedSummary(stored: AiSettings): StoredSummary {
  const { entries, unreadable } = readChain(stored.ai_chain);
  const [primary = null, ...fallbacks] = entries;
  if (!primary) {
    const local = stored.ai_provider === 'local';
    return {
      primary: null, fallbacks: [], unreadable,
      form: {
        ai_provider: stored.ai_provider,
        ai_model: local ? (stored.ai_local_model || stored.ai_model) : stored.ai_model,
        ai_cli_path: stored.ai_cli_path,
        ai_effort: stored.ai_effort,
        ai_custom_base_url: stored.ai_custom_base_url,
        ai_local_endpoint: stored.ai_local_endpoint,
      },
    };
  }
  const { lane } = primary;
  const cli = lane.kind === 'subscription';
  return {
    primary, fallbacks, unreadable: false,
    form: {
      ai_provider: lane.provider,
      ai_model: lane.model ?? '',
      ai_cli_path: cli ? lane.binary_path ?? '' : stored.ai_cli_path,
      ai_effort: cli ? lane.effort ?? '' : stored.ai_effort,
      ai_custom_base_url: lane.provider === 'custom' ? lane.base_url ?? '' : stored.ai_custom_base_url,
      ai_local_endpoint: lane.kind === 'local' ? lane.endpoint ?? '' : stored.ai_local_endpoint,
    },
  };
}

/**
 * How many papers a command is sent per call and per run, as the engine will
 * read them: from the stored first lane where it is a command, else from the
 * stored cap, which `composeChain` carries into the lane on the next save.
 */
export function planLimits(stored: AiSettings): { batch: number; cap: number } {
  const { primary } = storedSummary(stored);
  if (primary?.lane.kind === 'subscription') {
    return { batch: primary.lane.batch_size ?? DEFAULT_BATCH, cap: primary.lane.doc_cap ?? DEFAULT_DOC_CAP };
  }
  return { batch: DEFAULT_BATCH, cap: positive(stored.ai_subscription_doc_cap) ?? DEFAULT_DOC_CAP };
}

/**
 * The chain to store: the form as its first lane, then the fallbacks kept,
 * each exactly as it was stored. Empty where a chain would say nothing the
 * single keys do not, as the classic Settings writes it: no fallbacks and a
 * provider that is not a command. A command always gets a chain, because its
 * path, effort, cap, and batch size exist only on a lane.
 *
 * The cap and batch size are not on this form, so they are carried: from the
 * stored first lane where it was a command too, else from the stored cap.
 */
export function composeChain(form: SummaryForm, fallbacks: readonly ChainEntry[], stored: AiSettings): string {
  const provider = form.ai_provider.trim();
  if (!provider) return '';
  const kind = laneKind(provider);
  if (!fallbacks.length && kind !== 'subscription') return '';
  const lane: Record<string, unknown> = { kind, provider };
  const model = form.ai_model.trim();
  if (model) lane.model = model;
  if (kind === 'api_key') {
    lane.credential_alias = KEY_NAMES[provider] ?? `${provider}_api_key`;
    if (provider === 'custom' && form.ai_custom_base_url.trim()) lane.base_url = form.ai_custom_base_url.trim();
  }
  if (kind === 'local' && form.ai_local_endpoint.trim()) lane.endpoint = form.ai_local_endpoint.trim();
  if (kind === 'subscription') {
    if (form.ai_cli_path.trim()) lane.binary_path = form.ai_cli_path.trim();
    if (form.ai_effort.trim()) lane.effort = form.ai_effort.trim();
    const { primary } = storedSummary(stored);
    const before = primary?.lane.kind === 'subscription' ? primary.lane : null;
    const cap = before ? before.doc_cap : positive(stored.ai_subscription_doc_cap);
    if (cap) lane.doc_cap = cap;
    if (before?.batch_size) lane.batch_size = before.batch_size;
  }
  return JSON.stringify([lane, ...fallbacks.map((f) => f.raw)]);
}

/**
 * What Save sends: the single keys, kept in step with the first lane for a
 * build that reads only them, and the chain. For Ollama the model goes to
 * both keys it can be read from, so a stale `ai_local_model` cannot win.
 */
export function summaryPayload(stored: AiSettings, form: SummaryForm, fallbacks: readonly ChainEntry[]): Record<string, string> {
  const local = form.ai_provider === 'local';
  return {
    ai_provider: form.ai_provider,
    ai_model: form.ai_model,
    ai_cli_path: form.ai_cli_path,
    ai_effort: form.ai_effort,
    ai_custom_base_url: form.ai_custom_base_url,
    ...(local ? { ai_local_model: form.ai_model, ai_local_endpoint: form.ai_local_endpoint } : {}),
    ai_chain: composeChain(form, fallbacks, stored),
  };
}

const PLANS: Record<string, string> = { claude_code: 'your Claude plan', codex: 'your ChatGPT plan' };

/** One lane in a sentence: what it is, which model, and what it runs on. */
export function laneWords(lane: ChainLane): string {
  const name = lane.kind === 'local' ? 'Ollama' : providerWords(lane.provider);
  switch (lane.kind) {
    case 'subscription':
      return `${name} · ${lane.model ?? 'the command’s default model'}, on ${PLANS[lane.provider] ?? 'your plan'}`;
    case 'local':
      return lane.model
        ? `${name} · ${lane.model}, on ${lane.endpoint ?? 'this computer'}`
        : `${name}, with no model set, so a run skips it`;
    default:
      return lane.model
        ? `${name} · ${lane.model}, with your ${name} key`
        : `${name}, with no model set, so a run skips it`;
  }
}

/** Whether the form or the fallbacks differ from what is stored. */
export function summaryChanged(stored: AiSettings, form: SummaryForm, fallbacks: readonly ChainEntry[]): boolean {
  const before = storedSummary(stored);
  const keys = Object.keys(form) as (keyof SummaryForm)[];
  return keys.some((key) => form[key] !== before.form[key])
    || JSON.stringify(fallbacks.map((f) => f.raw)) !== JSON.stringify(before.fallbacks.map((f) => f.raw));
}

/**
 * One way the assistant can run, in words that claim only what resmon
 * checked. Finding the command is not knowing anyone is signed into it, and
 * the engine's own reason for a key already says the key is untried.
 */
export function routeSentence(kind: string, available: boolean, reason: string, selected: boolean): string {
  const said = /[.!?]$/.test(reason.trim()) ? reason.trim() : `${reason.trim()}.`;
  if (!available) return selected ? `cannot run. ${said}` : said;
  if (kind === 'claude_cli') return `${said} Sign-in and model acceptance are unverified until the first message.`;
  return said;
}
