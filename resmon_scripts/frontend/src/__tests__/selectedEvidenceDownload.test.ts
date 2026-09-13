import {downloadSelectedAnswer} from '../lib/selectedEvidenceDownload';import {Project} from '../api/evidence';import {Answer} from '../api/selectedEvidence';import {webcrypto,createHash} from 'crypto';import {Buffer} from 'buffer';
import {TextDecoder,TextEncoder} from 'util';
const project={project_id:'00000001-1111-4111-8111-111111111111',vault_id:'00000002-1111-4111-8111-111111111111'} as Project;const answer={...project,answer_id:'00000003-1111-4111-8111-111111111111',request_sha256:'a'.repeat(64)} as unknown as Answer;const bytes=new Uint8Array([80,75,3,4,0]);let click:jest.SpyInstance;
function response(changes:Record<string,string|undefined>={},data=bytes){let done=false;const headers:Record<string,string|undefined>={'x-resmon-evidence-contract':'selected-answer/v1','x-resmon-vault':project.vault_id,'x-resmon-project':project.project_id,'x-resmon-bundle':answer.answer_id,'x-resmon-version':answer.request_sha256,'x-resmon-sha256':createHash('sha256').update(data).digest('hex'),'content-type':'application/zip','content-disposition':'attachment; filename="selected-answer.zip"','content-length':String(data.length),...changes};return {ok:true,headers:{get:(key:string)=>headers[key.toLowerCase()]??null},body:{getReader:()=>({read:async()=>done?{done:true}:(done=true,{value:data,done:false}),cancel:jest.fn(),releaseLock:jest.fn()})}};}
beforeAll(()=>Object.defineProperty(globalThis,'crypto',{value:{subtle:{digest:(a:string,d:ArrayBuffer)=>webcrypto.subtle.digest(a,Buffer.from(new Uint8Array(d)))}},configurable:true}));
beforeEach(()=>{window.resmonAPI={getBackendPort:()=> '12345',platform:'test',versions:{node:'test',electron:'test'}};jest.useFakeTimers();global.fetch=jest.fn().mockResolvedValue(response());URL.createObjectURL=jest.fn().mockReturnValue('blob:owned');URL.revokeObjectURL=jest.fn();click=jest.spyOn(HTMLAnchorElement.prototype,'click').mockImplementation(()=>{});});afterEach(()=>{jest.runOnlyPendingTimers();jest.useRealTimers();jest.restoreAllMocks();});
it('downloads exactly one selected answer only after matching identity, bytes and hash, then revokes its URL',async()=>{await downloadSelectedAnswer(project,answer,new AbortController().signal);expect(click).toHaveBeenCalledTimes(1);expect((fetch as jest.Mock).mock.calls[0][0]).toContain(`/answers/${answer.answer_id}/export?`);jest.runOnlyPendingTimers();expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:owned');});
it.each([{'x-resmon-project':'wrong'},{'x-resmon-version':'b'.repeat(64)},{'x-resmon-sha256':'0'.repeat(64)},{'content-length':'6'},{'content-length':'4259841'},{'content-disposition':'attachment; filename="../x"'}])('refuses mismatched ZIP without browser delivery: %j',async headers=>{(fetch as jest.Mock).mockResolvedValue(response(headers));await expect(downloadSelectedAnswer(project,answer,new AbortController().signal)).rejects.toThrow();expect(click).not.toHaveBeenCalled();expect(URL.createObjectURL).not.toHaveBeenCalled();});
it('a cancelled delayed response cannot initiate a download',async()=>{let release!:(r:unknown)=>void;(fetch as jest.Mock).mockImplementation(()=>new Promise(r=>{release=r;}));const controller=new AbortController(),task=downloadSelectedAnswer(project,answer,controller.signal);controller.abort();release(response());await expect(task).rejects.toThrow();expect(click).not.toHaveBeenCalled();});

const htmlBytes=new TextEncoder().encode('<!doctype html><html><body>Literal 😀 &lt;script&gt;</body></html>');
const htmlHeaders={'x-resmon-evidence-contract':'selected-answer-html/v1','content-type':'text/html; charset=utf-8','content-disposition':'attachment; filename="selected-answer.html"'};
beforeAll(()=>Object.assign(globalThis,{TextDecoder,TextEncoder}));
it('HTML is a separate explicit verified download and is never inserted into the app DOM',async()=>{
  (fetch as jest.Mock).mockResolvedValue(response(htmlHeaders,htmlBytes));
  await downloadSelectedAnswer(project,answer,new AbortController().signal,'html');
  expect((fetch as jest.Mock).mock.calls[0][0]).toContain('format=html');
  expect(click).toHaveBeenCalledTimes(1);expect(click.mock.instances[0].download).toBe(`resmon-answer-${answer.answer_id}.html`);
  expect(document.body.textContent).not.toContain('Literal');expect(URL.createObjectURL).toHaveBeenCalledTimes(1);
});
it.each([
  {'x-resmon-evidence-contract':'selected-answer/v1'},{'x-resmon-vault':'wrong'},{'x-resmon-project':'wrong'},
  {'x-resmon-bundle':'wrong'},{'x-resmon-version':'b'.repeat(64)},{'x-resmon-sha256':'0'.repeat(64)},
  {'content-type':'application/zip'},{'content-disposition':'attachment; filename="untrusted.html"'},
  {'content-length':'4194305'},{'content-length':'0'},{'content-length':undefined},{'content-length':'1'},
])('refuses forged HTML identity/format/length/hash: %j',async changes=>{
  (fetch as jest.Mock).mockResolvedValue(response({...htmlHeaders,...changes},htmlBytes));
  await expect(downloadSelectedAnswer(project,answer,new AbortController().signal,'html')).rejects.toThrow();
  expect(click).not.toHaveBeenCalled();expect(URL.createObjectURL).not.toHaveBeenCalled();
});
it.each([new Uint8Array([0xff,0xfe]),new TextEncoder().encode('<!doctype html><html>partial'),bytes])('refuses invalid UTF-8 or incomplete HTML despite matching hash',async data=>{
  (fetch as jest.Mock).mockResolvedValue(response(htmlHeaders,data));
  await expect(downloadSelectedAnswer(project,answer,new AbortController().signal,'html')).rejects.toThrow();
  expect(URL.createObjectURL).not.toHaveBeenCalled();expect(click).not.toHaveBeenCalled();
});
it('HTML abort during body read refuses delivery and cancels a failed bounded stream',async()=>{
  const controller=new AbortController();const r=response(htmlHeaders,htmlBytes),reader=r.body.getReader();
  const read=reader.read;reader.read=async()=>{const value=await read();controller.abort();return value;};
  r.body.getReader=()=>reader;(fetch as jest.Mock).mockResolvedValue(r);
  await expect(downloadSelectedAnswer(project,answer,controller.signal,'html')).rejects.toThrow();
  expect(click).not.toHaveBeenCalled();expect(URL.createObjectURL).not.toHaveBeenCalled();
});
it('HTML abort during asynchronous digest is checked after hashing',async()=>{
  const controller=new AbortController();(fetch as jest.Mock).mockResolvedValue(response(htmlHeaders,htmlBytes));
  const digest=crypto.subtle.digest.bind(crypto.subtle);
  jest.spyOn(crypto.subtle,'digest').mockImplementation(async(algorithm,data)=>{const value=await digest(algorithm,data);controller.abort();return value;});
  await expect(downloadSelectedAnswer(project,answer,controller.signal,'html')).rejects.toThrow();
  expect(URL.createObjectURL).not.toHaveBeenCalled();
});
