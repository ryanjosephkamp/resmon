/** Actual saved-answer HTTP -> browser download -> separate offline Electron.
 * Native chooser/save destinations are scripted. All state/content is synthetic. */
import {test,expect,_electron,type ElectronApplication,type Page} from '@playwright/test';
import fs from 'fs';import os from 'os';import path from 'path';import {pathToFileURL} from 'url';
import {execFileSync} from 'child_process';import {createHash} from 'crypto';
import {FRONTEND_ROOT,REPO_ROOT,launchEnv,ensureScreenshotDir,selectedEvidenceTransport} from './fixtures/resmon-app';
// Wire shape only: importing selectedEvidence.ts also reaches renderer TSX,
// which is deliberately outside the existing e2e compiler's configuration.
interface Answer {answer_id:string;request_sha256:string;state:string;cleanup_state:string;partial_text:string;result:{sections:{items:{citations:{source_id:string;start_codepoint:number;end_codepoint:number;quote:string}[]}[]}[]}|null}
import type {LibraryStatus,LibraryPage,LibraryFile} from '../src/api/library';
import type {Project} from '../src/api/evidence';

const hash=(raw:Buffer|string)=>createHash('sha256').update(raw).digest('hex');
const alive=(pid:number)=>{try{process.kill(pid,0);return true;}catch{return false;}};
const started=(pid:number)=>execFileSync('ps',['-p',String(pid),'-o','lstart='],{encoding:'utf8'}).trim();
const hostile='</style><script>globalThis.EXPORTED_ATTACK=1</script><img src="https://invalid.test/x" onerror="alert(1)"><form action="file:///private/secret"><input></form><meta http-equiv="refresh" content="0;url=javascript:alert(1)"><base href="https://invalid.test/"><svg onload="alert(1)"></svg> @import url(https://invalid.test/style); file:///private/secret javascript:alert(1) 😀';

