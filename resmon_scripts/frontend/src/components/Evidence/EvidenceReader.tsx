import React,{useEffect,useRef,useState} from 'react';
import {Anchor,evidenceApi,EvidenceFile,Project,SavedNote,TextPage} from '../../api/evidence';
import PdfPage from './PdfPage';

export function selectionAnchor(text:TextPage,start:number,end:number):Anchor|null {
  if(text.status!=='extracted'||!text.page_text_sha256||start<0||end<=start||end>text.text.length)return null;
  const quote=text.text.slice(start,end);const prefix=text.text.slice(0,start);
  if(/[\uD800-\uDFFF]/u.test(quote+prefix)||Array.from(quote).length>20000)return null;
  return {page_number:text.page_number,extraction_contract:text.extraction_contract,page_text_sha256:text.page_text_sha256,start_codepoint:Array.from(prefix).length,end_codepoint:Array.from(text.text.slice(0,end)).length,quote};
}
export function resolveSaved(note:SavedNote,text:TextPage):boolean {
  return note.kind==='passage'&&note.file_id===text.file_id&&note.version_id===text.version_id&&note.file.sha256===text.sha256&&note.page_number===text.page_number&&note.extraction_contract===text.extraction_contract&&note.page_text_sha256===text.page_text_sha256&&Array.from(text.text).slice(note.start_codepoint??0,note.end_codepoint??0).join('')===note.quote;
}
export default function EvidenceReader({project,file,reopen,onPassage,canSave}:{project:Project;file:EvidenceFile;reopen:SavedNote|null;onPassage:(anchor:Anchor)=>void;canSave:boolean}){
  const [page,setPage]=useState(reopen?.page_number??1);const [text,setText]=useState<TextPage|null>(null);const [error,setError]=useState('');const [busy,setBusy]=useState(false);const [anchor,setAnchor]=useState<Anchor|null>(null);const [query,setQuery]=useState('');const [findStatus,setFindStatus]=useState('');const [resolution,setResolution]=useState('');const [reload,setReload]=useState(0);
  const pane=useRef<HTMLTextAreaElement>(null);const abort=useRef<AbortController|null>(null);
  useEffect(()=>{if(reopen?.page_number)setPage(reopen.page_number);},[reopen?.note_id]);
  useEffect(()=>{
    const controller=new AbortController();abort.current=controller;let live=true;setBusy(true);setText(null);setError('');setAnchor(null);setFindStatus('');setResolution('');
    void evidenceApi.text(project,file,page,controller.signal).then(value=>{if(live&&!controller.signal.aborted){setText(value);if(value.status!=='extracted')setError(`Canonical page text: ${value.status.replace(/_/g,' ')}. Saved records remain available.`);}},reason=>{if(live&&!controller.signal.aborted)setError(reason instanceof Error?reason.message:'Selected page unavailable.');}).finally(()=>{if(live&&!controller.signal.aborted)setBusy(false);});
    return()=>{live=false;controller.abort();};
  },[project.vault_id,project.project_id,file.file_id,file.version_id,file.sha256,page,reload]);
  useEffect(()=>{
    if(!reopen||reopen.kind!=='passage')return;
    if(!text){setResolution('Saved passage is unresolved until this exact page is checked.');return;}
    if(resolveSaved(reopen,text)){
      setResolution('Saved passage resolved against this exact version, extraction contract, text hash and codepoint range.');
      const chars=Array.from(text.text);const start=chars.slice(0,reopen.start_codepoint??0).join('').length;const end=chars.slice(0,reopen.end_codepoint??0).join('').length;
      pane.current?.focus();pane.current?.setSelectionRange(start,end);
    }else setResolution('Saved passage unresolved: this page, text hash or extraction contract does not match. The saved quote is unchanged.');
  },[reopen,text]);
  const choose=()=>{const el=pane.current;if(text&&el)setAnchor(selectionAnchor(text,el.selectionStart,el.selectionEnd));};
  const find=()=>{
    if(!text||!query)return;const from=pane.current?.selectionEnd??0;let index=text.text.indexOf(query,from);if(index<0)index=text.text.indexOf(query);
    if(index<0){setFindStatus('No literal match on this canonical page.');return;}
    pane.current?.focus();pane.current?.setSelectionRange(index,index+query.length);setAnchor(selectionAnchor(text,index,index+query.length));
    let count=0,at=0;while((at=text.text.indexOf(query,at))>=0){count++;at+=Math.max(1,query.length);}setFindStatus(`${count} literal matches on this canonical page only.`);
  };
  return <section className="evidence-reader" aria-label="Evidence reader">
    <h2>{file.original_name}</h2><p className="evidence-identity">File {file.file_id} · version {file.version_id}<br/>SHA256 {file.sha256}</p>
    <div className="evidence-toolbar"><button disabled={page<=1||busy} onClick={()=>setPage(p=>p-1)}>Previous page</button><label>Page<input type="number" min={1} max={text?.page_count??200} value={page} disabled={busy||file.media_type!=='application/pdf'} onChange={e=>{const n=Number(e.target.value);if(Number.isInteger(n)&&n>=1&&n<=200)setPage(n);}}/></label><button disabled={busy||file.media_type!=='application/pdf'||page>=(text?.page_count??1)} onClick={()=>setPage(p=>p+1)}>Next page</button><button disabled={busy} onClick={()=>setReload(n=>n+1)}>Recheck page</button>{busy&&<button onClick={()=>{abort.current?.abort();setBusy(false);setError('Canonical page request cancelled.');}}>Cancel page read</button>}</div>
    {busy&&<p role="status">Reading this exact retained page…</p>}{error&&<p role="alert">{error}</p>}
    {file.media_type==='application/pdf'&&<PdfPage project={project} file={file} page={page}/>}
    <h3>Canonical text · {file.media_type==='application/pdf'?'physical':'logical'} page {page}</h3>
    <p>{text?`${text.examined_pages.length} of ${text.page_count??'unknown'} pages examined by text extraction. Other pages: not examined.`:'This page has not yet been examined.'} Tables, equations, columns and images may be omitted or reshaped. No OCR.</p>
    {text?.status==='extracted'&&<><form className="evidence-toolbar" onSubmit={e=>{e.preventDefault();find();}}><label>Find on current canonical page<input value={query} maxLength={200} onChange={e=>setQuery(e.target.value)}/></label><button disabled={!query}>Find next literal match</button></form>{findStatus&&<p role="status">{findStatus}</p>}
      <textarea ref={pane} className="evidence-canonical" aria-label="Canonical page text" readOnly value={text.text} onSelect={choose} onKeyUp={choose} rows={12}/>
      <button disabled={!anchor||!canSave} onClick={()=>{if(anchor)onPassage(anchor);}}>Use selected passage</button><p>{anchor?`${anchor.end_codepoint-anchor.start_codepoint} Unicode codepoints selected. The server checks this exact quote before saving.`:'Select up to 20,000 codepoints in the canonical text pane.'}</p>
    </>}
    {resolution&&<p role="status" className="evidence-resolution">{resolution}</p>}
  </section>;
}
