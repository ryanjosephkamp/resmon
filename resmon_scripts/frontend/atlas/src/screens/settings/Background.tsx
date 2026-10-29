import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { answer, engine, EngineError } from '../../api/client';
import { bridge } from '../../bridge';
import { clock } from '../today/format';
import { daemonSentence, daemonState, unitKind } from './model';

/** How often the panel asks again: a service started at login appears without a reload. */
const EVERY = 5_000;

/**
 * In the background: whether the service is installed, whether anything is
 * running, and which engine this window is talking to. Three separate facts,
 * because an installed unit is not a running service and a running service is
 * not necessarily the one this window uses.
 *
 * Only the service runs watches on schedule. A window that starts its own
 * engine starts it with the scheduler off (`electron/main.ts`), so without
 * the service nothing runs a watch on schedule, whether or not a window is
 * open; Run now on a watch still runs it once.
 */
export function Background() {
  const client = useQueryClient();
  const service = useQuery({
    queryKey: ['service-status'], refetchInterval: EVERY,
    queryFn: () => answer(engine().GET('/api/service/status')),
  });
  const daemon = useQuery({
    queryKey: ['daemon-status'], refetchInterval: EVERY,
    queryFn: () => answer(engine().GET('/api/service/daemon-status')),
  });
  const health = useQuery({
    queryKey: ['health'],
    queryFn: () => answer(engine().GET('/api/health')),
  });
  const port = bridge()?.getBackendPort() ?? null;

  const toggle = useMutation({
    mutationFn: (install: boolean) => (install
      ? answer(engine().POST('/api/service/install', { body: { register: true } }))
      : answer(engine().POST('/api/service/uninstall', { body: { register: true } }))),
    onSettled: () => {
      void client.invalidateQueries({ queryKey: ['service-status'] });
      void client.invalidateQueries({ queryKey: ['daemon-status'] });
    },
  });

  const installed = service.data?.installed ?? false;
  const unit = unitKind(service.data?.platform);
  const state = daemon.data ? daemonState(daemon.data, health.data?.pid ?? null) : null;
  const since = daemon.data?.started_at ? clock(daemon.data.started_at) : null;

  const flip = () => {
    if (!service.data || toggle.isPending) return;
    const asked = installed
      ? 'Remove the background service? Nothing will then run your watches on schedule: a resmon window does not run '
        + 'them itself. Run now on a watch still runs it once.'
      : `Install the background service? resmon will write ${unit.kind} at ${service.data.unit_path} and register it `
        + `with ${unit.manager}, so it starts when you log in and runs your watches on schedule, with or without a window open.`;
    if (window.confirm(asked)) toggle.mutate(!installed);
  };

  return (
    <section
      className="settings-group service"
      aria-labelledby="service-title"
      aria-busy={service.isPending || daemon.isPending || health.isPending}
      data-service-installed={service.data ? String(installed) : undefined}
      data-daemon={state ?? undefined}
    >
      <h2 id="service-title" className="group-title">In the background</h2>
      <p className="group-lede">
        Your watches run on schedule only in the background service: a resmon window does not run them itself. The
        service starts when you log in, runs with or without a window open, and uses the same database and reports
        folder as this app. A window opened while it runs uses it when their versions match.
      </p>

      {service.isError && (
        <p className="field-error" role="alert">The engine did not say whether the service is installed ({service.error.message}).</p>
      )}

      {service.data && (
        <>
          <button
            type="button"
            className="switch service-switch"
            role="switch"
            aria-checked={installed}
            data-switch="service"
            disabled={toggle.isPending}
            onClick={flip}
          >
            <span className="switch-track"><span className="switch-knob" /></span>
            Run resmon in the background
          </button>

          <dl className="facts service-facts">
            <div data-service="status">
              <dt>Service</dt>
              <dd>
                <span className="fact-word">{installed ? 'Installed' : 'Not installed'}</span>
                {/* The file's presence is all "installed" establishes: not that the
                    system manager took it, and not that anything is running. */}
                {installed ? `. ${unit.kind[0]?.toUpperCase()}${unit.kind.slice(1)} is written here:` : `. Turning it on writes ${unit.kind} here:`}
                {' '}
                <code className="path" data-service="unit-path">{service.data.unit_path}</code>
              </dd>
            </div>
            <div data-service="running">
              <dt>Running now</dt>
              <dd>
                {daemon.data && state ? daemonSentence(daemon.data, state, since)
                  : daemon.isError ? `The engine did not say (${daemon.error.message}).` : 'Asking.'}
              </dd>
            </div>
            <div data-service="window">
              <dt>This window</dt>
              <dd>
                {health.data ? (
                  <>
                    This window is using {state === 'attached' ? 'the background service’s engine' : 'an engine it started itself'},
                    {' '}on <code className="path">127.0.0.1:{port ?? '?'}</code>: pid {health.data.pid}, version {health.data.version},
                    {' '}since {clock(health.data.started_at)}.
                  </>
                ) : health.isError ? `The engine did not say (${health.error.message}).` : 'Asking.'}
              </dd>
            </div>
          </dl>
        </>
      )}

      {toggle.isSuccess && (
        <p className="settings-said" role="status">
          {toggle.data.installed
            ? 'Installed. “Running now” changes when the service starts.'
            : 'Removed. Nothing runs your watches on schedule now; Run now on a watch still runs it once.'}
        </p>
      )}
      {toggle.error && (
        <p className="field-error" role="alert">
          {toggle.error instanceof EngineError && toggle.error.detail ? toggle.error.detail : toggle.error.message}
        </p>
      )}
    </section>
  );
}
