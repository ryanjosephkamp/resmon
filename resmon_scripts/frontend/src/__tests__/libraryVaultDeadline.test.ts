/**
 * The vault-creation deadline, against a `fetch` double that fails the way the
 * real one fails.
 *
 * An operator chose a parent folder, pressed Create managed vault once, and
 * watched both creation controls stay disabled past thirty seconds with no
 * error, no progress text and no vault. Every settled outcome in
 * `LibraryPage.create` - success, an HTTP refusal, a thrown exception - clears
 * the flag and says something, so the only shape that matches what was seen is
 * a request that never settles at all. Nothing in the client bounded one.
 *
 * The double below rejects on `abort` with an `AbortError`, which is what a
 * browser `fetch` does; a double that ignored the signal could not show that
 * the socket is released rather than merely forgotten.
 */
import { CREATE_VAULT_DEADLINE_MS, CREATE_VAULT_TIMEOUT_MESSAGE, libraryApi } from '../api/library';

const realFetch = global.fetch;

beforeEach(() => {
  window.resmonAPI = { getBackendPort: () => '12345', platform: 'test', versions: { node: '', electron: '' } };
});
afterEach(() => { global.fetch = realFetch; jest.useRealTimers(); });

function neverAnswers(): { signal: () => AbortSignal | undefined } {
  let captured: AbortSignal | undefined;
  global.fetch = jest.fn((_url: unknown, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
    captured = init?.signal as AbortSignal | undefined;
    captured?.addEventListener('abort', () => {
      const error = new Error('The operation was aborted.');
      error.name = 'AbortError';
      reject(error);
    });
  })) as unknown as typeof fetch;
  return { signal: () => captured };
}

it('ends a vault creation that never answers in a sentence, and aborts the request', async () => {
  jest.useFakeTimers();
  const held = neverAnswers();
  const pending = libraryApi.create('/owned/parent');
  const settled = jest.fn();
  void pending.then(settled, settled);

  jest.advanceTimersByTime(CREATE_VAULT_DEADLINE_MS - 1);
  await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
  expect(settled).not.toHaveBeenCalled();
  expect(held.signal()?.aborted).toBe(false);

  jest.advanceTimersByTime(1);
  await expect(pending).rejects.toThrow(CREATE_VAULT_TIMEOUT_MESSAGE);
  // `toThrow` matches a substring. `LibraryPage` decides which line this
  // sentence is rendered in by comparing it to the exported constant, so the
  // message has to be that constant exactly rather than one built around it.
  await expect(pending.catch((error: Error) => error.message)).resolves.toBe(CREATE_VAULT_TIMEOUT_MESSAGE);
  expect(held.signal()?.aborted).toBe(true);
});

it('says only what it knows: the vault may or may not exist, and names the way to find out', () => {
  expect(CREATE_VAULT_TIMEOUT_MESSAGE).toMatch(/unknown from here/);
  expect(CREATE_VAULT_TIMEOUT_MESSAGE).toMatch(/Refresh Library/);
});

it('leaves a request without a deadline unbounded rather than aborting it on a shared timer', async () => {
  jest.useFakeTimers();
  const held = neverAnswers();
  const pending = libraryApi.status();
  const settled = jest.fn();
  void pending.then(settled, settled);
  jest.advanceTimersByTime(CREATE_VAULT_DEADLINE_MS * 2);
  await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
  expect(settled).not.toHaveBeenCalled();
  expect(held.signal()?.aborted).toBe(false);
});
