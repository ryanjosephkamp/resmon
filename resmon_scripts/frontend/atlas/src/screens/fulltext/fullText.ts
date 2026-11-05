/**
 * Get the PDF and Find a paper, as the renderer reads them: the engine's
 * records (`/api/full-text/*`, `/api/find*`), put into the app's words.
 *
 * Nothing here decides whether a copy may be downloaded. The engine says so
 * (`downloadable`, a stated open license and never NASA ADS, Springer, CORE,
 * BMC, or nature.com) and why not (`why_not_words`); this file only says it.
 */
import { useCallback } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { answer, engine, EngineError } from '../../api/client';
import type { components } from '../../api/schema';

export type FullTextStatus = components['schemas']['FullTextStatus'];
export type FullTextRequest = components['schemas']['FullTextRequest'];
export type FullTextCopy = components['schemas']['FullTextCopy'];
export type FindResult = components['schemas']['FindResult'];
export type FindSourceResult = components['schemas']['FindSourceResult'];
export type FindDifference = components['schemas']['FindDifference'];
export type FindPlan = components['schemas']['FindPlan'];
export type FullTextRules = components['schemas']['FullTextRules'];

export const FULL_TEXT_KEY = 'full-text';
/** How many papers the engine answers about at once. */
const PER_ASK = 200;
/** How often a page reads a request again while it waits or downloads. */
const WHILE_GETTING_MS = 1000;

/** A refusal in the engine's words, or the error's own. */
export function errorWords(error: unknown): string {
  if (error instanceof EngineError && error.detail) return error.detail;
  return error instanceof Error ? error.message : String(error);
}

/** Whether a request is still going: waiting its turn, or downloading. */
export function pending(request: FullTextRequest | null | undefined): boolean {
  return request?.state === 'waiting' || request?.state === 'downloading';
}

/**
 * The papers' full-text statuses, by paper, read again every second while any
 * of their requests is still going, and not otherwise.
 */
export function useFullText(ids: readonly number[]) {
  return useQuery({
    queryKey: [FULL_TEXT_KEY, ids],
    enabled: ids.length > 0,
    queryFn: async () => {
      const parts: FullTextStatus[][] = [];
      for (let at = 0; at < ids.length; at += PER_ASK) {
        parts.push(await answer(engine().POST('/api/full-text/for-documents', {
          body: { document_ids: ids.slice(at, at + PER_ASK) },
        })));
      }
      return new Map(parts.flat().map((s) => [s.document_id, s]));
    },
    refetchInterval: (query) => {
      const data = query.state.data;
      return data && [...data.values()].some((s) => pending(s.download)) ? WHILE_GETTING_MS : false;
    },
  });
}

/**
 * Ask for one paper's PDF. When it lands, the Library's lists and the paper's
 * queue entry are read again, so a card becomes a PDF card with its cover.
 */
export function useGetPdf() {
  const client = useQueryClient();
  const refresh = () => {
    void client.invalidateQueries({ queryKey: [FULL_TEXT_KEY] });
  };
  return useMutation({
    mutationFn: (documentId: number) => answer(engine().POST('/api/documents/{doc_id}/full-text', {
      params: { path: { doc_id: documentId } },
    })),
    onSuccess: refresh,
  });
}

/** When a request that was going has finished, what else on the page to read again. */
export function useLandedRefresh() {
  const client = useQueryClient();
  return useCallback(() => {
    void client.invalidateQueries({ queryKey: ['reading-queue'] });
    void client.invalidateQueries({ queryKey: ['library-files'] });
    void client.invalidateQueries({ queryKey: ['library'] });
  }, [client]);
}

/** The host a copy is at, as a person reads it: without `www.`. */
export function hostWords(host: string | null | undefined): string {
  return (host ?? 'the source').replace(/^www\./, '');
}

/** "CC BY", or what the engine still has to read. */
export function licenseWords(copy: Pick<FullTextCopy, 'license_words' | 'license_to_be_read'> | null | undefined): string {
  if (!copy) return 'no license stated';
  if (copy.license_words) return copy.license_words;
  return copy.license_to_be_read ? 'license read from arXiv when you ask' : 'no license stated';
}

