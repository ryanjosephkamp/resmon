import { apiClient } from './client';
import { cloudClient } from './cloudClient';

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

/** Scope of a credential operation — local OS keyring or signed-in cloud account. */
export type CredentialScope = 'local' | 'cloud';

/**
 * Server returns ``{key_name: true, ...}`` for the cloud presence endpoint
 * (per `resmon_scripts/cloud/credentials.py`). Normalize to the same
 * ``{present: bool}`` shape used by the local endpoint so callers can treat
 * both scopes uniformly.
 */
function normalizeCloudPresence(raw: Record<string, boolean>): CredentialPresenceMap {
  const out: CredentialPresenceMap = {};
  for (const [k, v] of Object.entries(raw || {})) {
    out[k] = { present: !!v };
  }
  return out;
}

export const repositoriesApi = {
  getCatalog: (): Promise<RepoCatalogEntry[]> =>
    apiClient.get<RepoCatalogEntry[]>('/api/repositories/catalog'),

  getCredentialsPresence: (): Promise<CredentialPresenceMap> =>
    apiClient.get<CredentialPresenceMap>('/api/credentials'),

  saveCredential: (name: string, value: string): Promise<unknown> =>
    apiClient.put(`/api/credentials/${encodeURIComponent(name)}`, { value }),

  deleteCredential: (name: string): Promise<unknown> =>
    apiClient.delete(`/api/credentials/${encodeURIComponent(name)}`),

  // ------------------------------------------------------------------
  // Cloud-scoped variants (IMPL-38). Reach the resmon-cloud service via
  // cloudClient (JWT-aware). The server-side GET response shape is
  // `{key_name: bool}`; we normalize to the local `{present: bool}` shape
  // so consumers can treat both scopes uniformly.
  // ------------------------------------------------------------------
  getCloudCredentials: async (): Promise<CredentialPresenceMap> => {
    const raw = await cloudClient.get<Record<string, boolean>>('/api/v2/credentials');
    return normalizeCloudPresence(raw || {});
  },

  putCloudCredential: (name: string, value: string): Promise<unknown> =>
    cloudClient.put(`/api/v2/credentials/${encodeURIComponent(name)}`, { value }),

  deleteCloudCredential: (name: string): Promise<unknown> =>
    cloudClient.delete(`/api/v2/credentials/${encodeURIComponent(name)}`),
};
