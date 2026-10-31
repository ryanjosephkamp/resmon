/**
 * Embeddings: the words for what is embedded, what is missing and why, and
 * whether the collection can be ranked by meaning. Each sentence says only
 * what the engine's answer establishes: vectors in the table are not vectors
 * in the index, and a provider's listing is not a probe.
 */
import type { components } from '../../api/schema';
import { providerWords } from '../ask/askModel';
import { count, number } from '../today/format';

export type EmbeddingStatus = components['schemas']['EmbeddingStatus'];
export type EmbeddingPage = components['schemas']['EmbeddingSettingsPage'];
export type ProviderAnswer = components['schemas']['EmbeddingProviderAnswer'];
export type EmbeddingRun = components['schemas']['EmbeddingJobRun'];
export type EmbeddingCapability = components['schemas']['EmbeddingCapability'];

/** The status read, shared by Settings and Search › Your collection. */
export const EMBEDDING_STATUS_KEY = ['embedding-status'] as const;

/** Settings → AI, opened at its Embeddings part. */
export const EMBEDDINGS_PATH = '/settings/ai?focus=embeddings';

/** `POST /api/embeddings/probe`. The route declares no response model, so its shape is written here. */
export interface ProbeResult {
  ok: boolean;
  dims: number | null;
  model: string | null;
  reason: string;
}

/** `GET /api/embeddings/estimate` (`embeddings.estimate_cost`). */
export interface Estimate {
  documents: number;
  estimated_tokens: number;
  cost_usd: number | null;
  disk_bytes: number | null;
  disk_note: string;
  note: string;
}

/** `POST /api/embeddings/rebuild` (`vector_index.rebuild`). */
export interface Rebuilt {
  ok: boolean;
  rebuilt: number;
  dims: number | null;
  reason: string | null;
}

/** A sentence that ends as one. */
function sentence(said: string): string {
  const trimmed = said.trim();
  return /[.!?]$/.test(trimmed) ? trimmed : `${trimmed}.`;
}

/** A sentence made a clause, to be followed by more. */
function clause(said: string): string {
  return said.trim().replace(/[.!?]+$/, '');
}

const has = (n: number) => (n === 1 ? 'has' : 'have');

/** A provider as this list names it. */
export function providerName(provider: string): string {
  if (provider === 'local') return 'Ollama, on this computer';
  if (provider === 'meta') return 'Meta, through Together AI';
  if (provider === 'custom') return 'A custom endpoint';
  return providerWords(provider);
}

/** The provider list's label: the name, and the answer when it is not a plain yes. */
export function providerLabel(answer: ProviderAnswer): string {
  if (answer.state === 'no') return `${providerName(answer.provider)} — cannot embed`;
  if (answer.state === 'unknown') return `${providerName(answer.provider)} — unverified`;
  return providerName(answer.provider);
}

const STATE_ORDER: Record<string, number> = { yes: 0, unknown: 1, no: 2 };

/** Ollama first, because it is free and sends nothing anywhere; then those that embed, those unverified, and those that cannot. */
export function orderProviders(providers: readonly ProviderAnswer[]): ProviderAnswer[] {
  return [...providers].sort((a, b) => {
    if (a.provider === 'local' || b.provider === 'local') return a.provider === 'local' ? -1 : 1;
    return (STATE_ORDER[a.state] ?? 1) - (STATE_ORDER[b.state] ?? 1) || providerName(a.provider).localeCompare(providerName(b.provider));
  });
}

/** Papers in the collection with no vector from the model set, never below zero. */
export function missingCount(status: EmbeddingStatus): number {
  return Math.max(0, status.coverage.total - status.coverage.embedded);
}

/** The Embedded fact. */
export function embeddedWords(status: EmbeddingStatus): string {
  const { embedded, total, model } = status.coverage;
  if (!model) return 'None: no embedding model is set up.';
  if (total === 0) return `None yet: your collection is empty. Papers are embedded with ${model} as runs store them.`;
  return `${number(embedded)} of ${count(total, 'paper')}, with ${model}.`;
}

