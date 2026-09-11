/** R04c: actual Electron/backend/HTTP/SSE, authored fake CLI and API recipient.
 * Every account/model decision is synthetic. Downloads use scripted save paths. */
import { test, expect, _electron, type ElectronApplication, type Page } from '@playwright/test';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as http from 'http';
import { createHash } from 'crypto';
import { FRONTEND_ROOT, REPO_ROOT, launchEnv, ensureScreenshotDir } from './fixtures/resmon-app';

interface Captured { model: string; messages: {role:string;content?:string}[]; tools: unknown[] }
interface Snapshot {session:{id:number;runtime:string;choices:{provider:string;requested_model:string|null;requested_effort:string|null;binding_basis:string}|null};messages:{id:number;role:string;content:string}[];turn_choices:{user_message_id:number;assistant_message_id:number|null;requested:{requested_model:string|null};reported:{sequence:number;model:string;source:string}[]}[]}
const runtimeIds: number[]=[];
const startTime=(pid:number)=>execFileSync('ps',['-p',String(pid),'-o','lstart='],{encoding:'utf8'}).trim();
const alive=(pid:number)=>{try{process.kill(pid,0);return true;}catch{return false;}};

test('fixed choices, historical consent, real recipient requests, reports, Stop, exact Allow/Deny and saved exports',async()=>{
 test.setTimeout(300_000);
 const state=fs.mkdtempSync(path.join(os.tmpdir(),'resmon-composer-'));
 const out=ensureScreenshotDir();
 const receipt=(name:string,value:unknown)=>fs.writeFileSync(path.join(out,`composer-${name}.json`),JSON.stringify(value,null,2));
 const requests:Captured[]=[];const contacts:string[]=[];let round=0;
 const api=http.createServer((req,res)=>{
  let raw='';req.on('data',chunk=>raw+=chunk);req.on('end',()=>{
   const body=JSON.parse(raw) as Captured;requests.push(body);
   const prompt=[...body.messages].reverse().find(m=>m.role==='user')?.content||'';
   const status=body.model==='reject-model'?400:200;
   let message:object={role:'assistant',content:`API answer for ${prompt}`};
   if(prompt.startsWith('CREATE:')&&body.messages[body.messages.length-1]?.role!=='tool')message={role:'assistant',content:null,tool_calls:[{id:`r04c-${++round}`,type:'function',function:{name:'create_routine',arguments:prompt.slice(7)}}]};
   const payload=JSON.stringify(status===400?{error:{message:'authored model refusal'}}:{...(body.model==='no-report'?{}:{model:'api-reported-concrete'}),choices:[{message}]});
   res.writeHead(status,{'Content-Type':'application/json','Content-Length':Buffer.byteLength(payload)});res.end(payload);
  });
 });
 await new Promise<void>(resolve=>api.listen(0,'127.0.0.1',resolve));
 const address=api.address();if(!address||typeof address==='string')throw new Error('No authored server port');
 expect(address.port).not.toBe(8742);
 const endpoint=`http://127.0.0.1:${address.port}`;
 const env=launchEnv(state,true);env.RESMON_DISABLE_SCHEDULER='1';env.FAKE_CLAUDE_STATE=path.join(state,'fake-native');
 // Only this process sees the authored nonsecret keyring. No real keyring lookup.
 fs.writeFileSync(path.join(state,'composer_fake_keys.py'),`from keyring.backend import KeyringBackend\nclass Keyring(KeyringBackend):\n priority=1\n def get_password(self,service,username): return 'r04c-authored-nonsecret' if username=='custom_llm_api_key' else None\n def set_password(self,*a): raise RuntimeError('No key writes in composer fixture')\n def delete_password(self,*a): raise RuntimeError('No key deletion in composer fixture')\n`);
 env.PYTHON_KEYRING_BACKEND='composer_fake_keys.Keyring';env.PYTHONPATH=state+path.delimiter+(env.PYTHONPATH||'');
 const capture=path.join(state,'cli-capture.jsonl');const cli=path.join(state,'fake-composer-cli');
 fs.writeFileSync(cli,`#!${env.RESMON_PYTHON}\nimport sys,os,json,importlib.util,datetime\nfrom pathlib import Path\na=sys.argv[1:]\nmodel=a[a.index('--model')+1] if '--model' in a else None\nwith open(${JSON.stringify(capture)},'a') as f:f.write(json.dumps({'pid':os.getpid(),'at':datetime.datetime.now(datetime.timezone.utc).isoformat(),'argv':a})+'\\n')\nif model=='reject-model' or (model=='reject-effort' and '--effort' in a and a[a.index('--effort')+1]=='max'):\n print(json.dumps({'type':'result','subtype':'error_during_execution','is_error':True,'errors':['authored model refusal']}));sys.exit(1)\nspec=importlib.util.spec_from_file_location('authored_cli',${JSON.stringify(path.join(REPO_ROOT,'resmon_scripts/verification_scripts/fixtures/fake_claude.py'))})\nm=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)\noriginal=m.emit\ndef emit(value):\n if value.get('type')=='system' and value.get('subtype')=='init':\n  if model=='no-report':value.pop('model',None)\n  else:value['model']='cli-reported-concrete'\n original(value)\nm.emit=emit\nsys.exit(m.main())\n`,{mode:0o755});
 const py=(script:string,...args:string[])=>execFileSync(env.RESMON_PYTHON,['-c',script,...args],{cwd:REPO_ROOT,env,encoding:'utf8'});
 py(`import sys
sys.path.insert(0,'resmon_scripts')
from implementation_scripts import database,assistant_store as s
p=sys.argv[1];database.init_db(p);c=database.get_connection(p)
for k,v in [('ai_cli_path',sys.argv[2]),('ai_custom_base_url',sys.argv[3]),('assistant_model','opus'),('assistant_effort','high')]:database.set_setting(c,k,v)
for kind in ['claude_cli','api_key']:
 sid=s.create_session(c,runtime=kind,cli_session_id='unverified-old-native',model='misleading-old-model',title='Historical '+kind)
 s.add_message(c,sid,role='user',content='old-user-'+kind)
 s.add_message(c,sid,role='assistant',content='old-answer-'+kind,tool_results=[{'not_replayed':'OLD_TOOL_RESULT'}])
c.execute("INSERT INTO documents(source_repository,external_id,title,metadata_hash) VALUES ('arxiv','r04c-synthetic','R04c preserved corpus marker','r04c-synthetic')")
c.execute('INSERT INTO reading_queue(document_id) VALUES (last_insert_rowid())');c.commit()`,env.RESMON_DB_PATH,cli,endpoint);
 const rows=()=>JSON.parse(py(`import sys,sqlite3,json
c=sqlite3.connect('file:'+sys.argv[1]+'?mode=ro',uri=True)
tables=[r[0] for r in c.execute("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")]
print(json.dumps({t:c.execute('SELECT * FROM "'+t+'" ORDER BY 1').fetchall() for t in tables},default=lambda b:{'hex':b.hex()}))`,env.RESMON_DB_PATH)) as Record<string,unknown[][]>;
 const captures=()=>fs.existsSync(capture)?fs.readFileSync(capture,'utf8').trim().split('\n').filter(Boolean).map(l=>JSON.parse(l) as {pid:number;argv:string[]}):[];
 const lastCapture=()=>{const all=captures();return all[all.length-1];};
 let app:ElectronApplication|undefined;let win:Page;let base='';const instances:unknown[]=[];
 const launch=async()=>{
  app=await _electron.launch({args:['.',`--user-data-dir=${path.join(state,'profile')}`],cwd:FRONTEND_ROOT,env,timeout:180_000});
  const pid=app.process().pid!;runtimeIds.push(pid);const started=startTime(pid);
  win=await app.firstWindow();await win.waitForSelector('.app-main');
  const port=await win.evaluate(()=>(window as unknown as {resmonAPI:{getBackendPort():string}}).resmonAPI.getBackendPort());expect(port).not.toBe('8742');base=`http://127.0.0.1:${port}`;
  await win.route('**/*',route=>{const url=route.request().url();if(/^https?:/.test(url)&&!url.startsWith(base+'/')&&!url.startsWith(endpoint+'/')){contacts.push(url);return route.abort();}return route.continue();});
  const identity=await app.evaluate(({app})=>({pid:process.pid,state:process.env.RESMON_STATE_DIR,db:process.env.RESMON_DB_PATH,reports:process.env.RESMON_REPORTS_DIR,portFile:process.env.RESMON_PORT_FILE,profile:app.getPath('userData')}));
  instances.push({...identity,started,source:REPO_ROOT,port});receipt('instances',instances);
 };
 const get=async(url:string)=>(await fetch(base+url)).json();
 const put=async(url:string,settings:object)=>{const r=await fetch(base+url,{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify({settings})});expect(r.ok).toBe(true);};
 const open=async(id:number)=>{await win!.getByLabel('Earlier conversations',{exact:true}).click();await win!.locator('.assistant-session-open').filter({hasText:id===1?'Historical claude_cli':id===2?'Historical api_key':'SAY:R04c CLI'}).first().click();};
 const send=async(text:string,confirm=false)=>{
  const response=win!.waitForResponse(r=>/\/assistant\/sessions\/\d+\/messages$/.test(r.url())&&r.request().method()==='POST');
  await win!.getByLabel('Message the assistant').fill(text);await win!.getByRole('button',{name:'Send',exact:true}).click();
  if(confirm)await win!.getByRole('button',{name:'Confirm and send',exact:true}).click();
  const r=await response;const sse=await r.text();await expect(win!.getByRole('button',{name:'Stop',exact:true})).toBeHidden();
  receipt('turn-'+Date.now(),{request:r.request().postDataJSON(),url:r.url(),status:r.status(),sse});
  return {id:Number(r.url().match(/sessions\/(\d+)/)![1]),status:r.status(),sse};
 };
 try{
  await launch();const before=rows();receipt('before',before);
  await win!.getByTestId('assistant-trigger').click();
  const originalDefaults=await get('/api/settings/assistant');
  await win!.getByLabel('Model',{exact:true}).fill('opus');await win!.getByLabel('Effort',{exact:true}).selectOption('max');
  expect(await get('/api/settings/assistant')).toEqual(originalDefaults);
  const first=await send('SAY:R04c CLI one');const id=first.id;
  let snapshot=await get(`/api/assistant/sessions/${id}`) as Snapshot;
  expect(snapshot.session.choices?.requested_model).toBe('opus');expect(snapshot.session.choices?.requested_effort).toBe('max');
  expect(snapshot.turn_choices[0].reported.map(r=>r.model)).toEqual(['cli-reported-concrete']);
  expect(captures()[0].argv[captures()[0].argv.indexOf('--effort')+1]).toBe('max');
  await put('/api/settings/assistant',{assistant_runtime:'api_key',assistant_provider:'custom',assistant_model:'global-C',assistant_effort:'low'});
  await send('SAY:R04c CLI still pinned');expect(lastCapture()!.argv[lastCapture()!.argv.indexOf('--model')+1]).toBe('opus');expect(requests).toHaveLength(0);
  // Stop while the actual authored process is sleeping; navigation cannot move ownership.
  const priorCaptures=captures().length;
  await win!.getByLabel('Message the assistant').fill('SAY:live fragment\nSLEEP:120');await win!.getByRole('button',{name:'Send',exact:true}).click();
  await expect.poll(()=>captures().length).toBe(priorCaptures+1);
  await expect(win!.locator('.assistant-message--assistant').last()).toContainText('live fragment');await expect(win!.getByText('Change choices · new empty conversation',{exact:true})).toBeDisabled();
  const activeCapture=lastCapture()!;const activeStart=startTime(activeCapture.pid);
  await win!.getByRole('button',{name:'Stop',exact:true}).click();await expect(win!.getByRole('button',{name:'Stop',exact:true})).toBeHidden();
  expect(alive(activeCapture.pid)).toBe(false);receipt('stop',{pid:activeCapture.pid,started:activeStart,exited:true});
  for(const decision of ['Deny','Allow'] as const){
   const args={name:`R04c CLI ${decision}`,keywords:['synthetic'],sources:['arxiv'],schedule:'0 9 * * *',ai_enabled:false};
   const prior=await get('/api/routines');const stream=win!.waitForResponse(r=>r.url().endsWith(`/${id}/messages`));
   await win!.getByLabel('Message the assistant').fill('CALL:create_routine '+JSON.stringify(args));await win!.getByRole('button',{name:'Send',exact:true}).click();
   const card=win!.getByTestId('permission-card');await expect(card).toBeVisible();await expect(card.locator('pre')).toHaveText(`create_routine(${JSON.stringify(args,null,2)})`);
   const wrong=await fetch(base+'/api/assistant/permissions/not-the-request',{method:'POST',headers:{'Content-Type':'application/json'},body:'{"allow":true}'});expect(wrong.status).toBe(409);
   expect(await get('/api/routines')).toEqual(prior);
   const answer=win!.waitForResponse(r=>r.url().includes('/permissions/')&&r.request().method()==='POST');await card.getByRole('button',{name:decision,exact:true}).click();const approved=await answer;
   const streamResponse=await stream;await streamResponse.finished();await expect(win!.getByRole('button',{name:'Stop',exact:true})).toBeHidden();
   const after=await get('/api/routines');if(decision==='Deny')expect(after).toEqual(prior);else{const created=after.find((r:{name:string})=>r.name===args.name);expect(created.is_active).toBe(0);expect(created.last_executed_at).toBeNull();expect(after).toHaveLength(prior.length+1);}
   const replay=await fetch(approved.url(),{method:'POST',headers:{'Content-Type':'application/json'},body:'{"allow":true}'});expect(replay.status).toBe(409);expect(await get('/api/routines')).toEqual(after);
   receipt('cli-consent-'+decision,{request:approved.request().postDataJSON(),request_id:approved.url().split('/').pop(),prior,after,replay:replay.status,wrong:wrong.status});
  }
  await open(1);expect((await get('/api/assistant/sessions/1')).session.choices).toBeNull();
  const beforeLegacy=rows();const unconfirmed=await fetch(base+'/api/assistant/sessions/1/messages',{method:'POST',headers:{'Content-Type':'application/json'},body:'{"text":"no confirmation"}'});expect(unconfirmed.status).toBe(409);expect(rows()).toEqual(beforeLegacy);
  await win!.getByLabel('Message the assistant').fill('SAY:legacy future');await win!.getByRole('button',{name:'Send',exact:true}).click();
  await expect(win!.getByText('Earlier messages remain here; this new Claude session will receive your new message, not the earlier conversation.')).toBeVisible();await win!.getByText('Cancel continuation',{exact:true}).click();expect(rows()).toEqual(beforeLegacy);
  await send('SAY:legacy future',true);const legacyCapture=lastCapture()!;
  expect(legacyCapture.argv).toContain('--session-id');expect(legacyCapture.argv).not.toContain('--resume');expect(JSON.stringify(legacyCapture)).not.toContain('old-user');expect(JSON.stringify(legacyCapture)).not.toContain('unverified-old-native');
  const legacy=await get('/api/assistant/sessions/1') as Snapshot;expect(legacy.messages[0].content).toBe('old-user-claude_cli');expect(legacy.session.choices?.binding_basis).toBe('legacy_confirmed');receipt('legacy-cli',{legacy,capture:legacyCapture});
  await open(2);await win!.getByLabel('Connection',{exact:true}).selectOption('api_key:custom');await win!.getByLabel('Model',{exact:true}).fill('api-requested');
  await expect(win!.getByText('Effort: Not supported by this adapter',{exact:true})).toBeVisible();
  await win!.getByLabel('Message the assistant').fill('API legacy future');await win!.getByRole('button',{name:'Send',exact:true}).click();await expect(win!.getByText(/Saved user and assistant text from this chat will be sent to custom/)).toBeVisible();
  await win!.getByText('Cancel continuation',{exact:true}).click();await send('API legacy future',true);
  expect(JSON.stringify(requests[requests.length-1])).toContain('old-user-api_key');expect(JSON.stringify(requests[requests.length-1])).not.toContain('OLD_TOOL_RESULT');expect(JSON.stringify(requests[requests.length-1])).not.toContain('old-user-claude_cli');
  receipt('legacy-api',{request:requests[requests.length-1],stored:await get('/api/assistant/sessions/2')});
  await win!.getByText('Change choices · new empty conversation',{exact:true}).click();expect(await win!.locator('.assistant-bubble').count()).toBe(0);
  await win!.getByLabel('Connection',{exact:true}).selectOption('api_key:custom');await win!.getByLabel('Model',{exact:true}).fill('no-report');
  const empty=await send('new empty API');expect(empty.id).not.toBe(2);expect(JSON.stringify(requests[requests.length-1])).not.toContain('old-user');expect((await get(`/api/assistant/sessions/${empty.id}`)).turn_choices[0].reported).toEqual([]);
  await win!.getByText('Change choices · new empty conversation',{exact:true}).click();await win!.getByLabel('Model',{exact:true}).fill('api-requested');
  for(const decision of ['Deny','Allow'] as const){
   const args={name:`R04c API ${decision}`,keywords:['synthetic'],sources:['arxiv'],schedule:'0 9 * * *',ai_enabled:false};const prior=await get('/api/routines');
   await win!.getByLabel('Message the assistant').fill('CREATE:'+JSON.stringify(args));await win!.getByRole('button',{name:'Send',exact:true}).click();
   const card=win!.getByTestId('permission-card');await expect(card).toBeVisible();await expect(card.locator('pre')).toHaveText(`create_routine(${JSON.stringify(args,null,2)})`);
   await card.getByRole('button',{name:decision,exact:true}).click();await expect(win!.getByRole('button',{name:'Stop',exact:true})).toBeHidden();
   const after=await get('/api/routines');if(decision==='Deny')expect(after).toEqual(prior);else{expect(after).toHaveLength(prior.length+1);expect(after.find((r:{name:string})=>r.name===args.name).is_active).toBe(0);}
   receipt('api-consent-'+decision,{prior,after});
  }
  for(const [connection,model] of [['claude_cli:claude_code','reject-model'],['claude_cli:claude_code','reject-effort'],['api_key:custom','reject-model']]){
   await win!.getByText('Change choices · new empty conversation',{exact:true}).click();
   await win!.getByLabel('Connection',{exact:true}).selectOption(connection);await win!.getByLabel('Model',{exact:true}).fill(model);
   if(connection.startsWith('claude'))await win!.getByLabel('Effort',{exact:true}).selectOption('max');
   const cliBefore=captures().length,apiBefore=requests.length;
   const refused=await send('SAY:authored refusal');await expect(win!.locator('.assistant-error')).toBeVisible();
   expect(captures().length-cliBefore).toBe(connection.startsWith('claude')?1:0);expect(requests.length-apiBefore).toBe(connection.startsWith('api')?1:0);
   const saved=await get(`/api/assistant/sessions/${refused.id}`) as Snapshot;
   expect(saved.turn_choices[0].requested.requested_model).toBe(model);expect(saved.turn_choices[0].reported).toEqual([]);
   receipt('refusal-'+connection.replace(':','-')+'-'+model,{refused,saved,cliAttempts:captures().length-cliBefore,apiAttempts:requests.length-apiBefore});
  }
  // Genuine restart, same synthetic profile/state, then read/export the original CLI chat.
  const oldPid=app!.process().pid!;await app!.close();expect(alive(oldPid)).toBe(false);await launch();
  await win!.evaluate(()=>{location.hash='/chats';});await win!.waitForSelector('.chats-page');
  await win!.getByLabel('Filter saved titles').fill('R04c CLI one');await win!.locator('.chats-list button').filter({hasText:'SAY:R04c CLI one'}).click();
  const transcript=win!.getByRole('region',{name:'Saved transcript'});await expect(transcript).toContainText('Requested');snapshot=await get(`/api/assistant/sessions/${id}`);
  for(const format of ['json','markdown'] as const){
   const destination=path.join(out,`composer-saved.${format==='json'?'json':'md'}`);
   await app!.evaluate(({BrowserWindow},target)=>{BrowserWindow.getAllWindows()[0].webContents.session.once('will-download',(_event,item)=>item.setSavePath(target));},destination);
   const response=win!.waitForResponse(r=>r.url().endsWith(`/${id}/export?format=${format}`));await transcript.getByRole('button',{name:format==='json'?'Export JSON':'Export Markdown',exact:true}).click();const body=await (await response).json();
   await expect.poll(()=>fs.existsSync(destination)&&fs.readFileSync(destination,'utf8')===body.text).toBe(true);
   expect(body.text).not.toContain('route_digest');expect(body.text).not.toContain(cli);expect(body.text).not.toContain('cli_session_id');expect(body.text).toContain('cli-reported-concrete');
   if(format==='json'){const doc=JSON.parse(body.text);expect(doc.turn_choices).toEqual(snapshot.turn_choices);expect(doc.choices).toEqual(snapshot.session.choices);}
   receipt('download-'+format,{destination,sha256:createHash('sha256').update(body.text).digest('hex'),session_id:id,method:'actual Electron download, scripted save path; no native chooser'});
  }
  await transcript.getByRole('button',{name:'Continue in Ask',exact:true}).click();await win!.getByText('Change choices · new empty conversation',{exact:true}).click();
  await win!.getByLabel('Connection',{exact:true}).selectOption('claude_cli:claude_code');
  await win!.getByLabel('Model',{exact:true}).fill('long-model-'+ 'x'.repeat(500));
  const geometry=[];
  for(const appearance of ['light','dark'] as const)for(const [width,height] of [[960,600],[1280,800]]){
   await app!.evaluate(({BrowserWindow,nativeTheme},x)=>{nativeTheme.themeSource=x.appearance;BrowserWindow.getAllWindows()[0].setSize(x.width,x.height);},{appearance,width,height});
   for(const label of ['Connection','Model','Effort']){await win!.getByLabel(label,{exact:true}).focus();await expect(win!.getByLabel(label,{exact:true})).toBeFocused();}
   const bounds=await win!.evaluate(()=>({width:innerWidth,height:innerHeight,scroll:document.documentElement.scrollWidth,panel:document.querySelector('.assistant-panel')!.getBoundingClientRect().toJSON()}));
   expect(bounds.scroll).toBe(bounds.width);expect(bounds.panel.right).toBeLessThanOrEqual(bounds.width);expect(bounds.panel.bottom).toBeLessThanOrEqual(bounds.height);geometry.push(bounds);
   await win!.screenshot({path:path.join(out,`composer-${appearance}-${width}.png`)});
  }
  await app!.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].webContents.setZoomFactor(2));await win!.waitForTimeout(250);
  for(const label of ['Connection','Model','Effort']){
   const control=win!.getByLabel(label,{exact:true});await control.focus();await expect(control).toBeFocused();
   const measured=await control.evaluate(el=>({control:el.getBoundingClientRect().toJSON(),body:document.querySelector('.assistant-body')!.getBoundingClientRect().toJSON(),width:innerWidth,height:innerHeight}));
   expect(measured.control.left).toBeGreaterThanOrEqual(0);expect(measured.control.right).toBeLessThanOrEqual(measured.width);expect(measured.control.top).toBeGreaterThanOrEqual(measured.body.top);expect(measured.control.bottom).toBeLessThanOrEqual(measured.body.bottom);geometry.push(measured);
  }
  const native=await app!.evaluate(async({BrowserWindow})=>{const window=BrowserWindow.getAllWindows()[0];return {png:(await window.webContents.capturePage()).toPNG().toString('base64'),bounds:window.getContentBounds(),zoom:window.webContents.getZoomFactor()};});
  fs.writeFileSync(path.join(out,'composer-zoom200-native.png'),Buffer.from(native.png,'base64'));receipt('zoom200-native',{bounds:native.bounds,zoom:native.zoom,method:'Electron webContents.capturePage; Playwright zoom capture may crop'});
  await app!.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].webContents.setZoomFactor(1));receipt('geometry',geometry);
  const after=rows();const intended=['assistant_sessions','assistant_messages','assistant_session_choices','assistant_turn_choices','app_settings','routines','saved_configurations','sqlite_sequence'];
  for(const table of Object.keys(before).filter(t=>!intended.includes(t)))expect(after[table],table).toEqual(before[table]);
  expect(contacts).toEqual([]);receipt('after',after);receipt('preservation',{tables:Object.keys(before),intended,unexpectedContacts:contacts});receipt('cli-requests',captures());receipt('api-requests',requests);
 }finally{
  if(app){const pid=app.process().pid!;await app.close().catch(()=>{});await expect.poll(()=>alive(pid)).toBe(false);}
  await new Promise<void>(resolve=>api.close(()=>resolve()));
  receipt('cleanup',{instances,runtimePids:runtimeIds,remainingRuntimePids:runtimeIds.filter(alive),apiPort:address.port,apiListening:api.listening,state,preservedState:true,at:new Date().toISOString()});
 }
});
