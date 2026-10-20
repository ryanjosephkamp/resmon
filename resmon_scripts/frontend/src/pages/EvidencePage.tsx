import React,{useEffect,useRef,useState} from 'react';
import {useRuns} from '../hooks/useRuns';
import {Anchor,evidenceApi,evidenceBaseUrl,EvidenceFile,Member,Page,Project,SavedNote} from '../api/evidence';
import {libraryApi,LibraryPage,uuid} from '../api/library';
import ProjectList from '../components/Evidence/ProjectList';
import EvidenceReader from '../components/Evidence/EvidenceReader';
import NotePanel from '../components/Evidence/NotePanel';
import BundleDialog from '../components/Evidence/BundleDialog';
import PageHelp from '../components/Help/PageHelp';
import AnswerPanel from '../components/Evidence/AnswerPanel';

export default function EvidencePage(){
  const [vault,setVault]=useState<string|null>(null);const [projects,setProjects]=useState<Page<Project>|null>(null);const [project,setProject]=useState<Project|null>(null);const [files,setFiles]=useState<Page<Member>|null>(null);const [notes,setNotes]=useState<Page<SavedNote>|null>(null);
  const [file,setFile]=useState<EvidenceFile|null>(null);const [member,setMember]=useState(false);const [reopen,setReopen]=useState<SavedNote|null>(null);const [anchor,setAnchor]=useState<Anchor|null>(null);
  const [catalog,setCatalog]=useState<LibraryPage|null>(null);const [choosing,setChoosing]=useState(false);const [search,setSearch]=useState('');const [handoff,setHandoff]=useState<EvidenceFile|null>(null);const [bundle,setBundle]=useState(false);
  const [busy,setBusy]=useState(false);const [writing,setWriting]=useState(false);const [error,setError]=useState('');const [notice,setNotice]=useState('');const abort=useRef<AbortController|null>(null);
  // Each asynchronous control carries its own generation counter rather than
  // sharing one, and the two paging controls are why. They took a ticket from
  // ``epoch`` without ever bumping it, so a collection or notes page could
  // never be the newest run of anything: loading a project, the mount handoff
  // and every mutation through ``act`` all bumped ``epoch``, and each of them
  // threw away whatever paging had in flight. Paging also never sets ``busy``
  // - nor does the Library chooser, nor the project list's own Next - so
  // pressing Next leaves every ``disabled={busy}`` control live, Refresh
  // project and Remove among them, and the overlap is one ordinary click
  // apart. What was discarded was not only the page: a page that came back
  // *refused* reported nothing at all. The user pressed Next, the request
  // completed, and the page said nothing.
  //
  // ``project`` is deliberately one key for three callers. Loading a project,
  // the mount-time handoff and a mutation's reload all replace the project
  // view with one current revision, so the newest of them must win and the
  // others must not write. That is a decision rather than an accident, which
  // is the reason it is spelled as a shared key instead of a shared counter.
  const runs=useRuns();
  const selectedFile=useRef<EvidenceFile|null>(null);
  // Paging is bounded by the project on screen when its answer arrives, not by
  // the project captured when it was asked for. That is an identity, not a
  // generation: a page of project A must never be pasted into project B, while
  // a refresh of the same project is no reason to throw a page away. A page
  // that straddles a revision is refused by the revision checks below, which
  // say so out loud rather than dropping it.
  const shownProject=useRef<Project|null>(null);
  // One writer for both, so a later call site cannot set the state and forget
  // the ref. The ref exists because an answer that arrives after an ``await``
  // has to be checked against the project on screen *now*, and reading the
  // ``project`` state out of a closure gives the project as it was when the
  // request was sent. Making this a wrapper rather than an effect keeps the
  // two in step synchronously, which is what the awaits here need.
  const showProject=(p:Project)=>{shownProject.current=p;setProject(p);};
  const selection=(f:EvidenceFile|null,isMember=false,n:SavedNote|null=null)=>{runs.begin('selection');selectedFile.current=f;setBundle(false);setFile(f);setMember(isMember);setReopen(n);setAnchor(null);};
  const showError=(reason:unknown)=>setError(reason instanceof Error?reason.message:'Evidence request refused.');
  const loadProject=async(p:Project,reset=true)=>{
    const ticket=runs.begin('project');abort.current?.abort();const controller=new AbortController();abort.current=controller;setBusy(true);setError('');setBundle(false);
    if(reset){selection(null);setNotes(null);setFiles(null);}showProject(p);const selectedTicket=runs.token('selection');const activeFile=selectedFile.current;
    try{
      const current=await evidenceApi.detail(p.vault_id,p.project_id,controller.signal);
      const [nextFiles,nextNotes]=await Promise.all([evidenceApi.files(current,undefined,undefined,controller.signal),evidenceApi.notes(current,undefined,undefined,controller.signal)]);
      if(!runs.current('project',ticket))return;
      // Lists may observe a concurrent writer. Do not silently adopt mixed revisions.
      if(nextFiles.revision!==current.revision||nextNotes.revision!==current.revision)throw new Error('Project changed during refresh. Refresh explicitly to load one current revision.');
      let selectedMember:boolean|null=null;
      if(!reset&&activeFile){
        let members=nextFiles;
        // Absence from the first 50 rows cannot establish removal. Resolve only
        // the selected pair over this fixed ceiling, at most 1,000 memberships.
        for(let pageNumber=0;pageNumber<20;pageNumber++){
          if(!runs.current('selection',selectedTicket))break;
          if(members.items.some(x=>x.file_id===activeFile.file_id&&x.version_id===activeFile.version_id)){selectedMember=true;break;}
          if(!members.has_more){selectedMember=false;break;}
          if(pageNumber===19||members.next_after_id===null)throw new Error('Membership refresh exceeded its bounded pages. Refresh explicitly.');
          members=await evidenceApi.files(current,nextFiles.through_id,members.next_after_id,controller.signal);
          if(members.revision!==current.revision)throw new Error('Project changed during membership refresh. Refresh explicitly to load one current revision.');
        }
      }
      if(!runs.current('project',ticket))return;
      showProject(current);setFiles(nextFiles);setNotes(nextNotes);
      setProjects(prior=>prior?{...prior,items:prior.items.map(x=>x.project_id===current.project_id?current:x)}:prior);
      if(selectedMember!==null&&runs.current('selection',selectedTicket))setMember(selectedMember);
    }catch(reason){if(runs.current('project',ticket))showError(reason);}finally{if(runs.current('project',ticket))setBusy(false);}
  };
  useEffect(()=>{
    const ticket=runs.begin('project');setBusy(true);
    void(async()=>{try{
      evidenceBaseUrl();
      const status=await libraryApi.status();if(!runs.current('project',ticket))return;setVault(status.vault?.vault_id??null);
      if(!status.vault)return;const id=status.vault.vault_id;
      const page=await evidenceApi.projects(id);if(!runs.current('project',ticket))return;setProjects(page);
      const q=new URLSearchParams(window.location.hash.split('?')[1]??'');
      if(q.has('file_id')||q.has('version_id')||q.has('vault_id')){
        if(q.get('vault_id')!==id||!uuid(q.get('file_id'))||!uuid(q.get('version_id')))throw new Error('Library handoff has a missing or mismatched exact identity. Return to Library and select the item explicitly.');
        const candidate=await libraryApi.detail(id,q.get('file_id')!);if(!runs.current('project',ticket))return;
        if(candidate.version_id!==q.get('version_id'))throw new Error('Library handoff version changed. No latest-version fallback was applied.');setHandoff(candidate);
      }
      if(q.has('project_id')){const projectId=q.get('project_id');if(!uuid(projectId))throw new Error('Invalid project handoff.');const target=await evidenceApi.detail(id,projectId);if(runs.current('project',ticket))await loadProject(target);}
    }catch(reason){if(runs.current('project',ticket))showError(reason);}finally{if(runs.current('project',ticket))setBusy(false);}})();
    // The page going away is carried by ``runs``, which stops every key at
    // once; it is a separate condition from a newer run and does not need a
    // bump of its own. Only the request in flight has to be told.
    return()=>{abort.current?.abort();};
  },[]);
  const act=async(operation:()=>Promise<Project>,success:string,selected?:EvidenceFile)=>{
    const ticket=runs.begin('project');const selectedTicket=runs.token('selection');setBusy(true);setWriting(true);setError('');setNotice('');
    try{const p=await operation();if(!runs.current('project',ticket))return;showProject(p);setNotice(success);await loadProject(p,false);if(selected&&runs.current('selection',selectedTicket))selection(selected,true);}
    catch(reason){if(runs.current('project',ticket))showError(reason);throw reason;}finally{if(runs.mounted){setWriting(false);if(runs.current('project',ticket))setBusy(false);}}
  };
  const create=async(name:string)=>{if(!vault)return;await act(()=>evidenceApi.create(vault,name),'Project created.');if(runs.mounted)setProjects(await evidenceApi.projects(vault));};
  const chooseLibrary=async(through?:number,before?:number)=>{
    if(!vault)return;const ticket=runs.begin('catalog');setChoosing(true);setError('');
    try{const value=await libraryApi.list(vault,search,through,before);if(runs.current('catalog',ticket))setCatalog(value);}catch(reason){if(runs.current('catalog',ticket))showError(reason);}
  };
  // A page answers to a later press of its own Next button and to the project
  // on screen, and to nothing else. ``showing`` is the second half: the whole
  // list was replaced when the project changed, so there is no page left
  // hanging and nothing for the user to be told - which is not true of any of
  // the other things that used to cancel this.
  const showing=(p:Project)=>shownProject.current?.project_id===p.project_id;
  const filePage=async()=>{if(!project||!files?.has_more)return;const p=project,ticket=runs.begin('files');try{const value=await evidenceApi.files(p,files.through_id,files.next_after_id??undefined);if(runs.current('files',ticket)&&showing(p)){if(value.revision!==p.revision)throw new Error('Project changed. Refresh before using another page.');setFiles(value);}}catch(reason){if(runs.current('files',ticket)&&showing(p))showError(reason);}};
  const notePage=async()=>{if(!project||!notes?.has_more)return;const p=project,ticket=runs.begin('notes');try{const value=await evidenceApi.notes(p,notes.through_id,notes.next_after_id??undefined);if(runs.current('notes',ticket)&&showing(p)){if(value.revision!==p.revision)throw new Error('Project changed. Refresh before using another page.');setNotes(value);}}catch(reason){if(runs.current('notes',ticket)&&showing(p))showError(reason);}};
  const add=(f:EvidenceFile)=>{if(project)void act(()=>evidenceApi.add(project,f),'Exact Library version added; an existing membership is a no-op.',f).catch(()=>{});};
  return <div className="evidence-page"><div className="evidence-toolbar"><h1>Evidence</h1>{project&&<button disabled={busy} onClick={()=>void loadProject(project,false)}>Refresh project</button>}</div>
    <p>Organize retained files, read one bounded page, and keep exact passages with your notes.</p>
    <PageHelp storageKey="evidence" title="About Evidence" summary="Exact versions, literal notes and a portable selected bundle">
      <p>Start in Library: create its managed vault and import your own PDF, TXT or MD files. Read PDF in Evidence carries the exact selected version. Choose a project, then explicitly add that version to open its reader; an existing membership is reused. Add selected immutable versions to a project. Names and associations never establish publication identity.</p>
      <p>PDF reading accepts up to 16 MiB and 200 physical pages, one requested page at a time. Canonical pypdf text has a 20-second timeout and 200,000-codepoint page bound. Encrypted, malformed, unsupported, image-only and over-limit pages remain explicit. No OCR or full-text background processing.</p>
      <p>TXT/MD use literal UTF-8 with LF line endings, up to 256 KiB and 5,000 lines in one logical page. Select in the canonical pane, not the PDF canvas. A passage is at most 20,000 codepoints; the backend rechecks exact text, hash, page and version before saving.</p>
      <p>Each project holds up to 1,000 members and 5,000 notes; up to 100 projects. Removal keeps originals, retained files, notes and paper provenance. Notes and collections survive existing corpus erasure and resets. Reopen never silently finds a newer version or moves a quote. Database backup alone does not preserve Library bytes.</p>
      <p>Export 1–20 explicitly selected members. Metadata-only is the default; file mode rehashes selected retained bytes up to 256 MiB. Each metadata/text output is limited to 4 MiB. Review names, notes and included originals before sharing. Existing Library platform limits apply; this original-file bundle is not a backup/restore or citation inference feature.</p>
      <p>Answers use explicit versions/pages/passages and optional individually selected note bodies. Review the complete content and destination before Send. Each Send starts a fresh tools-off request, with no Ask/Chats history, retry or model fallback. Bounds: 5 files, 12 pages, 24 segments, 8 notes, 48 KiB/24,000 codepoints of source text, 8 KiB notes, 4,000 instruction codepoints, 96 KiB user payload, 64 KiB model text and 300 seconds. Over-limit or unavailable selections refuse without truncation.</p>
      <p>After an export, Downloads at the bottom of the app reports completion, filename and actual saved path. Show in folder reveals a completed file. Cancelled or interrupted downloads are not reported as saved.</p>
      <p>Exact citations identify selected text; they do not verify support or scientific truth. Saved answers retain their frozen excerpts after restart; incomplete output stays unvalidated. Export one answer as selected text only, separately from the original-file bundle. Stop cancels local publication; transport cleanup, remote computation and billing can remain unknown. No live-model quality claim, automatic analysis, new sources, OCR or full-paper understanding.</p>
    </PageHelp>
    {busy&&<p role="status">Loading or saving selected project…</p>}{error&&<p role="alert">{error}</p>}{notice&&<p role="status">{notice}</p>}
    {!vault&&!busy&&<p>Configure a managed vault and import a file in <a href="#/library">Library</a> to begin.</p>}
    {vault&&<><p className="evidence-identity">Vault {vault}</p><ProjectList page={projects} selected={project} busy={busy} selectDisabled={writing} onSelect={p=>void loadProject(p)} onCreate={create} onRename={name=>project?act(()=>evidenceApi.rename(project,name),'Project renamed.'):Promise.resolve()} onNext={()=>{if(!projects?.has_more)return;const ticket=runs.begin('projects');void evidenceApi.projects(vault,projects.through_id,projects.next_after_id??undefined).then(p=>{if(runs.current('projects',ticket))setProjects(p);},reason=>{if(runs.current('projects',ticket))showError(reason);});}}/>
      {handoff&&<section aria-label="Selected Library handoff"><h2>Selected from Library: {handoff.original_name}</h2><p className="evidence-identity">Exact version {handoff.version_id}</p><p>Choose or create the intended project, then add this exact version to open its reader. If already added, the same membership is reused. No note is saved by this action.</p><button disabled={!project||busy} onClick={()=>add(handoff)}>Add selected Library file to project</button></section>}
      {project&&<><div className="evidence-toolbar"><h2>{project.name}</h2><button disabled={busy} onClick={()=>void chooseLibrary()}>Choose from Library</button><a href={`#/library?evidence_project=${project.project_id}`}>Import files in Library, then choose a file for this project</a><button disabled={busy||!project.file_count} onClick={()=>setBundle(true)}>Export selected evidence</button></div><p className="evidence-identity">Project {project.project_id} · revision {project.revision} · {project.file_count} current members · {project.note_count} saved records</p>
        {choosing&&<section className="evidence-catalog" aria-label="Choose retained Library files"><div className="evidence-toolbar"><h3>Choose retained files</h3><button onClick={()=>{runs.begin('catalog');setChoosing(false);}}>Close Library chooser</button></div><form onSubmit={e=>{e.preventDefault();void chooseLibrary();}}><label>Find Library filename<input value={search} maxLength={200} onChange={e=>setSearch(e.target.value)}/></label><button>Search retained files</button></form>{catalog?.files.map(f=><div className="evidence-toolbar" key={f.file_id}><span>{f.original_name} · {f.byte_size.toLocaleString()} bytes</span><button disabled={busy} onClick={()=>add(f)}>Add {f.original_name}</button></div>)}{catalog?.has_more&&<button onClick={()=>void chooseLibrary(catalog.through_id,catalog.next_before_id??undefined)}>Next Library files</button>}</section>}
        {bundle&&<BundleDialog key={project.project_id} project={project} files={files} onNext={()=>void filePage()} onClose={()=>setBundle(false)}/>}
        <div className="evidence-workspace"><section className="evidence-members" aria-label="Current collection files"><h2>Collection files</h2>{files?.items.map(m=><div key={m.file_id} className="evidence-member"><button className="evidence-item" disabled={busy} aria-pressed={file?.file_id===m.file_id} onClick={()=>selection(m.file,true)}><strong>{m.file.original_name}</strong><span>{m.file.media_type} · {m.file.byte_size.toLocaleString()} bytes</span></button><button disabled={busy} onClick={()=>void act(()=>evidenceApi.remove(project,m.file),'Membership removed. Notes, files and provenance are preserved.').then(()=>{if(selectedFile.current?.file_id===m.file_id&&selectedFile.current.version_id===m.version_id)setMember(false);}).catch(()=>{})}>Remove {m.file.original_name} from collection</button></div>)}{files&&<p>{files.items.length} shown of {files.total} current members at ID ceiling {files.through_id}. Metadata does not freshly check retained bytes.</p>}{files?.has_more&&<button disabled={busy} onClick={()=>void filePage()}>Next collection files</button>}</section>
        <div>{file?<EvidenceReader key={`${project.project_id}/${file.file_id}/${file.version_id}`} project={project} file={file} reopen={reopen} canSave={member&&!busy} onPassage={setAnchor}/>:<p>Select a collection file or reopen a saved note to read its exact version.</p>}</div>
        <NotePanel key={project.project_id} project={project} file={file} anchor={anchor} notes={notes} member={member} onClear={()=>setAnchor(null)} onNext={()=>void notePage()} onReopen={n=>selection(n.file,n.membership_state==='member',n)} onSaved={async(p)=>{showProject(p);await loadProject(p,false);}}/>
        </div><AnswerPanel key={`answers/${project.project_id}`} project={project} files={files} notes={notes} file={file} anchor={anchor} onNextFiles={()=>void filePage()} onNextNotes={()=>void notePage()}/></>}
    </>}
  </div>;
}
