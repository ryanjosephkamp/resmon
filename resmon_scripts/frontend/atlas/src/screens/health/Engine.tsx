import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { answer, engine } from '../../api/client';
import { bridge } from '../../bridge';
import { when } from '../today/format';
import { HealthTabs } from './HealthTabs';
import { instantOf } from './model';

/**
 * This engine: which backend this window is talking to, by the identity the
 * engine reports for itself. The runtime id is new each time an engine
 * starts, so two windows naming the same one are talking to the same process.
 *
 * Runtime only. The engine does not identify its corpus or its build, and
 * this screen claims neither.
 */
export function Engine() {
  const now = useMemo(() => new Date(), []);
  const health = useQuery({
    queryKey: ['health'],
    queryFn: () => answer(engine().GET('/api/health')),
    refetchInterval: 10_000,
  });
  const port = bridge()?.getBackendPort() ?? null;
  const data = health.data;
  const started = instantOf(data?.started_at);
  const status = data ? 'Connected' : health.isError ? 'Not answering' : 'Asking the engine';

  return (
    <div className="page health engine-page" aria-busy={health.isFetching}>
      <HealthTabs />
      <section className="settings-group engine-identity" data-health="identity" data-status={data ? 'connected' : health.isError ? 'down' : 'asking'}>
        <h1 className="page-title">This engine</h1>
        <p className="page-lede" data-health="status">
          <b>{status}</b>
          {port && <> to the engine on <code className="path">127.0.0.1:{port}</code></>}
          {health.isError && <>: {health.error.message}</>}.
        </p>
        {data && (
          <dl className="facts" data-health="details">
            {/* An engine from before identity was reported names none; that is said, not crashed on. */}
            <div><dt>Runtime</dt><dd>{data.identity?.runtime_id
              ? <code className="path">{data.identity.runtime_id}</code> : 'not reported by this engine'}</dd></div>
            <div><dt>Process</dt><dd>pid {data.pid}, started {started ? when(started.toISOString(), now) : 'at a time not recorded'}</dd></div>
            <div><dt>Version</dt><dd>{data.version}</dd></div>
            <div><dt>Database</dt><dd>{data.identity?.schema_version !== undefined ? `schema ${data.identity.schema_version}` : 'schema not reported'}</dd></div>
            <div><dt>Similarity index</dt><dd>{data.embeddings.extension ? `sqlite-vec ${data.embeddings.extension}` : `Not loaded${data.embeddings.reason ? `: ${data.embeddings.reason}` : ''}`}</dd></div>
          </dl>
        )}
        <p className="form-hint">
          The runtime id is new each time an engine starts. The engine does not identify which collection or which build it
          is, so this screen does not either.
        </p>
      </section>
    </div>
  );
}
