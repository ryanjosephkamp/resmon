import React from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import Header from '../components/Layout/Header';

const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const health = (runtime: string | null = A) => ({ status: 'ok', pid: 42, started_at: '2026-01-01', version: '2.1.0',
  identity: runtime ? { contract_version: 1, runtime_id: runtime, schema_version: 14, corpus_id: null, build_id: null } : undefined,
  private_path: '/private/do-not-display' });
function response(body: unknown, status = 200): Response {
  return { ok: status === 200, status, json: async () => body } as Response;
}
const fetchMock = jest.fn<Promise<Response>, [string, RequestInit?]>();
function deferred() {
  let resolve!: (value: Response) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<Response>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
async function settle() { await act(async () => { await Promise.resolve(); }); }
function mount() { return render(<MemoryRouter><Header /></MemoryRouter>); }
const refresh = () => fireEvent.click(screen.getByRole('button', { name: 'Refresh status' }));
const reaccept = () => fireEvent.click(screen.getByRole('button', { name: 'Use this running app' }));
function openDetails() { fireEvent.click(screen.getByLabelText('Connected app details')); }

beforeEach(() => {
  jest.useFakeTimers(); fetchMock.mockReset(); global.fetch = fetchMock as typeof fetch;
  window.resmonAPI = { getBackendPort: () => '51234', platform: 'test', versions: { node: '', electron: '' } };
});
afterEach(() => { jest.useRealTimers(); delete window.resmonAPI; });

test('checking becomes observed runtime; polling carries same expectation and private fields stay absent', async () => {
  const first = deferred(); fetchMock.mockReturnValueOnce(first.promise).mockResolvedValue(response(health()));
  mount(); expect(screen.getByRole('status')).toHaveTextContent('Checking');
  first.resolve(response(health())); await settle(); openDetails();
  expect(screen.getByRole('status')).toHaveTextContent('Connected · aaaaaaaa');
  expect(screen.getByText(A)).toBeInTheDocument();
  expect(screen.queryByText('/private/do-not-display')).not.toBeInTheDocument();
  expect(screen.getByText('Corpus identity').nextSibling).toHaveTextContent('Unknown');
  await act(async () => { jest.advanceTimersByTime(15000); });
  expect(fetchMock.mock.calls[1][0]).toBe(`http://127.0.0.1:51234/api/health?expected_runtime_id=${A}`);
});

test('structured mismatch keeps old observation stale until explicit fresh reaccept', async () => {
  fetchMock.mockResolvedValueOnce(response(health())).mockResolvedValueOnce(response({ detail: { code: 'instance_mismatch', actual_runtime_id: B } }, 409)).mockResolvedValueOnce(response(health(B)));
  mount(); await settle(); openDetails(); refresh(); await settle();
  expect(screen.getByRole('status')).toHaveTextContent('Running app changed');
  expect(screen.getByText(A)).toBeInTheDocument(); expect(screen.getByText(/Last observation is stale/)).toBeInTheDocument();
  reaccept(); await settle();
  expect(fetchMock.mock.calls[2][0]).toBe('http://127.0.0.1:51234/api/health');
  expect(screen.getByRole('status')).toHaveTextContent('Connected · bbbbbbbb');
  expect(screen.queryByText(A)).not.toBeInTheDocument();
  expect(screen.queryByText(/Last observation is stale/)).not.toBeInTheDocument();
});

test('legacy unbound is unavailable and expected legacy reply cannot claim connected', async () => {
  fetchMock.mockResolvedValue(response(health(null)));
  const view = mount(); await settle(); openDetails();
  expect(screen.getByRole('status')).toHaveTextContent('Identity unavailable'); view.unmount();
  fetchMock.mockResolvedValueOnce(response(health())).mockResolvedValue(response(health(null)));
  mount(); await settle(); openDetails(); refresh(); await settle();
  expect(screen.getByRole('status')).toHaveTextContent('Identity unavailable');
  expect(screen.getByText(/Last observation is stale/)).toBeInTheDocument();
});

test('ignored expectation with a different successful token is still mismatch', async () => {
  fetchMock.mockResolvedValueOnce(response(health())).mockResolvedValue(response(health(B)));
  mount(); await settle(); openDetails(); refresh(); await settle();
  expect(screen.getByRole('status')).toHaveTextContent('Running app changed');
  expect(screen.queryByText(B)).not.toBeInTheDocument();
});

test.each(['success', 'failure'])('late %s after newer poll cannot overwrite observation', async kind => {
  const late = deferred();
  fetchMock.mockResolvedValueOnce(response(health())).mockReturnValueOnce(late.promise).mockResolvedValue(response(health()));
  mount(); await settle(); openDetails(); refresh(); refresh(); await settle();
  if (kind === 'success') late.resolve(response(health(B))); else late.reject(new Error('late failure'));
  await settle(); expect(screen.getByRole('status')).toHaveTextContent('Connected · aaaaaaaa');
});

test.each(['success', 'failure'])('late %s from old poll cannot undo explicit reaccept', async kind => {
  const late = deferred();
  fetchMock.mockResolvedValueOnce(response(health())).mockReturnValueOnce(late.promise)
    .mockResolvedValueOnce(response({ detail: { code: 'instance_mismatch' } }, 409)).mockResolvedValue(response(health(B)));
  mount(); await settle(); openDetails(); refresh(); refresh(); await settle(); reaccept(); await settle();
  if (kind === 'success') late.resolve(response(health())); else late.reject(new Error('late failure'));
  await settle(); expect(screen.getByRole('status')).toHaveTextContent('Connected · bbbbbbbb');
});

test('failed reaccept remains unavailable and subsequent polling retains previous expectation', async () => {
  fetchMock.mockResolvedValueOnce(response(health())).mockRejectedValueOnce(new Error('offline'))
    .mockRejectedValueOnce(new Error('failed reaccept')).mockResolvedValue(response(health(B)));
  mount(); await settle(); openDetails(); refresh(); await settle(); reaccept(); await settle();
  expect(screen.getByRole('status')).toHaveTextContent('Running app unavailable');
  refresh(); await settle(); expect(fetchMock.mock.calls[3][0]).toContain(`expected_runtime_id=${A}`);
  expect(screen.getByRole('status')).toHaveTextContent('Running app changed');
});

test('unmount disposes timer and late response', async () => {
  const late = deferred(); fetchMock.mockReturnValue(late.promise);
  const view = mount(); view.unmount(); late.resolve(response(health())); await settle();
  await act(async () => { jest.advanceTimersByTime(30000); });
  expect(fetchMock).toHaveBeenCalledTimes(1);
});

test.each([{ status: 'broken' }, { status: 'ok', identity: { contract_version: 1, runtime_id: 'not-a-uuid' } }])('invalid payload is never connected', async body => {
  fetchMock.mockResolvedValue(response(body)); mount(); await settle();
  expect(screen.getByRole('status')).not.toHaveTextContent('Connected ·');
});


test('a pending poll labels the previous observation stale instead of claiming current connection', async () => {
  const pending = deferred(); fetchMock.mockResolvedValueOnce(response(health())).mockReturnValue(pending.promise);
  mount(); await settle(); openDetails(); refresh();
  expect(screen.getByRole('status')).toHaveTextContent('Checking running app');
  expect(screen.getByText(/Last observation is stale/)).toBeInTheDocument();
});


test.each([{ schema_version: '14' }, { corpus_id: 'invented' }, { build_id: 'invented' }])('unsupported identity shape is unavailable', async change => {
  const valid = health(); fetchMock.mockResolvedValue(response({ ...valid, identity: { ...valid.identity, ...change } }));
  mount(); await settle(); expect(screen.getByRole('status')).toHaveTextContent('Identity unavailable');
});
