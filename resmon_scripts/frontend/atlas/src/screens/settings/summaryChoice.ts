/**
 * Summaries for one run, or for every run of a watch: on or off, with the
 * lanes Settings › AI holds or with one lane of its own, and how each summary
 * is written, each as Settings › AI has it unless set here.
 *
 * It travels as `ai_enabled` and `ai_settings`, which the engine merges over
 * Settings › AI when the run starts (`resmon._merge_ai_override`). A lane of
 * its own is sent as a one-lane `chain` as well as its provider and model:
 * the chain is what the engine runs, so the lane is exactly the one shown
 * here, and the provider and model are what the run's report names. A lane of
 * its own runs alone; the fallbacks in Settings › AI are not tried after it.
 */
import {
  CLI_PROVIDERS, entryOf, formLane, laneRaw, laneWords, readChain, storedSummary,
  type AiSettings, type ChainEntry,
} from './summaryLanes';

export interface SummaryChoice {
  on: boolean;
  /** `settings`: the lanes Settings › AI holds when a run starts. `own`: the one lane below, and only it. */
  lane: 'settings' | 'own';
  provider: string;
  model: string;
  /** Blank: as Settings › AI has it. */
  length: string;
  tone: string;
  temperature: string;
  extraction_goals: string;
  /** A stored lane list this screen did not write, sent back as it was until the lane is changed here. */
  keptChain: string | null;
}

export const NO_CHOICE: SummaryChoice = {
  on: false, lane: 'settings', provider: '', model: '', length: '', tone: '', temperature: '', extraction_goals: '', keptChain: null,
};

/** The keys of `ai_settings` this screen reads and writes; any other is kept as it is. */
const KNOWN = ['provider', 'model', 'local_model', 'chain', 'length', 'tone', 'temperature', 'extraction_goals'];

function objectOf(raw: unknown): Record<string, unknown> {
  let value = raw;
  if (typeof value === 'string') {
    try { value = JSON.parse(value); } catch { return {}; }
  }
  return value && typeof value === 'object' && !Array.isArray(value) ? { ...(value as Record<string, unknown>) } : {};
}

const said = (value: unknown): string => (value === null || value === undefined ? '' : String(value).trim());

/**
 * A stored choice (a watch's `ai_enabled` and `ai_settings`) as the form
 * shows it. A provider is read from the chain where one is stored, since the
 * chain is what runs; a provider with no chain is the one lane the engine
 * runs for it, as a watch saved in the classic editor stores it.
 */
export function choiceOf(enabled: boolean, settings: unknown): SummaryChoice {
  const stored = objectOf(settings);
  const chain = said(stored.chain);
  const lanes = chain ? readChain(chain).entries : [];
  const first = lanes[0]?.lane;
  const provider = first?.provider ?? said(stored.provider).toLowerCase();
  return {
    on: enabled,
    lane: provider ? 'own' : 'settings',
    provider,
    model: first ? first.model ?? '' : said(stored.model) || said(stored.local_model),
    length: said(stored.length),
    tone: said(stored.tone),
    temperature: said(stored.temperature),
    extraction_goals: said(stored.extraction_goals),
    keptChain: lanes.length ? chain : null,
  };
}

/**
 * The lane a choice of its own runs: where Settings › AI sets that same
 * provider, its command path, endpoint, or base URL is the one used, since
 * those say where the provider is rather than which model.
 */
export function ownLane(choice: Pick<SummaryChoice, 'provider' | 'model'>, stored: AiSettings): Record<string, unknown> {
  const settings = storedSummary(stored).form;
  return laneRaw({
    provider: choice.provider,
    model: choice.model,
    base_url: stored.ai_custom_base_url,
    endpoint: settings.ai_provider === 'local' ? settings.ai_local_endpoint : stored.ai_local_endpoint,
    cli_path: CLI_PROVIDERS.has(choice.provider) && settings.ai_provider === choice.provider ? settings.ai_cli_path : '',
  });
}

/**
 * What `ai_settings` carries for a choice: an empty object where nothing is
 * set here, which the engine reads as "as Settings › AI has it". Starts from
 * `kept`, what is stored, so a key a newer build writes survives a save.
 */
