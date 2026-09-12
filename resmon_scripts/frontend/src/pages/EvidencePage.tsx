import React,{useEffect,useRef,useState} from 'react';
import {Anchor,evidenceApi,evidenceBaseUrl,EvidenceFile,Member,Page,Project,SavedNote} from '../api/evidence';
import {libraryApi,LibraryPage,uuid} from '../api/library';
import ProjectList from '../components/Evidence/ProjectList';
import EvidenceReader from '../components/Evidence/EvidenceReader';
import NotePanel from '../components/Evidence/NotePanel';
import BundleDialog from '../components/Evidence/BundleDialog';
import PageHelp from '../components/Help/PageHelp';

export default function EvidencePage(){
  const [vault,setVault]=useState<string|null>(null);const [projects,setProjects]=useState<Page<Project>|null>(null);const [project,setProject]=useState<Project|null>(null);const [files,setFiles]=useState<Page<Member>|null>(null);const [notes,setNotes]=useState<Page<SavedNote>|null>(null);
  const [file,setFile]=useState<EvidenceFile|null>(null);const [member,setMember]=useState(false);const [reopen,setReopen]=useState<SavedNote|null>(null);const [anchor,setAnchor]=useState<Anchor|null>(null);
  const [catalog,setCatalog]=useState<LibraryPage|null>(null);const [choosing,setChoosing]=useState(false);const [search,setSearch]=useState('');const [handoff,setHandoff]=useState<EvidenceFile|null>(null);const [bundle,setBundle]=useState(false);
  const [busy,setBusy]=useState(false);const [writing,setWriting]=useState(false);const [error,setError]=useState('');const [notice,setNotice]=useState('');const epoch=useRef(0);const catalogEpoch=useRef(0);const alive=useRef(true);const abort=useRef<AbortController|null>(null);
  const selectionEpoch=useRef(0);const selectedFile=useRef<EvidenceFile|null>(null);
  const selection=(f:EvidenceFile|null,isMember=false,n:SavedNote|null=null)=>{++selectionEpoch.current;selectedFile.current=f;setBundle(false);setFile(f);setMember(isMember);setReopen(n);setAnchor(null);};
  const showError=(reason:unknown)=>setError(reason instanceof Error?reason.message:'Evidence request refused.');
  const loadProject=async(p:Project,reset=true)=>{
    const ticket=++epoch.current;abort.current?.abort();const controller=new AbortController();abort.current=controller;setBusy(true);setError('');setBundle(false);
    if(reset){selection(null);setNotes(null);setFiles(null);}setProject(p);const selectedTicket=selectionEpoch.current;const activeFile=selectedFile.current;
    try{
      const current=await evidenceApi.detail(p.vault_id,p.project_id,controller.signal);
      const [nextFiles,nextNotes]=await Promise.all([evidenceApi.files(current,undefined,undefined,controller.signal),evidenceApi.notes(current,undefined,undefined,controller.signal)]);
      if(!alive.current||epoch.current!==ticket)return;
      // Lists may observe a concurrent writer. Do not silently adopt mixed revisions.
      if(nextFiles.revision!==current.revision||nextNotes.revision!==current.revision)throw new Error('Project changed during refresh. Refresh explicitly to load one current revision.');
      let selectedMember:boolean|null=null;
      if(!reset&&activeFile){
        let members=nextFiles;
        // Absence from the first 50 rows cannot establish removal. Resolve only
        // the selected pair over this fixed ceiling, at most 1,000 memberships.
        for(let pageNumber=0;pageNumber<20;pageNumber++){
          if(selectedTicket!==selectionEpoch.current)break;
          if(members.items.some(x=>x.file_id===activeFile.file_id&&x.version_id===activeFile.version_id)){selectedMember=true;break;}
          if(!members.has_more){selectedMember=false;break;}
          if(pageNumber===19||members.next_after_id===null)throw new Error('Membership refresh exceeded its bounded pages. Refresh explicitly.');
          members=await evidenceApi.files(current,nextFiles.through_id,members.next_after_id,controller.signal);
          if(members.revision!==current.revision)throw new Error('Project changed during membership refresh. Refresh explicitly to load one current revision.');
        }
      }
      if(!alive.current||epoch.current!==ticket)return;
      setProject(current);setFiles(nextFiles);setNotes(nextNotes);
      setProjects(prior=>prior?{...prior,items:prior.items.map(x=>x.project_id===current.project_id?current:x)}:prior);
      if(selectedMember!==null&&selectedTicket===selectionEpoch.current)setMember(selectedMember);
    }catch(reason){if(alive.current&&epoch.current===ticket)showError(reason);}finally{if(alive.current&&epoch.current===ticket)setBusy(false);}
  };
  useEffect(()=>{
    alive.current=true;const ticket=++epoch.current;setBusy(true);
    void(async()=>{try{
      evidenceBaseUrl();
      const status=await libraryApi.status();if(!alive.current||epoch.current!==ticket)return;setVault(status.vault?.vault_id??null);
      if(!status.vault)return;const id=status.vault.vault_id;
      const page=await evidenceApi.projects(id);if(!alive.current||epoch.current!==ticket)return;setProjects(page);
      const q=new URLSearchParams(window.location.hash.split('?')[1]??'');
      if(q.has('file_id')||q.has('version_id')||q.has('vault_id')){
        if(q.get('vault_id')!==id||!uuid(q.get('file_id'))||!uuid(q.get('version_id')))throw new Error('Library handoff has a missing or mismatched exact identity. Return to Library and select the item explicitly.');
        const candidate=await libraryApi.detail(id,q.get('file_id')!);if(!alive.current||epoch.current!==ticket)return;
        if(candidate.version_id!==q.get('version_id'))throw new Error('Library handoff version changed. No latest-version fallback was applied.');setHandoff(candidate);
      }
      if(q.has('project_id')){const projectId=q.get('project_id');if(!uuid(projectId))throw new Error('Invalid project handoff.');const target=await evidenceApi.detail(id,projectId);if(alive.current&&epoch.current===ticket)await loadProject(target);}
    }catch(reason){if(alive.current&&epoch.current===ticket)showError(reason);}finally{if(alive.current&&epoch.current===ticket)setBusy(false);}})();
    return()=>{alive.current=false;++epoch.current;++catalogEpoch.current;abort.current?.abort();};
  },[]);
  const act=async(operation:()=>Promise<Project>,success:string,selected?:EvidenceFile)=>{
    const ticket=++epoch.current;const selectedTicket=selectionEpoch.current;setBusy(true);setWriting(true);setError('');setNotice('');
    try{const p=await operation();if(!alive.current||epoch.current!==ticket)return;setProject(p);setNotice(success);await loadProject(p,false);if(alive.current&&selected&&selectedTicket===selectionEpoch.current)selection(selected,true);}
    catch(reason){if(alive.current&&epoch.current===ticket)showError(reason);throw reason;}finally{if(alive.current){setWriting(false);if(epoch.current===ticket)setBusy(false);}}
  };
  const create=async(name:string)=>{if(!vault)return;await act(()=>evidenceApi.create(vault,name),'Project created.');if(alive.current)setProjects(await evidenceApi.projects(vault));};
  const chooseLibrary=async(through?:number,before?:number)=>{
    if(!vault)return;const ticket=++catalogEpoch.current;setChoosing(true);setError('');
    try{const value=await libraryApi.list(vault,search,through,before);if(alive.current&&ticket===catalogEpoch.current)setCatalog(value);}catch(reason){if(alive.current&&ticket===catalogEpoch.current)showError(reason);}
  };
  const filePage=async()=>{if(!project||!files?.has_more)return;const p=project,ticket=epoch.current;try{const value=await evidenceApi.files(p,files.through_id,files.next_after_id??undefined);if(alive.current&&ticket===epoch.current){if(value.revision!==p.revision)throw new Error('Project changed. Refresh before using another page.');setFiles(value);}}catch(reason){if(alive.current&&ticket===epoch.current)showError(reason);}};
  const notePage=async()=>{if(!project||!notes?.has_more)return;const p=project,ticket=epoch.current;try{const value=await evidenceApi.notes(p,notes.through_id,notes.next_after_id??undefined);if(alive.current&&ticket===epoch.current){if(value.revision!==p.revision)throw new Error('Project changed. Refresh before using another page.');setNotes(value);}}catch(reason){if(alive.current&&ticket===epoch.current)showError(reason);}};
  const add=(f:EvidenceFile)=>{if(project)void act(()=>evidenceApi.add(project,f),'Exact Library version added; an existing membership is a no-op.',f).catch(()=>{});};
  return <div className="evidence-page"><div className="evidence-toolbar"><h1>Evidence</h1>{project&&<button disabled={busy} onClick={()=>void loadProject(project,false)}>Refresh project</button>}</div>
    <p>Organize retained files, read one bounded page, and keep exact passages with your notes.</p>
    <PageHelp storageKey="evidence" title="About Evidence" summary="Exact versions, literal notes and a portable selected bundle">
      <p>Start in Library: create its managed vault and import your own PDF, TXT or MD files. Add selected immutable versions to a project. Names and associations never establish publication identity.</p>
      <p>PDF reading accepts up to 16 MiB and 200 physical pages, one requested page at a time. Canonical pypdf text has a 20-second timeout and 200,000-codepoint page bound. Encrypted, malformed, unsupported, image-only and over-limit pages remain explicit. No OCR or full-text background processing.</p>
      <p>TXT/MD use literal UTF-8 with LF line endings, up to 256 KiB and 5,000 lines in one logical page. Select in the canonical pane, not the PDF canvas. A passage is at most 20,000 codepoints; the backend rechecks exact text, hash, page and version before saving.</p>
      <p>Each project holds up to 1,000 members and 5,000 notes; up to 100 projects. Removal keeps originals, retained files, notes and paper provenance. Notes and collections survive existing corpus erasure and resets. Reopen never silently finds a newer version or moves a quote. Database backup alone does not preserve Library bytes.</p>
      <p>Export 1–20 explicitly selected members. Metadata-only is the default; file mode rehashes selected retained bytes up to 256 MiB. Each metadata/text output is limited to 4 MiB. Review names, notes and included originals before sharing. Existing Library platform limits apply; this is not a backup/restore, AI or citation inference feature.</p>
    </PageHelp>
    {busy&&<p role="status">Loading or saving selected project…</p>}{error&&<p role="alert">{error}</p>}{notice&&<p role="status">{notice}</p>}
    {!vault&&!busy&&<p>Configure a managed vault and import a file in <a href="#/library">Library</a> to begin.</p>}
    {vault&&<><p className="evidence-identity">Vault {vault}</p><ProjectList page={projects} selected={project} busy={busy} selectDisabled={writing} onSelect={p=>void loadProject(p)} onCreate={create} onRename={name=>project?act(()=>evidenceApi.rename(project,name),'Project renamed.'):Promise.resolve()} onNext={()=>{if(projects?.has_more)void evidenceApi.projects(vault,projects.through_id,projects.next_after_id??undefined).then(p=>{if(alive.current)setProjects(p);}).catch(showError);}}/>
      {handoff&&<section aria-label="Selected Library handoff"><h2>Selected from Library: {handoff.original_name}</h2><p className="evidence-identity">Exact version {handoff.version_id}</p><p>Choose or create the intended project, then add this version explicitly.</p><button disabled={!project||busy} onClick={()=>add(handoff)}>Add selected Library file to project</button></section>}
      {project&&<><div className="evidence-toolbar"><h2>{project.name}</h2><button disabled={busy} onClick={()=>void chooseLibrary()}>Choose from Library</button><a href={`#/library?evidence_project=${project.project_id}`}>Import files in Library, then choose a file for this project</a><button disabled={busy||!project.file_count} onClick={()=>setBundle(true)}>Export selected evidence</button></div><p className="evidence-identity">Project {project.project_id} · revision {project.revision} · {project.file_count} current members · {project.note_count} saved records</p>
        {choosing&&<section className="evidence-catalog" aria-label="Choose retained Library files"><div className="evidence-toolbar"><h3>Choose retained files</h3><button onClick={()=>{++catalogEpoch.current;setChoosing(false);}}>Close Library chooser</button></div><form onSubmit={e=>{e.preventDefault();void chooseLibrary();}}><label>Find Library filename<input value={search} maxLength={200} onChange={e=>setSearch(e.target.value)}/></label><button>Search retained files</button></form>{catalog?.files.map(f=><div className="evidence-toolbar" key={f.file_id}><span>{f.original_name} · {f.byte_size.toLocaleString()} bytes</span><button disabled={busy} onClick={()=>add(f)}>Add {f.original_name}</button></div>)}{catalog?.has_more&&<button onClick={()=>void chooseLibrary(catalog.through_id,catalog.next_before_id??undefined)}>Next Library files</button>}</section>}
        {bundle&&<BundleDialog key={project.project_id} project={project} files={files} onNext={()=>void filePage()} onClose={()=>setBundle(false)}/>}
        <div className="evidence-workspace"><section className="evidence-members" aria-label="Current collection files"><h2>Collection files</h2>{files?.items.map(m=><div key={m.file_id} className="evidence-member"><button className="evidence-item" disabled={busy} aria-pressed={file?.file_id===m.file_id} onClick={()=>selection(m.file,true)}><strong>{m.file.original_name}</strong><span>{m.file.media_type} · {m.file.byte_size.toLocaleString()} bytes</span></button><button disabled={busy} onClick={()=>void act(()=>evidenceApi.remove(project,m.file),'Membership removed. Notes, files and provenance are preserved.').then(()=>{if(selectedFile.current?.file_id===m.file_id&&selectedFile.current.version_id===m.version_id)setMember(false);}).catch(()=>{})}>Remove {m.file.original_name} from collection</button></div>)}{files&&<p>{files.items.length} shown of {files.total} current members at ID ceiling {files.through_id}. Metadata does not freshly check retained bytes.</p>}{files?.has_more&&<button disabled={busy} onClick={()=>void filePage()}>Next collection files</button>}</section>
        <div>{file?<EvidenceReader key={`${project.project_id}/${file.file_id}/${file.version_id}`} project={project} file={file} reopen={reopen} canSave={member&&!busy} onPassage={setAnchor}/>:<p>Select a collection file or reopen a saved note to read its exact version.</p>}</div>
        <NotePanel key={project.project_id} project={project} file={file} anchor={anchor} notes={notes} member={member} onClear={()=>setAnchor(null)} onNext={()=>void notePage()} onReopen={n=>selection(n.file,n.membership_state==='member',n)} onSaved={async(p)=>{setProject(p);await loadProject(p,false);}}/>
        </div></>}
    </>}
  </div>;
}
