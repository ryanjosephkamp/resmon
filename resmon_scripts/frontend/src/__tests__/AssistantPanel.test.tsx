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
  useAssistant,
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

  it('shows a notice as a note about the conversation, not as the assistant talking', async () => {
    /* P16a's renderer half. A lost CLI conversation is not an error — the turn
       carries on underneath the notice — so it must not land in the error
       banner, which the next event clears. */
    mockBackend({ stream: [
      { type: 'notice', code: 'cannot_resume',
        message: 'The claude CLI no longer has this conversation, so resmon started a fresh one.' },
      { type: 'text_delta', text: 'answered anyway' },
      { type: 'done' },
      { type: 'closed' },
    ] });
    await mount();
    await openPanel();
    await send('anything');

    await waitFor(() => {
      expect(screen.getByText(/no longer has this conversation/)).toBeInTheDocument();
    });
    expect(screen.getByText('answered anyway')).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    // Rendered as resmon's own line rather than as a reply from the assistant.
    expect(
      document.querySelector('.assistant-message--system'),
    ).toHaveTextContent(/no longer has this conversation/);
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

// A stream update must not steal focus from a pending decision or another control.
it('focuses on entry and returns to Ask on close without moving focus on draft edits', async () => {
  mockBackend(); await mount(); await openPanel();
  expect(screen.getByLabelText('Message the assistant')).toHaveFocus();
  const history = screen.getByRole('button', { name: 'Earlier conversations' });
  history.focus();
  fireEvent.change(screen.getByLabelText('Message the assistant'), { target: { value: 'draft' } });
  expect(history).toHaveFocus();
  fireEvent.click(screen.getByRole('button', { name: 'Close the assistant' }));
  expect(screen.getByTestId('assistant-trigger')).toHaveFocus();
});

// Controlled request completion exercises the real provider's synchronous refs.
let owner: ReturnType<typeof useAssistant>;
function OwnershipHarness() {
  owner = useAssistant();
  return <div data-testid="owner">{JSON.stringify({ id:owner.sessionId, answering:owner.isAnswering,
    messages:owner.messages,pending:owner.pending,error:owner.error })}</div>;
}
function deferred<T>() {
  let resolve!: (value:T)=>void; let reject!: (e:Error)=>void;
  const promise = new Promise<T>((ok,no)=>{resolve=ok;reject=no;});
  return {promise,resolve,reject};
}
async function mountOwner() { await act(async()=>{ render(<AssistantProvider><OwnershipHarness/></AssistantProvider>); }); }
const saved = (id:number) => ({session:{id},messages:[{id,role:'user',content:`saved ${id}`} ]});

it('late open success/error and create response cannot replace newer selection',async()=>{
  mockBackend();const previous=global.fetch;
  const a=deferred<Response>();const b=deferred<Response>();const created=deferred<Response>();
  global.fetch=jest.fn((input,init)=>{
    const url=String(input);
    if(url.endsWith('/sessions/10'))return a.promise;
    if(url.endsWith('/sessions/11'))return b.promise;
    if(url.endsWith('/sessions')&&init?.method==='POST')return created.promise;
    return previous(input,init);
  });
  await mountOwner();
  act(()=>{void owner.openSession(10);void owner.openSession(11);});
  await act(async()=>b.resolve(json(saved(11))));
  await act(async()=>a.resolve(json(saved(10))));expect(owner.sessionId).toBe(11);
  act(()=>{void owner.newSession();});
  await act(async()=>owner.openSession(11));
  await act(async()=>created.resolve(json({id:12})));expect(owner.sessionId).toBe(11);
  const stale=deferred<Response>();global.fetch=jest.fn((input,init)=>String(input).endsWith('/sessions/10')?stale.promise:previous(input,init));
  act(()=>{void owner.openSession(10);});
  await act(async()=>owner.newSession());
  await act(async()=>stale.reject(new Error('old failure')));
  expect(owner.sessionId).toBe(1);expect(owner.error).not.toBe('old failure');
});

it('same-tick double send, active continuation and exact permission ownership stay on one turn',async()=>{
  const calls=mockBackend();const previous=global.fetch;
  let controller!:ReadableStreamDefaultController<Uint8Array>;
  const stream=new ReadableStream<Uint8Array>({start(c){controller=c;}});
  global.fetch=jest.fn((input,init)=>{
    if(String(input).endsWith('/messages'))return Promise.resolve({ok:true,body:stream} as Response);
    if(String(input).endsWith('/sessions/1'))return Promise.resolve(json(saved(1)));
    return previous(input,init);
  });
  await mountOwner();let sending!:Promise<void>;
  await act(async()=>{sending=owner.send('one');void owner.send('two');});
  expect((global.fetch as jest.Mock).mock.calls.filter(([url])=>String(url).endsWith('/messages'))).toHaveLength(1);
  const event=(e:unknown)=>controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(e)}\n\n`));
  await act(async()=>event({type:'permission_request',request_id:'exact-A',tool_name:'create_routine',input:{name:'authored'}}));
  expect(owner.pending[0].request_id).toBe('exact-A');
  await act(async()=>{await owner.openSession(1);await owner.openSession(2);await owner.newSession();await owner.deleteSession(1);});
  expect(owner.sessionId).toBe(1);expect(owner.pending).toHaveLength(1);
  await act(async()=>{await owner.answerPermission('other-request',true);await owner.answerPermission('exact-A',false);await owner.answerPermission('exact-A',true);});
  expect(calls.filter(c=>c.path.includes('/permissions/'))).toEqual([{path:'/api/assistant/permissions/exact-A',body:{allow:false}}]);
  await act(async()=>{controller.close();await sending;});expect(owner.isAnswering).toBe(false);
  expect(owner.messages[0].content).toBe('saved 1');
});

it('Stop retains ownership until the actual reader settles, including delayed cancellation completion',async()=>{
  mockBackend();const previous=global.fetch;const stop=deferred<Response>();
  let controller!:ReadableStreamDefaultController<Uint8Array>;
  global.fetch=jest.fn((input,init)=>{
    if(String(input).endsWith('/messages'))return Promise.resolve({ok:true,body:new ReadableStream<Uint8Array>({start(c){controller=c;}})} as Response);
    if(String(input).endsWith('/cancel'))return stop.promise;
    if(String(input).endsWith('/sessions/1'))return Promise.resolve(json(saved(1)));
    if(String(input).endsWith('/sessions/2'))return Promise.resolve(json(saved(2)));
    return previous(input,init);
  });
  await mountOwner();let sending!:Promise<void>;let stopping!:Promise<void>;
  await act(async()=>{sending=owner.send('wait');});
  act(()=>{stopping=owner.cancel();});
  await act(async()=>owner.openSession(2));expect(owner.sessionId).toBe(1);expect(owner.isAnswering).toBe(true);
  await act(async()=>{controller.close();});
  await act(async()=>owner.openSession(2));expect(owner.sessionId).toBe(1);
  await act(async()=>{stop.resolve(json({cancelled:true}));await stopping;await sending;});
  await act(async()=>owner.openSession(2));
  expect(owner.sessionId).toBe(2);expect(owner.messages[0].content).toBe('saved 2');
});

it('retains a draft and disables submission while a new session is being selected',async()=>{
  mockBackend();const previous=global.fetch;const created=deferred<Response>();
  global.fetch=jest.fn((input,init)=>String(input).endsWith('/sessions')&&init?.method==='POST'?created.promise:previous(input,init));
  await mount();await openPanel();
  const composer=screen.getByLabelText('Message the assistant');
  fireEvent.change(composer,{target:{value:'retained draft'}});
  act(()=>fireEvent.click(screen.getByLabelText('New conversation')));
  expect(composer).toBeDisabled();
  fireEvent.submit(composer.closest('form')!);
  expect(composer).toHaveValue('retained draft');
  await act(async()=>created.resolve(json({id:44})));
  expect(composer).toBeEnabled();
  await act(async()=>fireEvent.click(screen.getByText('Send')));
  expect((global.fetch as jest.Mock).mock.calls.some(([url,init])=>String(url).endsWith('/sessions/44/messages')&&JSON.parse(init.body).text==='retained draft')).toBe(true);
});

const choiceRequest = {version:1 as const,runtime:'claude_cli' as const,provider:'claude_code',model:'opus',effort:'high'};
const choiceStatus = {...AVAILABLE,composer_choices:{version:1,default_request:choiceRequest,default_error:null,
 connections:[{runtime:'claude_cli',provider:'claude_code',label:'Claude Code',implemented:true,available:true,reason:'Local prerequisites only',effort_supported:true},
 {runtime:'api_key',provider:'custom',label:'Custom',implemented:true,available:true,reason:'Key configured; not authenticated',effort_supported:false}],
 claude_aliases:['opus','fable'],claude_efforts:['high','max'],limitations:'Aliases are not compatibility'}};
const storedChoice = {version:1,runtime:'claude_cli',provider:'claude_code',requested_model:'opus',requested_effort:'high',model_basis:'explicit',effort_basis:'explicit',binding_basis:'new'};

it('an edited choice survives late status and cannot save global defaults',async()=>{
 const calls=mockBackend({status:choiceStatus});await mountOwner();
 act(()=>owner.setDraftChoices({...choiceRequest,model:'literal-B',effort:'max'}));
 await act(async()=>owner.refreshStatus());
 expect(owner.draftChoices?.model).toBe('literal-B');
 expect(calls.filter(c=>c.path.startsWith('/api/settings'))).toEqual([]);
 await act(async()=>owner.newSession());
 expect(calls.find(c=>c.path==='/api/assistant/sessions'&&c.body)?.body).toEqual({choices:{...choiceRequest,model:'literal-B',effort:'max'}});
});

it('historical continuation stays unread until explicit confirmation; cancel keeps the draft',async()=>{
 const calls=mockBackend({status:choiceStatus});const previous=global.fetch;
 global.fetch=jest.fn((input,init)=>String(input).endsWith('/sessions/9')?Promise.resolve(json({session:{id:9,runtime:'claude_cli',choices:null},messages:[{id:90,role:'user',content:'old local text'}]})):previous(input,init));
 await act(async()=>{render(<AssistantProvider><OwnershipHarness/><AssistantPanel/></AssistantProvider>);});
 await act(async()=>owner.openSession(9));
 fireEvent.change(screen.getByLabelText('Message the assistant'),{target:{value:'future message'}});
 await act(async()=>fireEvent.click(screen.getByText('Send')));
 expect(screen.getByText(/Earlier messages remain here; this new Claude session/)).toBeVisible();
 expect(calls.filter(c=>c.path.endsWith('/messages'))).toEqual([]);
 fireEvent.click(screen.getByText('Cancel continuation'));
 expect(screen.getByLabelText('Message the assistant')).toHaveValue('future message');
 await act(async()=>fireEvent.click(screen.getByText('Send')));
 await act(async()=>fireEvent.click(screen.getByText('Confirm and send')));
 expect(calls.find(c=>c.path.endsWith('/9/messages'))?.body).toEqual({text:'future message',legacy_adoption:{choices:choiceRequest,confirmed:true}});
});

it('a bound selection resists same-tick edits/change choices and foreign late reports',async()=>{
 mockBackend({status:choiceStatus});const previous=global.fetch;let controller!:ReadableStreamDefaultController<Uint8Array>;
 global.fetch=jest.fn((input,init)=>{
  const u=String(input);
  if(u.endsWith('/sessions/1'))return Promise.resolve(json({session:{id:1,runtime:'claude_cli',choices:storedChoice},messages:[]}));
  if(u.endsWith('/messages'))return Promise.resolve({ok:true,body:new ReadableStream<Uint8Array>({start(c){controller=c;}})} as Response);
  return previous(input,init);
 });
 await mountOwner();await act(async()=>owner.openSession(1));let sending!:Promise<void>;
 await act(async()=>{sending=owner.send('live');owner.changeChoices();owner.setDraftChoices({...choiceRequest,model:'forbidden'});});
 expect(owner.sessionId).toBe(1);expect(owner.draftChoices?.model).toBe('opus');
 const event=(e:unknown)=>controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(e)}\n\n`));
 await act(async()=>{event({type:'turn_choices',session_id:1,user_message_id:5,requested:storedChoice});event({type:'turn_model_report',session_id:2,user_message_id:5,reported:{sequence:1,model:'foreign',source:'api_response_model',observed_at_utc:'now'}});});
 expect(owner.turnChoices[0].reported).toEqual([]);
 await act(async()=>{controller.close();await sending;});
 act(()=>owner.changeChoices());expect(owner.sessionId).toBeNull();expect(owner.messages).toEqual([]);
});
it('keeps the unavailable explanation and lets a usable alternative restore the composer',async()=>{
 const status={...choiceStatus,available:false,reason:'Claude is not installed',composer_choices:{...choiceStatus.composer_choices,connections:choiceStatus.composer_choices.connections.map(c=>c.runtime==='claude_cli'?{...c,available:false,reason:'Claude CLI missing. Configure Settings → AI.'}:c)}};
 const calls=mockBackend({status});
 await act(async()=>{render(<AssistantProvider><OwnershipHarness/><AssistantPanel/></AssistantProvider>);});
 await act(async()=>owner.setOpen(true));
 expect(screen.getByTestId('assistant-unavailable')).toHaveTextContent('Claude CLI missing');
 expect(screen.getByLabelText('Message the assistant')).toBeDisabled();
 fireEvent.change(screen.getByLabelText('Connection'),{target:{value:'api_key:custom'}});
 fireEvent.change(screen.getByLabelText('Model'),{target:{value:'explicit-api'}});
 expect(screen.queryByTestId('assistant-unavailable')).toBeNull();
 expect(screen.getByLabelText('Message the assistant')).toBeEnabled();
 expect(calls.filter(c=>c.path.startsWith('/api/settings'))).toEqual([]);
});