/** One sentence for a request, as it stands. */
export function requestWords(request: FullTextRequest): string {
  switch (request.state) {
    case 'waiting': return `Waiting its turn to get the PDF from ${hostWords(request.host)}.`;
    case 'downloading': return `Getting the PDF from ${hostWords(request.host)}.`;
    case 'stored':
      return request.reason === 'already_in_library' ? 'The PDF is already in the Library.' : 'The PDF is in the Library.';
    default: return request.words ?? 'The PDF was not downloaded.';
  }
}

/** What a find was asked for, in words: "the DOI 10.1371/…", "the title “…”". */
export function askedWords(query: { kind?: string | null; value?: string | null }): string {
  const value = query.value ?? '';
  switch (query.kind) {
    case 'doi': return `the DOI ${value}`;
    case 'arxiv': return `the arXiv id ${value}`;
    case 'pmid': return `the PMID ${value}`;
    default: return `the title “${value}”`;
  }
}

export const KIND_WORDS: Record<string, string> = { doi: 'DOI', arxiv: 'arXiv id', pmid: 'PMID', title: 'title' };

/** How a copy matched, in the words of the result. */
export function matchedWords(source: Pick<FindSourceResult, 'matched_by' | 'title_similarity'>): string {
  switch (source.matched_by) {
    case 'doi': return 'by its DOI';
    case 'arxiv': return 'by its arXiv id';
    case 'pmid': return 'by its PMID';
    case 'exact_title': return 'by its exact title';
    case 'close_title': {
      const share = source.title_similarity == null ? null : Math.round(source.title_similarity * 100);
      return share == null ? 'by a close title' : `by a close title (${share}% of its words)`;
    }
    default: return '';
  }
}

/** One source's answer to a find, as the outcome column says it. */
export function outcomeWords(source: FindSourceResult): string {
  switch (source.outcome) {
    case 'found': return `Found ${matchedWords(source)}`;
    case 'not_found': {
      const n = source.candidates ?? 0;
      return n ? `Not found: none of the ${n === 1 ? 'record' : `${n} records`} it sent is this paper` : 'Not found: it answered with nothing';
    }
    case 'did_not_answer': return 'Did not answer';
    case 'not_asked': return 'Not asked';
    default: return source.outcome;
  }
}

/** One difference from the reference copy, in a short phrase. */
export function differenceWords(d: FindDifference): string {
  const value = (v: unknown) => (v === null || v === undefined || v === '' ? null : String(v));
  const self = value(d.this);
  const ref = value(d.reference);
  switch (d.field) {
    case 'title': return `title “${self ?? 'none'}”`;
    case 'year': return self ? `year ${self}${ref ? `, not ${ref}` : ', where the reference copy gives none'}` : 'no year';
    case 'doi': return self ? `DOI ${self}${ref ? '' : ', where the reference copy gives none'}` : 'no DOI';
    case 'first_author': return `first author ${self ?? 'not given'}`;
    case 'author_count': return `${self ?? 'no'} ${self === '1' ? 'author' : 'authors'}${ref ? `, not ${ref}` : ''}`;
    default: return `${d.field} differs`;
  }
}

/** The differences, joined, or null when the copy agrees with the reference on all five. */
export function differencesWords(source: Pick<FindSourceResult, 'differences' | 'reference'>): string | null {
  if (source.reference) return 'The copy the others are compared with';
  if (!source.differences.length) return null;
  const parts = source.differences.map(differenceWords);
  return parts.length === 1 ? parts[0]! : `${parts.slice(0, -1).join(', ')}, and ${parts[parts.length - 1]}`;
}

/** A sentence that begins with a capital, whatever the engine's phrase began with. */
export function sentenceCase(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** The order the outcome groups are listed in. */
export const OUTCOME_ORDER = ['found', 'not_found', 'did_not_answer', 'not_asked'] as const;
