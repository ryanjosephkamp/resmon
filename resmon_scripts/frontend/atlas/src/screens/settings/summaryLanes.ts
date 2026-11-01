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

/** `GET /api/settings/ai`, read by Settings, Search, and the watch screens alike. */
export const AI_KEY = ['ai-settings'] as const;

/** The providers a summary can come from: the plans you already pay for first. */
export const PROVIDERS: readonly { value: string; label: string }[] = [
  { value: 'claude_code', label: 'Claude Code, on your Claude plan' },
  { value: 'codex', label: 'Codex, on your ChatGPT plan' },
  { value: 'anthropic', label: 'Anthropic' },
  { value: 'openai', label: 'OpenAI' },
  { value: 'google', label: 'Google' },
  { value: 'xai', label: 'xAI' },
  // Meta's models are reached through Together AI, and the text goes there: Settings › About says so too.
  { value: 'meta', label: 'Meta, through Together AI' },
  { value: 'deepseek', label: 'DeepSeek' },
  { value: 'alibaba', label: 'Alibaba' },
  { value: 'local', label: 'Local (Ollama)' },
  { value: 'custom', label: 'A custom endpoint' },
];

/** The two providers that are a command on this computer rather than an API. */
export const CLI_PROVIDERS = new Set(['claude_code', 'codex']);

/** The providers a temperature is sent to (`llm_remote`): the OpenAI-compatible ones and Google. */
export const TEMPERATURE_PROVIDERS = new Set(['openai', 'google', 'xai', 'meta', 'deepseek', 'alibaba', 'custom']);

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

/** The form's fields: the first lane, in the single keys' names, and a command's two limits. */
export interface SummaryForm {
  ai_provider: string;
  ai_model: string;
  ai_cli_path: string;
  ai_effort: string;
  ai_custom_base_url: string;
  ai_local_endpoint: string;
  /** A command's most papers per run, as typed; blank is `DEFAULT_DOC_CAP`. Only a lane can carry it. */
  doc_cap: string;
  /** A command's papers per call, as typed; blank is `DEFAULT_BATCH`. Only a lane can carry it. */
  batch_size: string;
}

/**
 * How every summary is written, whichever lane writes it: four single keys
 * that `_build_prompt_params` reads for every run. A blank length or tone is
 * the engine's own default, so the form shows that default rather than a
 * blank it would have to explain.
 */
export interface Wording {
  ai_summary_length: string;
  ai_tone: string;
  ai_temperature: string;
  ai_extraction_goals: string;
}

/** The lengths a summary can be asked for, and the words each asks for (`prompt_templates._LENGTH_BANDS`). */
export const LENGTHS: readonly { value: string; label: string }[] = [
  { value: 'brief', label: 'Brief, about 40 to 80 words' },
  { value: 'standard', label: 'Standard, about 120 to 180 words' },
  { value: 'detailed', label: 'Detailed, about 250 to 450 words' },
];
export const TONES: readonly { value: string; label: string }[] = [
  { value: 'technical', label: 'Technical: the field’s own terms' },
  { value: 'neutral', label: 'Neutral: plain, even prose' },
  { value: 'accessible', label: 'Accessible: jargon explained' },
];
/** What a run asks for when no length, tone, or goals are stored (`_build_prompt_params`, the clients' defaults). */
export const DEFAULT_LENGTH = 'standard';
export const DEFAULT_TONE = 'technical';
export const DEFAULT_GOALS = 'key findings, methodology, contributions';
/** The temperature an API-key request carries when none is stored (`llm_remote._DEFAULT_TEMPERATURE`). */
export const DEFAULT_TEMPERATURE = '0.2';

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
  // The cap's single key is read only for a command: a provider that is not one has no cap to show or keep.
  const storedCap = CLI_PROVIDERS.has(stored.ai_provider) ? positive(stored.ai_subscription_doc_cap) : null;
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
        doc_cap: storedCap ? String(storedCap) : '',
        batch_size: '',
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
      doc_cap: cli && lane.doc_cap ? String(lane.doc_cap) : '',
      batch_size: cli && lane.batch_size ? String(lane.batch_size) : '',
    },
  };
}

/** How every summary is written now, with a blank length or tone read as the default a run uses. */
export function wordingOf(stored: AiSettings): Wording {
  return {
    ai_summary_length: stored.ai_summary_length || DEFAULT_LENGTH,
    ai_tone: stored.ai_tone || DEFAULT_TONE,
    ai_temperature: stored.ai_temperature,
    ai_extraction_goals: stored.ai_extraction_goals,
  };
}

/**
 * Why a temperature cannot be saved, or null. Blank is the default. The range
 * is 0 to 1 because that is what every provider that is sent one accepts.
 */
export function temperatureProblem(text: string): string | null {
  const said = text.trim();
  if (!said) return null;
  const value = Number(said);
  return Number.isFinite(value) && value >= 0 && value <= 1 ? null : 'A temperature is a number from 0 to 1.';
}

/**
 * Why a custom endpoint cannot be used, or null: the engine refuses anything
 * but HTTPS, or HTTP on this computer (`llm_factory._validate_custom_base_url`),
 * rather than send a key in the clear. Blank is not a problem until a run needs it.
 */
