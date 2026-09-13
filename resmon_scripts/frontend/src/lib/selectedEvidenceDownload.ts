import {boundedBytes,evidenceRequest,Project,sha256} from '../api/evidence';
import {Answer} from '../api/selectedEvidence';
export async function downloadSelectedAnswer(project:Project,answer:Answer,signal:AbortSignal):Promise<void>{
  if(answer.vault_id!==project.vault_id||answer.project_id!==project.project_id)throw new Error('Select an answer from this project.');
  const query=new URLSearchParams({expected_vault_id:project.vault_id,format:'zip'});
  const response=await evidenceRequest(`/projects/${project.project_id}/answers/${answer.answer_id}/export?${query}`,'GET',undefined,signal);
  const expected={'X-Resmon-Evidence-Contract':'selected-answer/v1','X-Resmon-Vault':project.vault_id,'X-Resmon-Project':project.project_id,'X-Resmon-Bundle':answer.answer_id,'X-Resmon-Version':answer.request_sha256,'Content-Type':'application/zip','Content-Disposition':'attachment; filename="selected-answer.zip"'};
  const length=Number(response.headers.get('Content-Length')),hash=response.headers.get('X-Resmon-SHA256');
  if(Object.entries(expected).some(([k,v])=>response.headers.get(k)!==v)||!hash||!/^[0-9a-f]{64}$/.test(hash)||!Number.isSafeInteger(length)||length<1||length>4259840)throw new Error('Selected-answer ZIP headers or identity do not match.');
  const raw=new Uint8Array(await boundedBytes(response,4259840));
  if(signal.aborted||raw.length!==length||await sha256(raw)!==hash||raw.slice(0,4).join(',')!=='80,75,3,4')throw new Error('Selected-answer ZIP was cancelled, incomplete or hash-mismatched.');
  const url=URL.createObjectURL(new Blob([raw],{type:'application/zip'}));const link=document.createElement('a');
  try{link.href=url;link.download=`resmon-answer-${answer.answer_id}.zip`;document.body.appendChild(link);if(signal.aborted)throw new Error('Download cancelled.');link.click();}finally{link.remove();window.setTimeout(()=>URL.revokeObjectURL(url),1000);}
}
