import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { LibraryFile, libraryApi } from '../../api/library';
import LibraryTextReader from './LibraryTextReader';

export default function LibraryDetail({selected,onClose,evidenceProject}: {selected: LibraryFile;onClose: ()=>void;evidenceProject?:string}) {
  const [file,setFile]=useState(selected);const [error,setError]=useState('');const [notice,setNotice]=useState('');
  const [busy,setBusy]=useState(false);const [paper,setPaper]=useState('');const [reading,setReading]=useState(false);
  const evidenceHref='#/evidence?'+new URLSearchParams({vault_id:file.vault_id,file_id:file.file_id,version_id:file.version_id,...(evidenceProject?{project_id:evidenceProject}:{})}).toString();
  const restoreReadFocus=useRef(false);
  useLayoutEffect(()=>{if(!reading&&restoreReadFocus.current){restoreReadFocus.current=false;readButton.current?.focus();}},[reading]);
  // Each asynchronous control carries its own generation counter rather than
  // sharing one. The mount-time metadata refresh, Open externally and Associate
  // paper all read a single ``epoch`` and all bumped it, so starting either
  // action threw away whatever the refresh came back with. Open externally is
  // enabled from the first render, so that window is every selection, and the
  // changed-version check is not the only thing erased in it: a refresh that
  // had been *refused* reported nothing at all, and the freshened metadata this
  // panel is built on - the current paper associations in particular - went
  // with it. A request that completes and then says nothing is the outcome this
  // app exists to avoid.
  //
  // A run is superseded only by a later run of the same control. The panel
  // ceasing to be the panel for that item - unmounted, or pointed at another
  // one - is a separate condition, and the effect's cleanup carries it for
  // every control at once; the note there says why it retires the counters and
  // does not only drop ``alive``. Every guard below reads both.
  const runs=useRef({detail:0,open:0,link:0});const alive=useRef(true);
  const title=useRef<HTMLHeadingElement>(null);const readButton=useRef<HTMLButtonElement>(null);
  useEffect(()=>{
    alive.current=true;
    const ticket=++runs.current.detail;title.current?.focus();
    void libraryApi.detail(selected.vault_id,selected.file_id).then(value=>{if(alive.current&&ticket===runs.current.detail){if(value.version_id!==selected.version_id){setError('Selected version changed. Reselect this item.');return;}setFile(value);}},err=>{if(alive.current&&ticket===runs.current.detail)setError(err instanceof Error?err.message:String(err));});
    // The cleanup retires every counter as well as dropping ``alive``, and the
    // rule is that plain: when this stops being the panel for that item,
    // nothing still out may act. ``alive`` alone is not enough, because an
    // effect re-run re-arms it on the line above - an action that was already
    // out would then finish against an item the panel has moved off. Today the
    // effect cannot re-run without a remount, since Library keys this component
    // on the same three values the dependency list names. That is a property of
    // a different file, and the next person to edit it has no reason to know
    // this one is leaning on it, so this cleanup does not lean on it.
    return ()=>{alive.current=false;++runs.current.detail;++runs.current.open;++runs.current.link;};
  },[selected.file_id,selected.version_id,selected.vault_id]);
  const act=async(kind:'open'|'link')=>{
    // ``busy`` is what actually keeps a second action from starting while this
    // one is out, and it is set before the first await. The ticket is here so
    // that gate is not the only thing standing between two runs of the same
    // control, and because it is what the effect cleanup retires to cancel a
    // run that is already out.
    const ticket=++runs.current[kind];setError('');setNotice('');setBusy(true);
    try{
      if(kind==='open'){
        const path=await libraryApi.open(file);if(!alive.current||ticket!==runs.current[kind])return;
        if(!window.resmonAPI?.openPath)throw new Error('External Open is unavailable in this renderer.');
        const failure=await window.resmonAPI.openPath(path);if(!alive.current||ticket!==runs.current[kind])return;
        if(failure)throw new Error(`Open request failed: ${failure}`);
        setNotice('Open requested. External viewer rendering is not verified.');
      }else{
        const id=Number(paper);if(!Number.isSafeInteger(id)||id<1)throw new Error('Enter a positive corpus-local paper ID.');
        await libraryApi.link(file,id);if(!alive.current||ticket!==runs.current[kind])return;
        const value=await libraryApi.detail(file.vault_id,file.file_id);if(!alive.current||ticket!==runs.current[kind])return;
        if(value.version_id!==file.version_id)throw new Error('The version changed. Refresh Library.');
        setFile(value);setNotice(`Linked local paper ${id}. This is your association, not verified publication identity.`);setPaper('');
      }
    }catch(err){if(alive.current&&ticket===runs.current[kind])setError(err instanceof Error?err.message:'Library action failed.');}
    finally{if(alive.current&&ticket===runs.current[kind])setBusy(false);}
  };
  return <section className="library-detail" aria-label="Selected Library item">
    {/* Close marks the panel gone at the click rather than waiting for the
        cleanup above, which is what the shared counter's bump did here. Library
        unconditionally stops rendering this panel when Close runs, so the two
        say the same thing; doing it at the click keeps it independent of when
        React commits the unmount. */}
    <div className="library-toolbar"><h2 tabIndex={-1} ref={title}>{file.original_name}</h2><button onClick={()=>{alive.current=false;onClose();}}>Close item</button></div>
    <dl><dt>Retained format</dt><dd>{file.media_type} · {file.byte_size.toLocaleString()} bytes</dd>
      <dt>File</dt><dd className="library-identity">{file.file_id}</dd><dt>Immutable version</dt><dd className="library-identity">{file.version_id}</dd>
      <dt>SHA256 of imported bytes</dt><dd className="library-identity">{file.sha256}</dd></dl>
    <p>Availability has not been checked by this metadata view. Read or Open checks the retained version.</p>
    <div className="library-toolbar">{file.media_type==='application/pdf'?<a className="library-read-link" href={evidenceHref}>Read PDF in Evidence</a>:<button ref={readButton} disabled={reading} onClick={()=>setReading(true)}>Read text</button>}<button disabled={busy} onClick={()=>void act('open')}>Open externally</button></div>
    <p><a href={evidenceHref}>Open in Evidence / add to project</a> · Choose a project there, then explicitly add this exact version to open its reader. An existing membership is reused.</p>
    {error&&<p role="alert">{error}</p>}{notice&&<p role="status">{notice}</p>}
    {reading&&<LibraryTextReader file={file} onClose={()=>{restoreReadFocus.current=true;setReading(false);}}/>}
    <h3>Local paper associations</h3><p>Enter an existing paper ID from this app. No fuzzy matching, metadata merging or publication verification.</p>
    {file.paper_links.length?<ul>{file.paper_links.map(link=><li key={link.document_id}>Paper {link.document_id}: {link.title} · owner association</li>)}</ul>:<p>No local papers associated.</p>}
    <form className="library-toolbar" onSubmit={e=>{e.preventDefault();void act('link');}}><label>Existing paper ID<input inputMode="numeric" value={paper} onChange={e=>setPaper(e.target.value)}/></label><button disabled={busy||!paper.trim()}>Associate paper</button></form>
  </section>;
}