export function baseUrlProblem(text: string): string | null {
  const said = text.trim();
  if (!said) return null;
  let url: URL;
  try {
    url = new URL(said);
  } catch {
    return 'An endpoint is a whole address, such as https://api.example.com/v1.';
  }
  if (url.protocol === 'https:') return null;
  const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (url.protocol === 'http:') {
    return ['localhost', '127.0.0.1', '::1'].includes(host) ? null
      : 'Plain HTTP is used only on this computer. Use an https:// address, so the key is not sent in the clear.';
  }
  return 'An endpoint starts with https://.';
}

/** The model each provider was last saved with (`ai_default_models`), so choosing it again brings it back. */
export function rememberedModels(stored: AiSettings): Record<string, string> {
  try {
    const parsed: unknown = JSON.parse(stored.ai_default_models || '{}');
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    return Object.fromEntries(Object.entries(parsed as Record<string, unknown>)
      .filter((entry): entry is [string, string] => typeof entry[1] === 'string' && entry[1].length > 0));
  } catch {
    return {};
  }
}

/**
 * The form after another provider is chosen. Going back to the stored one
 * restores what is stored for it. Any other starts from the model it was last
 * saved with, and with no command path, effort, or limits: those belong to
 * the provider they were set for, and a path to one command is not a path to
 * the other.
 */
export function switchProvider(form: SummaryForm, next: string, start: SummaryForm, remembered: Record<string, string>): SummaryForm {
  if (next === start.ai_provider) {
    return {
      ...form, ai_provider: next, ai_model: start.ai_model, ai_cli_path: start.ai_cli_path, ai_effort: start.ai_effort,
      doc_cap: start.doc_cap, batch_size: start.batch_size,
    };
  }
  return { ...form, ai_provider: next, ai_model: remembered[next] ?? '', ai_cli_path: '', ai_effort: '', doc_cap: '', batch_size: '' };
}

/** How many papers a command is sent per call and per run, as the form stands. */
export function limitsOf(form: Pick<SummaryForm, 'doc_cap' | 'batch_size'>): { batch: number; cap: number } {
  return { batch: positive(form.batch_size) ?? DEFAULT_BATCH, cap: positive(form.doc_cap) ?? DEFAULT_DOC_CAP };
}

/** Why a typed limit cannot be saved, or null. Blank is the engine's default. */
export function limitProblem(text: string): string | null {
  return !text.trim() || positive(text) ? null : 'A whole number above zero.';
}

/** One lane's fields, as typed: the main lane, a fallback, or a run's own. */
export interface LaneFields {
  provider: string;
  model: string;
  cli_path?: string;
  effort?: string;
  base_url?: string;
  endpoint?: string;
  doc_cap?: string;
  batch_size?: string;
}

/**
 * A lane as the chain stores it, with only the fields its kind uses and
 * nothing blank, so the engine reads exactly what was typed.
 */
export function laneRaw(fields: LaneFields): Record<string, unknown> {
  const provider = fields.provider.trim();
  const kind = laneKind(provider);
  const lane: Record<string, unknown> = { kind, provider };
  const model = fields.model.trim();
  if (model) lane.model = model;
  if (kind === 'api_key') {
    lane.credential_alias = KEY_NAMES[provider] ?? `${provider}_api_key`;
    if (provider === 'custom' && fields.base_url?.trim()) lane.base_url = fields.base_url.trim();
  }
  if (kind === 'local' && fields.endpoint?.trim()) lane.endpoint = fields.endpoint.trim();
  if (kind === 'subscription') {
    if (fields.cli_path?.trim()) lane.binary_path = fields.cli_path.trim();
    if (fields.effort?.trim()) lane.effort = fields.effort.trim();
    const cap = positive(fields.doc_cap);
    if (cap) lane.doc_cap = cap;
    const batch = positive(fields.batch_size);
    if (batch) lane.batch_size = batch;
  }
  return lane;
}

/** A typed lane as a chain entry, read back by the engine's rules; null where it has no provider. */
export function entryOf(fields: LaneFields): ChainEntry | null {
  if (!fields.provider.trim()) return null;
  return readChain(JSON.stringify([laneRaw(fields)])).entries[0] ?? null;
}

