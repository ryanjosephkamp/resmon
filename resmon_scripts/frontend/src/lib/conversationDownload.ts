import { apiClient } from '../api/client';
import type { ConversationFormat } from '../api/chats';

/** The selection is checked after transport, immediately before the download. */
export async function downloadConversation(id: number, format: ConversationFormat,
  isCurrent: () => boolean): Promise<boolean> {
  const body = await apiClient.get<unknown>(`/api/assistant/sessions/${id}/export?format=${format}`);
  if (!isCurrent()) return false;
  const type = format === 'json' ? 'application/json' : 'text/markdown';
  const filename = `resmon-chat-${id}.${format === 'json' ? 'json' : 'md'}`;
  if (!body || typeof body !== 'object' || !('session_id' in body) || body.session_id !== id
      || !('format' in body) || body.format !== format || !('content_type' in body) || body.content_type !== type
      || !('filename' in body) || body.filename !== filename || !('text' in body) || typeof body.text !== 'string') {
    throw new Error('The export response did not match the selected conversation and format.');
  }
  if (format === 'json') {
    const content = JSON.parse(body.text);
    if (content?.version !== 1 || content?.session?.id !== id || !Array.isArray(content.messages)) {
      throw new Error('The exported JSON is not the selected saved transcript.');
    }
  }
  const blob = new Blob([body.text], { type: `${type};charset=utf-8` });
  if (blob.size > 8 * 1024 * 1024) throw new Error('This transcript exceeds the 8 MiB export limit. Nothing was truncated.');
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  try {
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
  } finally { a.remove(); URL.revokeObjectURL(url); }
  return true;
}
