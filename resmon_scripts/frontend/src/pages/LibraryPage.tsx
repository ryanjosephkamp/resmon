import React, { useEffect, useRef, useState } from 'react';
import PageHelp from '../components/Help/PageHelp';
import LibraryDetail from '../components/Library/LibraryDetail';
import { LibraryFile, LibraryPage, LibraryStatus, MAX_BATCH_FILES, MAX_FILE_BYTES, libraryApi } from '../api/library';
import { downloadInventory } from '../lib/libraryDownload';

export default function LibraryPageComponent() {
  const [status,setStatus]=useState<LibraryStatus|null>(null);const [page,setPage]=useState<LibraryPage|null>(null);
  const [selected,setSelected]=useState<LibraryFile|null>(null);const [query,setQuery]=useState('');
  const [parent,setParent]=useState('');const [loading,setLoading]=useState(false);const [busy,setBusy]=useState(false);
  const [error,setError]=useState('');const [notice,setNotice]=useState('');const [importing,setImporting]=useState(false);
  const epoch=useRef(0);const listEpoch=useRef(0);const selection=useRef<LibraryFile|null>(null);
  const list=useRef<HTMLDivElement>(null);const alive=useRef(true);
  const select=(file:LibraryFile|null)=>{++epoch.current;selection.current=file;setSelected(file);setError('');setNotice('');setBusy(false);};
  const load=async(q:string,through?:number,before?:number)=>{
    const ticket=++listEpoch.current;select(null);setLoading(true);setError('');setPage(null);
    try{
      const current=await libraryApi.status();if(!alive.current||ticket!==listEpoch.current)return;
      setStatus(current);
      if(current.vault){
        const value=await libraryApi.list(current.vault.vault_id,q,through,before);
        if(!alive.current||ticket!==listEpoch.current)return;setPage(value);
      }
    }catch(err){if(alive.current&&ticket===listEpoch.current)setError(err instanceof Error?err.message:'Library could not be loaded.');}
    finally{if(alive.current&&ticket===listEpoch.current)setLoading(false);}
  };
  useEffect(()=>{alive.current=true;void load('');return()=>{alive.current=false;++epoch.current;++listEpoch.current;};},[]);
  const choose=async()=>{
    const ticket=++epoch.current;setError('');
    try{
      if(!window.resmonAPI?.chooseDirectory)throw new Error('The desktop directory picker is unavailable.');
      const chosen=await window.resmonAPI.chooseDirectory();if(alive.current&&ticket===epoch.current&&chosen)setParent(chosen);
    }catch(err){if(alive.current&&ticket===epoch.current)setError(String(err));}
  };
  const create=async()=>{
    const ticket=++epoch.current;setBusy(true);setError('');
    try{await libraryApi.create(parent);if(alive.current&&ticket===epoch.current){setParent('');await load(query);}}
    catch(err){if(alive.current&&ticket===epoch.current)setError(err instanceof Error?err.message:'Vault creation failed.');}
    finally{if(alive.current)setBusy(false);}
  };
  const importFiles=async(files:File[])=>{
    if(!status?.vault)return;
    if(files.length>MAX_BATCH_FILES){setError('Choose at most 20 files per sequential batch. Nothing was imported.');return;}
    if(files.some(f=>!f.size||f.size>MAX_FILE_BYTES)){setError('Each selected file must be nonempty and at most 64 MiB. Nothing was imported.');return;}
    const vault=status.vault.vault_id;const ticket=++epoch.current;setImporting(true);setError('');setNotice('');
    let created=0,reused=0;const failures:string[]=[];
    for(const file of files){
      if(!alive.current)break;
      try{const result=await libraryApi.import(vault,file);if(result.created)++created;else++reused;}
      catch(err){failures.push(`${file.name}: ${err instanceof Error?err.message:'Import refused.'}`);break;}
    }
    if(!alive.current)return;
    setImporting(false);
    if(ticket!==epoch.current)return;
    await load(query);
    setNotice(`${created} retained, ${reused} exact duplicates reused, ${files.length-created-reused-failures.length} not attempted. Originals remain unchanged.`);
    if(failures.length)setError(failures.join('\n'));
  };
  const inventory=async()=>{
    if(!status?.vault)return;
    const vault=status.vault.vault_id,ticket=++epoch.current;setBusy(true);setError('');setNotice('');
    try{
      const result=await libraryApi.inventory(vault);if(!alive.current||ticket!==epoch.current)return;
      downloadInventory(result,vault);setNotice('Complete JSON inventory download requested. This contains metadata, not retained file bytes.');
    }catch(err){if(alive.current&&ticket===epoch.current)setError(err instanceof Error?err.message:'Inventory export failed.');}
    finally{if(alive.current&&ticket===epoch.current)setBusy(false);}
  };
  return <div className="library-page">
    <div className="library-toolbar"><h1>Library</h1><button disabled={loading||importing} onClick={()=>void load(query)}>Refresh Library</button></div>
    <p>Keep your own PDF, TXT and Markdown files as immutable local copies. Read bounded text here, or request an external Open.</p>
    <PageHelp storageKey="library" title="About Library" summary="Owned copies, explicit associations and portable metadata">
      <p>Choose an existing parent folder, then explicitly create one new managed child vault. Import up to 20 selected files sequentially, 64 MiB each. The vault retains up to 1 GiB and 10,000 items. Originals are untouched; exact byte duplicates reuse their first name and version.</p>
      <p>TXT/MD reading is literal UTF-8 without NUL, up to 256 KiB and 5,000 logical lines. PDF and larger text remain retained for verified external Open. No PDF extraction, AI analysis, executable Markdown, annotations or inferred publication identity.</p>
      <p>Search matches literal filenames. Paging keeps the first page’s ceiling; Refresh includes later imports. Metadata views do not freshly check file integrity. Missing or mismatched storage refuses access without adopting or repairing it.</p>
      <p>The complete JSON inventory is recorded metadata, limited to 8 MiB. It is not a file bundle, backup, relocation tool or integrity scan. Review original names before sharing. Library catalog and retained files survive existing resets and corpus erasure; paper associations disappear when their local paper is deleted. Database backup alone does not preserve managed bytes. No automatic Library cloud backup is added.</p>
    </PageHelp>
    {error&&<p role="alert" className="library-error">{error}</p>}{notice&&<p role="status">{notice}</p>}
    {loading&&<p role="status">Loading Library…</p>}
    {status&&!status.vault&&<section aria-label="Create managed vault"><h2>Create your managed vault</h2><p>A new child folder will be created inside your selected parent. Existing folders are never adopted.</p>
      <button disabled={busy} onClick={()=>void choose()}>Choose parent folder</button><p>{parent||'No parent selected.'}</p><button disabled={!parent||busy} onClick={()=>void create()}>Create managed vault</button>
    </section>}
    {status?.vault&&<>
      <p className="library-identity">Vault {status.vault.vault_id} · {status.status} · {status.counts.items.toLocaleString()} catalog items · {status.counts.retained_bytes.toLocaleString()} recorded bytes</p>
      {status.status!=='ready'&&<p role="alert">Vault {status.status}. Import is blocked. Existing data is retained; no automatic recovery is available.</p>}
      <div className="library-toolbar"><label>Import PDF, TXT or MD<input type="file" accept=".pdf,.txt,.md" multiple disabled={importing||status.status!=='ready'} onChange={e=>{const files=Array.from(e.target.files??[]);e.target.value='';if(files.length)void importFiles(files);}}/></label>
        <button disabled={busy||importing} onClick={()=>void inventory()}>Export complete JSON inventory</button></div>
      {importing&&<p role="status">Importing selected files one at a time…</p>}
      <p>Inventory includes every catalog item, beyond this page. Review filenames before sharing; it is not a backup.</p>
      <form className="library-toolbar" onSubmit={e=>{e.preventDefault();void load(query);}}><label>Search filenames<input value={query} maxLength={200} onChange={e=>setQuery(e.target.value)}/></label><button disabled={loading||importing}>Search Library</button></form>
      <div className="library-workspace"><div ref={list} className="library-list" role="region" aria-label="Library files">
        {!loading&&page?.files.length===0&&<p>No retained files match this view.</p>}
        {page?.files.map(file=><button key={file.file_id} className="library-item" aria-pressed={selected?.file_id===file.file_id} onClick={()=>select(file)}><strong>{file.original_name}</strong><span>{file.media_type} · {file.byte_size.toLocaleString()} bytes · {file.paper_links.length} local associations</span></button>)}
        {page&&<p>{page.files.length} items on this page · through catalog ID {page.through_id}</p>}
        {page?.has_more&&<button disabled={loading||importing} onClick={()=>void load(query,page.through_id,page.next_before_id??undefined)}>Next 50 items</button>}
      </div>
      {selected?<LibraryDetail evidenceProject={(()=>{const id=new URLSearchParams(window.location.hash.split('?')[1]??'').get('evidence_project');return id&&/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(id)?id:undefined;})()} key={`${selected.vault_id}/${selected.file_id}/${selected.version_id}`} selected={selected} onClose={()=>{const id=selected.file_id;select(null);const i=page?.files.findIndex(f=>f.file_id===id);if(i!==undefined&&i>=0)list.current?.querySelectorAll<HTMLButtonElement>('.library-item')[i]?.focus();}}/>:<p className="library-empty-detail">Select an item to read, inspect, associate a local paper or request Open.</p>}
      </div>
    </>}
  </div>;
}
