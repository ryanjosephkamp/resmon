import { apiClient } from './client';

export type ApiKeyRequirement = 'none' | 'required' | 'optional' | 'recommended';

/** 'required' is a licence condition; 'requested' is a courtesy. They are rendered differently on purpose. */
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
  /** Whether that credit is a licence condition ("required") or a courtesy the upstream asks for ("requested"). */
  attribution_requirement?: AttributionRequirement;
  /** URL of the clause or policy page stating the obligation. */
  attribution_source?: string;
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
