import React, { useEffect, useRef, useState } from 'react';
import PageHelp from '../components/Help/PageHelp';
import { ChoiceSummary } from '../components/Assistant/ComposerChoices';
import { TranscriptMessages } from '../components/Assistant/TranscriptMessages';
import { useAssistant } from '../context/AssistantContext';
import { ChatDetail, ChatPage, chatsApi, ConversationFormat } from '../api/chats';
import { downloadConversation } from '../lib/conversationDownload';

const reason = (e: unknown) => e instanceof Error ? e.message : String(e);
const ChatsPage: React.FC = () => {
  const ask = useAssistant();
  const [q, setQ] = useState('');
  const [page, setPage] = useState<ChatPage | null>(null);
  const [pageNumber, setPageNumber] = useState(1);
  const [listError, setListError] = useState('');
  const [loading, setLoading] = useState(false);
  const [selected, setSelected] = useState<number | null>(null);
  const [detail, setDetail] = useState<ChatDetail | null>(null);
  const [detailError, setDetailError] = useState('');
  const [exporting, setExporting] = useState(false);
  const [notice, setNotice] = useState('');
  const listEpoch = useRef(0);
  const detailEpoch = useRef(0);
  const exportEpoch = useRef(0);
  const titleRef = useRef<HTMLHeadingElement>(null);

  const clearSelection = () => {
    ++detailEpoch.current; ++exportEpoch.current;
    setSelected(null); setDetail(null); setDetailError(''); setNotice(''); setExporting(false);
  };
  const load = async (query: string, older = false) => {
    const epoch = ++listEpoch.current;
    clearSelection(); setLoading(true); setListError('');
    const number = older ? pageNumber + 1 : 1;
    const through = older ? page?.through_id : undefined;
    const before = older ? page?.next_before_id ?? undefined : undefined;
    setPage(null);
    try {
      const next = await chatsApi.browse(query, through, before);
      if (epoch !== listEpoch.current) return;
      setPage(next); setPageNumber(number);
    } catch (e) { if (epoch === listEpoch.current) setListError(reason(e)); }
    finally { if (epoch === listEpoch.current) setLoading(false); }
  };
  useEffect(() => {
    void load('');
    return () => { ++listEpoch.current; ++detailEpoch.current; ++exportEpoch.current; };
  }, []);
  const select = async (id: number) => {
    const epoch = ++detailEpoch.current;
    ++exportEpoch.current; setExporting(false); setNotice('');
    setSelected(id); setDetail(null); setDetailError('');
    try {
      const next = await chatsApi.detail(id);
      if (epoch === detailEpoch.current) { setDetail(next); }
    } catch (e) { if (epoch === detailEpoch.current) setDetailError(reason(e)); }
  };
  useEffect(() => { if (detail) titleRef.current?.focus(); }, [detail]);
  const save = async (format: ConversationFormat) => {
    if (!detail || exporting) return;
    const epoch = ++exportEpoch.current;
    setExporting(true); setNotice('');
    try {
      const requested = await downloadConversation(detail.session.id, format, () => epoch === exportEpoch.current);
      if (requested && epoch === exportEpoch.current) setNotice('Download requested. Choose a destination; this page cannot confirm a native save.');
    } catch (e) { if (epoch === exportEpoch.current) setNotice(reason(e)); }
    finally { if (epoch === exportEpoch.current) setExporting(false); }
  };
  const blocked = ask.isAnswering && selected !== ask.sessionId;
  return <div className="chats-page">
    <PageHelp storageKey="chats" title="About Chats" summary="Find, read, continue and export saved conversations.">
      <p>Newest created first. Refresh includes new chats. The refresh fixes an ID ceiling, not titles or message contents.
        Filter matches a literal saved-title substring, ignoring ASCII case; other characters match literally.</p>
      <p>Continue in Ask opens the same local conversation without sending a message. One Ask turn can run in this renderer.
        Other saved chats remain readable and exportable. Historical completion is unknown.</p>
      <p>Ask fixes connection/model/effort per conversation without changing global defaults. Requested choices and literal runtime model reports are separate. Historical chats require confirmation of future choices: API continuation sends saved user/assistant text to the chosen provider; Claude starts fresh without earlier messages. Change choices starts an empty conversation.</p>
      <p>Exports contain persisted messages and tool data only, without live fragments or pending approval cards.
        Each format is limited to 8 MiB and refuses larger output without truncation. Recorded metadata may be absent;
        cost is not an invoice. Review saved text before sharing.</p>
    </PageHelp>
    <div className="chats-toolbar">
      <label>Filter saved titles<input aria-label="Filter saved titles" maxLength={200} value={q}
        onChange={e => { setQ(e.target.value); void load(e.target.value); }} /></label>
      <button type="button" onClick={() => void load(q)}>Refresh chats</button>
    </div>
    <div className="chats-layout">
      <section aria-label="Saved chats" className="chats-list">
        {loading && <p role="status">Loading chats…</p>}
        {listError && <p role="alert">{listError}</p>}
        {page && <>
          <p>Page {pageNumber} · {page.sessions.length} chats on this page</p>
          <ul>{page.sessions.map(chat => <li key={chat.id}>
            <button type="button" aria-pressed={chat.id === selected} onClick={() => void select(chat.id)}>
              <strong>{chat.title}</strong><span>Created {chat.created_at}</span><span>Updated {chat.updated_at}</span>
              <span>{chat.message_count} saved messages</span>
            </button>
          </li>)}</ul>
          {page.has_more ? <button type="button" onClick={() => void load(q, true)}>Older chats</button>
            : <p>No more matching chats at this refresh.</p>}
        </>}
      </section>
      <section aria-label="Saved transcript" className="chats-transcript">
        {selected === null && <p>Select a saved chat to read its transcript.</p>}
        {selected !== null && !detail && !detailError && <p role="status">Loading transcript…</p>}
        {detailError && <p role="alert">{detailError}</p>}
        {detail && <>
          <h2 ref={titleRef} tabIndex={-1}>{detail.session.title}</h2>
          <p>{detail.snapshot.message_count} persisted messages · Historical completion unknown.</p>
          <p>Snapshot observed {detail.snapshot.captured_at_utc}.</p>
          {detail.activity_observation.turn_claimed && <p>Already answering when checked. This saved snapshot may be incomplete.</p>}
          <div className="chats-actions">
            <button type="button" disabled={blocked} onClick={() => void ask.openSession(detail.session.id)}>Continue in Ask</button>
            <button type="button" disabled={exporting} onClick={() => void save('markdown')}>Export Markdown</button>
            <button type="button" disabled={exporting} onClick={() => void save('json')}>Export JSON</button>
            <button type="button" onClick={() => void select(detail.session.id)}>Refresh transcript</button>
          </div>
          {blocked && <p>Finish or stop the current answer before continuing another chat.</p>}
          <p>Includes saved messages and tool data; review before sharing. Live-only fragments and pending cards are excluded.</p>
          {notice && <p role="status">{notice}</p>}
          {!detail.messages.length && <p>No saved messages.</p>}
          <ChoiceSummary choices={detail.session.choices} />
          <TranscriptMessages messages={detail.messages} turnChoices={detail.turn_choices} />
        </>}
      </section>
    </div>
  </div>;
};
export default ChatsPage;
