import React from 'react';
import { AssistantMessage, shortToolName } from '../../context/AssistantContext';

function formatCost(value?: number | null): string {
  // "not reported" rather than "$0.00". Zero is a measurement and this is not
  // one; every other surface in resmon draws that line and so does this.
  if (value === null || value === undefined) return 'cost not reported';
  return `$${value.toFixed(4)}`;
}

const ToolCallRow: React.FC<{ call: NonNullable<AssistantMessage['tool_calls']>[number]; live: boolean }> = (
  { call, live },
) => {
  const [open, setOpen] = React.useState(false);
  const icon = call.outcome === 'error' ? '✗' : call.outcome === 'ok' ? '✓' : (live ? '⟳' : '·');
  return (
    <div className={`assistant-tool assistant-tool--${call.outcome || (live ? 'running' : 'saved')}`}>
      <button
        type="button"
        className="assistant-tool-head"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        <span className="assistant-tool-icon" aria-hidden="true">{icon}</span>
        <span className="assistant-tool-name">{shortToolName(call.name)}</span>
        <span className="assistant-tool-chevron" aria-hidden="true">{open ? '▾' : '▸'}</span>
      </button>
      {open && (
        <pre className="assistant-tool-body">{JSON.stringify(call.input ?? {}, null, 2)}</pre>
      )}
    </div>
  );
};

/** All persisted text and arbitrary tool data render literally, without HTML/Markdown. */
export const TranscriptMessages: React.FC<{ messages: AssistantMessage[] }> = ({ messages }) => <>
  {messages.map((message, index) => <div className={`assistant-message assistant-message--${message.role}`}
    key={message.id ?? `live-${index}`}>
    {message.content && <div className="assistant-bubble">{message.content}</div>}
    {Array.isArray(message.tool_calls) && message.tool_calls.every(call => call && typeof call.name === 'string')
      ? message.tool_calls.map((call, i) => <ToolCallRow key={i} call={call} live={!!message.streaming} />)
      : message.tool_calls != null && <details><summary>Saved tool calls</summary><pre>{JSON.stringify(message.tool_calls, null, 2)}</pre></details>}
    {message.tool_results != null && <details><summary>Saved tool results</summary><pre>{JSON.stringify(message.tool_results, null, 2)}</pre></details>}
    {message.role === 'assistant' && !message.streaming && <div className="assistant-meta">{formatCost(message.cost_usd)}</div>}
  </div>)}
</>;
