import { getBaseUrl } from './client';
import { object, uuid, LibraryFile } from './library';

export type EvidenceFile = Pick<LibraryFile, 'file_id'|'version_id'|'vault_id'|'sha256'|'byte_size'|'media_type'|'original_name'|'created_at_utc'>;
export interface Project {id:number; project_id:string; vault_id:string; name:string; revision:number; created_at_utc:string; updated_at_utc:string; file_count:number; note_count:number}
export interface Member {id:number; project_id:string; file_id:string; version_id:string; added_at_utc:string; availability:'not_checked'; file:EvidenceFile}
export interface Anchor {page_number:number; extraction_contract:string; page_text_sha256:string; start_codepoint:number; end_codepoint:number; quote:string}
export interface SavedNote {id:number; note_id:string; project_id:string; file_id:string; version_id:string; kind:'note'|'passage'; body:string; revision:number; created_at_utc:string; updated_at_utc:string; file:EvidenceFile; membership_state:'member'|'removed'; resolution:'not_checked'; page_number:number|null; extraction_contract:string|null; page_text_sha256:string|null; start_codepoint:number|null; end_codepoint:number|null; quote:string|null}
export interface Page<T> {items:T[]; through_id:number; next_after_id:number|null; has_more:boolean; total:number; count_basis:string; revision?:number}
export interface TextPage {contract_version:1; vault_id:string; project_id:string; file_id:string; version_id:string; sha256:string; media_type:string; status:'extracted'|'no_text'|'unsupported'|'malformed'|'limit_exceeded'|'timeout'|'unavailable'; page_number:number; page_count:number|null; text:string; extraction_contract:string; page_text_sha256:string|null; examined_pages:number[]; remaining_pages:'not_examined'; coverage:string}
export const integer=(x:unknown,min=0,max=Number.MAX_SAFE_INTEGER):x is number=>Number.isSafeInteger(x)&&(x as number)>=min&&(x as number)<=max;
const literal=(x:unknown,min:number,max:number):x is string=>typeof x==='string'&&Array.from(x).length>=min&&Array.from(x).length<=max&&!/[\x00\uD800-\uDFFF]/u.test(x);
const digest=(x:unknown):x is string=>typeof x==='string'&&/^[a-f0-9]{64}$/.test(x);
const stamp=(x:unknown):x is string=>typeof x==='string'&&/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,6})?(?:\+00:00|Z)$/.test(x);
const fail=():never=>{throw new Error('Evidence response does not match the selected identity or bounds. Refresh explicitly.');};
export function validateFile(raw:unknown,vault:string):EvidenceFile {
  const x=object(raw);
  if(!uuid(vault)||x.vault_id!==vault||!uuid(x.file_id)||!uuid(x.version_id)||!digest(x.sha256)||!integer(x.byte_size,1,67108864)||!['application/pdf','text/plain','text/markdown'].includes(String(x.media_type))||!literal(x.original_name,1,255)||!stamp(x.created_at_utc))fail();
  return x as unknown as EvidenceFile;
}
export function validateProject(raw:unknown,vault:string,id?:string):Project {
  const x=object(raw);
  if(!integer(x.id,1)||!uuid(x.project_id)||x.vault_id!==vault||(id&&x.project_id!==id)||!literal(x.name,1,120)||!integer(x.revision,1)||!integer(x.file_count,0,1000)||!integer(x.note_count,0,5000)||!stamp(x.created_at_utc)||!stamp(x.updated_at_utc))fail();
  return x as unknown as Project;
}
export function validateNote(raw:unknown,vault:string,project:string):SavedNote {
  const x=object(raw);const f=validateFile(x.file,vault);
  if(!integer(x.id,1)||!uuid(x.note_id)||x.project_id!==project||x.file_id!==f.file_id||x.version_id!==f.version_id||!integer(x.revision,1)||!stamp(x.created_at_utc)||!stamp(x.updated_at_utc)||!['member','removed'].includes(String(x.membership_state))||x.resolution!=='not_checked'||!literal(x.body,x.kind==='note'?1:0,20000))fail();
  const fields=['page_number','extraction_contract','page_text_sha256','start_codepoint','end_codepoint','quote'];
  if(x.kind==='note'){if(fields.some(k=>x[k]!==null))fail();}
  else if(x.kind==='passage'){
    if(!integer(x.page_number,1,200)||!literal(x.extraction_contract,1,100)||!digest(x.page_text_sha256)||!integer(x.start_codepoint)||!integer(x.end_codepoint,1)||!literal(x.quote,1,20000)||(x.end_codepoint as number)-(x.start_codepoint as number)!==Array.from(x.quote as string).length)fail();
  }else fail();
  return x as unknown as SavedNote;
}
function envelope(raw:unknown,vault:string,project?:string):Record<string,unknown>{const x=object(raw);if(!uuid(vault)||x.contract_version!==1||x.vault_id!==vault||(project&&(!uuid(project)||x.project_id!==project)))fail();return x;}
const query=(values:Record<string,string|number|undefined>)=>'?'+new URLSearchParams(Object.entries(values).filter(([,v])=>v!==undefined).map(([k,v])=>[k,String(v)])).toString();
export function evidenceBaseUrl():string {
  const port=window.resmonAPI?.getBackendPort();
  if(!port||!/^([1-9][0-9]{0,4})$/.test(port)||Number(port)>65535||port==='8742')throw new Error('An explicitly identified desktop backend is required for Evidence. No default instance is selected.');
  const base=getBaseUrl();if(base!==`http://127.0.0.1:${port}`)throw new Error('The selected backend changed.');return base;
}
export async function evidenceRequest(path:string,method='GET',body?:unknown,signal?:AbortSignal):Promise<Response>{
  const response=await fetch(`${evidenceBaseUrl()}/api/evidence${path}`,{method,signal,cache:'no-store',headers:{'X-Resmon-Library':'1',...(body!==undefined?{'Content-Type':'application/json'}:{})},...(body!==undefined?{body:JSON.stringify(body)}:{})});
  if(!response.ok){let message=`Evidence request refused (${response.status}).`;try{const x=object(await response.json());const d=x.detail;if(typeof d==='string')message=d;else if(d&&typeof d==='object'&&typeof object(d).message==='string')message=String(object(d).message);}catch{/* Keep redacted status. */}throw new Error(message);}
  return response;
}
const read=async(path:string,method='GET',body?:unknown,signal?:AbortSignal):Promise<unknown>=>(await evidenceRequest(path,method,body,signal)).json();
const base=(p:Project)=>({expected_vault_id:p.vault_id,expected_revision:p.revision});
function projectResult(raw:unknown,vault:string,id?:string):Project{const x=envelope(raw,vault,id);const p=validateProject(x.project,vault,id);if(x.project_id!==p.project_id)fail();return p;}
function pageResult<T extends {id:number}>(x:Record<string,unknown>,key:string,validate:(raw:unknown)=>T,through?:number,after=0):Page<T>{
  if(!Array.isArray(x[key])||(x[key] as unknown[]).length>50||!integer(x.through_id)||(through!==undefined&&x.through_id!==through)||!integer(x.total)||typeof x.count_basis!=='string'||typeof x.has_more!=='boolean'||!(x.next_after_id===null||integer(x.next_after_id,1))||(x.revision!==undefined&&!integer(x.revision,1)))fail();
  const items=(x[key] as unknown[]).map(validate);
  if(items.some((it,i)=>it.id<=after||it.id>(x.through_id as number)||(i>0&&it.id<=items[i-1].id))||(x.has_more?items.length===0||x.next_after_id!==items[items.length-1].id:x.next_after_id!==null))fail();
  return {items,through_id:x.through_id as number,next_after_id:x.next_after_id as number|null,has_more:x.has_more as boolean,total:x.total as number,count_basis:x.count_basis as string,revision:x.revision as number|undefined};
}
export async function sha256(bytes:Uint8Array):Promise<string>{const copy=new Uint8Array(bytes);return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',copy.buffer)),b=>b.toString(16).padStart(2,'0')).join('');}
export async function validateText(raw:unknown,p:Project,f:EvidenceFile,page:number):Promise<TextPage>{
  const x=envelope(raw,p.vault_id,p.project_id);const expected=f.media_type==='application/pdf'?'pypdf-6.18.1/plain-lf/v1':'library-text-lf/v1';
  if(x.file_id!==f.file_id||x.version_id!==f.version_id||x.sha256!==f.sha256||x.media_type!==f.media_type||x.page_number!==page||!['extracted','no_text','unsupported','malformed','limit_exceeded','timeout','unavailable'].includes(String(x.status))||!literal(x.text,0,f.media_type==='application/pdf'?200000:262144)||/[\r\x00]/.test(x.text as string)||x.extraction_contract!==expected||!(x.page_count===null||integer(x.page_count,0))||!Array.isArray(x.examined_pages)||x.remaining_pages!=='not_examined'||typeof x.coverage!=='string'||new TextEncoder().encode(JSON.stringify(x)).length>2097152)fail();
  if(f.media_type!=='application/pdf'&&((x.text as string).split('\n').length>5000||f.byte_size>262144||page!==1))fail();
  if(x.status==='extracted'||x.status==='no_text'){
    if(!integer(x.page_count,page,200)||JSON.stringify(x.examined_pages)!==JSON.stringify([page])||(x.status==='extracted')!==Boolean(x.text))fail();
    if(x.status==='extracted'){if(!digest(x.page_text_sha256)||await sha256(new TextEncoder().encode(x.text as string))!==x.page_text_sha256)fail();}else if(x.page_text_sha256!==null)fail();
  }else if(x.text!==''||x.page_text_sha256!==null||(x.examined_pages as unknown[]).length!==0)fail();
  return x as unknown as TextPage;
}
export const evidenceApi={
  projects:async(vault:string,through?:number,after?:number,signal?:AbortSignal)=>pageResult(envelope(await read('/projects'+query({expected_vault_id:vault,through_id:through,after_id:after}),undefined,undefined,signal),vault),'projects',x=>validateProject(x,vault),through,after),
  create:async(vault:string,name:string)=>projectResult(await read('/projects','POST',{expected_vault_id:vault,name}),vault),
  detail:async(vault:string,id:string,signal?:AbortSignal)=>projectResult(await read(`/projects/${id}`+query({expected_vault_id:vault}),undefined,undefined,signal),vault,id),
  rename:async(p:Project,name:string)=>projectResult(await read(`/projects/${p.project_id}`,'PATCH',{...base(p),name}),p.vault_id,p.project_id),
  files:async(p:Project,through?:number,after?:number,signal?:AbortSignal)=>pageResult(envelope(await read(`/projects/${p.project_id}/files`+query({expected_vault_id:p.vault_id,through_id:through,after_id:after}),undefined,undefined,signal),p.vault_id,p.project_id),'files',raw=>{const x=object(raw);const f=validateFile(x.file,p.vault_id);if(!integer(x.id,1)||x.project_id!==p.project_id||x.file_id!==f.file_id||x.version_id!==f.version_id||x.availability!=='not_checked'||!stamp(x.added_at_utc))fail();return x as unknown as Member;},through,after),
  add:async(p:Project,f:EvidenceFile)=>{const x=envelope(await read(`/projects/${p.project_id}/files`,'POST',{...base(p),file_id:f.file_id,version_id:f.version_id}),p.vault_id,p.project_id);const m=object(x.membership);if(m.project_id!==p.project_id||m.file_id!==f.file_id||m.version_id!==f.version_id||typeof x.added!=='boolean')fail();return projectResult(x,p.vault_id,p.project_id);},
  remove:async(p:Project,f:EvidenceFile)=>{const x=envelope(await read(`/projects/${p.project_id}/files/${f.file_id}`,'DELETE',{...base(p),version_id:f.version_id}),p.vault_id,p.project_id);if(typeof x.removed!=='boolean')fail();return projectResult(x,p.vault_id,p.project_id);},
  notes:async(p:Project,through?:number,after?:number,signal?:AbortSignal)=>pageResult(envelope(await read(`/projects/${p.project_id}/notes`+query({expected_vault_id:p.vault_id,through_id:through,after_id:after}),undefined,undefined,signal),p.vault_id,p.project_id),'notes',x=>validateNote(x,p.vault_id,p.project_id),through,after),
  save:async(p:Project,f:EvidenceFile,body:string,anchor?:Anchor)=>{const x=envelope(await read(`/projects/${p.project_id}/notes`,'POST',{...base(p),file_id:f.file_id,version_id:f.version_id,kind:anchor?'passage':'note',body,anchor:anchor??null}),p.vault_id,p.project_id);const note=validateNote(x.note,p.vault_id,p.project_id);if(note.file_id!==f.file_id||note.version_id!==f.version_id||note.body!==body||note.kind!==(anchor?'passage':'note'))fail();if(anchor&&Object.entries(anchor).some(([k,v])=>object(note)[k]!==v))fail();return {project:projectResult(x,p.vault_id,p.project_id),note};},
  edit:async(p:Project,n:SavedNote,body:string)=>{const x=envelope(await read(`/projects/${p.project_id}/notes/${n.note_id}`,'PATCH',{...base(p),expected_note_revision:n.revision,body}),p.vault_id,p.project_id);const note=validateNote(x.note,p.vault_id,p.project_id);if(note.note_id!==n.note_id||note.body!==body||note.revision!==n.revision+1||['file_id','version_id','kind','page_number','extraction_contract','page_text_sha256','start_codepoint','end_codepoint','quote'].some(k=>object(note)[k]!==object(n)[k]))fail();return {project:projectResult(x,p.vault_id,p.project_id),note};},
  text:async(p:Project,f:EvidenceFile,page:number,signal?:AbortSignal)=>validateText(await read(`/projects/${p.project_id}/reader/${f.file_id}`+query({expected_vault_id:p.vault_id,version_id:f.version_id,page,representation:'text'}),undefined,undefined,signal),p,f,page),
  pdf:async(p:Project,f:EvidenceFile,signal?:AbortSignal)=>{const r=await evidenceRequest(`/projects/${p.project_id}/reader/${f.file_id}`+query({expected_vault_id:p.vault_id,version_id:f.version_id,representation:'pdf'}),'GET',undefined,signal);const headers={'X-Resmon-Evidence-Contract':'1','X-Resmon-Vault':p.vault_id,'X-Resmon-Project':p.project_id,'X-Resmon-File':f.file_id,'X-Resmon-Version':f.version_id,'X-Resmon-SHA256':f.sha256};if(Object.entries(headers).some(([k,v])=>r.headers.get(k)!==v)||f.byte_size>16777216)fail();const data=new Uint8Array(await boundedBytes(r,16777216));if(data.length!==f.byte_size||await sha256(data)!==f.sha256)fail();return data;},
};
export async function boundedBytes(response:Response,maximum:number):Promise<ArrayBuffer>{
  const reader=response.body?.getReader();if(!reader)throw new Error('A bounded response stream is unavailable.');const chunks:Uint8Array[]=[];let size=0;
  try{while(true){const {value,done}=await reader.read();if(done)break;size+=value.byteLength;if(size>maximum)throw new Error('Download exceeds its stated limit.');chunks.push(value);}}catch(error){await reader.cancel();throw error;}finally{reader.releaseLock();}
  const bytes=new Uint8Array(size);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.length;}return bytes.buffer;
}
