/**
 * The arrangement as the shell holds it: two changes made close together end
 * on the second, whatever order the answers come back in; a refusal reads the
 * engine's own value back; and a window coming to the front reads it again,
 * since another window may have changed it.
 */
import { act, render, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { engine } from '../../api/client';
import { DEFAULT_TOP_BAR, type TopBar } from '../topBar';
import { TOP_BAR_KEY, useTopBar, useTopBarFollowsOtherWindows, type TopBarState } from '../useTopBar';

jest.mock('../../api/client', () => ({ ...jest.requireActual('../../api/client'), engine: jest.fn() }));

const reply = (data: unknown) => ({ data, error: undefined, response: { url: 'http://127.0.0.1:1/api/top-bar', status: 200 } as Response });
const refusal = () => ({ data: undefined, error: { detail: 'no' }, response: { url: 'http://127.0.0.1:1/api/top-bar', status: 422 } as Response });

let state: TopBarState;
function Probe() {
  state = useTopBar();
  useTopBarFollowsOtherWindows();
  return null;
}

function mount(GET: jest.Mock, PUT: jest.Mock) {
  (engine as jest.Mock).mockReturnValue({ GET, PUT });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  client.setQueryData(TOP_BAR_KEY, DEFAULT_TOP_BAR);
  render(<QueryClientProvider client={client}><Probe /></QueryClientProvider>);
  return client;
}

const hiding = (...hidden: TopBar['hidden']): TopBar => ({ ...DEFAULT_TOP_BAR, hidden });

test('two changes close together end on the second, though the first one\'s answer comes back last', async () => {
  const answers: ((value: unknown) => void)[] = [];
  const PUT = jest.fn(() => new Promise((resolve) => { answers.push(resolve); }));
  const client = mount(jest.fn(() => new Promise(() => {})), PUT);
  act(() => { state.save(hiding('ask')); });
  act(() => { state.save(hiding('ask', 'health')); });
  expect(client.getQueryData(TOP_BAR_KEY)).toEqual(hiding('ask', 'health'));
  // One at a time: the second waits for the first.
  await waitFor(() => expect(PUT).toHaveBeenCalledTimes(1));
  await act(async () => { answers[0]!(reply(hiding('ask'))); });
  expect(client.getQueryData(TOP_BAR_KEY)).toEqual(hiding('ask', 'health'));
  await waitFor(() => expect(PUT).toHaveBeenCalledTimes(2));
  await act(async () => { answers[1]!(reply(hiding('ask', 'health'))); });
  await waitFor(() => expect(state.stored).toEqual(hiding('ask', 'health')));
  expect([...state.arranged.hidden]).toEqual(['ask', 'health']);
});

test('a refusal puts back what the engine holds', async () => {
  const GET = jest.fn(() => Promise.resolve(reply(hiding('runs'))));
  const client = mount(GET, jest.fn(() => Promise.resolve(refusal())));
  act(() => { state.save(hiding('today')); });
  expect(client.getQueryData(TOP_BAR_KEY)).toEqual(hiding('today'));
  await waitFor(() => expect(client.getQueryData(TOP_BAR_KEY)).toEqual(hiding('runs')));
  expect(state.saveError?.message).toMatch(/HTTP 422/);
});

test('a window coming to the front reads the arrangement again', async () => {
  const GET = jest.fn(() => Promise.resolve(reply(hiding('watches'))));
  const client = mount(GET, jest.fn());
  expect(GET).not.toHaveBeenCalled();
  act(() => { window.dispatchEvent(new Event('focus')); });
  await waitFor(() => expect(client.getQueryData(TOP_BAR_KEY)).toEqual(hiding('watches')));
  expect(GET).toHaveBeenCalledTimes(1);
});