export function overrideOf(choice: SummaryChoice, stored: AiSettings, kept: unknown = {}): Record<string, unknown> {
  const out = objectOf(kept);
  for (const key of KNOWN) delete out[key];
  if (choice.lane === 'own' && choice.provider) {
    out.provider = choice.provider;
    if (choice.model.trim()) out.model = choice.model.trim();
    out.chain = choice.keptChain ?? JSON.stringify([ownLane(choice, stored)]);
  }
  if (choice.length) out.length = choice.length;
  if (choice.tone) out.tone = choice.tone;
  if (choice.temperature.trim()) out.temperature = choice.temperature.trim();
  if (choice.extraction_goals.trim()) out.extraction_goals = choice.extraction_goals.trim();
  return out;
}

/** The lanes Settings › AI holds, in the order a run tries them, as the engine resolves them. */
export function settingsLanes(stored: AiSettings): ChainEntry[] {
  const { entries } = readChain(stored.ai_chain);
  if (entries.length) return entries;
  const single = stored.ai_provider ? entryOf(formLane(storedSummary(stored).form)) : null;
  return single ? [single] : [];
}

/** The lanes a choice runs, in order. */
export function choiceLanes(choice: SummaryChoice, stored: AiSettings): ChainEntry[] {
  if (choice.lane === 'own' && choice.provider) {
    const chain = choice.keptChain ?? JSON.stringify([ownLane(choice, stored)]);
    return readChain(chain).entries;
  }
  return settingsLanes(stored);
}

const WORDING_NAMES: Record<string, string> = {
  length: 'length', tone: 'tone', temperature: 'temperature', extraction_goals: 'what to draw out',
};

/** "length and tone", for the wording a choice sets. */
export function wordingSet(choice: Pick<SummaryChoice, 'length' | 'tone' | 'temperature' | 'extraction_goals'>): string[] {
  return (['length', 'tone', 'temperature', 'extraction_goals'] as const)
    .filter((key) => choice[key].trim()).map((key) => WORDING_NAMES[key]!);
}

export function listWords(items: readonly string[]): string {
  if (items.length <= 1) return items[0] ?? '';
  if (items.length === 2) return `${items[0]} and ${items[1]}`;
  return `${items.slice(0, -1).join(', ')}, and ${items[items.length - 1]}`;
}

/**
 * Which lanes a choice summarizes with, in a sentence. `whose` is what the
 * choice belongs to ("this run", "this watch"), for the lane of its own.
 */
export function choiceSentence(choice: SummaryChoice, stored: AiSettings, whose: string): string {
  if (!choice.on) return 'Off: the papers are found and kept, with no summary.';
  const lanes = choiceLanes(choice, stored);
  if (choice.lane === 'own' && choice.provider) {
    if (!lanes.length) return `With a connection set for ${whose} that resmon cannot read.`;
    const lead = `With ${lanes.map((l) => laneWords(l.lane)).join(', then ')}, set for ${whose}`;
    return settingsLanes(stored).length > 0 ? `${lead}. The connections in Settings › AI are not tried.` : `${lead}.`;
  }
  if (!lanes.length) return 'Settings › AI has no provider chosen, so no summary can be written. The papers are kept either way.';
  return `With ${lanes.map((l) => laneWords(l.lane)).join(', then ')}, as Settings › AI holds them when a run starts.`;
}

/**
 * With summaries off, where they would come from if turned on: the engine
 * merges a run's own connection over Settings › AI's when the run starts
 * (`_apply_ai_settings_to_engine`), and the choice of one is hidden while off.
 */
export function offSentence(whose: string): string {
  return `When on, summaries are written with the connections Settings › AI holds when a run starts, unless you choose one for ${whose}.`;
}

/** The same, led by whether it is on, for a page where no switch beside it says so. */
export function stateSentence(choice: SummaryChoice, stored: AiSettings, whose: string): string {
  const said = choiceSentence(choice, stored, whose);
  if (!choice.on) return said;
  return said.startsWith('With ') ? `On, with ${said.slice(5)}` : `On, but ${said}`;
}