/**
 * The Missing fact: how many papers have no vector, and what resmon knows of
 * why. A backfill's own count of papers with nothing to embed is the one
 * reason recorded per paper; the rest have simply not been embedded yet.
 */
export function missingWords(status: EmbeddingStatus): string {
  const { total, model } = status.coverage;
  if (total === 0) return 'None: your collection is empty.';
  if (!model) return `${count(total, 'paper')}: no embedding model is set up to make vectors.`;
  const missing = missingCount(status);
  if (missing === 0) return 'None.';
  const run = status.run;
  const last = !run.running && run.finished_at && run.model === model ? run : null;
  const parts = [`${count(missing, 'paper')} ${has(missing)} no vector from ${model} yet.`];
  if (last && last.skipped_no_text > 0) {
    const n = last.skipped_no_text;
    parts.push(`The last backfill found ${count(n, 'paper')} with no title or abstract to embed; ${n === 1 ? 'it stays' : 'they stay'} missing.`);
  }
  parts.push(missing === 1
    ? 'It is kept and searchable by its words, and is listed last when the collection is ranked by meaning.'
    : 'They are kept and searchable by their words, and are listed last when the collection is ranked by meaning.');
  return parts.join(' ');
}

/** The Similarity index fact: whether sqlite-vec loaded, and what the index holds against the table. */
export function indexWords(status: EmbeddingStatus): string {
  const { extension, reason } = status.extension;
  const { embedded, model } = status.coverage;
  if (!extension) {
    return `Not loaded: ${clause(reason ?? 'no reason was recorded')}. Nothing can be ranked by meaning in this copy of resmon; `
      + 'vectors are still made and kept, and are used once the extension loads.';
  }
  const { rows, dims } = status.index;
  const named = `sqlite-vec ${extension}`;
  if (rows === 0) {
    return model && embedded > 0
      ? `${named}, holding none of the ${count(embedded, 'vector')} from ${model}. Rebuild it below.`
      : `${named}, empty.`;
  }
  if (model && status.index.model && status.index.model !== model) {
    return `${named}, holding ${count(rows, 'vector')} from ${status.index.model}, not from ${model}. Rebuild it below.`;
  }
  if (model && rows < embedded) {
    return `${named}, holding ${number(rows)} of the ${count(embedded, 'vector')} from ${model}. Rebuild it below.`;
  }
  return `${named}, holding ${count(rows, 'vector')}${dims ? `, ${dims} dimensions each` : ''}.`;
}

export interface Ranking {
  available: boolean;
  /** Whether ranking is available, and if not, why. */
  sentence: string;
  /** The words of the link to Settings → AI → Embeddings, where something there is the next step. */
  action: string | null;
}

/**
 * Whether the collection can be ranked by meaning, and if not, the reason a
 * person can act on: no model, papers without vectors (counted), an index
 * that holds none of them, or the extension missing.
 */
