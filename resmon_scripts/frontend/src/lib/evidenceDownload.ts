import { boundedBytes,evidenceRequest,EvidenceFile,Project } from '../api/evidence';
import {uuid} from '../api/library';
export const MAX_BUNDLE_BYTES=256*1024*1024+8*1024*1024+65536;
export async function downloadEvidence(project:Project,files:EvidenceFile[],includeFiles:boolean,signal:AbortSignal):Promise<string>{
  if(!files.length||files.length>20||new Set(files.map(f=>f.file_id)).size!==files.length||files.some(f=>f.vault_id!==project.vault_id||!uuid(f.file_id)||!uuid(f.version_id)))throw new Error('Select 1–20 exact file versions from this project.');
  const response=await evidenceRequest(`/projects/${project.project_id}/bundle`,'POST',{expected_vault_id:project.vault_id,expected_revision:project.revision,selected:files.map(({file_id,version_id})=>({file_id,version_id})),include_files:includeFiles},signal);
  const expected={'X-Resmon-Evidence-Contract':'1','X-Resmon-Vault':project.vault_id,'X-Resmon-Project':project.project_id,'X-Resmon-Revision':String(project.revision),'Content-Type':'application/zip'};
  const bundle=response.headers.get('X-Resmon-Bundle');const length=Number(response.headers.get('Content-Length'));
  if(Object.entries(expected).some(([k,v])=>response.headers.get(k)!==v)||!uuid(bundle)||!Number.isSafeInteger(length)||length<1||length>MAX_BUNDLE_BYTES||response.headers.get('Content-Disposition')!=='attachment; filename="selected-evidence.zip"')throw new Error('Bundle response identity or size changed. Nothing was downloaded.');
  const bytes=await boundedBytes(response,MAX_BUNDLE_BYTES);if(bytes.byteLength!==length||signal.aborted)throw new Error('Bundle download was incomplete or cancelled.');
  const signature=new Uint8Array(bytes,0,Math.min(4,bytes.byteLength));if(signature.join(',')!=='80,75,3,4')throw new Error('Bundle response is not a ZIP archive.');
  const url=URL.createObjectURL(new Blob([bytes],{type:'application/zip'}));const anchor=document.createElement('a');
  try{anchor.href=url;anchor.download=`resmon-evidence-${project.project_id}-${bundle}.zip`;document.body.appendChild(anchor);if(!signal.aborted)anchor.click();else throw new Error('Bundle download cancelled.');}finally{anchor.remove();window.setTimeout(()=>URL.revokeObjectURL(url),1000);}
  return bundle;
}
