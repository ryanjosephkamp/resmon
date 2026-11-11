/**
 * Evidence talks to the engine this window uses, the background service's
 * included. It once refused port 8742, the service's default, so it never
 * worked with the service. These tests read the address it builds; the
 * request goes to a mocked fetch, never to a socket.
 */
let port = '8742';
jest.mock('../../../bridge', () => ({ bridge: () => ({ getBackendPort: () => port, getApiToken: () => 'token' }) }));

import { EngineError } from '../../../api/client';
import { evidenceFetch } from '../evidenceApi';

const realFetch = globalThis.fetch;
let asked: string[] = [];
beforeEach(() => {
  asked = [];
  globalThis.fetch = jest.fn((url: string) => {
    asked.push(url);
    return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ projects: [] }) });
  }) as unknown as typeof fetch;
});
afterEach(() => { globalThis.fetch = realFetch; });

test('Evidence asks the engine on the service port, as it does any other', async () => {
  port = '8742';
  await evidenceFetch('/projects');
  expect(asked).toEqual(['http://127.0.0.1:8742/api/evidence/projects']);
  port = '51000';
  await evidenceFetch('/projects');
  expect(asked[1]).toBe('http://127.0.0.1:51000/api/evidence/projects');
});

test('with no port from the window, Evidence asks nothing and says so', async () => {
  for (const missing of ['', '0', '70000', 'abc']) {
    port = missing;
    await expect(evidenceFetch('/projects')).rejects.toEqual(new EngineError(0, 'Evidence cannot reach resmon’s engine yet.'));
  }
  expect(asked).toEqual([]);
});
