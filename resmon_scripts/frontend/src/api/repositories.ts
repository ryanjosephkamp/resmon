import { apiClient } from './client';

export type ApiKeyRequirement = 'none' | 'required' | 'optional' | 'recommended';

/** 'required' is a license condition; 'requested' is a courtesy. They are rendered differently on purpose. */
export type AttributionRequirement = 'none' | 'requested' | 'required';

export interface RepoCatalogEntry {
  slug: string;
  name: string;
  description: string;
  subject_coverage: string;
  endpoint: string;
  query_method: string;
  rate_limit: string;
  client_module: string;
  api_key_requirement: ApiKeyRequirement;
  credential_name: string | null;
  website: string;
  registration_url: string | null;
  placeholder: string;
  upstream_policy?: string;
  parallel_safe?: string;
  notes?: string;
  /** Short label for how the upstream API combines space-separated keywords (e.g. "Implicit AND", "Explicit OR", "Relevance-ranked"). */
  keyword_combination?: string;
  /** One-sentence detail describing the upstream's keyword-combination semantics. */
  keyword_combination_notes?: string;
  /** The credit line this source asks to be shown, verbatim where the upstream specifies exact wording. */
  attribution?: string;
  /** Whether that credit is a license condition ("required") or a courtesy the upstream asks for ("requested"). */
  attribution_requirement?: AttributionRequirement;
  /** URL of the clause or policy page stating the obligation. */
  attribution_source?: string;
  /**
   * The finest date precision resmon's own query to this source can express,
   * read from the client's date-filter code rather than from a description of
   * the upstream. Rendered on the Repositories page because it decides
   * whether a window can be answered at all.
   */
  date_granularity: 'day' | 'month' | 'year';
  /**
   * What this source will do to a query before it is sent — the record the
   * search forms read so a user learns about a reshaped window while they can
   * still change it, rather than from a zero after waiting for a sweep.
   */
  constraints: SourceConstraints;
}

/**
 * How faithfully the user's date window reaches the source.
 *
 * `whole_years` / `whole_months` say the request is coarser than the dates
 * typed into the form; `window_rounding` says which way, and the two together
 * are the only pair that tells a user whether to expect extra records or none.
 */
export type WindowEffect = 'as_asked' | 'whole_years' | 'whole_months';

/**
 * `inward`: only whole periods contained by the window are searched, so a
 * window containing none returns nothing at all. `outward`: the whole periods
 * the window touches are searched, so records outside the typed dates can
 * come back.
 */
export type WindowRounding = 'none' | 'inward' | 'outward';

/** `client_side` means the upstream has no query parameter and resmon matches the terms itself. */
export type KeywordSearchMode = 'upstream' | 'client_side' | 'none';

export type ConstraintKind =
  | 'date_window'
  | 'keyword_search'
  | 'credential'
  | 'result_cap'
  | 'applied_default'
  | 'record_filter';

export interface SourceNotice {
  kind: ConstraintKind;
  /** What resmon will do, in the user's terms. Rendered verbatim. */
  effect: string;
  /** Where the sentence was read from. Carried, not rendered. */
  established: string;
}

/**
 * What resmon knows about a source before a search is submitted.
 *
 * Whether the source needs a credential is **not** here: that lives on
 * `api_key_requirement` and `credential_name` of the same entry, and a second
 * copy is the drift this record exists to prevent.
 */
export interface SourceConstraints {
  window_effect: WindowEffect;
  window_rounding: WindowRounding;
  /** Whether records outside the typed dates are dropped again once they arrive. */
  window_refiltered_locally: boolean;
  keyword_search: KeywordSearchMode;
  notices: SourceNotice[];
  established: string;
}

/** present = stored; absent = not set; unreadable = the keyring would not answer. */
export type CredentialStatus = 'present' | 'absent' | 'unreadable';

export type CredentialPresenceMap = Record<string, { present: boolean; status?: CredentialStatus }>;

export interface CredentialsResponse {
  /** False once a keyring read has timed out — reads are failing fast. */
  keyring_responsive: boolean;
  credentials: CredentialPresenceMap;
}

export const repositoriesApi = {
  getCatalog: (): Promise<RepoCatalogEntry[]> =>
    apiClient.get<RepoCatalogEntry[]>('/api/repositories/catalog'),

  getCredentials: (): Promise<CredentialsResponse> =>
    apiClient.get<CredentialsResponse>('/api/credentials'),

  saveCredential: (name: string, value: string): Promise<unknown> =>
    apiClient.put(`/api/credentials/${encodeURIComponent(name)}`, { value }),

  deleteCredential: (name: string): Promise<unknown> =>
    apiClient.delete(`/api/credentials/${encodeURIComponent(name)}`),
};