/** The list with one entry moved up (-1) or down (+1); unchanged where it cannot move. */
export function moveFallback<T>(list: readonly T[], index: number, delta: -1 | 1): T[] {
  const target = index + delta;
  if (index < 0 || index >= list.length || target < 0 || target >= list.length) return [...list];
  const next = [...list];
  [next[index], next[target]] = [next[target]!, next[index]!];
  return next;
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

/** The form's first lane as typed. */
export function formLane(form: SummaryForm): LaneFields {
  return {
    provider: form.ai_provider, model: form.ai_model, cli_path: form.ai_cli_path, effort: form.ai_effort,
    base_url: form.ai_custom_base_url, endpoint: form.ai_local_endpoint, doc_cap: form.doc_cap, batch_size: form.batch_size,
  };
}

/**
 * The chain to store: the form as its first lane, then the fallbacks kept,
 * each exactly as it was stored. Empty where a chain would say nothing the
 * single keys do not, as resmon has always stored it: no fallbacks and a
 * provider that is not a command. A command always gets a chain, because its
 * path, effort, cap, and batch size exist only on a lane.
 */
export function composeChain(form: SummaryForm, fallbacks: readonly ChainEntry[]): string {
  const provider = form.ai_provider.trim();
  if (!provider) return '';
  if (!fallbacks.length && laneKind(provider) !== 'subscription') return '';
  return JSON.stringify([laneRaw(formLane(form)), ...fallbacks.map((f) => f.raw)]);
}

/**
 * What Save sends: the single keys, kept in step with the first lane for a
 * build that reads only them, the chain, and how summaries are written. For
 * Ollama the model goes to both keys it can be read from, so a stale
 * `ai_local_model` cannot win, and a command's cap goes to its single key
 * too. The model is remembered for its provider (`ai_default_models`), so
 * choosing that provider again brings it back; no run reads that map.
 */
export function summaryPayload(
  stored: AiSettings, form: SummaryForm, fallbacks: readonly ChainEntry[], wording: Wording = wordingOf(stored),
): Record<string, string> {
  const local = form.ai_provider === 'local';
  const cli = CLI_PROVIDERS.has(form.ai_provider);
  const remembered = rememberedModels(stored);
  const model = form.ai_model.trim();
  const remember = !!form.ai_provider && !!model && remembered[form.ai_provider] !== model;
  return {
    ai_provider: form.ai_provider,
    ai_model: form.ai_model,
    ai_cli_path: form.ai_cli_path,
    ai_effort: form.ai_effort,
    ai_custom_base_url: form.ai_custom_base_url,
    ...(local ? { ai_local_model: form.ai_model, ai_local_endpoint: form.ai_local_endpoint } : {}),
    ...(cli ? { ai_subscription_doc_cap: form.doc_cap.trim() } : {}),
    ai_chain: composeChain(form, fallbacks),
    ai_summary_length: wording.ai_summary_length,
    ai_tone: wording.ai_tone,
    ai_temperature: wording.ai_temperature.trim(),
    ai_extraction_goals: wording.ai_extraction_goals.trim(),
    ...(remember ? { ai_default_models: JSON.stringify({ ...remembered, [form.ai_provider]: model }) } : {}),
  };
}

const PLANS: Record<string, string> = { claude_code: 'your Claude plan', codex: 'your ChatGPT plan' };

/** A provider's name in a lane's sentence. */
export function laneName(provider: string, kind?: string): string {
  if (kind === 'local' || provider === 'local') return 'Ollama';
  return provider === 'custom' ? 'Custom endpoint' : providerWords(provider);
}

/** One lane in a sentence: what it is, which model, and what it runs on. */
export function laneWords(lane: ChainLane): string {
  const name = laneName(lane.provider, lane.kind);
  switch (lane.kind) {
    case 'subscription':
      return `${name} · ${lane.model ?? 'the command’s default model'}, on ${PLANS[lane.provider] ?? 'your plan'}`;
    case 'local':
      return lane.model
        ? `${name} · ${lane.model}, on ${lane.endpoint ?? 'this computer'}`
        : `${name}, with no model set, so a run skips it`;
    default:
      if (!lane.model) return `${name}, with no model set, so a run skips it`;
      return lane.provider === 'custom'
        ? `${name} · ${lane.model}, at ${lane.base_url ?? 'the endpoint in Settings › AI'}, with its key`
        : `${name} · ${lane.model}, with your ${name} key`;
  }
}

/** Whether the form, the fallbacks, or the wording differ from what is stored. */
export function summaryChanged(
  stored: AiSettings, form: SummaryForm, fallbacks: readonly ChainEntry[], wording: Wording = wordingOf(stored),
): boolean {
  const before = storedSummary(stored);
  const said = wordingOf(stored);
  const keys = Object.keys(form) as (keyof SummaryForm)[];
  const words = Object.keys(wording) as (keyof Wording)[];
  return keys.some((key) => form[key] !== before.form[key])
    || words.some((key) => wording[key] !== said[key])
    || JSON.stringify(fallbacks.map((f) => f.raw)) !== JSON.stringify(before.fallbacks.map((f) => f.raw));
}

/**
 * What `/api/ai/models` answers (it declares no model): a provider's model
 * IDs, or for a command, what the command says it accepts, with how that list
 * was obtained, which is a different claim for each of the two.
 */
export interface ModelCatalog {
  models: string[];
  provenance?: string;
  /** Per model, the effort levels the command reports it takes. */
  efforts?: Record<string, string[]>;
}

/**
 * The effort levels to offer: the model's own where the command listed them,
 * else every level any listed model takes, else the levels known without a
 * list. The command checks the level when it runs.
 */
export function effortsFor(catalog: ModelCatalog | null, model: string, known: readonly string[]): string[] {
  const listed = catalog?.efforts ?? {};
  if (model && listed[model]?.length) return [...listed[model]!];
  const all = [...new Set(Object.values(listed).flat())];
  return all.length ? all : [...known];
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
