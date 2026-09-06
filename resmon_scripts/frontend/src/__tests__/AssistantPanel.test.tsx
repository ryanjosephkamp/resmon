/**
 * The assistant panel — jsdom.
 *
 * The stream is a real `ReadableStream` of real SSE bytes, parsed by the real
 * reader loop in `AssistantContext`. What is stubbed is `fetch`, so the boundary
 * is **hermetic double** on every row: no backend, no CLI, no permission server.
 *
 * These tests cannot see whether a write actually ran — that is a claim about a
 * database, and it is made in `test_assistant_api.py` against a real backend.
 * What they can see is what a person is shown, which is the other half of the
 * confirmation model: a card that paraphrased the call without showing it would
 * be a gate that displays one thing and runs another.
 */

import React from 'react';
import { act, fireEvent, screen, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom';
import { render } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import AssistantPanel from '../components/Assistant/AssistantPanel';
import {
  AssistantProvider,
  describeToolCall,
  shortToolName,
} from '../context/AssistantContext';

const AVAILABLE = {
  available: true,
  reason: 'Found where the installer puts it: /usr/local/bin/claude',
  runtime: { kind: 'claude_cli', path: '/usr/local/bin/claude' },
  contract_version: '2.0',
  others: [{ kind: 'codex_cli', installed: true, available: false,
             reason: 'Codex is not offered for the assistant: resmon cannot take away its shell.' }],
};

function sse(events: unknown[], keepOpen = false): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const event of events) {
        controller.enqueue(encoder.encode(
          `event: assistant\ndata: ${JSON.stringify(event)}\n\n`));
      }
      // A card's stream stays open, because that is what really happens: the
      // CLI is blocked on the answer, so the turn cannot end while a card is
      // outstanding. Closing it here would clear `pending` in the panel's own
      // cleanup and the test would be asserting against a turn that had ended.
      if (!keepOpen) controller.close();
    },
  });
}

interface Options {
  status?: unknown;
  stream?: unknown[];
  keepOpen?: boolean;
  onPost?: (path: string, body: unknown) => void;
}

function mockBackend({ status = AVAILABLE, stream = [], keepOpen = false,
                       onPost }: Options = {}) {
  const calls: { path: string; body?: unknown }[] = [];
  (global as any).fetch = jest.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input).replace(/^https?:\/\/[^/]+/, '');
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ path, body });
    if (init?.method === 'POST' || init?.method === 'DELETE') onPost?.(path, body);

    if (path === '/api/assistant/status') return json(status);
    if (path === '/api/assistant/sessions' && init?.method === 'POST') return json({ id: 1 });
    if (path === '/api/assistant/sessions') return json({ sessions: [] });
    if (path.endsWith('/messages')) {
      return { ok: true, status: 200, body: sse(stream, keepOpen) } as any;
    }
    return json({ ok: true });
  });
  return calls;
}

function json(payload: unknown) {
  return {
    ok: true, status: 200,
    headers: { get: () => 'application/json' },
    json: async () => payload,
    text: async () => JSON.stringify(payload),
  } as any;
}

async function mount() {
  await act(async () => {
    render(
      <MemoryRouter>
        <AssistantProvider><AssistantPanel /></AssistantProvider>
      </MemoryRouter>,
    );
  });
}

async function openPanel() {
  await act(async () => { fireEvent.click(screen.getByTestId('assistant-trigger')); });
}

async function send(text: string) {
  fireEvent.change(screen.getByLabelText('Message the assistant'), { target: { value: text } });
  await act(async () => { fireEvent.click(screen.getByText('Send')); });
}

beforeEach(() => { jest.restoreAllMocks(); });

describe('the trigger', () => {
  it('is present even when there is no runtime', async () => {
    mockBackend({ status: { available: false, reason: 'No claude executable was found.' } });
    await mount();
    // An assistant that vanished when its CLI was missing would look like a
    // feature resmon does not have, rather than one waiting on a setting.
    expect(screen.getByTestId('assistant-trigger')).toBeInTheDocument();
  });

  it('opens the panel, and ⌘/ toggles it', async () => {
    mockBackend();
    await mount();
    await openPanel();
    expect(screen.getByTestId('assistant-panel')).toBeInTheDocument();

    await act(async () => {
      fireEvent.keyDown(window, { key: '/', metaKey: true });
    });
    expect(screen.queryByTestId('assistant-panel')).not.toBeInTheDocument();
  });
});

