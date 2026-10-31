import { useEffect, useMemo, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { answer as answered, engine, EngineError } from '../../api/client';
import { CommandEnterHint, commandEnterKeys } from '../../shell/CommandEnterHint';
import { commandEnter } from '../../shell/shortcuts';
import { count, number, when } from '../today/format';
import {
  answers, citedText, terminal,
  type Answer, type AnswerEvent, type Choice, type Choices, type ChosenNote, type Citation, type Mode, type Preview, type Selection, type Source,
} from './answersApi';
import {
  CLEANUP_WORDS, ITEM_WORDS, MODE_WORDS, SECTION_WORDS, STATE_WORDS,
  citationLabel, connectionKey, firstChoice, reportedWords, requestedWords, usageWords,
} from './answersModel';
import type { FileRecord, Member, Note, Project } from './evidenceApi';
import type { Pin } from './evidenceModel';
import { Reader } from './Reader';
import { LIBRARY, download } from './libraryApi';

function errorWords(error: unknown): string {
  if (error instanceof EngineError && error.detail) return error.detail;
  return error instanceof Error ? error.message : String(error);
}

/** The answer this window started and still owns: it is cancelled if the window leaves it. */
interface Owned { answer: Answer; runtime: string }

/**
 * A project's selected-evidence answers: ask a question of, or ask for a
 * briefing from, exact excerpts of the files it holds. Nothing is sent until
 * the exact disclosure has been shown and Send is pressed, and each Send makes
 * one new saved answer; earlier answers and Ask conversations are never sent.
 * Opening a saved answer reads what was saved. It calls no model and reads no
 * original file until a citation is opened.
 */
export function Answers({ project, members, notes }: { project: Project; members: Member[]; notes: Note[] }) {
  const client = useQueryClient();
  const history = useQuery({ queryKey: ['evidence-answers', project.project_id], queryFn: ({ signal }) => answers.history(project, signal) });
  const [composing, setComposing] = useState(false);
  const [open, setOpen] = useState<string | null>(null);
  const [live, setLive] = useState<Answer | null>(null);
  const [blocked, setBlocked] = useState<string | null>(null);
  const owned = useRef<Owned | null>(null);
  const stream = useRef<AbortController | null>(null);
  const [running, setRunning] = useState(false);

  // Leaving the project or the tab while an answer runs stops it: the engine
  // would otherwise run on for nobody, and its cleanup blocks the next one.
  // Keyed by the project's identity, not its revision, which moves on every write.
  const { vault_id, project_id } = project;
  useEffect(() => {
    const jobs = owned;
    const streams = stream;
    return () => {
      streams.current?.abort();
      const job = jobs.current;
      if (job) void answers.cancel({ vault_id, project_id }, job.answer.answer_id, job.runtime).catch(() => undefined);
    };
  }, [vault_id, project_id]);

  const refresh = () => {
    void client.invalidateQueries({ queryKey: ['evidence-answers', project.project_id] });
  };

  const settle = (final: Answer) => {
    setLive(final);
    refresh();
    void client.invalidateQueries({ queryKey: ['evidence-answer', project.project_id, final.answer_id] });
    if (final.cleanup_state === 'confirmed') {
      owned.current = null;
      setRunning(false);
      setBlocked(null);
    } else {
      setBlocked('Local cleanup is not confirmed yet, so a new answer cannot start. Check again in a moment.');
    }
  };

  const started = (admitted: Answer, runtime: string) => {
    owned.current = { answer: admitted, runtime };
    setLive(admitted);
    setOpen(admitted.answer_id);
    setComposing(false);
    setRunning(true);
    refresh();
    const controller = new AbortController();
    stream.current = controller;
    void answers.events(project, admitted, runtime, (event: AnswerEvent) => {
      setLive((prior) => {
        if (!prior || prior.answer_id !== event.answer_id) return prior;
        if (event.type === 'initial' && event.answer) return event.answer;
        if (terminal(prior.state)) return prior;
        if (event.type === 'partial' && event.partial_text !== undefined && event.partial_text.startsWith(prior.partial_text)) {
          return { ...prior, partial_text: event.partial_text };
        }
        if (event.type === 'report' && event.model_report) return { ...prior, reports: [...prior.reports, event.model_report] };
        if (event.state) return { ...prior, state: event.state };
        return prior;
      });
    }, controller.signal)
      .then(async () => {
        const after = await answers.detail(project, admitted.answer_id);
        settle(terminal(after.state) ? after : await answers.cancel(project, admitted.answer_id, runtime));
      })
      .catch(async (reason) => {
        if (controller.signal.aborted) return;
        try {
          settle(await answers.cancel(project, admitted.answer_id, runtime));
        } catch {
          setBlocked(`${errorWords(reason)} Stopping was asked for; whether local cleanup finished is not known.`);
        }
      });
  };

  const stop = async () => {
    const job = owned.current;
    if (!job) return;
    try {
      setLive(await answers.cancel(project, job.answer.answer_id, job.runtime));
    } catch (error) {
      setBlocked(`${errorWords(error)} Whether it stopped is not known.`);
    }
  };

  const recheck = async () => {
    const job = owned.current;
    if (!job) return;
    try {
      const now = await answers.detail(project, job.answer.answer_id);
      if (terminal(now.state)) settle(now); else setLive(now);
    } catch (error) {
      setBlocked(errorWords(error));
    }
  };

  const list = history.data?.answers ?? [];
  const busy = running || !!blocked;
  return (
    <div className="ev-answers-split">
      <nav className="ev-answers" aria-label="Saved answers" aria-busy={history.isFetching}>
        <button type="button" className="btn sm primary" disabled={busy || composing} onClick={() => { setComposing(true); setOpen(null); }}>
          New answer
        </button>
        {running && <button type="button" className="btn sm" onClick={() => void stop()}>Stop the answer</button>}
        {blocked && <button type="button" className="btn sm quiet" onClick={() => void recheck()}>Check again</button>}
        <p className="form-hint">Opening a saved answer reads what was saved. It calls no model and reads no original file.</p>
        {history.isError && <p className="field-error" role="alert">{errorWords(history.error)}</p>}
        {history.data && !list.length && <p className="index-empty">No answers yet.</p>}
        <ol>
          {[...list].reverse().map((a) => (
            <li key={a.answer_id}>
              <button type="button" className="ev-answer-row" aria-pressed={a.answer_id === open && !composing} data-answer={a.answer_id}
                disabled={running && a.answer_id !== live?.answer_id} onClick={() => { setComposing(false); setOpen(a.answer_id); }}>
                <span className="lib-name">{MODE_WORDS[a.mode] ?? a.mode} · {STATE_WORDS[a.state] ?? a.state}</span>
                <span className="meta"><span>{when(a.created_at_utc, new Date())}</span><span className="sep" /><code className="path">{a.answer_id.slice(0, 8)}</code></span>
              </button>
            </li>
          ))}
        </ol>
        {history.data && history.data.total > list.length && <p className="record-cap">Showing {number(list.length)} of {number(history.data.total)}.</p>}
      </nav>
      <div className="ev-answers-main">
        {blocked && <p className="field-error" role="alert">{blocked}</p>}
        {composing && (
          <Composer project={project} members={members} notes={notes} onClose={() => setComposing(false)} onStarted={started} />
        )}
        {!composing && open && (
          live?.answer_id === open
            ? <AnswerView project={project} answer={live} />
            : <SavedAnswer project={project} id={open} />
        )}
        {!composing && !open && (
          <p className="page-lede ev-answers-lede">
            Ask a question of exact excerpts from this project’s files, or ask for a briefing. You choose every page or passage
            that is sent, and see exactly what will leave the app before anything does.
          </p>
        )}
      </div>
    </div>
  );
}

function SavedAnswer({ project, id }: { project: Project; id: string }) {
  const saved = useQuery({ queryKey: ['evidence-answer', project.project_id, id], queryFn: ({ signal }) => answers.detail(project, id, signal) });
  if (saved.isPending) return <p className="record-cap">Reading the saved answer.</p>;
  if (saved.isError) return <p className="field-error" role="alert">{errorWords(saved.error)}</p>;
  return <AnswerView project={project} answer={saved.data} />;
}

/** A selection's own words: which file, which page, all of it or which codepoints. */
function selectionWords(s: Selection, names: Map<string, string>): string {
  return `${names.get(s.file_id) ?? s.file_id} · page ${s.page_number} · ${s.range ? `codepoints ${s.range.start_codepoint} to ${s.range.end_codepoint}` : 'the whole page’s text'}`;
}

function Composer({ project, members, notes, onClose, onStarted }: {
  project: Project; members: Member[]; notes: Note[]; onClose: () => void; onStarted: (a: Answer, runtime: string) => void;
}) {
  const setup = useQuery({ queryKey: ['evidence-answer-setup'], queryFn: answers.setup, staleTime: 0, gcTime: 0 });
  const [selections, setSelections] = useState<Selection[]>([]);
  const [chosenNotes, setChosenNotes] = useState<ChosenNote[]>([]);
  const [pages, setPages] = useState<Record<string, string>>({});
  const [mode, setMode] = useState<Mode>('question');
  const [instruction, setInstruction] = useState('');
  const [choice, setChoice] = useState<Choice | null>(null);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [working, setWorking] = useState<'preview' | 'send' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const ticket = useRef(0);
  const names = useMemo(() => new Map(members.map((m) => [m.file_id, m.file.original_name])), [members]);
  const choices: Choices | undefined = setup.data?.choices;
  const current = choice ?? (choices ? firstChoice(choices) : null);

  /** Any change to what would be sent throws away the preview of what was going to be. */
  const changed = () => { ticket.current += 1; setPreview(null); setError(null); setWorking(null); };
  const add = (next: Selection) => {
    changed();
    setSelections((prior) => (prior.some((x) => JSON.stringify(x) === JSON.stringify(next)) ? prior : [...prior, next]));
  };
  const addPage = (m: Member) => {
    const n = m.file.media_type === 'application/pdf' ? Number(pages[m.file_id]) : 1;
    if (!Number.isInteger(n) || n < 1 || n > 200) { setError('Give a page number from 1 to 200.'); return; }
    add({ file_id: m.file_id, version_id: m.version_id, sha256: m.file.sha256, page_number: n, range: null });
  };
  const passages = notes.filter((n) => n.kind === 'passage' && n.membership_state === 'member' && n.page_number !== null);
  const selectable = notes.filter((n) => n.membership_state === 'member' && selections.some((s) => s.file_id === n.file_id && s.version_id === n.version_id));
  const length = Array.from(instruction).length;
  const connection = choices?.connections.find((c) => current && connectionKey(c) === connectionKey(current));

  const prepare = async () => {
    if (!setup.data || !current) return;
    changed();
    const mine = ticket.current;
    setWorking('preview');
    try {
      const made = await answers.preview(project, setup.data.runtimeId, { selections, notes: chosenNotes, mode, instruction, choices: current });
      if (mine === ticket.current) setPreview(made);
    } catch (e) {
      if (mine === ticket.current) setError(errorWords(e));
    } finally {
      if (mine === ticket.current) setWorking(null);
    }
  };
  const send = async () => {
    if (!preview) return;
    const mine = ++ticket.current;
    setWorking('send');
    try {
      const admitted = await answers.send(project, preview);
      if (mine === ticket.current) onStarted(admitted, preview.owner_runtime_id);
      else await answers.cancel(project, admitted.answer_id, preview.owner_runtime_id);
    } catch (e) {
      if (mine === ticket.current) { setError(errorWords(e)); setWorking(null); }
    }
  };

  return (
    <section className="ev-compose" aria-label="New answer from selected evidence">
      <div className="ev-compose-head">
        <h2 className="ev-title">New answer</h2>
        <button type="button" className="btn sm quiet" onClick={onClose}>Close without sending</button>
      </div>
      <p className="form-hint">Up to 5 files, 12 pages, 24 excerpts and 8 notes. Nothing is sent until you have seen exactly what will be, and pressed Send.</p>

      <fieldset className="ev-step" disabled={!!working}>
        <legend>1. What to send</legend>
        <ul className="ev-pick">
          {members.map((m) => (
            <li key={m.file_id}>
              <span className="lib-name">{m.file.original_name}</span>
              {m.file.media_type === 'application/pdf'
                ? (
                  <span className="ev-pick-page">
                    <label htmlFor={`ev-pick-${m.file_id}`}>Page of {m.file.original_name}</label>
                    <input id={`ev-pick-${m.file_id}`} inputMode="numeric" value={pages[m.file_id] ?? ''} autoComplete="off"
                      onChange={(e) => { changed(); setPages((p) => ({ ...p, [m.file_id]: e.target.value.replace(/[^0-9]/g, '') })); }} />
                    <button type="button" className="btn sm" onClick={() => addPage(m)} aria-label={`Add the page of ${m.file.original_name}`}>Add the page</button>
                  </span>
                )
                : <button type="button" className="btn sm" onClick={() => addPage(m)} aria-label={`Add the text of ${m.file.original_name}`}>Add the text</button>}
            </li>
          ))}
        </ul>
        {passages.length > 0 && (
          <>
            <p className="record-cap">Or a passage you saved, exactly as saved:</p>
            <ul className="ev-pick">
              {passages.map((n) => (
                <li key={n.note_id}>
                  <span className="ev-quote ev-pick-quote">{n.quote}</span>
                  <button type="button" className="btn sm" aria-label={`Add the passage “${n.quote}”`} onClick={() => add({
                    file_id: n.file_id, version_id: n.version_id, sha256: n.file.sha256, page_number: n.page_number!,
                    range: {
                      start_codepoint: n.start_codepoint!, end_codepoint: n.end_codepoint!, quote: n.quote!,
                      page_text_sha256: n.page_text_sha256!, extraction_contract: n.extraction_contract!,
                    },
                  })}>Add the passage</button>
                </li>
              ))}
            </ul>
          </>
        )}
        <h3 className="record-sub">Selected</h3>
        {!selections.length && <p className="record-cap">Nothing yet.</p>}
        <ol className="ev-selected" aria-label="Selected excerpts">
          {selections.map((s, i) => (
            <li key={`${s.file_id}:${s.page_number}:${s.range?.start_codepoint ?? 'page'}:${i}`}>
              <span>{selectionWords(s, names)}</span>
              {s.range && <span className="ev-quote ev-pick-quote">{s.range.quote}</span>}
              <button type="button" className="btn sm quiet" onClick={() => { changed(); setSelections((p) => p.filter((_, j) => j !== i)); setChosenNotes([]); }}>
                Remove
              </button>
            </li>
          ))}
        </ol>
      </fieldset>

      <fieldset className="ev-step" disabled={!!working}>
        <legend>2. Your notes, if any</legend>
        <p className="form-hint">None is sent unless you tick it. A note is your own commentary, not evidence from a document, and an answer cannot cite it as one.</p>
        {!selectable.length && <p className="record-cap">No saved note on a selected file.</p>}
        {selectable.map((n) => (
          <label className="choice" key={n.note_id}>
            <input type="checkbox" checked={chosenNotes.some((x) => x.note_id === n.note_id)} onChange={(e) => {
              changed();
              setChosenNotes((p) => (e.target.checked ? [...p, { note_id: n.note_id, expected_note_revision: n.revision }] : p.filter((x) => x.note_id !== n.note_id)));
            }} />
            <span>Include note: {n.body || '(an empty note on a passage)'}</span>
          </label>
        ))}
      </fieldset>

      <fieldset className="ev-step" disabled={!!working}>
        <legend>3. What to ask</legend>
        <div className="ev-row">
          <label htmlFor="ev-mode" className="form-label">Answer as</label>
          <select id="ev-mode" value={mode} onChange={(e) => { changed(); setMode(e.target.value as Mode); }}>
            <option value="question">An answer to a question</option>
            <option value="briefing">A structured briefing</option>
          </select>
        </div>
        <label htmlFor="ev-instruction" className="form-label">Question or instruction</label>
        <textarea id="ev-instruction" value={instruction} rows={3} {...commandEnter('ev-prepare')}
          onChange={(e) => { changed(); setInstruction(e.target.value); }} />
        <span className="record-cap num">{number(length)} of 4,000 codepoints</span>
      </fieldset>

      <fieldset className="ev-step" disabled={!!working || !choices}>
        <legend>4. Where it goes</legend>
        {setup.isError && <p className="field-error" role="alert">{errorWords(setup.error)}</p>}
        {choices && (
          <>
            <div className="ev-row">
              <label htmlFor="ev-connection" className="form-label">Connection</label>
              <select id="ev-connection" value={current ? connectionKey(current) : ''} onChange={(e) => {
                changed();
                const c = choices.connections.find((x) => connectionKey(x) === e.target.value);
                if (c?.runtime) setChoice({ version: 1, runtime: c.runtime as Choice['runtime'], provider: c.provider, model: null, effort: null });
              }}>
                {choices.connections.map((c) => (
                  <option key={connectionKey(c)} value={connectionKey(c)} disabled={!c.implemented || !c.available || !c.runtime}>
                    {c.label}{c.available ? '' : ' (unavailable)'}
                  </option>
                ))}
              </select>
            </div>
            {connection && <p className="record-cap">{connection.reason}</p>}
            <div className="ev-row">
              <label htmlFor="ev-model" className="form-label">Model</label>
              <input id="ev-model" value={current?.model ?? ''} list="ev-models" autoComplete="off"
                placeholder={current?.runtime === 'api_key' ? 'The model’s ID, required' : 'Leave empty for its default'}
                onChange={(e) => { changed(); if (current) setChoice({ ...current, model: e.target.value.trim() || null }); }} />
              <datalist id="ev-models">{current?.runtime === 'claude_cli' && choices.claude_aliases.map((a) => <option key={a} value={a} />)}</datalist>
            </div>
            {connection?.effort_supported && (
              <div className="ev-row">
                <label htmlFor="ev-effort" className="form-label">Effort</label>
                <select id="ev-effort" value={current?.effort ?? ''} onChange={(e) => { changed(); if (current) setChoice({ ...current, effort: e.target.value || null }); }}>
                  <option value="">Its default</option>
                  {choices.claude_efforts.map((x) => <option key={x} value={x}>{x}</option>)}
                </select>
              </div>
            )}
          </>
        )}
      </fieldset>

      <div className="ev-use">
        <button type="button" id="ev-prepare" className="btn sm primary" aria-keyshortcuts={commandEnterKeys()}
          disabled={!!working || !current || !selections.length || !instruction.trim() || length > 4000}
          onClick={() => void prepare()}>
          {working === 'preview' ? 'Checking the exact selection' : 'Show exactly what will be sent'}
        </button>
        <CommandEnterHint />
      </div>
      {error && <p className="field-error" role="alert">{error}</p>}
      {preview && <Disclosure preview={preview} sending={working === 'send'} onSend={() => void send()} onBack={changed} />}
    </section>
  );
}

/** The exact request a Send would make, before it is made. */
function Disclosure({ preview, sending, onSend, onBack }: { preview: Preview; sending: boolean; onSend: () => void; onBack: () => void }) {
  const p = preview.request.payload;
  return (
    <section className="ev-disclosure" aria-label="Exact disclosure">
      <h3 className="ev-title">Check before sending</h3>
      <p><b>To:</b> {requestedWords(p.requested)}{p.disclosure.custom_endpoint ? ', at the custom address set in Settings' : ''}.</p>
      <p className="record-cap">
        {count(p.coverage.file_count, 'file')}, {count(p.coverage.page_count, 'page')} read, {count(p.coverage.segment_count, 'excerpt')},{' '}
        {number(p.coverage.source_codepoints)} codepoints of source text, {count(p.coverage.note_count, 'note')}.
      </p>
      {p.coverage.files.map((f) => (
        <p className="record-cap" key={f.file_id}>
          Version <code className="path">{f.version_id}</code>: page {f.selected_pages.join(', ')} of {f.known_page_count ?? 'an unknown number'} sent;{' '}
          {f.unexamined_page_count === null ? 'how many were not examined is not known'
            : f.unexamined_page_count === 0 ? 'every page examined' : `${count(f.unexamined_page_count, 'page')} not examined`}.
        </p>
      ))}
      <p className="record-cap">{p.disclosure.source_strings_may_contain_private_material}</p>
      {p.sources.map((s) => (
        <article key={s.source_id} className="ev-source">
          <h4>{s.source_id} · {s.original_name} · page {s.page_number}</h4>
          <p className="record-cap">Codepoints {s.start_codepoint} to {s.end_codepoint} · version <code className="path">{s.version_id}</code></p>
          <pre>{s.text}</pre>
        </article>
      ))}
      {p.notes.map((n) => (
        <article key={n.note_id} className="ev-source">
          <h4>Your note · revision {n.revision}</h4>
          <pre>{n.body}</pre>
        </article>
      ))}
      <details><summary>The exact instructions the app sends with it</summary><pre>{preview.request.system_text}</pre></details>
      <details><summary>The exact text sent, as one string</summary><pre>{preview.request.user_prompt}</pre></details>
      <p className="record-cap">Request SHA-256 <code className="path">{preview.request_sha256}</code>. This preview expires {when(preview.expires_at_utc, new Date())}.</p>
      <p className="record-cap">{p.disclosure.limitations}</p>
      <p className="form-hint">One new answer, with no tools and no earlier conversation, stopped after 300 seconds. A stopped request may still be worked on, and charged for, by the provider.</p>
      <div className="ev-use">
        <button type="button" className="btn sm primary" disabled={sending} onClick={onSend}>{sending ? 'Sending' : 'Send'}</button>
        <button type="button" className="btn sm quiet" disabled={sending} onClick={onBack}>Change the selection</button>
      </div>
    </section>
  );
}

/** One saved answer, and its citations, each checkable against the current file. */
function AnswerView({ project, answer }: { project: Project; answer: Answer }) {
  const [cited, setCited] = useState<{ source: Source; citation: Citation; key: string } | null>(null);
  const [saving, setSaving] = useState<string | null>(null);
  const [said, setSaid] = useState<string | null>(null);
  const sources = answer.request.payload.sources;
  const save = async (format: 'zip' | 'html') => {
    setSaving(format);
    setSaid(null);
    try {
      const file = await answers.exportFile(project, answer, format);
      download(file.bytes, file.filename, format === 'html' ? 'text/html' : 'application/zip');
      setSaid(`Saved the answer as ${format === 'html' ? 'one HTML file' : 'a ZIP archive'}, ${count(file.bytes.byteLength, 'byte')}, to your downloads.`);
    } catch (e) {
      setSaid(errorWords(e));
    } finally {
      setSaving(null);
    }
  };
  return (
    <article className="ev-answer" aria-label="Saved answer" data-answer={answer.answer_id} data-state={answer.state}>
      <header className="ev-answer-head">
        <h2 className="ev-title">{MODE_WORDS[answer.mode] ?? answer.mode}</h2>
        <span className={`ev-state ev-state-${answer.state}`}>{STATE_WORDS[answer.state] ?? answer.state}</span>
        <span className="record-cap">{CLEANUP_WORDS[answer.cleanup_state] ?? answer.cleanup_state}</span>
      </header>
      <p className="ev-instruction">{answer.request.payload.instruction}</p>
      <p className="record-cap">Asked of {requestedWords(answer.request.payload.requested)}. {reportedWords(answer.reports)} {usageWords(answer.usage)}</p>
      {answer.error_message && <p className="field-error" role="alert">{answer.error_message}</p>}
      {answer.result
        ? (
          <>
            <p className="form-hint">Every citation below is the selected text at its exact range. Whether a quote supports what it is attached to is not checked.</p>
            {answer.result.sections.map((section, si) => (
              <section key={si} className="ev-answer-section">
                <h3 className="record-sub">{SECTION_WORDS[section.kind] ?? section.kind}</h3>
                {section.items.map((item, ii) => (
                  <div key={ii} className="ev-answer-item">
                    <p className="record-cap">{ITEM_WORDS[item.kind] ?? item.kind}</p>
                    <p className="ev-answer-text">{item.text}</p>
                    {item.note_ids.length > 0 && <p className="record-cap">From {count(item.note_ids.length, 'note')} of yours, not from a document.</p>}
                    {item.citations.length > 0 && (
                      <div className="ev-cites">
                        {item.citations.map((c, ci) => {
                          const source = sources.find((s) => s.source_id === c.source_id)!;
                          const key = `${si}-${ii}-${ci}`;
                          return (
                            <button key={key} type="button" className="ev-cite" aria-pressed={cited?.key === key}
                              onClick={() => setCited({ source, citation: c, key })}>{citationLabel(source)}</button>
                          );
                        })}
                      </div>
                    )}
                  </div>
                ))}
              </section>
            ))}
            {answer.result.limitations.length > 0 && (
              <section className="ev-answer-section">
                <h3 className="record-sub">What the answer says it could not do</h3>
                <ul>{answer.result.limitations.map((l, i) => <li key={i}>{l}</li>)}</ul>
              </section>
            )}
          </>
        )
        : (
          <section className="ev-unvalidated" data-answer="unvalidated" aria-label="Unvalidated output">
            <h3 className="record-sub">Unvalidated output</h3>
            <p className="form-hint">
              {terminal(answer.state)
                ? 'Nothing here was accepted as an answer, so none of it is shown as cited.'
                : 'The answer is still arriving. Nothing is shown as cited until it is complete and checked.'}
            </p>
            <pre>{answer.partial_text || 'Nothing was received.'}</pre>
          </section>
        )}
      {cited && <CitationCheck key={cited.key} project={project} source={cited.source} citation={cited.citation} />}
      <details className="ev-sent">
        <summary>What was sent: {count(sources.length, 'excerpt')} and {count(answer.request.payload.notes.length, 'note')}</summary>
        {sources.map((s) => (
          <section key={s.source_id} className="ev-source"><h4>{citationLabel(s)}</h4><pre>{s.text}</pre></section>
        ))}
        {answer.request.payload.notes.map((n) => (
          <section key={n.note_id} className="ev-source"><h4>Your note · revision {n.revision}</h4><pre>{n.body}</pre></section>
        ))}
      </details>
      <p className="record-cap">Answer <code className="path">{answer.answer_id}</code> · request SHA-256 <code className="path">{answer.request_sha256}</code></p>
      <p className="record-cap">{answer.limitations}</p>
      <div className="lib-actions">
        <button type="button" className="btn sm" disabled={!!saving || !terminal(answer.state)} onClick={() => void save('html')}>Save as HTML</button>
        <button type="button" className="btn sm" disabled={!!saving || !terminal(answer.state)} onClick={() => void save('zip')}>Save as ZIP</button>
      </div>
      {said && <p className="settings-said" role="status" data-answer="saved">{said}</p>}
    </article>
  );
}

/**
 * One citation: the quote exactly as the answer saved it, then the current
 * file's page, read again and checked against the same version, extraction
 * contract, hash and range. If the file the library holds now is another
 * version, nothing else is read in its place.
 */
function CitationCheck({ project, source, citation }: { project: Project; source: Source; citation: Citation }) {
  const current = useQuery({
    queryKey: ['library-file', project.vault_id, source.file_id],
    queryFn: () => answered(engine().GET('/api/library/files/{file_id}', {
      ...LIBRARY, params: { path: { file_id: source.file_id }, query: { expected_vault_id: project.vault_id } },
    })),
  });
  const file = current.data?.file;
  const same = !!file && file.version_id === source.version_id && file.sha256 === source.sha256;
  const record: FileRecord | null = same && file ? file : null;
  const pin = useMemo<Pin>(() => ({
    kind: 'citation', file_id: source.file_id, version_id: source.version_id, sha256: source.sha256, page_number: source.page_number,
    extraction_contract: source.extraction_contract, page_text_sha256: source.page_text_sha256,
    start_codepoint: citation.start_codepoint, end_codepoint: citation.end_codepoint, quote: citation.quote,
  }), [source, citation]);
  return (
    <section className="ev-citation" aria-label="Saved citation">
      <h3 className="record-sub">Frozen quote · {source.source_id}</h3>
      <pre className="ev-quote">{citedText([source], citation) ?? citation.quote}</pre>
      <p className="form-hint">This is the text exactly as the answer was given it. The page below is the current file, read again now.</p>
      {current.isError && <p className="field-error" role="alert">{errorWords(current.error)}</p>}
      {file && !same && (
        <p className="field-error" role="alert">
          The library now holds another version of {source.original_name}, so this citation cannot be checked against it. No other version is read in its place.
        </p>
      )}
      {record && <Reader project={project} file={record} member pin={pin} readOnly />}
    </section>
  );
}
