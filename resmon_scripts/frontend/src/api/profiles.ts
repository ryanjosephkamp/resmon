import { apiClient } from './client';

/**
 * Watch profiles — the people a routine can be pointed at.
 *
 * The one type rule here: `basis_warning` and `basis` are **not optional in
 * practice**, only in the type. The backend returns the warning on every read
 * of a profile that has no identifier, and every match row carries a basis
 * enforced by a CHECK constraint. They are typed nullable because a profile
 * *with* an identifier has no warning, not because a caller may skip rendering
 * one that is there.
 */

/** A name, kept with its script: two spellings of one person, never folded. */
export interface ProfileName {
  value: string;
  script?: string;
}

/** An identifier and where the user got it. Untraceable is not an identifier. */
export interface ProfileIdentifier {
  value: string;
  cited?: string;
}

export interface WatchProfile {
  id: number;
  kind: 'person' | 'institution' | 'group';
  display_name: string;
  names: ProfileName[];
  identifiers: Record<string, ProfileIdentifier>;
  affiliations: string[];
  field_hints: string[];
  notes: string | null;
  created_at?: string;
  updated_at?: string;
  /** Present exactly when this profile can never match on identity. */
  basis_warning: string | null;
}

/** What a profile looks like on its way to the backend. No id, no timestamps. */
export interface WatchProfileDraft {
  kind: string;
  display_name: string;
  names: ProfileName[];
  identifiers: Record<string, ProfileIdentifier>;
  affiliations: string[];
  field_hints: string[];
  notes: string | null;
}

export type MatchBasis = 'identifier' | 'name+affiliation' | 'name_only';

export interface ProfileMatch {
  document_id: number;
  basis: MatchBasis;
  matched_author: string | null;
  evidence: string | null;
  first_seen_at: string | null;
  title: string | null;
  source_repository: string | null;
  doi: string | null;
  url: string | null;
  publication_date: string | null;
}

export interface ProfileMatchPage {
  matches: ProfileMatch[];
  total: number;
  by_basis: Partial<Record<MatchBasis, number>>;
}

/** One profile's claim on one paper, as the Explorer and Results lists see it. */
export interface DocumentMatch {
  profile_id: number;
  display_name: string;
  basis: MatchBasis;
  matched_author: string | null;
  evidence: string | null;
}

export interface ProfileLifecycleFinding {
  document_id: number;
  kind: string;
  severity: string;
  label: string | null;
  notice_doi: string | null;
  notice_url: string;
  notice_date: string | null;
  provider: string;
  provider_source: string | null;
  title: string | null;
  doi: string | null;
  source_repository: string | null;
  basis: MatchBasis;
  matched_author: string | null;
}

export interface ProfileLifecycle {
  findings: ProfileLifecycleFinding[];
  matched_documents: number;
  checked_documents: number;
  coverage_note: string;
}

export const profilesApi = {
  list: () =>
    apiClient.get<{ profiles: WatchProfile[] }>('/api/profiles')
      .then((r) => r.profiles),

  /** The curated set shipped in the repo — served, so the files stay the one source. */
  starter: () =>
    apiClient.get<{ profiles: WatchProfileDraft[] }>('/api/profiles/starter')
      .then((r) => r.profiles),

  get: (id: number) => apiClient.get<WatchProfile>(`/api/profiles/${id}`),

  create: (draft: WatchProfileDraft) =>
    apiClient.post<WatchProfile>('/api/profiles', draft),

  update: (id: number, draft: WatchProfileDraft) =>
    apiClient.put<WatchProfile>(`/api/profiles/${id}`, draft),

  remove: (id: number) =>
    apiClient.delete<{ deleted: number; routines_watching: { id: number; name: string }[];
                      detail?: string }>(`/api/profiles/${id}`),

  matches: (id: number, limit = 50, offset = 0) =>
    apiClient.get<ProfileMatchPage>(
      `/api/profiles/${id}/matches?limit=${limit}&offset=${offset}`),

  lifecycle: (id: number) =>
    apiClient.get<ProfileLifecycle>(`/api/profiles/${id}/lifecycle`),

  exportOne: (id: number) =>
    apiClient.get<Record<string, unknown>>(`/api/profiles/${id}/export`),

  import: (profiles: unknown[]) =>
    apiClient.post<{ imported: WatchProfile[];
                     failed: { index: number; reason: string }[] }>(
      '/api/profiles/import', { profiles }),

  /** One round trip for a page of papers, never one per row. */
  forDocuments: (documentIds: number[]) => {
    if (documentIds.length === 0) return Promise.resolve({} as Record<string, DocumentMatch[]>);
    return apiClient.post<{ matches: Record<string, DocumentMatch[]> }>(
      '/api/profiles/matches/for-documents', { document_ids: documentIds },
    ).then((r) => r.matches);
  },
};

/** An empty draft, so the editor and the starter picker agree on the shape. */
export const emptyProfileDraft = (): WatchProfileDraft => ({
  kind: 'person',
  display_name: '',
  names: [],
  identifiers: {},
  affiliations: [],
  field_hints: [],
  notes: null,
});