export function ranking(status: EmbeddingStatus): Ranking {
  const { embedded, total, model } = status.coverage;
  const missing = missingCount(status);
  if (status.capability.available) {
    return {
      available: true, action: null,
      sentence: model && missing > 0
        ? `Ranking by meaning is on. ${count(missing, 'paper')} without a vector from ${model} ${missing === 1 ? 'is' : 'are'} listed last.`
        : 'Ranking by meaning is on.',
    };
  }
  if (!status.extension.extension) {
    const reason = status.extension.reason ?? status.capability.reason;
    return {
      available: false, action: 'Settings → AI → Embeddings says more',
      sentence: `Ranking by meaning is off: the similarity index (sqlite-vec) did not load in this copy of resmon${reason ? ` (${clause(reason)})` : ''}.`
        + (model && embedded > 0 ? ` The ${count(embedded, 'vector')} from ${model} ${embedded === 1 ? 'is' : 'are'} kept.` : ''),
    };
  }
  if (!status.lane || !model) {
    return {
      available: false, action: 'Set one up in Settings → AI → Embeddings',
      sentence: total > 0
        ? `Ranking by meaning is off: no embedding model is set up, so none of your ${count(total, 'paper')} has a vector.`
        : 'Ranking by meaning is off: no embedding model is set up.',
    };
  }
  if (total === 0) {
    return {
      available: false, action: null,
      sentence: `Ranking by meaning starts once your collection has papers: runs embed the ones they store with ${model}.`,
    };
  }
  if (embedded === 0) {
    return {
      available: false, action: 'Embed them in Settings → AI → Embeddings',
      sentence: `Ranking by meaning is off: none of your ${count(total, 'paper')} has a vector from ${model} yet.`,
    };
  }
  if (status.index.rows === 0) {
    return {
      available: false, action: 'Rebuild it in Settings → AI → Embeddings',
      sentence: `Ranking by meaning is off: ${number(embedded)} of your ${count(total, 'paper')} ${has(embedded)} a vector from ${model}, but the similarity index holds none of them.`,
    };
  }
  return { available: false, action: 'Settings → AI → Embeddings says more', sentence: sentence(status.capability.reason ?? 'Ranking by meaning is off.') };
}

/** The work and the money, before a backfill starts. */
export function estimateWords(estimate: Estimate): string {
  if (estimate.documents === 0) return 'Nothing to embed: every paper with a title or an abstract has a vector.';
  const work = `${count(estimate.documents, 'paper')} to embed, about ${number(estimate.estimated_tokens)} tokens.`;
  const cost = estimate.cost_usd;
  const money = cost !== null && cost > 0 ? (cost < 0.01 ? 'Less than $0.01. ' : `About $${cost.toFixed(2)}. `) : '';
  return `${work} ${money}${sentence(estimate.note)}`;
}

/** Papers missing a vector that an estimate does not count: they have nothing to embed. */
export function nothingToEmbedWords(missing: number, documents: number): string | null {
  const n = missing - documents;
  if (n <= 0) return null;
  return `${count(n, 'other paper')} ${has(n)} no title or abstract, so there is nothing to embed for ${n === 1 ? 'it' : 'them'}.`;
}

/** A backfill in progress. */
export function progressWords(run: EmbeddingRun): string {
  if (run.total === 0) return `Starting: finding the papers with no vector${run.model ? ` from ${run.model}` : ''}.`;
  return `Embedding with ${run.model ?? 'the model set'}: ${number(run.processed)} of ${count(run.total, 'paper')} so far.`;
}

/** How the last backfill ended, or null when there has been none in this engine's life. */
export function outcomeWords(run: EmbeddingRun): string | null {
  if (run.running || !run.finished_at) return null;
  if (run.total === 0 && !run.reason) return 'The last backfill found nothing to embed.';
  const of = `${number(run.processed)} of ${count(run.total, 'paper')}`;
  if (run.cancelled) {
    return `Stopped after ${of}, as asked. The vectors made are kept; embedding again starts from the papers still missing.`;
  }
  if (run.reason) return `Stopped after ${of}: ${clause(run.reason)}.`;
  const skipped = run.skipped_no_text > 0 ? ` ${count(run.skipped_no_text, 'paper')} had no title or abstract to embed.` : '';
  return `Embedded ${of}${run.model ? ` with ${run.model}` : ''}.${skipped}`;
}

/** What a rebuild did. */
export function rebuiltWords(result: Rebuilt): string {
  if (!result.ok) return `Not rebuilt: ${clause(result.reason ?? 'the similarity index could not be loaded')}.`;
  if (result.rebuilt === 0) return sentence(result.reason ?? 'There were no vectors to index.');
  const done = `Rebuilt: the index holds ${count(result.rebuilt, 'vector')}${result.dims ? `, ${result.dims} dimensions each` : ''}.`;
  return result.reason ? `${done} ${sentence(result.reason)}` : done;
}
