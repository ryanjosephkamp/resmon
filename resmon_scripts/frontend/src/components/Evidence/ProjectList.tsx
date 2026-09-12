import React,{useEffect,useState} from 'react';
import {Page,Project} from '../../api/evidence';
export default function ProjectList({page,selected,busy,selectDisabled=false,onSelect,onCreate,onRename,onNext}:{page:Page<Project>|null;selected:Project|null;busy:boolean;selectDisabled?:boolean;onSelect:(p:Project)=>void;onCreate:(name:string)=>Promise<void>;onRename:(name:string)=>Promise<void>;onNext:()=>void}){
  const [name,setName]=useState('');const [rename,setRename]=useState('');
  useEffect(()=>{setRename(selected?.name??'');},[selected?.project_id,selected?.name]);
  return <section className="evidence-projects" aria-label="Project collections"><h2>Project collections</h2>
    <form onSubmit={e=>{e.preventDefault();void onCreate(name).then(()=>setName('')).catch(()=>{});}} className="evidence-toolbar"><label>New project name<input value={name} onChange={e=>setName(e.target.value)} maxLength={240}/></label><button disabled={busy||!name.trim()||Array.from(name.trim()).length>120}>Create project</button></form>
    {page?.items.map(p=><button className="evidence-item" key={p.project_id} aria-pressed={selected?.project_id===p.project_id} onClick={()=>onSelect(p)} disabled={selectDisabled}><strong>{p.name}</strong><span>{p.file_count} current files · {p.note_count} saved notes</span></button>)}
    {page&&<p>{page.items.length} shown of {page.total} projects at ID ceiling {page.through_id}. {page.count_basis}.</p>}
    {page?.has_more&&<button disabled={busy} onClick={onNext}>Next projects</button>}
    {selected&&<form className="evidence-toolbar" onSubmit={e=>{e.preventDefault();void onRename(rename).catch(()=>{});}}><label>Rename selected project<input value={rename} onChange={e=>setRename(e.target.value)} maxLength={240}/></label><button disabled={busy||!rename.trim()||Array.from(rename.trim()).length>120}>Rename project</button></form>}
  </section>;
}
