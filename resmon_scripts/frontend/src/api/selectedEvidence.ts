import {Anchor,boundedBytes,evidenceBaseUrl,evidenceRequest,integer,Page,Project,sha256} from './evidence';
import {object,uuid} from './library';
import {ChoiceRequest,ChoicesDescriptor,SavedChoices} from '../components/Assistant/ComposerChoices';
import {fetchConnection} from './connection';

export interface Selection {file_id:string;version_id:string;sha256:string;page_number:number;range:Omit<Anchor,'page_number'>|null}
export interface SelectedNote {note_id:string;expected_note_revision:number}
export interface Source {source_id:string;source_sha256:string;vault_id:string;project_id:string;file_id:string;version_id:string;sha256:string;byte_size:number;media_type:string;original_name:string;page_number:number;page_count:number|null;extraction_contract:string;page_text_sha256:string;start_codepoint:number;end_codepoint:number;text:string}
export interface NoteSnapshot {note_id:string;revision:number;kind:'note'|'passage';body:string;provenance:'owner_note';file_id:string;version_id:string;created_at_utc:string;updated_at_utc:string;anchor:Anchor|null}
export interface Payload {version:1;profile:'selected_evidence_v1';vault_id:string;project_id:string;project_revision:number;mode:'question'|'briefing';instruction:string;requested:SavedChoices;sources:Source[];notes:NoteSnapshot[];system_version:string;system_sha256:string;response_contract:unknown;coverage:{files:{file_id:string;version_id:string;known_page_count:number|null;selected_pages:number[];anchor_checked_pages:number[];unexamined_page_count:number|null}[];file_count:number;page_count:number;segment_count:number;source_bytes:number;source_codepoints:number;note_count:number;note_bytes:number};disclosure:{custom_endpoint:boolean;limitations:string;source_strings_may_contain_private_material:string;retained_digest_reads_selected_file_bytes:boolean;pdf_structure_examined_for_selected_pages:boolean}}
export interface RequestSnapshot {payload:Payload;request_sha256:string;user_prompt:string;user_sha256:string;system_text:string;system_sha256:string}
export interface Preview {contract_version:1;preview_id:string;vault_id:string;project_id:string;owner_runtime_id:string;expires_at_utc:string;request_sha256:string;request:RequestSnapshot}
export interface Citation {source_id:string;start_codepoint:number;end_codepoint:number;quote:string}
export interface AnswerItem {kind:'source_statement'|'interpretation'|'note_summary'|'question';text:string;citations:Citation[];note_ids:string[]}
export interface AnswerResult {version:1;request_sha256:string;mode:'question'|'briefing';status:'answer'|'insufficient_evidence';sections:{kind:string;items:AnswerItem[]}[];limitations:string[]}
export type AnswerState='admitted'|'running'|'succeeded'|'refused'|'failed'|'cancelled'|'interrupted';
export interface AnswerSummary {id:number;answer_id:string;request_sha256:string;mode:'question'|'briefing';state:AnswerState;created_at_utc:string;finished_at_utc:string|null;cleanup_state:'not_started'|'pending'|'confirmed'|'unknown'}
export interface Answer extends AnswerSummary {contract_version:1;vault_id:string;project_id:string;project_revision:number;request:RequestSnapshot;partial_text:string;result:AnswerResult|null;reports:{model:string;source:string;observed_at_utc:string}[];usage:unknown;validation:string;current_originals:string;limitations:string;error_code:string|null;error_message:string|null;started_at_utc:string|null}
export interface AnswerEvent {type:'initial'|'progress'|'partial'|'report'|'terminal';sequence:number;answer_id:string;request_sha256:string;project_id:string;vault_id:string;owner_runtime_id:string;state?:AnswerState;cleanup_state?:AnswerSummary['cleanup_state'];partial_text?:string;model_report?:Answer['reports'][number];answer?:Answer}
const fail=():never=>{throw new Error('Selected-answer response identity or content does not match. Refresh explicitly.');};
const digest=(x:unknown):x is string=>typeof x==='string'&&/^[0-9a-f]{64}$/.test(x);
const literal=(x:unknown,max=262144):x is string=>typeof x==='string'&&Array.from(x).length<=max&&!/[\x00\uD800-\uDFFF]/u.test(x);
export const terminal=(state:AnswerState)=>!['admitted','running'].includes(state);
export function canonical(value:unknown):string {
  if(value===null||typeof value==='boolean')return JSON.stringify(value);
  if(typeof value==='number'){if(!Number.isSafeInteger(value))fail();return String(value);}
  if(typeof value==='string'){if(!literal(value))fail();return JSON.stringify(value);}
  if(Array.isArray(value))return '['+value.map(canonical).join(',')+']';
  const x=object(value);return '{'+Object.keys(x).sort().map(k=>JSON.stringify(k)+':'+canonical(x[k])).join(',')+'}';
}
const report=(raw:unknown)=>{const r=object(raw);if(!literal(r.model,1000)||!r.model||!['claude_system_init_model','api_response_model','google_response_modelVersion'].includes(String(r.source))||typeof r.observed_at_utc!=='string'||!Number.isFinite(Date.parse(r.observed_at_utc)))fail();};
const hash=(value:string)=>sha256(new TextEncoder().encode(value));
export async function validateRequest(raw:unknown,project:Project):Promise<RequestSnapshot>{
  const x=object(raw),p=object(x.payload);
  if(p.version!==1||p.profile!=='selected_evidence_v1'||p.vault_id!==project.vault_id||p.project_id!==project.project_id||!integer(p.project_revision,1)||!['question','briefing'].includes(String(p.mode))||!literal(p.instruction,4000)||!digest(x.request_sha256)||!literal(x.user_prompt)||!literal(x.system_text,16384)||!digest(x.system_sha256)||!digest(x.user_sha256)||p.system_sha256!==x.system_sha256||p.system_version!=='selected-evidence/v1')fail();
  if(!Array.isArray(p.sources)||p.sources.length<1||p.sources.length>24||!Array.isArray(p.notes)||p.notes.length>8)fail();
  let points=0,bytes=0;
  for(const [i,rawSource] of (p.sources as unknown[]).entries()){
    const s=object(rawSource);
    if(s.source_id!==`S${String(i+1).padStart(2,'0')}`||s.vault_id!==project.vault_id||s.project_id!==project.project_id||!uuid(s.file_id)||!uuid(s.version_id)||!digest(s.sha256)||!digest(s.page_text_sha256)||!digest(s.source_sha256)||!integer(s.page_number,1,200)||!integer(s.start_codepoint)||!integer(s.end_codepoint,1)||!literal(s.text,24000)||!literal(s.original_name,255)||!literal(s.extraction_contract,100)||(s.end_codepoint as number)-(s.start_codepoint as number)!==Array.from(s.text as string).length)fail();
    const basis=Object.fromEntries(Object.entries(s).filter(([k])=>!['source_id','source_sha256'].includes(k)));
    if(await hash(canonical(basis))!==s.source_sha256)fail();
    points+=Array.from(s.text as string).length;bytes+=new TextEncoder().encode(s.text as string).length;
  }
  let noteBytes=0;const noteIds=new Set();for(const rawNote of p.notes as unknown[]){const n=object(rawNote);if(!uuid(n.note_id)||noteIds.has(n.note_id)||!integer(n.revision,1)||n.provenance!=='owner_note'||!literal(n.body,2000)||!(p.sources as Source[]).some(s=>s.file_id===n.file_id&&s.version_id===n.version_id)||!['note','passage'].includes(String(n.kind)))fail();noteIds.add(n.note_id);noteBytes+=new TextEncoder().encode(n.body as string).length;}
  const coverage=object(p.coverage);if(coverage.source_bytes!==bytes||coverage.source_codepoints!==points||coverage.segment_count!==(p.sources as unknown[]).length||coverage.note_count!==(p.notes as unknown[]).length||coverage.note_bytes!==noteBytes||noteBytes>8192||!integer(coverage.file_count,1,5)||!integer(coverage.page_count,1,12)||!Array.isArray(coverage.files)||coverage.files.length!==coverage.file_count)fail();
  if(points>24000||bytes>49152||new TextEncoder().encode(x.user_prompt as string).length>98304||new TextEncoder().encode(x.system_text as string).length>16384||await hash(canonical(p))!==x.request_sha256||await hash(x.user_prompt as string)!==x.user_sha256||await hash(x.system_text as string)!==x.system_sha256||x.user_prompt!==canonical({request_sha256:x.request_sha256,payload:p}))fail();
  return x as unknown as RequestSnapshot;
}
function summary(raw:unknown):AnswerSummary{const x=object(raw);if(!integer(x.id,1)||!uuid(x.answer_id)||!digest(x.request_sha256)||!['question','briefing'].includes(String(x.mode))||!['admitted','running','succeeded','refused','failed','cancelled','interrupted'].includes(String(x.state))||!['not_started','pending','confirmed','unknown'].includes(String(x.cleanup_state))||typeof x.created_at_utc!=='string')fail();return x as unknown as AnswerSummary;}
export async function validateAnswer(raw:unknown,project:Project,answerId?:string,requestHash?:string):Promise<Answer>{
  const x=object(raw);summary(x);
  if(x.contract_version!==1||x.vault_id!==project.vault_id||x.project_id!==project.project_id||(answerId&&x.answer_id!==answerId)||(requestHash&&x.request_sha256!==requestHash)||!literal(x.partial_text,65536)||new TextEncoder().encode(x.partial_text as string).length>65536||!Array.isArray(x.reports)||x.reports.length>64||typeof x.validation!=='string'||typeof x.limitations!=='string')fail();
  const request=await validateRequest(x.request,project);
  if(request.request_sha256!==x.request_sha256||request.payload.mode!==x.mode||request.payload.project_revision!==x.project_revision)fail();
  (x.reports as unknown[]).forEach(report);if(new TextEncoder().encode(JSON.stringify(x.reports)).length>16384)fail();
  if(x.result!==null){const r=object(x.result);if(r.request_sha256!==x.request_sha256||r.mode!==x.mode||r.version!==1||!Array.isArray(r.sections)||!Array.isArray(r.limitations)||r.sections.length<1||r.limitations.length>36||!['answer','insufficient_evidence'].includes(String(r.status))||(r.status==='answer')!==(x.state==='succeeded'))fail();
    let items=0,citations=0,visible=0;
    for(const rawSection of r.sections as unknown[]){const section=object(rawSection);if(!['summary','details','limitations','questions'].includes(String(section.kind))||!Array.isArray(section.items))fail();
      for(const rawItem of section.items as unknown[]){const item=object(rawItem);items++;if(!literal(item.text,20000)||!['source_statement','interpretation','note_summary','question'].includes(String(item.kind))||!Array.isArray(item.citations)||!Array.isArray(item.note_ids)||!item.text)fail();
        const ids=item.note_ids as unknown[],refs=item.citations as unknown[];visible+=Array.from(item.text as string).length;
        if(ids.length>8||new Set(ids).size!==ids.length||ids.some(id=>!request.payload.notes.some(n=>n.note_id===id))||(['source_statement','interpretation'].includes(String(item.kind))&&!refs.length)||(item.kind==='note_summary'?(!ids.length||refs.length>0):ids.length>0))fail();
        for(const rawCitation of item.citations as unknown[]){citations++;const c=object(rawCitation);const s=request.payload.sources.find(s=>s.source_id===c.source_id);if(!s||!integer(c.start_codepoint,s.start_codepoint,s.end_codepoint-1)||!integer(c.end_codepoint,(c.start_codepoint as number)+1,s.end_codepoint)||!literal(c.quote,1000)||Array.from(s.text).slice((c.start_codepoint as number)-s.start_codepoint,(c.end_codepoint as number)-s.start_codepoint).join('')!==c.quote||!c.quote)fail();visible+=Array.from(c.quote as string).length;}
      }
    }
    for(const limit of r.limitations as unknown[]){if(!literal(limit,20000)||!limit)fail();visible+=Array.from(limit as string).length;}
    if(visible>20000||items>36||citations>72||(r.sections as unknown[]).length>6||!['succeeded','refused'].includes(String(x.state)))fail();
  }else if(['succeeded','refused'].includes(String(x.state)))fail();
  return {...x,request} as unknown as Answer;
}
const base=(p:Project)=>`/projects/${p.project_id}`;
const query=(p:Project,extra:Record<string,string|number|undefined>={})=>'?'+new URLSearchParams(Object.entries({expected_vault_id:p.vault_id,...extra}).filter(([,v])=>v!==undefined).map(([k,v])=>[k,String(v)]));
async function read(path:string,method='GET',body?:unknown,signal?:AbortSignal):Promise<unknown>{const r=await evidenceRequest(path,method,body,signal);return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(await boundedBytes(r,1048576)));}
export const selectedApi={
  setup:async():Promise<{runtimeId:string;descriptor:ChoicesDescriptor}>=>{evidenceBaseUrl();const connection=await fetchConnection();if(!connection.identity)fail();const r=await fetch(evidenceBaseUrl()+'/api/assistant/status',{cache:'no-store'});if(!r.ok)fail();const x=object(await r.json());const descriptor=object(x.composer_choices);if(descriptor.version!==1||!Array.isArray(descriptor.connections)||!Array.isArray(descriptor.claude_aliases)||!Array.isArray(descriptor.claude_efforts))fail();return {runtimeId:connection.identity!.runtime_id,descriptor:descriptor as unknown as ChoicesDescriptor};},
  preview:async(p:Project,runtime:string,selections:Selection[],notes:SelectedNote[],mode:'question'|'briefing',instruction:string,choices:ChoiceRequest,signal?:AbortSignal):Promise<Preview>=>{
    const x=object(await read(base(p)+'/answer-previews','POST',{expected_vault_id:p.vault_id,expected_revision:p.revision,expected_runtime_id:runtime,selections,notes,mode,instruction,choices},signal));
    if(x.contract_version!==1||!uuid(x.preview_id)||x.vault_id!==p.vault_id||x.project_id!==p.project_id||x.owner_runtime_id!==runtime||typeof x.expires_at_utc!=='string')fail();
    const request=await validateRequest(x.request,p);if(request.request_sha256!==x.request_sha256||request.payload.mode!==mode||request.payload.instruction!==instruction||request.payload.project_revision!==p.revision)fail();
    return {...x,request} as unknown as Preview;
  },
  send:async(p:Project,preview:Preview)=>validateAnswer(await read(base(p)+'/answers','POST',{expected_vault_id:p.vault_id,expected_runtime_id:preview.owner_runtime_id,preview_id:preview.preview_id,request_sha256:preview.request_sha256,confirmed:true}),p,undefined,preview.request_sha256),
  detail:async(p:Project,id:string,signal?:AbortSignal)=>validateAnswer(await read(base(p)+`/answers/${id}`+query(p),'GET',undefined,signal),p,id),
  cancel:async(p:Project,id:string,runtime:string)=>validateAnswer(await read(base(p)+`/answers/${id}/cancel`,'POST',{expected_vault_id:p.vault_id,expected_runtime_id:runtime}),p,id),
  history:async(p:Project,through?:number,after=0,signal?:AbortSignal):Promise<Page<AnswerSummary>>=>{const x=object(await read(base(p)+'/answers'+query(p,{through_id:through,after_id:after}),'GET',undefined,signal));if(x.contract_version!==1||x.vault_id!==p.vault_id||x.project_id!==p.project_id||!Array.isArray(x.answers)||x.answers.length>50||!integer(x.through_id)||(through!==undefined&&x.through_id!==through)||!integer(x.total,0,1000)||typeof x.has_more!=='boolean'||typeof x.count_basis!=='string')fail();const items=(x.answers as unknown[]).map(summary);if(items.some((s,i)=>s.id<=after||s.id>(x.through_id as number)||(i>0&&s.id<=items[i-1].id))||(x.has_more?items.length===0||x.next_after_id!==items[items.length-1].id:x.next_after_id!==null))fail();return {items,through_id:x.through_id as number,next_after_id:x.next_after_id as number|null,has_more:x.has_more as boolean,total:x.total as number,count_basis:x.count_basis as string};},
  events:async(p:Project,answer:Answer,runtime:string,onEvent:(e:AnswerEvent)=>void,signal:AbortSignal):Promise<void>=>{
    const response=await evidenceRequest(base(p)+`/answers/${answer.answer_id}/events`+query(p,{expected_runtime_id:runtime}),'GET',undefined,signal);
    if(!response.headers.get('content-type')?.startsWith('text/event-stream'))fail();const reader=response.body?.getReader();if(!reader)fail();
    const decoder=new TextDecoder('utf-8',{fatal:true});let pending='',sequence=-1,total=0;
    try{while(true){const {value,done}=await reader!.read();if(done)break;total+=value.length;if(total>8388608)fail();pending+=decoder.decode(value,{stream:true});if(new TextEncoder().encode(pending).length>524288)fail();let at:number;
      while((at=pending.indexOf('\n\n'))>=0){const frame=pending.slice(0,at);pending=pending.slice(at+2);if(!frame.startsWith('data: '))continue;const x=object(JSON.parse(frame.slice(6)));if(x.answer_id!==answer.answer_id||x.request_sha256!==answer.request_sha256||x.project_id!==p.project_id||x.vault_id!==p.vault_id||x.owner_runtime_id!==runtime||!integer(x.sequence,sequence+1)||!['initial','progress','partial','report','terminal'].includes(String(x.type)))fail();sequence=x.sequence as number;if(x.partial_text!==undefined&&(!literal(x.partial_text,65536)||new TextEncoder().encode(x.partial_text as string).length>65536))fail();if(x.model_report!==undefined)report(x.model_report);if(x.answer!==undefined)await validateAnswer(x.answer,p,answer.answer_id,answer.request_sha256);onEvent(x as unknown as AnswerEvent);}
    }if(pending.trim())fail();}finally{await reader!.cancel();reader!.releaseLock();}
  },
};
