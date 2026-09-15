import React from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react';
import Downloads from '../components/Layout/Downloads';
import type { DownloadRecord } from '../api/client';
const record: DownloadRecord = { id: '7', filename: 'selected-answer.html', state: 'completed', path: '/synthetic/downloads/selected-answer.html', receivedBytes: 123, totalBytes: 123 };
let notify: (rows: DownloadRecord[]) => void;
const unsubscribe = jest.fn();
beforeEach(() => {
  jest.clearAllMocks();
  window.resmonAPI = { getBackendPort: () => '12345', platform: 'test', versions: { node: 'test', electron: 'test' },
    getDownloads: jest.fn().mockResolvedValue([]), revealDownload: jest.fn().mockResolvedValue(true),
    onDownloadsChanged: callback => { notify = callback; return unsubscribe; } };
});
it('shows the completed filename and actual path, reveals by ID only, and unsubscribes', async () => {
  const view = render(<Downloads/>); await act(async () => {});
  act(() => notify([record]));
  expect(screen.getByText(record.path)).toBeInTheDocument();
  expect(screen.getByRole('status')).toHaveTextContent('Saved: selected-answer.html');
  fireEvent.click(screen.getByRole('button', { name: 'Show in folder' }));
  expect(window.resmonAPI?.revealDownload).toHaveBeenCalledWith('7');
  view.unmount(); expect(unsubscribe).toHaveBeenCalledTimes(1);
});
it.each(['progressing', 'cancelled', 'interrupted'] as const)('does not advertise %s as a saved file', async state => {
  render(<Downloads/>); await act(async () => {}); act(() => notify([{ ...record, state, path: '' }]));
  expect(screen.queryByRole('button', { name: 'Show in folder' })).toBeNull();
  expect(screen.getByRole('status')).not.toHaveTextContent('Saved:');
});
it('keeps a completion received before a stale initial history response', async () => {
  let resolve!: (rows: DownloadRecord[]) => void;
  window.resmonAPI!.getDownloads = () => new Promise(done => { resolve = done; });
  render(<Downloads/>); act(() => notify([record])); await act(async () => resolve([]));
  expect(screen.getByText(record.path)).toBeInTheDocument();
});
it('preserves the visible path if reveal fails', async () => {
  window.resmonAPI!.revealDownload = jest.fn().mockRejectedValue(new Error('refused'));
  render(<Downloads/>); await act(async () => {}); act(() => notify([record]));
  fireEvent.click(screen.getByRole('button', { name: 'Show in folder' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('Use the saved path');
});