describe('when no runtime is available', () => {
  it('says why, names where to fix it, and says why codex is not one', async () => {
    mockBackend({ status: {
      available: false,
      reason: 'No claude executable was found.',
      others: [{ kind: 'codex_cli', available: false,
                 reason: 'Codex is not offered: resmon cannot take away its shell.' }],
    } });
    await mount();
    await openPanel();
    const block = screen.getByTestId('assistant-unavailable');
    expect(block).toHaveTextContent('No claude executable was found.');
    expect(block).toHaveTextContent('cannot take away its shell');
    expect(block).toHaveTextContent('Settings → AI');
    expect(screen.getByLabelText('Message the assistant')).toBeDisabled();
  });
});

describe('a turn', () => {
  it('renders streamed text and the turn cost', async () => {
    mockBackend({ stream: [
      { type: 'started', tools: [] },
      { type: 'text_delta', text: 'Three routines' },
      { type: 'text_delta', text: ', two active.' },
      { type: 'done', cost_usd: 0.0042, input_tokens: 11, output_tokens: 4 },
      { type: 'closed' },
    ] });
    await mount();
    await openPanel();
    await send('how many routines');

    await waitFor(() => {
      expect(screen.getByText('Three routines, two active.')).toBeInTheDocument();
    });
    expect(screen.getByText('$0.0042')).toBeInTheDocument();
  });

  it('says a cost was not reported rather than showing zero', async () => {
    // Zero is a measurement. Absent is not, and every other surface in resmon
    // draws that line.
    mockBackend({ stream: [
      { type: 'text_delta', text: 'ok' },
      { type: 'done' },
      { type: 'closed' },
    ] });
    await mount();
    await openPanel();
    await send('anything');
    await waitFor(() => {
      expect(screen.getByText('cost not reported')).toBeInTheDocument();
    });
    expect(screen.queryByText('$0.0000')).not.toBeInTheDocument();
  });

  it('never renders an event type it does not know', async () => {
    /* P6's jsdom half. */
    mockBackend({ stream: [
      { type: 'rate_limit_event', info: 'INTERNAL-PLUMBING' },
      { type: 'hook_lifecycle', payload: 'INTERNAL-PLUMBING' },
      { type: 'text_delta', text: 'the answer' },
      { type: 'done' },
      { type: 'closed' },
    ] });
    await mount();
    await openPanel();
    await send('anything');
    await waitFor(() => expect(screen.getByText('the answer')).toBeInTheDocument());
    expect(document.body.textContent).not.toContain('INTERNAL-PLUMBING');
  });

  it('shows a tool call collapsed, and expands to the exact arguments', async () => {
    mockBackend({ stream: [
      { type: 'tool_call', tool_name: 'list_routines', tool_use_id: 't1',
        input: { active_only: true } },
      { type: 'tool_result', tool_use_id: 't1', is_error: false },
      { type: 'done' },
      { type: 'closed' },
    ] });
    await mount();
    await openPanel();
    await send('anything');

    await waitFor(() => expect(screen.getByText('list_routines')).toBeInTheDocument());
    expect(document.body.textContent).not.toContain('active_only');
    await act(async () => { fireEvent.click(screen.getByText('list_routines')); });
    expect(document.body.textContent).toContain('active_only');
  });

  it('surfaces an error event as an error, not as silence', async () => {
    mockBackend({ stream: [
      { type: 'error', message: 'The claude CLI is not signed in.' },
      { type: 'closed' },
    ] });
    await mount();
    await openPanel();
    await send('anything');
    await waitFor(() => {
      expect(screen.getByRole('alert')).toHaveTextContent('not signed in');
    });
  });
});

