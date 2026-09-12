import React,{useEffect,useId,useRef,useState} from 'react';
import {Anchor,evidenceApi,EvidenceFile,Page,Project,SavedNote} from '../../api/evidence';
export default function NotePanel({project,file,anchor,notes,member,onSaved,onClear,onReopen,onNext}:{project:Project;file:EvidenceFile|null;anchor:Anchor|null;notes:Page<SavedNote>|null;member:boolean;onSaved:(p:Project,n:SavedNote)=>Promise<void>;onClear:()=>void;onReopen:(n:SavedNote)=>void;onNext:()=>void}){
  const [body,setBody]=useState('');const [editing,setEditing]=useState<SavedNote|null>(null);const [busy,setBusy]=useState(false);const [error,setError]=useState('');const [notice,setNotice]=useState('');const epoch=useRef(0);const input=useRef<HTMLTextAreaElement>(null);
  const saving=useRef(false);const draft=useRef(0);const bodyId=useId();const currentEditing=notes?.items.find(n=>n.note_id===editing?.note_id);const newerEditing=currentEditing&&editing&&currentEditing.revision!==editing.revision?currentEditing:null;
  useEffect(()=>()=>{++epoch.current;},[]);
  useEffect(()=>{setEditing(null);setBody('');setError('');setNotice('');++epoch.current;setBusy(false);},[file?.file_id,file?.version_id]);
  useEffect(()=>{if(editing)input.current?.focus();},[editing?.note_id]);
  useEffect(()=>{++draft.current;if(anchor){setEditing(null);input.current?.focus();}},[anchor]);
  const save=async()=>{
    if(saving.current||(!file&&!editing))return;saving.current=true;const ticket=++epoch.current;const submittedDraft=draft.current;setBusy(true);setError('');setNotice('');
    try{const result=editing?await evidenceApi.edit(project,editing,body):await evidenceApi.save(project,file!,body,anchor??undefined);if(ticket!==epoch.current)return;
      await onSaved(result.project,result.note);if(ticket!==epoch.current)return;
      // The request saved its submitted snapshot. A later body or passage choice
      // belongs to the user, including changes during the project refresh.
      if(draft.current!==submittedDraft){setNotice('Saved the submitted record. Newer unsaved changes remain in the editor.');return;}
      setBody('');setEditing(null);onClear();setNotice('Saved this exact evidence record.');
    }catch(reason){if(ticket===epoch.current)setError(`${reason instanceof Error?reason.message:'Save refused.'} Your unsaved text remains here. Use Refresh project to load its current revision before explicitly retrying. For a changed saved body, review its current record and choose Keep draft against current revision first.`);}
    finally{saving.current=false;if(ticket===epoch.current)setBusy(false);}
  };
  return <section className="evidence-notes" aria-label="Saved evidence notes"><h2>Notes and passages</h2>
    <p>Plain text only. Removing a file from a collection keeps its saved records. Editing changes the body; passage anchors remain fixed.</p>
    {(file||editing)&&<form onSubmit={e=>{e.preventDefault();void save();}}>
      <h3>{editing?`Edit saved body · ${editing.file.original_name}`:anchor?'New exact passage':'New plain note'}</h3>
      {editing&&<p className="evidence-identity">Note {editing.note_id} · version {editing.version_id}{editing.page_number?` · page ${editing.page_number}`:''}</p>}
      {editing?.quote&&<blockquote className="evidence-literal">{editing.quote}</blockquote>}
      {anchor&&!editing&&<p className="evidence-identity">{file?.original_name} · version {file?.version_id} · page {anchor.page_number}</p>}
      {anchor&&!editing&&<blockquote className="evidence-literal">{anchor.quote}</blockquote>}
      <label htmlFor={bodyId}>Note body</label><textarea id={bodyId} ref={input} value={body} rows={5} onChange={e=>{++draft.current;setBody(e.target.value);}} maxLength={40000}/>
      {newerEditing&&<div role="status"><p>The saved body changed. Review the current record below. Your next save will replace that body with this draft.</p><button type="button" disabled={busy} onClick={()=>{setEditing(newerEditing);setError('');input.current?.focus();}}>Keep draft against current revision</button></div>}
      <p>{Array.from(body).length} of 20,000 codepoints</p>
      <div className="evidence-toolbar"><button disabled={busy||(!editing&&!member)||Array.from(body).length>20000||(!(anchor||editing?.kind==='passage')&&!body.length)}>Save {editing?'body':anchor?'passage':'note'}</button><button type="button" disabled={busy} onClick={()=>{setEditing(null);onClear();setError('');input.current?.focus();}}>Use plain note</button></div>
      {!member&&!editing&&<p role="status">File removed from this collection. Re-add this exact Library identity before creating a new note.</p>}
    </form>}
    {error&&<p role="alert">{error}</p>}{notice&&<p role="status">{notice}</p>}
    {notes?.items.map(n=><article className="evidence-saved-note" key={n.note_id}><h3>{n.file.original_name} · {n.kind}{n.page_number?` · page ${n.page_number}`:''}</h3>
      <p>{n.membership_state==='removed'?'File removed from this collection.':'Current collection member.'} Saved record; source resolution has not been checked.</p>
      {n.quote!==null&&<blockquote className="evidence-literal">{n.quote}</blockquote>}<p className="evidence-literal">{n.body}</p>
      <p className="evidence-identity">Note {n.note_id} · revision {n.revision}<br/>Version {n.version_id}</p>
      <div className="evidence-toolbar"><button disabled={busy} onClick={()=>onReopen(n)}>Reopen saved {n.kind}</button><button disabled={busy} onClick={()=>{setEditing(n);setBody(n.body);onClear();setError('');input.current?.focus();}}>Edit saved body</button></div>
    </article>)}
    {notes&&<p>{notes.items.length} shown of {notes.total} saved records at ID ceiling {notes.through_id}. {notes.count_basis}.</p>}
    {notes?.has_more&&<button disabled={busy} onClick={onNext}>Next saved notes</button>}
  </section>;
}
