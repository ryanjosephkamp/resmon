import React,{useEffect,useRef,useState} from 'react';
import {Anchor,EvidenceFile,Member,Page,Project,SavedNote} from '../../api/evidence';
import {Answer,Preview,selectedApi,terminal} from '../../api/selectedEvidence';
import {ChoicesDescriptor} from '../Assistant/ComposerChoices';
import SelectionDialog from './SelectionDialog';
import AnswerView from './AnswerView';
import AnswerHistory from './AnswerHistory';
export default function AnswerPanel({project,files,notes,file,anchor,onNextFiles,onNextNotes}:{project:Project;files:Page<Member>|null;notes:Page<SavedNote>|null;file:EvidenceFile|null;anchor:Anchor|null;onNextFiles:()=>void;onNextNotes:()=>void}){
  const [setup,setSetup]=useState<{runtimeId:string;descriptor:ChoicesDescriptor}|null>(null),[dialog,setDialog]=useState(false),[answer,setAnswer]=useState<Answer|null>(null),[error,setError]=useState(''),[busy,setBusy]=useState(false),[active,setActive]=useState(false),[refresh,setRefresh]=useState(0);
  const trigger=useRef<HTMLButtonElement>(null);
  const generation=useRef(0),alive=useRef(true),events=useRef<AbortController|null>(null),owned=useRef<{answer:Answer;runtime:string}|null>(null);
  useEffect(()=>{alive.current=true;return()=>{alive.current=false;++generation.current;events.current?.abort();const job=owned.current;if(job)void selectedApi.cancel(project,job.answer.answer_id,job.runtime).catch(()=>{});};},[project.project_id,project.vault_id]);
  const openSelection=async()=>{const ticket=++generation.current;setBusy(true);setError('');try{const result=await selectedApi.setup();if(alive.current&&ticket===generation.current){setSetup(result);setDialog(true);}}catch(e){if(alive.current&&ticket===generation.current)setError(e instanceof Error?e.message:'Selected connection unavailable.');}finally{if(alive.current&&ticket===generation.current)setBusy(false);}};
  const openAnswer=async(id:string)=>{const ticket=++generation.current;setError('');setBusy(true);try{const result=await selectedApi.detail(project,id);if(alive.current&&ticket===generation.current)setAnswer(result);}catch(e){if(alive.current&&ticket===generation.current)setError(e instanceof Error?e.message:'Saved answer unavailable.');}finally{if(alive.current&&ticket===generation.current)setBusy(false);}};
  const send=async(preview:Preview)=>{const ticket=++generation.current;setBusy(true);let result:Answer;try{result=await selectedApi.send(project,preview);}catch(error){if(alive.current&&ticket===generation.current)setBusy(false);throw error;}
    if(!alive.current||ticket!==generation.current){await selectedApi.cancel(project,result.answer_id,preview.owner_runtime_id);return;}
    owned.current={answer:result,runtime:preview.owner_runtime_id};setAnswer(result);setDialog(false);setActive(true);setBusy(false);setError('');setRefresh(n=>n+1);
    const controller=new AbortController();events.current=controller;
    void selectedApi.events(project,result,preview.owner_runtime_id,event=>{if(!alive.current||ticket!==generation.current)return;
      setAnswer(previous=>{if(!previous||previous.answer_id!==event.answer_id||previous.request_sha256!==event.request_sha256)return previous;
        if(event.type==='initial'&&event.answer)return event.answer;
        if(terminal(previous.state))return previous;
        if(event.type==='partial'&&event.partial_text!==undefined&&event.partial_text.startsWith(previous.partial_text))return {...previous,partial_text:event.partial_text,validation:'unvalidated'};
        if(event.type==='report'&&event.model_report&&!previous.reports.some(r=>JSON.stringify(r)===JSON.stringify(event.model_report)))return {...previous,reports:[...previous.reports,event.model_report]};
        return previous;
      });
    },controller.signal).then(async()=>{const final=await selectedApi.detail(project,result.answer_id);if(!terminal(final.state))await selectedApi.cancel(project,result.answer_id,preview.owner_runtime_id);return selectedApi.detail(project,result.answer_id);}).then(final=>{
      if(alive.current&&ticket===generation.current){setAnswer(final);setRefresh(n=>n+1);if(final.cleanup_state==='confirmed'){owned.current=null;setActive(false);}else setError('Local cleanup remains unresolved. New selected requests stay blocked.');}
    }).catch(async reason=>{
      try{const final=await selectedApi.cancel(project,result.answer_id,preview.owner_runtime_id);if(alive.current&&ticket===generation.current){setAnswer(final);setActive(final.cleanup_state!=='confirmed');if(final.cleanup_state==='confirmed')owned.current=null;}}
      catch{/* Keep the last exact identity and honest unknown cleanup. */}
      if(alive.current&&ticket===generation.current&&!controller.signal.aborted)setError(reason instanceof Error?reason.message:'Selected event stream failed; cancellation was requested.');
    });
  };
  const refreshCleanup=async()=>{const job=owned.current;if(!job)return;const ticket=generation.current;try{const current=await selectedApi.detail(project,job.answer.answer_id);if(alive.current&&ticket===generation.current){setAnswer(current);if(terminal(current.state)&&current.cleanup_state==='confirmed'){owned.current=null;setActive(false);setError('');setRefresh(n=>n+1);}}}catch(e){if(alive.current&&ticket===generation.current)setError(e instanceof Error?e.message:'Cleanup remains unknown.');}};
  const stop=async()=>{const job=owned.current;if(!job)return;const ticket=generation.current;try{const result=await selectedApi.cancel(project,job.answer.answer_id,job.runtime);if(alive.current&&ticket===generation.current)setAnswer(result);}catch(e){if(alive.current&&ticket===generation.current)setError(e instanceof Error?e.message:'Cancellation request failed; cleanup is unknown.');}};
  return <section className="selected-panel" aria-label="Evidence answers"><div className="evidence-toolbar"><h2>Answers</h2><button ref={trigger} disabled={busy||active} onClick={()=>void openSelection()}>New selected-evidence answer</button>{active&&<><button onClick={()=>void stop()}>Stop selected answer</button><button onClick={()=>void refreshCleanup()}>Recheck selected cleanup</button></>}</div>
    <p>Ask a question or make a manual briefing from explicit excerpts. Each Send creates one new saved answer; earlier answers and Ask history are never included.</p>
    {active&&<p role="status">This selected operation owns its local runtime until cleanup finishes. Leaving this project or page requests cancellation; remote completion and billing can remain unknown.</p>}{busy&&<p role="status">Loading selected answer details…</p>}{error&&<p role="alert">{error}</p>}
    {dialog&&setup&&<SelectionDialog project={project} files={files} notes={notes} file={file} anchor={anchor} runtime={setup.runtimeId} descriptor={setup.descriptor} onNextFiles={onNextFiles} onNextNotes={onNextNotes} onClose={()=>{++generation.current;setDialog(false);setBusy(false);requestAnimationFrame(()=>trigger.current?.focus());}} onSend={send}/>}
    {answer&&<AnswerView project={project} answer={answer}/>}<AnswerHistory project={project} refresh={refresh} onOpen={id=>void openAnswer(id)} disabled={active||busy}/>
  </section>;
}
