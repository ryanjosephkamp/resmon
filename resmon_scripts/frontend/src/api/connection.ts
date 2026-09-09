import { getBaseUrl } from './client';

export interface RuntimeIdentity {
  contract_version: 1;
  runtime_id: string;
  schema_version: number | null;
  corpus_id: null;
  build_id: null;
}
export interface ConnectionObservation {
  identity: RuntimeIdentity | null;
  pid: number | null;
  started_at: string | null;
  version: string | null;
  observedAt: number;
}
export class ConnectionError extends Error {
  constructor(public readonly code: 'instance_mismatch' | 'identity_unavailable' | 'offline') {
    super(code);
  }
}
const uuid4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function identityOf(value: unknown): RuntimeIdentity | null {
  if (!record(value) || value.contract_version !== 1 || typeof value.runtime_id !== 'string'
      || !uuid4.test(value.runtime_id) || value.corpus_id !== null || value.build_id !== null
      || !(value.schema_version === null || (typeof value.schema_version === 'number' && Number.isInteger(value.schema_version)))) return null;
  return { contract_version: 1, runtime_id: value.runtime_id,
    schema_version: typeof value.schema_version === 'number' && Number.isInteger(value.schema_version)
      ? value.schema_version : null,
    corpus_id: null, build_id: null };
}
export async function fetchConnection(expected?: string): Promise<ConnectionObservation> {
  const query = expected === undefined ? '' : `?expected_runtime_id=${encodeURIComponent(expected)}`;
  const response = await fetch(`${getBaseUrl()}/api/health${query}`, { cache: 'no-store' });
  const body: unknown = await response.json();
  if (!response.ok) {
    if (response.status === 409 && record(body) && record(body.detail)
        && body.detail.code === 'instance_mismatch') throw new ConnectionError('instance_mismatch');
    throw new ConnectionError('offline');
  }
  if (!record(body) || body.status !== 'ok') throw new ConnectionError('offline');
  const identity = identityOf(body.identity);
  if (expected !== undefined) {
    if (!identity) throw new ConnectionError('identity_unavailable');
    if (identity.runtime_id !== expected) throw new ConnectionError('instance_mismatch');
  }
  return { identity, pid: typeof body.pid === 'number' ? body.pid : null,
    started_at: typeof body.started_at === 'string' ? body.started_at : null,
    version: typeof body.version === 'string' ? body.version : null, observedAt: Date.now() };
}
