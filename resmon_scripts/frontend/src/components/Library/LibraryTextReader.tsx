import React, { useEffect, useRef, useState } from 'react';
import { LibraryFile, TextEnvelope, libraryApi } from '../../api/library';

export default function LibraryTextReader({file, onClose}: {file: LibraryFile; onClose: ()=>void}) {
  const [text,setText] = useState<TextEnvelope|null>(null);
  const [error,setError] = useState(''); const [query,setQuery] = useState(''); const [match,setMatch] = useState(0);
  const epoch = useRef(0); const title = useRef<HTMLHeadingElement>(null); const region = useRef<HTMLDivElement>(null);
  useEffect(()=>{
    const ticket=++epoch.current; setText(null); setError(''); setQuery(''); setMatch(0); title.current?.focus();
    void libraryApi.text(file).then(value=>{if(epoch.current===ticket)setText(value);},err=>{if(epoch.current===ticket)setError(err instanceof Error?err.message:'Text could not be read.');});
    return ()=>{++epoch.current;};
  },[file.file_id,file.version_id,file.vault_id]);
  const lines=text?.text.split('\n')??[];
  const matches: {line:number;start:number}[]=[];
  if(query)lines.forEach((line,i)=>{let start=0;while(start<=line.length-query.length){const found=line.indexOf(query,start);if(found<0)break;matches.push({line:i,start:found});start=found+query.length;}});
  const selected=matches.length?Math.min(match,matches.length-1):0;
  const move=(next:number)=>{
    if(!matches.length)return;
    const n=(next+matches.length)%matches.length;setMatch(n);
    const el=region.current?.querySelector<HTMLElement>(`[data-library-line="${matches[n].line}"]`);el?.focus();el?.scrollIntoView({block:'nearest'});
  };
  const selectedMatch=matches[selected];
  return <section className="library-reader" aria-label="Retained text reader">
    <div className="library-toolbar"><h3 ref={title} tabIndex={-1}>Read retained text</h3><button type="button" onClick={()=>{++epoch.current;onClose();}}>Close reader</button></div>
    <p className="library-identity">{file.original_name} · version {file.version_id}</p>
    <p>Literal UTF-8 text. CRLF and CR display as LF; retained bytes stay unchanged. Line numbers are local navigation, not portable citations.</p>
    {!text&&!error&&<p role="status">Reading and checking the selected retained version…</p>}
    {error&&<p role="alert">Cannot read here: {error} The retained item remains available for a verified external Open request.</p>}
    {text&&<>
      <div className="library-toolbar">
        <label>Find in this text<input value={query} onChange={e=>{setQuery(e.target.value);setMatch(0);}} onKeyDown={e=>{if(e.key==='Enter'){e.preventDefault();move(selected+(e.shiftKey?-1:1));}}}/></label>
        <button disabled={!matches.length} onClick={()=>move(selected-1)}>Previous match</button>
        <button disabled={!matches.length} onClick={()=>move(selected+1)}>Next match</button>
        <span role="status">{!query?'Enter literal text to find.':matches.length?`${selected+1} of ${matches.length} matches`:'No matches.'}</span>
      </div>
      <p>{text.line_count} logical lines · {text.byte_size.toLocaleString()} original bytes · SHA256 {text.sha256}</p>
      <div ref={region} className="library-lines" role="region" aria-label="Literal retained lines" tabIndex={0}>
        {lines.map((line,i)=>{
          const active=selectedMatch?.line===i;const start=active?selectedMatch.start:-1;
          return <div key={i} data-library-line={i} tabIndex={-1} className={active?'library-line library-line-active':'library-line'}>
            <span className="library-line-number" aria-label={`Line ${i+1}`}>{i+1}</span><span>{active?<>{line.slice(0,start)}<mark>{line.slice(start,start+query.length)}</mark>{line.slice(start+query.length)}</>:line||' '}</span>
          </div>;
        })}
      </div>
    </>}
  </section>;
}
