import {boundedBytes,evidenceRequest,Project,sha256} from '../api/evidence';
import {Answer} from '../api/selectedEvidence';
export type SelectedAnswerFormat='zip'|'html';
export async function downloadSelectedAnswer(project:Project,answer:Answer,signal:AbortSignal,format:SelectedAnswerFormat='zip'):Promise<void>{
  if(format!=='zip'&&format!=='html')throw new Error('Select ZIP or HTML explicitly.');
  if(answer.vault_id!==project.vault_id||answer.project_id!==project.project_id)throw new Error('Select an answer from this project.');
  const isHtml=format==='html',label=isHtml?'HTML':'ZIP',limit=isHtml?4194304:4259840;
  const type=isHtml?'text/html; charset=utf-8':'application/zip';
  const query=new URLSearchParams({expected_vault_id:project.vault_id,format});
  const response=await evidenceRequest(`/projects/${project.project_id}/answers/${answer.answer_id}/export?${query}`,'GET',undefined,signal);
  const expected={'X-Resmon-Evidence-Contract':isHtml?'selected-answer-html/v1':'selected-answer/v1','X-Resmon-Vault':project.vault_id,'X-Resmon-Project':project.project_id,'X-Resmon-Bundle':answer.answer_id,'X-Resmon-Version':answer.request_sha256,'Content-Type':type,'Content-Disposition':`attachment; filename="selected-answer.${format}"`};
  const length=Number(response.headers.get('Content-Length')),hash=response.headers.get('X-Resmon-SHA256');
  if(isHtml&&!/^[1-9][0-9]*$/.test(response.headers.get('Content-Length')??''))throw new Error('Selected-answer HTML length is malformed.');
  if(Object.entries(expected).some(([k,v])=>response.headers.get(k)!==v)||!hash||!/^[0-9a-f]{64}$/.test(hash)||!Number.isSafeInteger(length)||length<1||length>limit)throw new Error(`Selected-answer ${label} headers or identity do not match.`);
  const raw=new Uint8Array(await boundedBytes(response,limit));
  const digest=await sha256(raw);
  if(signal.aborted||raw.length!==length||digest!==hash)throw new Error(`Selected-answer ${label} was cancelled, incomplete or hash-mismatched.`);
  if(isHtml){
    // Decode only to validate UTF-8 and the authored envelope; never insert it
    // into the app DOM or interpret content from an export response.
    const text=new TextDecoder('utf-8',{fatal:true}).decode(raw);
    if(!text.startsWith('<!doctype html>')||!text.endsWith('</html>'))throw new Error('Selected-answer HTML document is incomplete.');
  }else if(raw.slice(0,4).join(',')!=='80,75,3,4')throw new Error('Selected-answer ZIP was cancelled, incomplete or hash-mismatched.');
  if(signal.aborted)throw new Error('Download cancelled.');
  const url=URL.createObjectURL(new Blob([raw],{type}));const link=document.createElement('a');
  try{link.href=url;link.download=`resmon-answer-${answer.answer_id}.${format}`;document.body.appendChild(link);if(signal.aborted)throw new Error('Download cancelled.');link.click();}finally{link.remove();window.setTimeout(()=>URL.revokeObjectURL(url),1000);}
}
