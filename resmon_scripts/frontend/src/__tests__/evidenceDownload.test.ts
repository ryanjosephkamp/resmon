import {downloadEvidence,MAX_BUNDLE_BYTES} from '../lib/evidenceDownload';
import {EvidenceFile,Project} from '../api/evidence';
const id=(n:number)=>`${n.toString().padStart(8,'0')}-1111-4111-8111-111111111111`;
const project={project_id:id(1),vault_id:id(2),revision:5} as Project;const file={file_id:id(3),version_id:id(4),vault_id:project.vault_id} as EvidenceFile;
const bytes=new Uint8Array([80,75,3,4,0]);let click:jest.SpyInstance;
function response(changes:Record<string,string|undefined>={},data=bytes){let done=false;const headers={'x-resmon-evidence-contract':'1','x-resmon-vault':project.vault_id,'x-resmon-project':project.project_id,'x-resmon-revision':'5','x-resmon-bundle':id(8),'content-type':'application/zip','content-disposition':'attachment; filename="selected-evidence.zip"','content-length':String(data.length),...changes};return {ok:true,headers:{get:(key:string)=>headers[key.toLowerCase() as keyof typeof headers]??null},body:{getReader:()=>({read:async()=>{if(done)return {done:true};done=true;return {value:data,done:false};},cancel:jest.fn(),releaseLock:jest.fn()})}};}
beforeEach(()=>{window.resmonAPI={getBackendPort:()=> '12345',platform:'test',versions:{node:'test',electron:'test'}};jest.useFakeTimers();global.fetch=jest.fn().mockResolvedValue(response());URL.createObjectURL=jest.fn().mockReturnValue('blob:owned');URL.revokeObjectURL=jest.fn();click=jest.spyOn(HTMLAnchorElement.prototype,'click').mockImplementation(()=>{});});
afterEach(()=>{jest.runOnlyPendingTimers();jest.useRealTimers();jest.restoreAllMocks();});
it('sends only the explicit identities, defaults chosen mode and downloads after exact headers/length',async()=>{
 await downloadEvidence(project,[file],false,new AbortController().signal);expect(click).toHaveBeenCalledTimes(1);const body=JSON.parse((fetch as jest.Mock).mock.calls[0][1].body);expect(body).toEqual({expected_vault_id:project.vault_id,expected_revision:5,selected:[{file_id:file.file_id,version_id:file.version_id}],include_files:false});jest.runOnlyPendingTimers();expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:owned');
});
it.each([{'x-resmon-project':id(9)},{'x-resmon-revision':'6'},{'content-length':'6'},{'content-length':String(MAX_BUNDLE_BYTES+1)},{'x-resmon-bundle':'../x'},{'content-disposition':'attachment; filename="../x"'}])('refuses mismatched identity or incomplete bytes without a download: %j',async(headers)=>{
 (fetch as jest.Mock).mockResolvedValue(response(headers));await expect(downloadEvidence(project,[file],true,new AbortController().signal)).rejects.toThrow();expect(click).not.toHaveBeenCalled();expect(URL.createObjectURL).not.toHaveBeenCalled();
});
it('refuses empty and duplicate selections before contacting the backend',async()=>{for(const selected of [[],[file,file]])await expect(downloadEvidence(project,selected,false,new AbortController().signal)).rejects.toThrow();expect(fetch).not.toHaveBeenCalled();});
it('does not download a delayed success after its owning dialog is cancelled',async()=>{
 let release!:(value:unknown)=>void;(fetch as jest.Mock).mockImplementation(()=>new Promise(resolve=>{release=resolve;}));const abort=new AbortController();const task=downloadEvidence(project,[file],false,abort.signal);abort.abort();release(response());await expect(task).rejects.toThrow(/cancelled/);expect(click).not.toHaveBeenCalled();
});

it('never falls back to an ambient backend or reserved daemon port',async()=>{for(const port of ['', '8742', '0', '65536']){window.resmonAPI!.getBackendPort=()=>port;await expect(downloadEvidence(project,[file],false,new AbortController().signal)).rejects.toThrow(/identified desktop/);}expect(fetch).not.toHaveBeenCalled();});
