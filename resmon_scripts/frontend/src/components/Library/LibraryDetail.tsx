import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { LibraryFile, libraryApi } from '../../api/library';
import LibraryTextReader from './LibraryTextReader';

export default function LibraryDetail({selected,onClose}: {selected: LibraryFile;onClose: ()=>void}) {
  const [file,setFile]=useState(selected);const [error,setError]=useState('');const [notice,setNotice]=useState('');
  const [busy,setBusy]=useState(false);const [paper,setPaper]=useState('');const [reading,setReading]=useState(false);
  const restoreReadFocus=useRef(false);
  useLayoutEffect(()=>{if(!reading&&restoreReadFocus.current){restoreReadFocus.current=false;readButton.current?.focus();}},[reading]);
  const epoch=useRef(0);const title=useRef<HTMLHeadingElement>(null);const readButton=useRef<HTMLButtonElement>(null);
  useEffect(()=>{
    const ticket=++epoch.current;title.current?.focus();
    void libraryApi.detail(selected.vault_id,selected.file_id).then(value=>{if(epoch.current===ticket){if(value.version_id!==selected.version_id){setError('Selected version changed. Reselect this item.');return;}setFile(value);}},err=>{if(epoch.current===ticket)setError(String(err));});
    return ()=>{++epoch.current;};
  },[selected.file_id,selected.version_id,selected.vault_id]);
  const act=async(kind:'open'|'link')=>{
    const ticket=++epoch.current;setError('');setNotice('');setBusy(true);
    try{
      if(kind==='open'){
        const path=await libraryApi.open(file);if(epoch.current!==ticket)return;
        if(!window.resmonAPI?.openPath)throw new Error('External Open is unavailable in this renderer.');
        const failure=await window.resmonAPI.openPath(path);if(epoch.current!==ticket)return;
        if(failure)throw new Error(`Open request failed: ${failure}`);
        setNotice('Open requested. External viewer rendering is not verified.');
      }else{
        const id=Number(paper);if(!Number.isSafeInteger(id)||id<1)throw new Error('Enter a positive corpus-local paper ID.');
        await libraryApi.link(file,id);if(epoch.current!==ticket)return;
        const value=await libraryApi.detail(file.vault_id,file.file_id);if(epoch.current!==ticket)return;
        if(value.version_id!==file.version_id)throw new Error('The version changed. Refresh Library.');
        setFile(value);setNotice(`Linked local paper ${id}. This is your association, not verified publication identity.`);setPaper('');
      }
    }catch(err){if(epoch.current===ticket)setError(err instanceof Error?err.message:'Library action failed.');}
    finally{if(epoch.current===ticket)setBusy(false);}
  };
  return <section className="library-detail" aria-label="Selected Library item">
    <div className="library-toolbar"><h2 tabIndex={-1} ref={title}>{file.original_name}</h2><button onClick={()=>{++epoch.current;onClose();}}>Close item</button></div>
    <dl><dt>Retained format</dt><dd>{file.media_type} · {file.byte_size.toLocaleString()} bytes</dd>
      <dt>File</dt><dd className="library-identity">{file.file_id}</dd><dt>Immutable version</dt><dd className="library-identity">{file.version_id}</dd>
      <dt>SHA256 of imported bytes</dt><dd className="library-identity">{file.sha256}</dd></dl>
    <p>Availability has not been checked by this metadata view. Read or Open checks the retained version.</p>
    <div className="library-toolbar"><button ref={readButton} disabled={reading} onClick={()=>setReading(true)}>Read text</button><button disabled={busy} onClick={()=>void act('open')}>Open externally</button></div>
    {error&&<p role="alert">{error}</p>}{notice&&<p role="status">{notice}</p>}
    {reading&&<LibraryTextReader file={file} onClose={()=>{restoreReadFocus.current=true;setReading(false);}}/>}
    <h3>Local paper associations</h3><p>Enter an existing paper ID from this app. No fuzzy matching, metadata merging or publication verification.</p>
    {file.paper_links.length?<ul>{file.paper_links.map(link=><li key={link.document_id}>Paper {link.document_id}: {link.title} · owner association</li>)}</ul>:<p>No local papers associated.</p>}
    <form className="library-toolbar" onSubmit={e=>{e.preventDefault();void act('link');}}><label>Existing paper ID<input inputMode="numeric" value={paper} onChange={e=>setPaper(e.target.value)}/></label><button disabled={busy||!paper.trim()}>Associate paper</button></form>
  </section>;
}
