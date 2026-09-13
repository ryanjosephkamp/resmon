import React,{useEffect,useRef,useState} from 'react';
import {Anchor,EvidenceFile,Member,Page,Project,SavedNote} from '../../api/evidence';
import {ChoiceRequest,ChoicesDescriptor,ComposerChoices} from '../Assistant/ComposerChoices';
import {Preview,SelectedNote,Selection,selectedApi} from '../../api/selectedEvidence';

export default function SelectionDialog({project,files,notes,file,anchor,runtime,descriptor,onNextFiles,onNextNotes,onClose,onSend}:{project:Project;files:Page<Member>|null;notes:Page<SavedNote>|null;file:EvidenceFile|null;anchor:Anchor|null;runtime:string;descriptor:ChoicesDescriptor;onNextFiles:()=>void;onNextNotes:()=>void;onClose:()=>void;onSend:(p:Preview)=>Promise<void>}){
  const [selections,setSelections]=useState<Selection[]>([]),[selectedNotes,setSelectedNotes]=useState<SelectedNote[]>([]);
  const [pageNumbers,setPageNumbers]=useState<Record<string,string>>({}),[labels,setLabels]=useState<Record<string,string>>({});
  const [mode,setMode]=useState<'question'|'briefing'>('question'),[instruction,setInstruction]=useState(''),[choice,setChoice]=useState<ChoiceRequest|null>(descriptor.default_request);
  const [preview,setPreview]=useState<Preview|null>(null),[busy,setBusy]=useState(false),[error,setError]=useState('');
  const dialog=useRef<HTMLElement>(null),ticket=useRef(0),abort=useRef<AbortController|null>(null),alive=useRef(true);
  useEffect(()=>{alive.current=true;const previous=document.activeElement as HTMLElement|null;dialog.current?.focus();return()=>{alive.current=false;++ticket.current;abort.current?.abort();previous?.focus();};},[]);
  const invalidate=()=>{++ticket.current;abort.current?.abort();setPreview(null);setBusy(false);setError('');};
  const add=(f:EvidenceFile,a?:Anchor)=>{
    invalidate();const n=a?.page_number??(f.media_type==='application/pdf'?Number(pageNumbers[f.file_id]):1);
    if(!Number.isInteger(n)||n<1||n>200){setError('Enter an explicit physical PDF page from 1 to 200.');return;}
    const next:Selection={file_id:f.file_id,version_id:f.version_id,sha256:f.sha256,page_number:n,range:a?{start_codepoint:a.start_codepoint,end_codepoint:a.end_codepoint,quote:a.quote,page_text_sha256:a.page_text_sha256,extraction_contract:a.extraction_contract}:null};
    setSelections(prior=>prior.some(x=>JSON.stringify(x)===JSON.stringify(next))?prior:[...prior,next]);setLabels(prior=>({...prior,[f.file_id]:f.original_name}));
  };
  const prepare=async()=>{if(!choice)return;invalidate();const generation=ticket.current;const controller=new AbortController();abort.current=controller;setBusy(true);dialog.current?.focus();
    try{const p=await selectedApi.preview(project,runtime,selections,selectedNotes,mode,instruction,choice,controller.signal);if(alive.current&&generation===ticket.current)setPreview(p);}
    catch(e){if(alive.current&&generation===ticket.current)setError(e instanceof Error?e.message:'Preview refused.');}
    finally{if(alive.current&&generation===ticket.current)setBusy(false);}
  };
  const send=async()=>{if(!preview)return;const current=preview;const generation=++ticket.current;setBusy(true);setError('');dialog.current?.focus();try{await onSend(current);}catch(e){if(alive.current&&generation===ticket.current){setError(e instanceof Error?e.message:'Send refused.');setBusy(false);}}};
  return <section className="selected-dialog" role="dialog" aria-modal="true" aria-label="Select evidence for an answer" tabIndex={-1} ref={dialog} onKeyDown={e=>{
    if(e.key==='Escape'){e.preventDefault();onClose();}
    if(e.key==='Tab'){const targets=Array.from(dialog.current?.querySelectorAll<HTMLElement>('button:not(:disabled),input:not(:disabled),select:not(:disabled),textarea:not(:disabled),summary,[tabindex="0"]')??[]).filter(x=>x.getClientRects().length);const first=targets[0],last=targets[targets.length-1];if(e.shiftKey&&(document.activeElement===first||document.activeElement===dialog.current)){e.preventDefault();last?.focus();}else if(!e.shiftKey&&document.activeElement===last){e.preventDefault();first?.focus();}}
  }}>
    <div className="evidence-toolbar"><h2>Selected-evidence answer</h2><button onClick={onClose}>Close selection</button></div>
    <p>Select exact pages or passages. Nothing is sent until you inspect a preview and press Send. Up to 5 files, 12 pages, 24 segments and 8 optional notes.</p>
    <fieldset disabled={busy}><legend>Explicit source selection</legend>
      {files?.items.map(m=><div className="selected-file" key={m.file_id}><span>{m.file.original_name}</span><small>Version {m.version_id}</small>{m.file.media_type==='application/pdf'&&<label>Physical page for {m.file.original_name}<input type="number" min={1} max={200} value={pageNumbers[m.file_id]??''} onChange={e=>{invalidate();setPageNumbers(p=>({...p,[m.file_id]:e.target.value}));}}/></label>}<button onClick={()=>add(m.file)}>Add {m.file.original_name} {m.file.media_type==='application/pdf'?'page':'logical page 1'}</button></div>)}
      {files?.has_more&&<button onClick={onNextFiles}>Next selectable files</button>}
      {file&&anchor&&<button onClick={()=>add(file,anchor)}>Add current reader passage</button>}
      <ol>{selections.map((s,i)=><li key={`${s.file_id}/${s.page_number}/${i}`}><strong>{labels[s.file_id]}</strong> · page {s.page_number} · {s.range?`codepoints ${s.range.start_codepoint}–${s.range.end_codepoint}`:'complete canonical page text'}{s.range&&<pre>{s.range.quote}</pre>}<button aria-label={`Remove selection ${i+1}`} onClick={()=>{invalidate();setSelections(prior=>prior.filter((_,index)=>index!==i));setSelectedNotes([]);}}>Remove selection {i+1}</button></li>)}</ol>
    </fieldset>
    <fieldset disabled={busy}><legend>Optional saved note bodies — none selected by default</legend><p>A selected passage quote does not include its note body. Notes are local commentary, not document evidence.</p>
      {notes?.items.filter(n=>n.membership_state==='member'&&selections.some(s=>s.file_id===n.file_id&&s.version_id===n.version_id)).map(n=><label className="selected-note" key={n.note_id}><input type="checkbox" checked={selectedNotes.some(x=>x.note_id===n.note_id)} onChange={e=>{invalidate();setSelectedNotes(prior=>e.target.checked?[...prior,{note_id:n.note_id,expected_note_revision:n.revision}]:prior.filter(x=>x.note_id!==n.note_id));}}/>Include note body: {n.body||'(empty passage commentary)'}<small>{n.file.original_name} · note {n.note_id} · revision {n.revision}</small></label>)}
      {notes?.has_more&&<button onClick={onNextNotes}>Next selectable notes</button>}
    </fieldset>
    <label>Answer format<select value={mode} disabled={busy} onChange={e=>{invalidate();setMode(e.target.value as 'question'|'briefing');}}><option value="question">Question</option><option value="briefing">Manual structured briefing</option></select></label>
    <label>Question or briefing instruction<textarea value={instruction} rows={4} disabled={busy} onChange={e=>{invalidate();setInstruction(e.target.value);}}/></label><p>{Array.from(instruction).length} of 4,000 codepoints.</p>
    <ComposerChoices descriptor={descriptor} value={choice} onChange={c=>{invalidate();setChoice(c);}} disabled={busy} legend="Choices for this selected answer" idPrefix="selected-evidence"/>
    <button disabled={busy||!choice||!instruction.trim()||!selections.length} onClick={()=>void prepare()}>Preview selected content</button>
    {busy&&<p role="status">Checking the exact selection…</p>}{error&&<p role="alert">{error}</p>}
    {preview&&<section className="selected-preview" aria-label="Exact disclosure preview"><h3>Inspect before Send</h3><p><strong>Destination:</strong> {preview.request.payload.requested.provider}{preview.request.payload.disclosure.custom_endpoint?' · configured custom endpoint':''} · requested model {preview.request.payload.requested.requested_model??'CLI default (unknown)'} · effort {preview.request.payload.requested.requested_effort??(preview.request.payload.requested.runtime==='api_key'?'not supported':'CLI default (unknown)')}</p>
      <p>{preview.request.payload.coverage.file_count} files · {preview.request.payload.coverage.page_count} selected/anchor-checked pages · {preview.request.payload.coverage.segment_count} segments · {preview.request.payload.coverage.source_bytes} source bytes · {preview.request.payload.coverage.note_count} notes / {preview.request.payload.coverage.note_bytes} note bytes.</p>
      {preview.request.payload.coverage.files.map(f=><p key={f.file_id}>Version {f.version_id}: selected pages {f.selected_pages.join(', ')} of {f.known_page_count??'unknown'}. {f.unexamined_page_count??'Unknown'} pages unexamined.</p>)}
      <p>Digest verification reads each selected file’s bytes; PDF parsing examines its structure to reach the chosen page. This does not extract or understand every page.</p>
      <p>{preview.request.payload.disclosure.source_strings_may_contain_private_material}</p>
      {preview.request.payload.sources.map(s=><article key={s.source_id}><h4>{s.source_id} · {s.original_name} · page {s.page_number}</h4><p className="evidence-identity">Version {s.version_id} · codepoints {s.start_codepoint}–{s.end_codepoint} · source SHA256 {s.source_sha256}</p><pre>{s.text}</pre></article>)}
      {preview.request.payload.notes.map(n=><article key={n.note_id}><h4>Owner note · {n.note_id}</h4><p>Saved local note, revision {n.revision}; authorship is not established.</p><pre>{n.body}</pre></article>)}
      <details><summary>Exact application system instructions</summary><pre>{preview.request.system_text}</pre></details><details><summary>Exact application user payload</summary><pre>{preview.request.user_prompt}</pre></details>
      <p className="evidence-identity">Request SHA256 {preview.request_sha256}<br/>Expires {preview.expires_at_utc}</p><p>{preview.request.payload.disclosure.limitations}</p>
      <p>One new answer, with tools off and no earlier conversation. Local maximum 300 seconds; a stopped remote request may still incur provider work or charges.</p>
      <div className="evidence-toolbar"><button disabled={busy} onClick={()=>void send()}>Send selected evidence</button><button disabled={busy} onClick={()=>{invalidate();dialog.current?.focus();}}>Close preview without sending</button></div>
    </section>}
  </section>;
}