test('Portable briefing: exact saved downloads, stale guards, seven offline states, keyboard, widths and print',async()=>{
 test.setTimeout(360_000);
 const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'resmon-portable-product-')));
 const dirs=Object.fromEntries(['state','profile','originals','vault-parent','downloads','reader-profile'].map(name=>{const dir=path.join(root,name);fs.mkdirSync(dir);return [name,dir];}));
 const out=ensureScreenshotDir(),receipt=(name:string,value:unknown)=>fs.writeFileSync(path.join(out,'portable-'+name+'.json'),JSON.stringify(value,null,2));
 const env=launchEnv(dirs.state,true);env.PYTHON_KEYRING_BACKEND='keyring.backends.null.Keyring';
 const python=execFileSync(env.RESMON_PYTHON,['-c','import sys;print(sys.executable)'],{env,encoding:'utf8'}).trim();
 const fake=await selectedEvidenceTransport(root,python);env.RESMON_PYTHON=fake.backend;
 const py=(code:string,...args:string[])=>execFileSync(python,['-c',code,...args],{cwd:REPO_ROOT,env,encoding:'utf8'});
 const sql=()=>py("import sqlite3,json,sys;c=sqlite3.connect(sys.argv[1]);tables=[r[0] for r in c.execute(\"SELECT name FROM sqlite_master WHERE type='table'\")];print(json.dumps({t:sorted(list(c.execute('SELECT * FROM '+t)),key=repr) for t in sorted(tables)},default=lambda value:{'sqlite_blob_hex':value.hex()}));c.close()",env.RESMON_DB_PATH);
 const originals=['two-pages.pdf','unicode.txt'];for(const name of originals)fs.copyFileSync(path.join(REPO_ROOT,'resmon_scripts/verification_scripts/fixtures/evidence',name),path.join(dirs.originals,name));
 fs.writeFileSync(path.join(dirs.originals,'hostile.txt'),hostile+'\n'+'longword'.repeat(120));originals.push('hostile.txt');
 const originalHashes=Object.fromEntries(originals.map(n=>[n,hash(fs.readFileSync(path.join(dirs.originals,n)))]));
 let app:ElectronApplication|undefined,reader:ElectronApplication|undefined,win!:Page,base='',origin='',vid='',pid='',vaultRoot='',runtime='';
 const backends:number[]=[],mainPids:number[]=[],instances:unknown[]=[],exports:{label:string;target:string;answer:Answer;sha256:string}[]=[],errors:string[]=[];
 const req=async<T>(url:string,method='GET',body?:unknown):Promise<T>=>{const r=await fetch(base+url,{method,headers:{Origin:origin,'X-Resmon-Library':'1',...(body===undefined?{}:{'Content-Type':'application/json'})},...(body===undefined?{}:{body:JSON.stringify(body)})});expect(r.ok,await r.clone().text()).toBe(true);return r.json() as Promise<T>;};
 const detail=(id:string)=>req<Answer>(`/api/evidence/projects/${pid}/answers/${id}?expected_vault_id=${vid}`);
 const calls=()=>fake.captures().length+fake.requests.length;
 const launch=async()=>{
  app=await _electron.launch({args:['.',`--user-data-dir=${dirs.profile}`],cwd:FRONTEND_ROOT,env});mainPids.push(app.process().pid!);win=await app.firstWindow();win.on('pageerror',e=>errors.push(e.message));await win.waitForSelector('.app-main');
  const port=await win.evaluate(()=>window.resmonAPI!.getBackendPort());expect(Number(port)).toBeGreaterThan(0);expect(port).not.toBe('8742');base=`http://127.0.0.1:${port}`;origin=new URL(win.url()).origin;
  const health=await req<{pid:number;identity:{runtime_id:string;schema_version:number}}>('/api/health');expect(health.identity.schema_version).toBe(18);runtime=health.identity.runtime_id;backends.push(health.pid);
  const identity=await app.evaluate(({app})=>({pid:process.pid,state:process.env.RESMON_STATE_DIR,database:process.env.RESMON_DB_PATH,profile:app.getPath('userData')}));
  expect(identity.state).toBe(dirs.state);expect(identity.database).toBe(env.RESMON_DB_PATH);expect(identity.profile).toBe(dirs.profile);expect(fs.readFileSync(env.RESMON_PORT_FILE,'utf8').trim()).toBe(port);
  instances.push({...identity,health,port,source:REPO_ROOT,mainStart:started(identity.pid),backendStart:started(health.pid)});receipt('instances',instances);
  await app.evaluate(({session,dialog,shell},v)=>{
   const g=globalThis as unknown as {portableNetwork:{allowed:string[];blocked:string[];opens:string[];downloads:string[]}};g.portableNetwork={allowed:[],blocked:[],opens:[],downloads:[]};
   session.defaultSession.webRequest.onBeforeRequest({urls:['*://*/*']},(d,cb)=>{const local=d.url.startsWith(v.base+'/')||d.url.startsWith(v.origin+'/');(local?g.portableNetwork.allowed:g.portableNetwork.blocked).push(d.url);cb({cancel:!local});});
   shell.openExternal=async url=>{g.portableNetwork.opens.push(url);};shell.openPath=async target=>{g.portableNetwork.opens.push(target);return 'Not an authorized destination';};
   dialog.showOpenDialog=async()=>({canceled:false,filePaths:[v.parent]});session.defaultSession.on('will-download',(_event,item)=>g.portableNetwork.downloads.push(item.getFilename()));
  },{base,origin,parent:dirs['vault-parent']});
  await win.evaluate(()=>{const original=window.fetch;const requests:{url:string;method:string}[]=[];(window as unknown as {portableRequests:typeof requests}).portableRequests=requests;window.fetch=async(input,init)=>{requests.push({url:String(input),method:init?.method??'GET'});return original(input,init);};});
 };
 const network=async()=>app!.evaluate(()=>(globalThis as unknown as {portableNetwork:{allowed:string[];blocked:string[];opens:string[];downloads:string[]}}).portableNetwork);
 const closeApp=async()=>{if(!app)return;const n=await network();receipt('network-'+mainPids.length,n);expect(n.blocked).toEqual([]);expect(n.opens).toEqual([]);const owned=app.process().pid!;await app.close();app=undefined;await expect.poll(()=>alive(owned)).toBe(false);await expect.poll(()=>backends.filter(alive)).toEqual([]);};
 const openSaved=async(a:Answer)=>{await win.getByRole('region',{name:'Saved answer history'}).getByRole('button').filter({hasText:a.answer_id}).click();await expect(win.getByRole('article',{name:'Selected evidence answer'})).toContainText(a.answer_id);};
 const eventRequests=async()=>win.evaluate(()=>(window as unknown as {portableRequests:{url:string;method:string}[]}).portableRequests.filter(r=>r.url.includes('/events?')));
 const download=async(a:Answer,label:string,format:'html'|'zip'='html')=>{
  const target=path.join(dirs.downloads,label+'.'+format);const count=calls(),rows=sql(),events=await eventRequests();
  await app!.evaluate(({session},destination)=>session.defaultSession.once('will-download',(_event,item)=>item.setSavePath(destination)),target);
  await win.getByRole('button',{name:format==='html'?'Export HTML':'Export this answer and selected text',exact:true}).click();
  await expect(win.getByRole('status').filter({hasText:new RegExp(`selected ${format.toUpperCase()} was handed`)})).toBeVisible();
  await expect.poll(()=>fs.existsSync(target)&&fs.statSync(target).size>0).toBe(true);
  const r=await fetch(base+`/api/evidence/projects/${pid}/answers/${a.answer_id}/export?expected_vault_id=${vid}&format=${format}`,{headers:{Origin:origin,'X-Resmon-Library':'1'}});expect(r.status).toBe(200);
  const raw=Buffer.from(await r.arrayBuffer());await expect.poll(()=>hash(fs.readFileSync(target))).toBe(hash(raw));
  expect(r.headers.get('x-resmon-sha256')).toBe(hash(raw));expect(r.headers.get('content-length')).toBe(String(raw.length));expect(r.headers.get('x-resmon-version')).toBe(a.request_sha256);
  expect(calls()).toBe(count);expect(sql()).toBe(rows);expect(await eventRequests()).toEqual(events);
  if(format==='html')exports.push({label,target,answer:a,sha256:hash(raw)});
  receipt('download-'+label,{target,bytes:raw.length,headers:Object.fromEntries(r.headers),runtimeCallsBefore:count,runtimeCallsAfter:calls(),sqlUnchanged:true,sseRequestHistoryUnchanged:true,scriptedDestination:true});return raw;
 };
 const send=async(mode:'question'|'briefing',active=false)=>{
  await win.getByRole('button',{name:'New selected-evidence answer'}).click();const dialog=win.getByRole('dialog',{name:'Select evidence for an answer'});
  await dialog.getByLabel('Physical page for two-pages.pdf').fill('1');
  await dialog.getByRole('button',{name:'Add two-pages.pdf page',exact:true}).click();
  await dialog.getByRole('button',{name:'Add unicode.txt logical page 1',exact:true}).click();
  await dialog.getByRole('button',{name:'Add hostile.txt logical page 1',exact:true}).click();
  await dialog.getByLabel(/Include note body: PORTABLE OWNER NOTE/).check();
  await dialog.getByLabel('Answer format').selectOption(mode);await dialog.getByLabel('Question or briefing instruction').fill(hostile);
  await dialog.getByLabel('Connection',{exact:true}).selectOption(mode==='question'?'claude_cli:claude_code':'api_key:custom');await dialog.getByLabel('Model',{exact:true}).fill('requested-synthetic-portable');
  await dialog.getByRole('button',{name:'Preview selected content'}).click();await expect(dialog.getByRole('heading',{name:'Inspect before Send'})).toBeVisible();
  const response=win.waitForResponse(r=>r.request().method()==='POST'&&r.url().endsWith('/answers'));
  await dialog.getByRole('button',{name:'Send selected evidence'}).click();const a=await (await response).json() as Answer;
  if(active){await expect.poll(async()=>(await detail(a.answer_id)).partial_text).toContain('durable checkpoint');return detail(a.answer_id);}
  await expect.poll(async()=>(await detail(a.answer_id)).cleanup_state).toBe('confirmed');const saved=await detail(a.answer_id);expect(saved.state).toBe('succeeded');await expect(win.getByRole('button',{name:'New selected-evidence answer'})).toBeEnabled();return saved;
 };
 let catalog:LibraryFile[]=[];
 try{
  receipt('fixture',{source:REPO_ROOT,python,...fake.receipt()});await launch();
  await req('/api/settings/ai','PUT',{settings:{ai_cli_path:fake.cli,assistant_provider:'custom',ai_custom_base_url:fake.base}});
  await win.evaluate(()=>{location.hash='/library';});await win.getByRole('button',{name:'Choose parent folder',exact:true}).click();await win.getByRole('button',{name:'Create managed vault',exact:true}).click();
  await win.getByLabel('Import PDF, TXT or MD').setInputFiles(originals.map(n=>path.join(dirs.originals,n)));await expect(win.getByText(/3 retained, 0 exact duplicates/)).toBeVisible();
  const status=await req<LibraryStatus>('/api/library');vid=status.vault!.vault_id;vaultRoot=path.join(dirs['vault-parent'],status.vault!.label);catalog=(await req<LibraryPage>(`/api/library/files?expected_vault_id=${vid}`)).files;
  await win.getByRole('region',{name:'Library files'}).getByRole('button',{name:/^two-pages.pdf /}).click();await win.getByRole('link',{name:'Open in Evidence / add to project'}).click();await win.getByLabel('New project name',{exact:true}).fill('Portable synthetic project');await win.getByRole('button',{name:'Create project',exact:true}).click();await win.getByRole('button',{name:'Add selected Library file to project'}).click();
  await expect(win.getByLabel('Canonical page text')).toHaveValue('Alpha evidence — exact version.');pid=(await req<{projects:Project[]}>(`/api/evidence/projects?expected_vault_id=${vid}`)).projects[0].project_id;
  await win.getByLabel('Note body',{exact:true}).fill('PORTABLE OWNER NOTE '+hostile);await win.getByRole('button',{name:'Save note',exact:true}).click();await expect(win.getByText('PORTABLE OWNER NOTE '+hostile,{exact:true}).first()).toBeVisible();
  await win.getByRole('button',{name:'Choose from Library'}).click();for(const name of ['unicode.txt','hostile.txt']){await win.getByRole('button',{name:'Add '+name,exact:true}).click();await expect(win.getByRole('button',{name:'Choose from Library'})).toBeEnabled();}await win.getByRole('button',{name:'Close Library chooser'}).click();
  const question=await send('question');const zip=await download(question,'legacy','zip');await download(question,'question');
  const briefing=await send('briefing');await download(briefing,'briefing');expect(fake.captures()).toHaveLength(1);expect(fake.requests).toHaveLength(1);
  // Hold the real HTTP response before the download consumer receives it.
  for(const outcome of ['success','error','identity'] as const){
   await openSaved(question);const before=(await network()).downloads.length;
   await win.evaluate(({target,outcome})=>{const original=window.fetch;let release!:()=>void;const held={ready:false,release:()=>release(),restore:()=>{window.fetch=original;}};(window as unknown as {portableHeld:typeof held}).portableHeld=held;window.fetch=async(input,init)=>{const r=await original(input,init);if(String(input)===target){await new Promise<void>(resolve=>{release=resolve;held.ready=true;});if(outcome==='error')throw new Error('RETIRED_HTML_ERROR');if(outcome==='identity'){const h=new Headers(r.headers);h.set('X-Resmon-Bundle','wrong');return new Response(await r.arrayBuffer(),{status:r.status,headers:h});}}return r;};},{target:base+`/api/evidence/projects/${pid}/answers/${question.answer_id}/export?expected_vault_id=${vid}&format=html`,outcome});
   await win.getByRole('button',{name:'Export HTML',exact:true}).click();await expect.poll(async()=>win.evaluate(()=>(window as unknown as {portableHeld:{ready:boolean}}).portableHeld.ready)).toBe(true);
   if(outcome!=='identity')await openSaved(briefing);
   await win.evaluate(()=>{const h=(window as unknown as {portableHeld:{restore:()=>void;release:()=>void}}).portableHeld;h.restore();h.release();});
   if(outcome==='identity')await expect(win.getByRole('article',{name:'Selected evidence answer'}).getByRole('status')).toContainText('HTML headers or identity do not match');
   else{await expect(win.getByRole('article',{name:'Selected evidence answer'})).toContainText(briefing.answer_id);await expect(win.getByText('RETIRED_HTML_ERROR',{exact:true})).toHaveCount(0);}
   expect((await network()).downloads).toHaveLength(before);receipt('held-'+outcome,{retired:outcome!=='identity',downloadCountBefore:before,downloadCountAfter:(await network()).downloads.length});
  }
  fake.setFault('crash_wait');const active=await send('question',true);expect(active.state).toBe('running');await download(active,'running');
  await win.getByRole('button',{name:'Stop selected answer'}).click();await expect.poll(async()=>(await detail(active.answer_id)).cleanup_state).toBe('confirmed');await expect(win.getByRole('button',{name:'New selected-evidence answer'})).toBeEnabled();
  const cancelled=await detail(active.answer_id);expect(cancelled.state).toBe('cancelled');await download(cancelled,'cancelled');
  // Additional literal lifecycle snapshots are fixture rows, not model Sends.
  const seed=JSON.parse(py("import sqlite3,json,sys,uuid;c=sqlite3.connect(sys.argv[1]);c.row_factory=sqlite3.Row;original=dict(c.execute('SELECT * FROM evidence_answers WHERE answer_id=?',(sys.argv[2],)).fetchone());original.pop('id');ids=[]\nfor state in ['admitted','refused','failed','interrupted']:\n r=dict(original);r.update(answer_id=str(uuid.uuid4()),preview_id=str(uuid.uuid4()),state=state,cleanup_state='unknown' if state=='interrupted' else 'not_started',partial_text='Saved unvalidated '+state+' <script>literal</script>',result_json=None,finished_at_utc=None if state=='admitted' else original['finished_at_utc']);\n if state=='refused':\n  result=json.loads(original['result_json']);result['status']='insufficient_evidence';r['result_json']=json.dumps(result)\n if state=='failed':r.update(error_code='fixture_error',error_message=sys.argv[3])\n c.execute('INSERT INTO evidence_answers ('+','.join(r)+') VALUES ('+','.join('?' for _ in r)+')',tuple(r.values()));ids.append(r['answer_id'])\nc.commit();c.close();print(json.dumps(ids))",env.RESMON_DB_PATH,question.answer_id,hostile)) as string[];
  receipt('synthetic-seed',{ids:seed,states:['admitted','refused','failed','interrupted'],basis:'Copied saved selected request with explicit synthetic lifecycle fields; no Send or model request'});
  await win.getByRole('button',{name:'Refresh answers'}).click();
  for(const id of seed){const a=await detail(id);await openSaved(a);await download(a,a.state);}
  // One additional validated synthetic snapshot exercises hostile filename,
  // structured answer/quote and model observation fields in the real file DOM.
  const matrixId=py(`import sqlite3,json,sys,uuid
from implementation_scripts import selected_evidence as se
c=sqlite3.connect(sys.argv[1]);c.row_factory=sqlite3.Row
r=dict(c.execute('SELECT * FROM evidence_answers WHERE answer_id=?',(sys.argv[2],)).fetchone());r.pop('id')
request=json.loads(r['request_json']);payload=request['payload'];sources=payload['sources'];hostile=sys.argv[3]
source=next(s for s in sources if s['original_name']=='hostile.txt')
source['original_name']='<img onerror="bad">.txt'
source['source_sha256']=se.sha(se.canonical({k:v for k,v in source.items() if k not in ('source_id','source_sha256')}))
request['request_sha256']=se.sha(se.canonical(payload));request['user_prompt']=se.canonical({'request_sha256':request['request_sha256'],'payload':payload});request['user_sha256']=se.sha(request['user_prompt'])
result=json.loads(r['result_json']);result['request_sha256']=request['request_sha256']
item=result['sections'][0]['items'][0];item['text']=hostile
item['citations']=[{'source_id':source['source_id'],'start_codepoint':source['start_codepoint'],'end_codepoint':source['start_codepoint']+len(hostile),'quote':hostile}]
unicode=next(s for s in sources if s['original_name']=='unicode.txt')
for token in ['😀','repeat needle']:
 start=0
 while True:
  start=unicode['text'].find(token,start)
  if start<0:break
  for width in sorted(set([len(token),max(1,len(token)-2)])):
   item['citations'].append({'source_id':unicode['source_id'],'start_codepoint':unicode['start_codepoint']+start,'end_codepoint':unicode['start_codepoint']+start+width,'quote':unicode['text'][start:start+width]})
  start+=1
se.validate_request(request);se.validate_result(se.canonical(result),request)
r.update(answer_id=str(uuid.uuid4()),preview_id=str(uuid.uuid4()),request_json=se.canonical(request),request_sha256=request['request_sha256'],result_json=se.canonical(result),reports_json=se.canonical([{'model':hostile,'source':'api_response_model','observed_at_utc':r['created_at_utc']}]))
c.execute('INSERT INTO evidence_answers ('+','.join(r)+') VALUES ('+','.join('?' for _ in r)+')',tuple(r.values()));c.commit();print(r['answer_id']);c.close()
`,env.RESMON_DB_PATH,question.answer_id,hostile).trim();
  const matrix=await detail(matrixId);await win.getByRole('button',{name:'Refresh answers'}).click();await openSaved(matrix);await download(matrix,'hostile-matrix');
  receipt('hostile-matrix',{answer:matrixId,fields:['filename','instruction','structured answer','quote','note','error in failed snapshot','reported model'],syntheticSavedFixture:true});
  // Startup marks admitted fixture rows interrupted. All other saved bytes stay fixed.
  const count=calls();await closeApp();await launch();await win.evaluate(projectId=>{location.hash='/evidence?project_id='+projectId;},pid);await win.waitForSelector('.evidence-page');
  const retained=catalog.map(f=>path.join(vaultRoot,f.relative_path));for(const f of retained)fs.renameSync(f,f+'.portable-held');
  try{await openSaved(question);await download(question,'restart-missing-originals');expect(await download(question,'legacy-reopened','zip')).toEqual(zip);}finally{for(const f of retained)fs.renameSync(f+'.portable-held',f);}
  expect(calls()).toBe(count);await win.screenshot({path:path.join(out,'portable-app.png')});await closeApp();
  expect(backends.filter(alive)).toEqual([]);expect(mainPids.filter(alive)).toEqual([]);
  // Independent file-reader process: interceptor installed in main BEFORE loadURL.
  // It permits exactly one initial owned file, with only fragment navigation later.
  for(const [index,entry] of exports.entries()){
   const target=pathToFileURL(entry.target).href,readerMain=path.join(root,'reader-'+index+'.js'),profile=path.join(dirs['reader-profile'],String(index));
   const code=`const {app,BrowserWindow,session}=require('electron');\nconst target=${JSON.stringify(target)};\nglobalThis.portableReader={allowed:[],blocked:[],opens:[],target,pid:process.pid};\napp.whenReady().then(()=>{\n let initial=false;session.defaultSession.webRequest.onBeforeRequest({urls:['<all_urls>']},(d,cb)=>{const same=d.url===target&&!initial;if(same){initial=true;globalThis.portableReader.allowed.push(d.url);}else globalThis.portableReader.blocked.push(d.url);cb({cancel:!same});});\n session.defaultSession.setPermissionRequestHandler((_wc,_permission,cb)=>cb(false));\n const win=new BrowserWindow({width:1000,height:850,webPreferences:{nodeIntegration:false,contextIsolation:true,sandbox:true}});\n win.webContents.setWindowOpenHandler(d=>{globalThis.portableReader.opens.push(d.url);return {action:'deny'};});\n win.webContents.on('will-navigate',(e,url)=>{if(url.split('#')[0]!==target){globalThis.portableReader.opens.push(url);e.preventDefault();}});\n win.loadURL(target);\n});\napp.on('window-all-closed',()=>app.quit());\n`;
   fs.writeFileSync(readerMain,code);reader=await _electron.launch({args:[readerMain,`--user-data-dir=${profile}`],cwd:FRONTEND_ROOT,env});const owned=reader.process().pid!,readerStart=started(owned),page=await reader.firstWindow();await page.waitForSelector('main');
   expect(page.url()).toBe(target);expect(await page.locator('body').textContent()).toContain(entry.answer.answer_id);expect(await page.locator('body').textContent()).toContain(entry.answer.state);
   expect(await page.locator('script,img,form,input,iframe,object,embed,base,svg,link,video,audio').count()).toBe(0);
   expect(await page.evaluate(()=>(globalThis as unknown as {EXPORTED_ATTACK?:number}).EXPORTED_ATTACK)).toBeUndefined();
   expect(await page.locator('*').evaluateAll(elements=>elements.flatMap(el=>Array.from(el.attributes).filter(a=>a.name.startsWith('on')||a.name==='src'||a.name==='style').map(a=>a.name)))).toEqual([]);
   expect(await page.locator('body').textContent()).toContain(hostile);expect(await page.locator('body').textContent()).toContain('PORTABLE OWNER NOTE');
   const links=await page.locator('a').evaluateAll(elements=>elements.map(a=>a.getAttribute('href')));expect(links.every(href=>/^#[a-z0-9-]+$/.test(href??''))).toBe(true);
   if(entry.answer.result){
    for(const [si,section] of entry.answer.result.sections.entries())for(const [ii,item] of section.items.entries())for(const [ci,citation] of item.citations.entries()){
     const id=`reference-${si+1}-${ii+1}-${ci+1}`,link=page.locator('#'+id),href=await link.getAttribute('href');await link.focus();await page.keyboard.press('Enter');expect(new URL(page.url()).hash).toBe(href);
     const quote=page.locator(href!);expect(await quote.locator('div.literal').textContent()).toBe(citation.quote);expect(await quote.locator('dd').nth(1).textContent()).toBe(String(citation.start_codepoint));expect(await quote.locator('dd').nth(2).textContent()).toBe(String(citation.end_codepoint));
     await quote.getByRole('link',{name:'Return to this answer citation'}).focus();await page.keyboard.press('Enter');expect(new URL(page.url()).hash).toBe('#'+id);await expect(link).toBeFocused();
    }
   }else await expect(page.getByRole('heading',{name:'Incomplete / unvalidated output'})).toBeVisible();
   if(index===0){
    const layouts:unknown[]=[];
    for(const width of [320,390,768,1440]){await page.setViewportSize({width,height:900});const geometry=await page.evaluate(()=>({width:innerWidth,scroll:document.documentElement.scrollWidth,client:document.documentElement.clientWidth}));expect(geometry.width).toBe(width);expect(geometry.scroll).toBeLessThanOrEqual(geometry.client);layouts.push(geometry);if(width===390){await page.evaluate(()=>scrollTo(0,0));await page.screenshot({path:path.join(out,'portable-offline-390-viewport.png')});}await page.screenshot({path:path.join(out,`portable-offline-${width}.png`),fullPage:true});}
    await page.setViewportSize({width:768,height:900});await reader.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].webContents.setZoomFactor(2));
    const zoom=await reader.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].webContents.getZoomFactor());expect(zoom).toBe(2);expect(await page.evaluate(()=>document.documentElement.scrollWidth<=document.documentElement.clientWidth)).toBe(true);
    const summary=page.getByText('Exact saved identity and output limits',{exact:true});await summary.focus();await page.keyboard.press('Enter');await expect(page.locator('details')).not.toHaveAttribute('open','');await page.keyboard.press('Enter');await expect(page.locator('details')).toHaveAttribute('open','');
    const focus=await summary.evaluate(el=>({active:document.activeElement===el,outline:getComputedStyle(el).outlineStyle}));expect(focus.active).toBe(true);expect(focus.outline).not.toBe('none');
    const native=await reader.evaluate(async({BrowserWindow})=>Array.from((await BrowserWindow.getAllWindows()[0].webContents.capturePage()).toPNG()));fs.writeFileSync(path.join(out,'portable-offline-zoom200-native.png'),Buffer.from(native));
    await reader.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].webContents.setZoomFactor(1));await page.emulateMedia({media:'print'});
    await expect(page.locator('#sources')).toBeVisible();await expect(page.locator('#coverage')).toBeVisible();expect(await page.locator('body').textContent()).toContain('billing');
    const print=await reader.evaluate(async({BrowserWindow})=>Array.from(await BrowserWindow.getAllWindows()[0].webContents.printToPDF({printBackground:true})));fs.writeFileSync(path.join(out,'portable-print.pdf'),Buffer.from(print));expect(Buffer.from(print).subarray(0,5).toString()).toBe('%PDF-');
    const printed=py("from pypdf import PdfReader;import sys;print('\\n'.join(p.extract_text() or '' for p in PdfReader(sys.argv[1]).pages))",path.join(out,'portable-print.pdf'));
    for(const literal of [entry.answer.answer_id,'Frozen selected sources','PORTABLE OWNER NOTE','Saved coverage and disclosure','Requested settings','Reported usage','65,536','20,000','billing','Citation identity is not semantic support'])expect(printed).toContain(literal);
    receipt('layout-keyboard-print',{layouts,zoom,focus,printBytes:print.length,printTextSha256:hash(printed),printContentAssertions:11,nativeCapture:true,physicalAndroid:false});
   }
   const observed=await reader.evaluate(()=>(globalThis as unknown as {portableReader:{allowed:string[];blocked:string[];opens:string[]}}).portableReader);
   expect(observed.allowed).toEqual([target]);expect(observed.blocked).toEqual([]);expect(observed.opens).toEqual([]);
   receipt('offline-'+entry.label,{...observed,profile,source:REPO_ROOT,readerMain,readerMainSha256:hash(code),pid:owned,processStart:readerStart,appPidsAbsent:mainPids.filter(alive),backendPidsAbsent:backends.filter(alive),sha256:hash(fs.readFileSync(entry.target)),state:entry.answer.state});
   await reader.close();reader=undefined;await expect.poll(()=>alive(owned)).toBe(false);receipt('reader-cleanup-'+entry.label,{pid:owned,reaped:true});
  }
  for(const name of originals)expect(hash(fs.readFileSync(path.join(dirs.originals,name)))).toBe(originalHashes[name]);
  expect(calls()).toBe(count);expect(errors).toEqual([]);receipt('exports',exports);receipt('preservation',{originalHashes,runtimeCalls:count,afterOfflineCalls:calls(),errors});
 }finally{
  if(reader){const owned=reader.process().pid!;await reader.close();await expect.poll(()=>alive(owned)).toBe(false);}
  if(app){if(!win.isClosed()){await win.screenshot({path:path.join(out,'portable-terminal.png')});receipt('terminal',{body:await win.locator('body').innerText(),errors});}await closeApp();}
  receipt('runtime-captures',{cli:fake.captures(),api:fake.requests});await fake.close();await expect.poll(()=>backends.filter(alive)).toEqual([]);
  receipt('cleanup',{root,instances,mainPids,backends,remainingMain:mainPids.filter(alive),remainingBackend:backends.filter(alive),fakeChildren:fake.captures().map(c=>({pid:c.pid,alive:alive(c.pid)})),at:new Date().toISOString()});
 }
});
