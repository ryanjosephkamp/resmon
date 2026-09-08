/**
 * The reading queue's HTTP surface, in one place.
 *
 * Membership only. Nothing here deletes a paper: `remove` drops the queue row
 * and the corpus is untouched, which is the distinction the interface has to
 * keep visible and the reason the call is not named `delete`.
 */
import { apiClient } from './client';

/** What the backend stores. The interface labels these "To read" and "Read". */
export type ReadingStatus = 'to_read' | 'read';

/** The filter a user has chosen. `all` is not a stored status. */
export type ReadingFilter = ReadingStatus | 'all';

/** A paper as the queue and the Papers tab render it. */
export interface QueuedDocument {
  id: number;
  source_repository: string;
  external_id: string;
  doi: string | null;
  title: string;
  authors: string | null;
  abstract: string | null;
  publication_date: string | null;
  url: string | null;
  categories: string | null;
  first_seen_at?: string;
}

/** One membership row, with the paper it points at. */
export interface ReadingQueueEntry {
  document_id: number;
  status: ReadingStatus;
  saved_at: string;
  updated_at: string;
  read_at: string | null;
  document: QueuedDocument;
}

/** The membership row alone — what a save or a state change answers with. */
export type ReadingQueueMembership = Omit<ReadingQueueEntry, 'document'>;

export interface ReadingQueueCounts {
  to_read: number;
  read: number;
  all: number;
}

export interface ReadingQueuePage {
  entries: ReadingQueueEntry[];
  total: number;
  limit: number;
  offset: number;
  status: ReadingStatus | null;
  counts: ReadingQueueCounts;
}

/** One page of an execution's papers, each carrying its stored corpus id. */
export interface ExecutionPaper extends QueuedDocument {
  /** `null` when this paper is not in the queue — absence is the answer. */
  queue_status: ReadingStatus | null;
}

export interface ExecutionPapersPage {
  papers: ExecutionPaper[];
  total: number;
  limit: number;
  offset: number;
  only_new: boolean;
}

/** Matches `reading_queue.DEFAULT_PAGE_SIZE`; the backend caps requests at 200. */
export const READING_PAGE_SIZE = 50;

export const readingQueueApi = {
  list: (filter: ReadingFilter, limit = READING_PAGE_SIZE, offset = 0) =>
    apiClient.get<ReadingQueuePage>(
      `/api/reading-queue?status=${encodeURIComponent(filter)}`
      + `&limit=${limit}&offset=${offset}`,
    ),

  /** Idempotent: saving a paper already saved returns it unchanged. */
  save: (documentId: number) =>
    apiClient.post<ReadingQueueMembership>('/api/reading-queue', { document_id: documentId }),

  setStatus: (documentId: number, status: ReadingStatus) =>
    apiClient.put<ReadingQueueMembership>(`/api/reading-queue/${documentId}`, { status }),

  /** Drops the membership row. The paper stays in the corpus. */
  remove: (documentId: number) =>
    apiClient.delete<{ removed: boolean; document_id: number }>(
      `/api/reading-queue/${documentId}`,
    ),

  papers: (executionId: number, limit = READING_PAGE_SIZE, offset = 0) =>
    apiClient.get<ExecutionPapersPage>(
      `/api/executions/${executionId}/documents?limit=${limit}&offset=${offset}`,
    ),
};
