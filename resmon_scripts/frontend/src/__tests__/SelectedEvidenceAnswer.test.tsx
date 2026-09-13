import React from 'react';import {render,screen,fireEvent,act} from '@testing-library/react';import AnswerView from '../components/Evidence/AnswerView';import {Answer} from '../api/selectedEvidence';import {Project} from '../api/evidence';import {libraryApi} from '../api/library';import * as download from '../lib/selectedEvidenceDownload';
jest.mock('../components/Evidence/EvidenceReader',()=>()=> <div>Resolved current reader</div>);
const project={project_id:'project',vault_id:'vault'} as Project;
const answer={answer_id:'answer-a',request_sha256:'hash-a',mode:'question',state:'succeeded',cleanup_state:'confirmed',request:{payload:{instruction:'<script>instruction</script>',requested:{runtime:'claude_cli',provider:'claude_code'},sources:[{source_id:'S01',original_name:'<img src="bad">.txt',file_id:'file',version_id:'version',sha256:'hash',page_number:1,text:'<script>source</script>'}],notes:[],coverage:{},disclosure:{}}},reports:[],usage:null,limitations:'Exact text identity only; support unchecked',result:{sections:[{kind:'summary',items:[{kind:'interpretation',text:'<script>answer</script>',note_ids:[],citations:[{source_id:'S01',start_codepoint:0,end_codepoint:8,quote:'<script>'}]}]}],limitations:[]}} as unknown as Answer;
afterEach(()=>jest.restoreAllMocks());
it('renders source and output as literal text and keeps frozen citation after the current original is missing',async()=>{jest.spyOn(libraryApi,'detail').mockRejectedValue(new Error('Current original missing'));const view=render(<AnswerView project={project} answer={answer}/>);expect(view.container.querySelector('script,img,a')).toBeNull();fireEvent.click(screen.getByRole('button',{name:/Open citation S01/}));await screen.findByText('Current original missing');expect(screen.getByRole('region',{name:'Saved citation excerpt'})).toHaveTextContent('<script>');expect(screen.queryByText('Resolved current reader')).toBeNull();});
it('shows incomplete text as unvalidated and cancels a retired export',async()=>{let finish!:()=>void;const call=jest.spyOn(download,'downloadSelectedAnswer').mockImplementation(()=>new Promise(r=>{finish=r;}));const view=render(<AnswerView project={project} answer={{...answer,state:'cancelled',result:null,partial_text:'partial literal <script>'}}/>);expect(screen.getByRole('region',{name:'Unvalidated answer text'})).toHaveTextContent('partial literal <script>');fireEvent.click(screen.getByRole('button',{name:'Export this answer and selected text'}));view.rerender(<AnswerView project={project} answer={{...answer,answer_id:'answer-b'}}/>);expect(call.mock.calls[0][2].aborted).toBe(true);await act(async()=>finish());expect(screen.queryByText(/handed to the browser/)).toBeNull();});

it('offers distinct HTML and unchanged ZIP actions with format-specific delivery status',async()=>{
  const call=jest.spyOn(download,'downloadSelectedAnswer').mockResolvedValue();render(<AnswerView project={project} answer={answer}/>);
  fireEvent.click(screen.getByRole('button',{name:'Export HTML'}));
  await screen.findByText(/selected HTML was handed/);expect(call.mock.calls[0][3]).toBe('html');
  fireEvent.click(screen.getByRole('button',{name:'Export this answer and selected text'}));
  await screen.findByText(/selected ZIP was handed/);expect(call.mock.calls[1]).toHaveLength(3);
});
it.each(['answer','project','unmount'])('retired HTML error cannot change another selection: %s',async change=>{
  let reject!:(error:Error)=>void;const call=jest.spyOn(download,'downloadSelectedAnswer').mockImplementation(()=>new Promise((_,r)=>{reject=r;}));
  const view=render(<AnswerView project={project} answer={answer}/>);fireEvent.click(screen.getByRole('button',{name:'Export HTML'}));
  expect(screen.getByRole('button',{name:'Export HTML'})).toBeDisabled();expect(screen.getByRole('status')).toHaveTextContent('HTML');
  if(change==='unmount')view.unmount();
  else view.rerender(<AnswerView project={change==='project'?{...project,project_id:'other'}:project} answer={change==='answer'?{...answer,answer_id:'b'}:answer}/>);
  expect(call.mock.calls[0][2].aborted).toBe(true);
  await act(async()=>reject(new Error('RETIRED_HTML_ERROR')));
  expect(screen.queryByText('RETIRED_HTML_ERROR')).toBeNull();
});
it('an active HTML error stays literal and re-enables both export actions',async()=>{
  jest.spyOn(download,'downloadSelectedAnswer').mockRejectedValue(new Error('HTML <img src=bad> failure'));
  const view=render(<AnswerView project={project} answer={answer}/>);fireEvent.click(screen.getByRole('button',{name:'Export HTML'}));
  await screen.findByText('HTML <img src=bad> failure');expect(view.container.querySelector('img')).toBeNull();
  expect(screen.getByRole('button',{name:'Export HTML'})).toBeEnabled();
});

jest.mock('../components/Evidence/SelectionDialog',()=>({__esModule:true,default:({onSend,onClose}:{onSend:(p:unknown)=>Promise<void>;onClose:()=>void})=><section><button onClick={()=>void onSend({owner_runtime_id:'runtime'})}>Fixture Send</button><button onClick={onClose}>Fixture close</button></section>}));
import AnswerPanel from '../components/Evidence/AnswerPanel';import {selectedApi} from '../api/selectedEvidence';
it('a late successful Send after closing selection cancels its exact admitted answer without adopting it',async()=>{let release!:(a:Answer)=>void;jest.spyOn(selectedApi,'setup').mockResolvedValue({runtimeId:'runtime',descriptor:{}} as Awaited<ReturnType<typeof selectedApi.setup>>);jest.spyOn(selectedApi,'history').mockResolvedValue({items:[],has_more:false,through_id:0,next_after_id:null,total:0,count_basis:'fixture'});jest.spyOn(selectedApi,'send').mockImplementation(()=>new Promise(r=>{release=r;}));const cancel=jest.spyOn(selectedApi,'cancel').mockResolvedValue(answer);render(<AnswerPanel project={project} files={null} notes={null} file={null} anchor={null} onNextFiles={()=>{}} onNextNotes={()=>{}}/>);fireEvent.click(screen.getByRole('button',{name:'New selected-evidence answer'}));fireEvent.click(await screen.findByRole('button',{name:'Fixture Send'}));fireEvent.click(screen.getByRole('button',{name:'Fixture close'}));await act(async()=>release(answer));expect(cancel).toHaveBeenCalledWith(project,answer.answer_id,'runtime');expect(screen.queryByRole('article',{name:'Selected evidence answer'})).toBeNull();});
