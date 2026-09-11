import { apiClient } from './client';
import type { AssistantMessage, AssistantSessionSummary } from '../context/AssistantContext';

export type ConversationFormat = 'json' | 'markdown';
export interface ChatSummary extends AssistantSessionSummary { created_at: string; model: string | null }
export interface ChatPage {
  sessions: ChatSummary[]; through_id: number; next_before_id: number | null; has_more: boolean;
}
export interface ChatDetail {
  session: ChatSummary; messages: AssistantMessage[];
  snapshot: { captured_at_utc: string; basis: string; message_count: number; last_message_id: number | null };
  activity_observation: { observed_at_utc: string; turn_claimed: boolean; cli_running: boolean; basis: string };
}
export const chatsApi = {
  browse: (q: string, through?: number, before?: number) => {
    const params = new URLSearchParams({ q });
    if (through !== undefined) params.set('through_id', String(through));
    if (before !== undefined) params.set('before_id', String(before));
    return apiClient.get<ChatPage>(`/api/assistant/sessions/browse?${params}`);
  },
  detail: async (id: number): Promise<ChatDetail> => {
    const body = await apiClient.get<ChatDetail>(`/api/assistant/sessions/${id}`);
    if (body?.session?.id !== id || !Array.isArray(body.messages)) throw new Error('The conversation response did not match.');
    return body;
  },
};