describe('the permission card', () => {
  const CARD = {
    type: 'permission_request', request_id: 'req-1',
    tool_name: 'mcp__resmon__activate_routine', input: { routine_id: 4 },
  };

  it('shows the exact call as well as a sentence about it', async () => {
    mockBackend({ stream: [CARD], keepOpen: true });
    await mount();
    await openPanel();
    await send('turn on routine 4');

    const card = await screen.findByTestId('permission-card');
    expect(card).toHaveTextContent('Put routine 4 on its schedule');
    // The paraphrase is a convenience; the call is the fact. A card that only
    // paraphrased would be showing one thing while something else ran.
    expect(card).toHaveTextContent('activate_routine');
    expect(card).toHaveTextContent('"routine_id": 4');
    expect(card).toHaveTextContent('Nothing runs until you answer');
  });

  it('has Allow and Deny and no way to dismiss it', async () => {
    // A real process is blocked behind the card. Closing it without answering
    // would leave that process waiting for the backend's timeout.
    mockBackend({ stream: [CARD], keepOpen: true });
    await mount();
    await openPanel();
    await send('turn on routine 4');

    const card = await screen.findByTestId('permission-card');
    const buttons = Array.from(card.querySelectorAll('button')).map((b) => b.textContent);
    expect(buttons).toEqual(['Allow', 'Deny']);
  });

  it.each([['Allow', true], ['Deny', false]] as const)(
    'posts %s to the request it belongs to', async (label, allow) => {
      const posted: { path: string; body: any }[] = [];
      mockBackend({ stream: [CARD], keepOpen: true,
                    onPost: (path, body) => posted.push({ path, body }) });
      await mount();
      await openPanel();
      await send('turn on routine 4');

      const card = await screen.findByTestId('permission-card');
      await act(async () => { fireEvent.click(screen.getByText(label)); });

      const answer = posted.find((p) => p.path.includes('/permissions/'));
      expect(answer?.path).toBe('/api/assistant/permissions/req-1');
      expect(answer?.body).toEqual({ allow });
      await waitFor(() => expect(card).not.toBeInTheDocument());
    });
});

describe('describing a call to a person', () => {
  it.each([
    ['mcp__resmon__run_sweep', {}, 'Search your sources now'],
    ['mcp__resmon__activate_routine', { routine_id: 2 }, 'Put routine 2 on its schedule'],
    ['mcp__resmon__deactivate_routine', { routine_id: 2 }, 'Take routine 2 off its schedule'],
    ['mcp__resmon__update_settings', { group: 'ai' }, 'Change your ai settings'],
    ['mcp__resmon__create_routine', { name: 'Weekly' }, 'switched off'],
    ['mcp__resmon__run_routine', { routine_id: 9 }, 'Run routine 9 now'],
  ])('%s reads as a sentence about the app', (name, input, expected) => {
    expect(describeToolCall(name, input as Record<string, unknown>)).toContain(expected);
  });

  it('never invents a sentence for a tool it does not know', () => {
    // The exact call renders underneath either way, so an unknown tool degrades
    // to "here is precisely what would run" rather than to a plausible
    // description of something else.
    expect(describeToolCall('mcp__resmon__some_future_tool', {}))
      .toBe('Run some_future_tool');
  });

  it('covers every write tool the contract has', () => {
    /* The denominator is the contract's own write list. A tool that gains
       confirmation without gaining a sentence here would show the user
       "Run update_whatever", which is worse than the sentence it deserves. */
    const WRITE_TOOLS = ['run_sweep', 'create_routine', 'run_routine',
      'activate_routine', 'deactivate_routine', 'update_settings'];
    for (const tool of WRITE_TOOLS) {
      expect(describeToolCall(`mcp__resmon__${tool}`, {}))
        .not.toBe(`Run ${tool}`);
    }
  });
});

describe('naming a tool', () => {
  it('strips the mcp address the user has no use for', () => {
    expect(shortToolName('mcp__resmon__list_routines')).toBe('list_routines');
    expect(shortToolName('list_routines')).toBe('list_routines');
  });
});
