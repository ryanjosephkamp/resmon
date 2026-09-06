import React from 'react';
import { render, screen, act, fireEvent, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom';
import AssistantSettings from '../components/Settings/AssistantSettings';

/**
 * Settings → AI → Assistant, with two routes to choose between.
 *
 * The section's job is to make the *choice* legible and to avoid asking for
 * anything twice. What is checked here is that picking the API-key route
 * reveals the things that route needs and hides the things it does not have —
 * an effort selector that does nothing on a raw provider API is exactly the
 * control 1.8.5 refused to ship — and that the honest statements about cost and
 * memory are on screen rather than in a docstring.
 */

const STATUS = {
  available: true,
  reason: 'resmon will drive openai (gpt-4o-mini) with your own key.',
  runtime: { kind: 'api_key' },
  provider: 'openai',
  provider_source: 'assistant_provider',
  tool_calling: {
    state: 'yes',
    reason: "OpenAI's chat completions take tools and answer with tool_calls.",
    assistant: 'api_key_runtime',
    assistant_reason: 'resmon drives it directly with your key.',
  },
  others: [
    { kind: 'claude_cli', installed: true, available: false,
      reason: 'The claude command was not found on this machine.' },
    { kind: 'codex_cli', installed: true, available: false,
      reason: 'Codex is not offered: resmon cannot take away its shell.' },
  ],
};

function mockBackend(stored: Record<string, string>, status: unknown = STATUS) {
  const puts: unknown[] = [];
  (global as any).fetch = jest.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input).replace(/^https?:\/\/[^/]+/, '');
    if (init?.method === 'PUT') puts.push(JSON.parse(String(init.body)));
    const payload = path === '/api/settings/assistant' ? stored
      : path === '/api/assistant/status' ? status : { ok: true };
    return {
      ok: true, status: 200,
      headers: { get: () => 'application/json' },
      json: async () => payload,
      text: async () => JSON.stringify(payload),
    } as any;
  });
  return puts;
}

async function mount() {
  await act(async () => { render(<AssistantSettings />); });
}

const CLI_STORED = {
  assistant_runtime: '', assistant_provider: '', assistant_model: '',
  assistant_effort: '',
};
const KEY_STORED = {
  assistant_runtime: 'api_key', assistant_provider: 'openai',
  assistant_model: 'gpt-4o-mini', assistant_effort: '',
};

beforeEach(() => { jest.restoreAllMocks(); });

describe('the assistant settings section', () => {
  it('offers both routes and defaults to the CLI', async () => {
    mockBackend(CLI_STORED);
    await mount();
    await waitFor(() => expect(screen.getByTestId('assistant-settings')).toBeInTheDocument());
    const runtime = screen.getByLabelText('Run it with') as HTMLSelectElement;
    expect(runtime.value).toBe('');
    expect(screen.getByText(/already signed into/)).toBeInTheDocument();
    // A provider picker belongs to the other route and is not shown on this one.
    expect(screen.queryByLabelText('Provider')).not.toBeInTheDocument();
  });

  it('shows the provider picker only on the API-key route', async () => {
    mockBackend(CLI_STORED);
    await mount();
    await waitFor(() => expect(screen.getByLabelText('Run it with')).toBeInTheDocument());
    await act(async () => {
      fireEvent.change(screen.getByLabelText('Run it with'), {
        target: { value: 'api_key' },
      });
    });
    expect(screen.getByLabelText('Provider')).toBeInTheDocument();
  });

  it('hides the effort selector on the API-key route', async () => {
    /* An effort level is real on a subscription CLI and is not a parameter any
       of the raw provider APIs takes. 1.8.5 refused to offer a control that
       does nothing across eight providers; the same refusal applies here. */
    mockBackend(CLI_STORED);
    await mount();
    await waitFor(() => expect(screen.getByLabelText('Effort')).toBeInTheDocument());
    await act(async () => {
      fireEvent.change(screen.getByLabelText('Run it with'), {
        target: { value: 'api_key' },
      });
    });
    expect(screen.queryByLabelText('Effort')).not.toBeInTheDocument();
  });

  it('takes a typed model on the API-key route rather than a CLI alias list', async () => {
    /* `opus` is a claude alias, not a model id any provider API accepts. */
    mockBackend(KEY_STORED);
    await mount();
    await waitFor(() => expect(screen.getByLabelText('Model')).toBeInTheDocument());
    const model = screen.getByLabelText('Model') as HTMLInputElement;
    expect(model.tagName).toBe('INPUT');
    expect(model.value).toBe('gpt-4o-mini');
  });

  it('says it reports tokens rather than a cost, and why', async () => {
    /* resmon maintains no price list. A computed dollar figure would be a
       measurement nobody made. */
    mockBackend(KEY_STORED);
    await mount();
    await waitFor(() => expect(screen.getByTestId('assistant-settings')).toBeInTheDocument());
    const text = screen.getByTestId('assistant-settings').textContent || '';
    expect(text).toMatch(/token count rather than a cost/i);
    expect(text).toMatch(/will not invent one/i);
  });

  it('says the API-key route does not re-send earlier tool output', async () => {
    mockBackend(KEY_STORED);
    await mount();
    await waitFor(() => expect(screen.getByTestId('assistant-settings')).toBeInTheDocument());
    const text = screen.getByTestId('assistant-settings').textContent || '';
    expect(text).toMatch(/remembers what was said, not what the tools returned/i);
  });

  it("renders the backend's tool-calling sentence rather than one of its own", async () => {
    /* Whether a provider supports tool calling is established in the backend,
       with its evidence. The renderer must not paraphrase it into a claim. */
    mockBackend(KEY_STORED);
    await mount();
    await waitFor(() => expect(screen.getByTestId('assistant-tool-calling')).toBeInTheDocument());
    expect(screen.getByTestId('assistant-tool-calling')).toHaveTextContent(
      STATUS.tool_calling.reason);
  });

  it('lists every other route with its reason, available or not', async () => {
    mockBackend(KEY_STORED);
    await mount();
    await waitFor(() => expect(screen.getByTestId('assistant-settings')).toBeInTheDocument());
    for (const other of STATUS.others) {
      expect(screen.getByText(other.reason)).toBeInTheDocument();
    }
  });

  it('saves the runtime and the provider together', async () => {
    const puts = mockBackend(CLI_STORED);
    await mount();
    await waitFor(() => expect(screen.getByLabelText('Run it with')).toBeInTheDocument());
    await act(async () => {
      fireEvent.change(screen.getByLabelText('Run it with'), {
        target: { value: 'api_key' },
      });
    });
    await act(async () => {
      fireEvent.change(screen.getByLabelText('Provider'), { target: { value: 'google' } });
    });
    await act(async () => {
      fireEvent.click(screen.getByText('Save assistant settings'));
    });
    expect(puts).toEqual([{ settings: {
      assistant_runtime: 'api_key', assistant_provider: 'google',
      assistant_model: '', assistant_effort: '',
    } }]);
  });
});
