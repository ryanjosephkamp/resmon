/**
 * resmon's app as the background service, and as the poster of its notifications.
 *
 * The background service used to be a bare Python process that launchd (or
 * systemd, or Task Scheduler) started. Nothing about it was resmon as far as
 * the OS could tell, so its notifications went out through `osascript` and
 * macOS credited every one to Script Editor: its name, its icon, and a click
 * that opened Script Editor. A process cannot post under another app's name,
 * so the app has to be the one posting, which means the app has to be running.
 *
 * Launched with `--service`, the app is that process: it starts the engine
 * (the same `implementation_scripts.daemon` the unit used to start) as its
 * child, keeps no window and no Dock icon, and stays up when a window it
 * opened is closed. A notification the engine sends to the listener here is
 * posted by the app, and clicking it opens the run. Opening resmon while the
 * service runs opens a window in this same process, on the same engine.
 *
 * This file holds the parts that do not need Electron, so they can be tested
 * as plain functions; `main.ts` wires them to the app.
 */
import * as crypto from 'crypto';
import * as http from 'http';

/** True when this launch is the background service rather than a window. */
export function isServiceLaunch(argv: readonly string[], env: NodeJS.ProcessEnv): boolean {
  return argv.includes('--service') || env.RESMON_SERVICE === '1';
}

/**
 * The port the service's engine listens on: `RESMON_DAEMON_PORT`, as the unit
 * sets it and as `service_manager.default_port` reads it, else 8742.
 *
 * A value that is set and is not a port is an error, not a reason to fall
 * back: a service that quietly took the default would be a second resmon on
 * someone else's port, which is the shape `backendPort.test.ts` exists to
 * keep out of the renderer.
 */
export function servicePort(env: NodeJS.ProcessEnv): number {
  const raw = env.RESMON_DAEMON_PORT;
  if (raw === undefined || raw === '') return 8742;
  const port = Number(raw);
  if (!/^\d+$/.test(raw) || port < 1 || port > 65535) {
    throw new Error(`RESMON_DAEMON_PORT is set to ${JSON.stringify(raw)}, which is not a port.`);
  }
  return port;
}

/** One notification as the engine sends it. */
export interface Notice {
  title: string;
  body: string;
  executionId: number | null;
}

/** The most a notice may carry; the engine's bodies are a few hundred bytes. */
const MAX_NOTICE_BYTES = 16 * 1024;

/** A notice from the request body, or null when it is not one. */
export function parseNotice(raw: string): Notice | null {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof value !== 'object' || value === null) return null;
  const { title, body, execution_id: executionId } = value as Record<string, unknown>;
  if (typeof title !== 'string' || typeof body !== 'string') return null;
  if (executionId !== null && executionId !== undefined
    && !(typeof executionId === 'number' && Number.isInteger(executionId) && executionId > 0)) {
    return null;
  }
  return { title, body, executionId: typeof executionId === 'number' ? executionId : null };
}

/** Where the engine sends notices, and what it must present to be heard. */
export interface NoticeListener {
  url: string;
  token: string;
  close(): void;
}

/**
 * A listener on loopback that takes notices from the engine this app started.
 *
 * Bound to 127.0.0.1 on a port the OS picks, and answering only a request
 * that carries the token minted here, which reaches the engine in its
 * environment and nowhere else (`desktop_notifier.configure_host_from_environment`
 * takes it out again). Any other local process gets 401 and posts nothing.
 *
 * `onNotice` says whether the app posted it. When it could not (no
 * notification support here), the answer is 503 and the engine posts the
 * notification itself, the old way, rather than the notification being lost.
 */
export function startNoticeListener(onNotice: (notice: Notice) => boolean): Promise<NoticeListener> {
  const token = crypto.randomBytes(32).toString('base64url');
  const expected = Buffer.from(`Bearer ${token}`);
  const server = http.createServer((req, res) => {
    const given = Buffer.from(req.headers.authorization ?? '');
    const authorized = given.length === expected.length && crypto.timingSafeEqual(given, expected);
    if (req.method !== 'POST' || req.url !== '/notify' || !authorized) {
      req.resume();
      res.writeHead(authorized ? 404 : 401).end();
      return;
    }
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_NOTICE_BYTES) {
        res.writeHead(413).end();
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (res.writableEnded) return;
      const notice = parseNotice(Buffer.concat(chunks).toString('utf-8'));
      if (!notice) {
        res.writeHead(400).end();
        return;
      }
      res.writeHead(onNotice(notice) ? 204 : 503).end();
    });
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (address === null || typeof address === 'string') {
        reject(new Error('the notice listener has no port'));
        return;
      }
      resolve({
        url: `http://127.0.0.1:${address.port}/notify`,
        token,
        close: () => server.close(),
      });
    });
  });
}

/** The renderer route that shows a run, for a notice about one. */
export function routeForNotice(notice: Notice, atlas: boolean): string {
  // Atlas has no run screen yet; Today is where a finished run's papers are.
  if (atlas) return '/today';
  return notice.executionId === null ? '/results' : `/results?exec=${notice.executionId}`;
}
