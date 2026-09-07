/**
 * The assistant's first line, in a backend Electron actually spawned.
 *
 * **This is the shape the v2.0.1 field defect lived in and nothing covered.**
 * Every other assistant check runs the backend from pytest — a subprocess of
 * the test process. The published app's backend is a child of Electron, and the
 * CLI is a child of that. When the CLI went silent there, resmon waited five
 * minutes and said "resmon could not finish that turn"; `test_assistant_packaged.py`
 * asserted `tools/list` on the MCP servers and never a *turn*, which is Ledger 75.
 *
 * It needs no signed-in CLI. `ai_cli_path` points at the same `fake_claude.py`
 * the Python suite uses, so what is under test is resmon's own path from the
 * panel to the CLI's first line — the exact thing that failed.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { test, expect, FRONTEND_ROOT, REPO_ROOT } from './fixtures/resmon-app';

const FAKE = path.join(REPO_ROOT, 'resmon_scripts', 'verification_scripts',
  'fixtures', 'fake_claude.py');

/** A shim so the double runs under an interpreter that has resmon's deps. */
function fakeCli(): string {
  const python = process.env.RESMON_PYTHON
    || path.join(REPO_ROOT, '.venv', 'bin', 'python');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'resmon-e2e-cli-'));
  const shim = path.join(dir, 'fake-claude');
  fs.writeFileSync(shim, `#!/bin/sh\nexec "${python}" "${FAKE}" "$@"\n`);
  fs.chmodSync(shim, 0o755);
  return shim;
}

test.describe('the assistant, in an Electron-spawned backend', () => {
  test.describe.configure({ mode: 'serial' });

  test('a turn produces its first event within seconds', async ({ win, goto, backendPort }) => {
    const port = await backendPort();
    expect(port).not.toBe('8742');
    const cli = fakeCli();

    await goto('/');
    const result = await win.evaluate(async ([p, cliPath]) => {
      const base = `http://127.0.0.1:${p}`;
      const j = { 'Content-Type': 'application/json' };
      await fetch(`${base}/api/settings/ai`, {
        method: 'PUT', headers: j,
        body: JSON.stringify({ settings: { ai_cli_path: cliPath } }),
      });
      const session = await (await fetch(`${base}/api/assistant/sessions`, {
        method: 'POST', headers: j, body: '{}',
      })).json();

      const began = Date.now();
      const res = await fetch(`${base}/api/assistant/sessions/${session.id}/messages`, {
        method: 'POST', headers: j,
        body: JSON.stringify({ text: 'SAY:hello from the fake CLI' }),
      });
      const reader = res.body!.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      const seen: string[] = [];
      let firstEventMs = -1;
      // Bounded by the caller's own clock as well as the stream, so a hang here
      // fails the test rather than hanging the suite.
      while (Date.now() - began < 60000) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        for (const line of buffer.split('\n')) {
          if (!line.startsWith('data: ')) continue;
          const event = JSON.parse(line.slice(6));
          if (!event.type) continue;
          if (firstEventMs < 0 && event.type !== 'closed') {
            firstEventMs = Date.now() - began;
          }
          if (!seen.includes(event.type)) seen.push(event.type);
          if (event.type === 'error') return { seen, firstEventMs, error: event.message };
        }
        if (seen.includes('done')) break;
      }
      return { seen, firstEventMs, error: null as string | null };
    }, [port, cli] as const);

    // The defect was the absence of this event, for five minutes.
    expect(result.error, 'the turn reported an error').toBeNull();
    expect(result.seen, `events seen: ${result.seen.join(', ')}`).toContain('started');
    expect(result.firstEventMs).toBeGreaterThanOrEqual(0);
    expect(result.firstEventMs,
      'the first event took longer than any measured CLI start').toBeLessThan(20000);
    expect(result.seen).toContain('text_delta');
    expect(result.seen).toContain('done');
  });

  test('a CLI that never speaks fails fast, and says what to do', async ({ win, goto, backendPort }) => {
    /* The field defect itself. Before the hotfix this waited the full 300 s
       silence timeout and ended with "resmon could not finish that turn". */
    const port = await backendPort();
    const cli = fakeCli();
    await goto('/');

    const result = await win.evaluate(async ([p, cliPath]) => {
      const base = `http://127.0.0.1:${p}`;
      const j = { 'Content-Type': 'application/json' };
      await fetch(`${base}/api/settings/ai`, {
        method: 'PUT', headers: j,
        body: JSON.stringify({ settings: { ai_cli_path: cliPath } }),
      });
      const session = await (await fetch(`${base}/api/assistant/sessions`, {
        method: 'POST', headers: j, body: '{}',
      })).json();
      const began = Date.now();
      const res = await fetch(`${base}/api/assistant/sessions/${session.id}/messages`, {
        method: 'POST', headers: j, body: JSON.stringify({ text: 'SILENT:120' }),
      });
      const reader = res.body!.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      while (Date.now() - began < 120000) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        for (const line of buffer.split('\n')) {
          if (!line.startsWith('data: ')) continue;
          const event = JSON.parse(line.slice(6));
          if (event.type === 'error') {
            return { ms: Date.now() - began, message: event.message, detail: event.detail };
          }
        }
      }
      return { ms: Date.now() - began, message: null as string | null, detail: null };
    }, [port, cli] as const);

    expect(result.message, 'no error arrived at all').not.toBeNull();
    expect(result.ms, 'the startup deadline did not bound the wait').toBeLessThan(60000);
    expect(result.detail).toBe('startup_timeout');
    expect(result.message).toContain('said nothing');
    expect(result.message).not.toContain('could not finish that turn');
  });
});
