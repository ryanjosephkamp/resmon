import { downloadConversation } from '../lib/conversationDownload';
import { apiClient } from '../api/client';
jest.mock('../api/client', () => ({ apiClient: { get: jest.fn() } }));
const get = apiClient.get as jest.Mock;
const payload = (format = 'json') => ({ session_id: 12, format, filename: `resmon-chat-12.${format === 'json' ? 'json' : 'md'}`,
  content_type: format === 'json' ? 'application/json' : 'text/markdown',
  text: format === 'json' ? JSON.stringify({ version: 1, session: { id: 12 }, messages: [] }) : '# Saved conversation\n' });
beforeEach(() => {
  jest.restoreAllMocks(); get.mockReset();
  URL.createObjectURL = jest.fn(() => 'blob:synthetic'); URL.revokeObjectURL = jest.fn();
  jest.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
});
it.each(['json','markdown'] as const)('requests %s bytes only after validated identity', async format => {
  get.mockResolvedValue(payload(format));
  expect(await downloadConversation(12, format, () => true)).toBe(true);
  expect(URL.createObjectURL).toHaveBeenCalledTimes(1);
  expect(HTMLAnchorElement.prototype.click).toHaveBeenCalledTimes(1);
  expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:synthetic');
});
it.each([{ session_id: 13 }, { format: 'markdown' }, { filename: '../bad' }, { content_type: 'text/html' }, { text: '{broken' }, { text: '{"error":"no"}' }])('refuses malformed or mismatched envelope %j', async change => {
  get.mockResolvedValue({ ...payload(), ...change });
  await expect(downloadConversation(12, 'json', () => true)).rejects.toThrow();
  expect(URL.createObjectURL).not.toHaveBeenCalled();
});
it('drops a successful stale response and refuses HTTP failure or oversized content', async () => {
  get.mockResolvedValue(payload());
  expect(await downloadConversation(12,'json',()=>false)).toBe(false);
  get.mockRejectedValue(new Error('404 absent'));
  await expect(downloadConversation(12,'json',()=>true)).rejects.toThrow('404');
  get.mockResolvedValue({...payload('markdown'),text:'a'.repeat(8*1024*1024+1)});
  await expect(downloadConversation(12,'markdown',()=>true)).rejects.toThrow('8 MiB');
  expect(URL.createObjectURL).not.toHaveBeenCalled();
});
