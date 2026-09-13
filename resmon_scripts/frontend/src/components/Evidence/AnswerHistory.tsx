import React,{useEffect,useRef,useState} from 'react';
import {Page,Project} from '../../api/evidence';
import {AnswerSummary,selectedApi} from '../../api/selectedEvidence';
export default function AnswerHistory({project,refresh,onOpen,disabled}:{project:Project;refresh:number;onOpen:(id:string)=>void;disabled:boolean}){
  const [page,setPage]=useState<Page<AnswerSummary>|null>(null),[error,setError]=useState(''),[busy,setBusy]=useState(false);const generation=useRef(0),abort=useRef<AbortController|null>(null);
  const load=async(through?:number,after?:number)=>{const ticket=++generation.current;abort.current?.abort();const controller=new AbortController();abort.current=controller;setBusy(true);setError('');
    try{const result=await selectedApi.history(project,through,after,controller.signal);if(ticket===generation.current)setPage(result);}catch(e){if(ticket===generation.current&&!controller.signal.aborted)setError(e instanceof Error?e.message:'Answer history unavailable.');}finally{if(ticket===generation.current)setBusy(false);}
  };
  useEffect(()=>{void load();return()=>{++generation.current;abort.current?.abort();};},[project.project_id,project.vault_id,refresh]);
  return <section aria-label="Saved answer history" className="selected-history"><div className="evidence-toolbar"><h3>Saved answers</h3><button disabled={busy} onClick={()=>void load()}>Refresh answers</button></div><p>Opening a saved answer reads its stored excerpts and last durable state. It does not call a model or read the original files.</p>{error&&<p role="alert">{error}</p>}{busy&&<p role="status">Loading saved answers…</p>}
    {page?.items.map(a=><button className="evidence-item" key={a.answer_id} disabled={disabled} onClick={()=>onOpen(a.answer_id)}><strong>{a.mode==='briefing'?'Manual briefing':'Question'} · {a.state}</strong><span>{a.created_at_utc}</span><span className="evidence-identity">{a.answer_id}</span></button>)}
    {page&&<p>{page.items.length} shown of {page.total} saved answers at ID ceiling {page.through_id}.</p>}{page?.has_more&&<button disabled={busy} onClick={()=>void load(page.through_id,page.next_after_id??undefined)}>Next saved answers</button>}
  </section>;
}
