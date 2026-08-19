import { apiClient } from './client';

export type ApiKeyRequirement = 'none' | 'required' | 'optional' | 'recommended';

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
}

export type CredentialPresenceMap = Record<string, { present: boolean }>;

export const repositoriesApi = {
  getCatalog: (): Promise<RepoCatalogEntry[]> =>
    apiClient.get<RepoCatalogEntry[]>('/api/repositories/catalog'),

  getCredentialsPresence: (): Promise<CredentialPresenceMap> =>
    apiClient.get<CredentialPresenceMap>('/api/credentials'),

  saveCredential: (name: string, value: string): Promise<unknown> =>
    apiClient.put(`/api/credentials/${encodeURIComponent(name)}`, { value }),

  deleteCredential: (name: string): Promise<unknown> =>
    apiClient.delete(`/api/credentials/${encodeURIComponent(name)}`),
};
