/**
 * The app as the background service: the parts of `electron/host.ts` that do
 * not need Electron.
 *
 * The listener is the one new way into the app from outside it, so most of
 * these cases are about who it answers: only the engine this app started,
 * which holds the token, and only with a notice. The rest pin the two values a
 * service start reads from its environment, where a guess would put a second
 * resmon on someone else's port.
 */
import * as http from 'http';

import {
  appExecutable, engineFlags, isServiceLaunch, opensWindowFor, parseNotice, routeForNotice, servicePort, startNoticeListener,
  type Notice, type NoticeListener,
} from '../electron/host';

function post(url: string, body: string, authorization?: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const request = http.request(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(authorization ? { Authorization: authorization } : {}) },
    }, (response) => {
      response.resume();
      resolve(response.statusCode ?? 0);
    });
    request.on('error', reject);
    request.end(body);
  });
}

describe('the notice listener', () => {
  let listener: NoticeListener;
  let received: Notice[];
  let posted: boolean;

  beforeEach(async () => {
    received = [];
    posted = true;
    listener = await startNoticeListener((notice) => { received.push(notice); return posted; });
  });
  afterEach(() => listener.close());

  const notice = JSON.stringify({ title: 'resmon: Execution Completed', body: '6 new of 1,500', execution_id: 141 });

  it('is on loopback, on a port the OS chose', () => {
    expect(listener.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/notify$/);
    expect(listener.url).not.toContain(':8742/');
    expect(listener.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it('takes a notice from the engine that holds the token', async () => {
    expect(await post(listener.url, notice, `Bearer ${listener.token}`)).toBe(204);
    expect(received).toEqual([{ title: 'resmon: Execution Completed', body: '6 new of 1,500', executionId: 141 }]);
  });

  it('refuses anyone else, and posts nothing for them', async () => {
    expect(await post(listener.url, notice)).toBe(401);
    expect(await post(listener.url, notice, 'Bearer wrong')).toBe(401);
    expect(await post(listener.url, notice, `Bearer ${listener.token}x`)).toBe(401);
    expect(received).toEqual([]);
  });

  it('refuses what is not a notice', async () => {
    const auth = `Bearer ${listener.token}`;
    expect(await post(listener.url, 'not json', auth)).toBe(400);
    expect(await post(listener.url, JSON.stringify({ title: 1, body: 'b' }), auth)).toBe(400);
    expect(await post(listener.url, JSON.stringify({ title: 't', body: 'b', execution_id: 'one' }), auth)).toBe(400);
    expect(await post(listener.url, JSON.stringify({ title: 't', body: 'x'.repeat(20_000) }), auth)).toBe(413);
    expect(received).toEqual([]);
  });

  it('answers 503 when the app could not post it, so the engine posts it itself', async () => {
    posted = false;
    expect(await post(listener.url, notice, `Bearer ${listener.token}`)).toBe(503);
  });
});

describe('reading a notice', () => {
  it('keeps a run id and drops a missing one to null', () => {
    expect(parseNotice('{"title":"t","body":"b","execution_id":7}')).toEqual({ title: 't', body: 'b', executionId: 7 });
    expect(parseNotice('{"title":"t","body":"b"}')).toEqual({ title: 't', body: 'b', executionId: null });
    expect(parseNotice('{"title":"t","body":"b","execution_id":null}')).toEqual({ title: 't', body: 'b', executionId: null });
  });

  it('refuses a run id that is not a run', () => {
    for (const id of [0, -1, 1.5, '7', true]) {
      expect(parseNotice(JSON.stringify({ title: 't', body: 'b', execution_id: id }))).toBeNull();
    }
  });

  it('opens the run on Atlas\'s run page, or the run log when it names none', () => {
    expect(routeForNotice({ title: 't', body: 'b', executionId: 9 })).toBe('/runs/9');
    expect(routeForNotice({ title: 't', body: 'b', executionId: null })).toBe('/search/ask');
  });
});

describe('a service start', () => {
  it('is asked for by the flag or the variable, and by nothing else', () => {
    expect(isServiceLaunch(['electron', '.', '--service'], {})).toBe(true);
    expect(isServiceLaunch(['electron', '.'], { RESMON_SERVICE: '1' })).toBe(true);
    expect(isServiceLaunch(['electron', '.'], {})).toBe(false);
    expect(isServiceLaunch(['electron', '.', '--services'], { RESMON_SERVICE: 'yes' })).toBe(false);
  });

  it('takes its port from the unit, and refuses a value that is not one rather than guessing', () => {
    expect(servicePort({})).toBe(8742);
    expect(servicePort({ RESMON_DAEMON_PORT: '51335' })).toBe(51335);
    for (const raw of ['abc', '0', '70000', '80 80', '-1']) {
      expect(() => servicePort({ RESMON_DAEMON_PORT: raw })).toThrow(/not a port/);
    }
  });
});

describe('the app run by a service unit', () => {
  it('takes its port from --port, ahead of the environment, and refuses one that is not a port', () => {
    expect(servicePort({}, ['resmon', '--service', '--port=51336'])).toBe(51336);
    expect(servicePort({ RESMON_DAEMON_PORT: '51335' }, ['resmon', '--service', '--port=51336'])).toBe(51336);
    expect(servicePort({ RESMON_DAEMON_PORT: '51335' }, ['resmon', '--service'])).toBe(51335);
    expect(() => servicePort({}, ['resmon', '--service', '--port=abc'])).toThrow(/--port is set to "abc"/);
  });

  it('hands the unit\'s state flags on to the engine, and nothing else', () => {
    const argv = [
      '/Applications/resmon.app/Contents/MacOS/resmon', '--service', '--port=8742',
      '--db-path=/Users/ada/Library/Application Support/resmon/resmon.db',
      '--reports-dir=/Users/ada/Library/Application Support/resmon/resmon_reports',
      '--log-dir=C:\\logs', '--user-data-dir=/tmp/x', '--db-path=',
    ];
    expect(engineFlags(argv)).toEqual([
      '--db-path=/Users/ada/Library/Application Support/resmon/resmon.db',
      '--reports-dir=/Users/ada/Library/Application Support/resmon/resmon_reports',
      '--log-dir=C:\\logs',
    ]);
    expect(engineFlags(['resmon', '--service'])).toEqual([]);
  });

  describe('the executable a unit should start', () => {
    it('is the app on macOS and Windows when packaged', () => {
      expect(appExecutable('darwin', '/Applications/resmon.app/Contents/MacOS/resmon', true))
        .toBe('/Applications/resmon.app/Contents/MacOS/resmon');
      expect(appExecutable('win32', 'C:\\resmon\\resmon.exe', true)).toBe('C:\\resmon\\resmon.exe');
    });

    it('is nothing on Linux, even from an AppImage: its unit runs the engine, which needs no display', () => {
      expect(appExecutable('linux', '/tmp/.mount_resmonAbC/resmon', true)).toBeNull();
    });

    it('is nothing from a source checkout', () => {
      expect(appExecutable('darwin', '/x/electron', false)).toBeNull();
      expect(appExecutable('win32', 'C:\\x\\electron.exe', false)).toBeNull();
    });
  });
});

describe('a second launch handed to the resmon already running', () => {
  test('a person opening resmon gets a window; the service starting does not', () => {
    expect(opensWindowFor(['/Applications/resmon.app/Contents/MacOS/resmon'])).toBe(true);
    expect(opensWindowFor(['/Applications/resmon.app/Contents/MacOS/resmon', '--service', '--port=8742'])).toBe(false);
  });
});
