/** Actual backend/PDF worker/notes/restart/ZIP, authored local fixtures only.
 * Native directory and download destinations are scripted, not human observations. */
import {test,expect,_electron,type ElectronApplication,type Page,type Route,type APIResponse} from '@playwright/test';
import {execFileSync} from 'child_process';import fs from 'fs';import os from 'os';import path from 'path';import {createHash} from 'crypto';
import {FRONTEND_ROOT,REPO_ROOT,launchEnv,ensureScreenshotDir} from './fixtures/resmon-app';
import type {LibraryFile,LibraryPage,LibraryStatus} from '../src/api/library';
import type {Project,SavedNote,TextPage} from '../src/api/evidence';
const hash=(raw:Buffer|string)=>createHash('sha256').update(raw).digest('hex');
const alive=(pid:number)=>{try{process.kill(pid,0);return true;}catch{return false;}};
const started=(pid:number)=>execFileSync('ps',['-p',String(pid),'-o','lstart='],{encoding:'utf8'}).trim();
const escaped=(name:string)=>name.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
const ALPHA='Alpha evidence — exact version.',BETA='Beta evidence stays separate.';
type HeldSave={ready:boolean;status:number;body:string;release:()=>void;restore:()=>void};

test('Evidence actual collection, PDF/text passages, notes, restart, exact selected ZIP and isolated refusals',async()=>{
 test.setTimeout(360_000);
 const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'resmon-evidence-journey-')));
 const state=path.join(root,'state'),originals=path.join(root,'originals'),parent=path.join(root,'vault-parent'),exports=path.join(root,'exports'),profile=path.join(root,'profile');
 for(const directory of [state,originals,parent,exports,profile])fs.mkdirSync(directory);
 const env=launchEnv(state,true);env.RESMON_DISABLE_SCHEDULER='1';
 const out=ensureScreenshotDir(),receipt=(name:string,data:unknown)=>fs.writeFileSync(path.join(out,`evidence-${name}.json`),JSON.stringify(data,null,2));
 const python=(code:string,...args:string[])=>execFileSync(env.RESMON_PYTHON,['-c',code,...args],{cwd:REPO_ROOT,env,encoding:'utf8'});
 const sourceFixtures=path.join(REPO_ROOT,'resmon_scripts/verification_scripts/fixtures/evidence');
 const names=['two-pages.pdf','unicode.txt','hostile.md','image-only.pdf','encrypted.pdf','malformed.pdf'];
 for(const name of names)fs.copyFileSync(path.join(sourceFixtures,name),path.join(originals,name));
 python("import sys;sys.path[:0]=['resmon_scripts','resmon_scripts/verification_scripts'];from pathlib import Path;from test_evidence_pdf import action_canaries;Path(sys.argv[1]).write_bytes(action_canaries())",path.join(originals,'actions.pdf'));names.push('actions.pdf');
 const preservation=()=>Object.fromEntries(names.map(name=>[name,hash(fs.readFileSync(path.join(originals,name)))]));const originalHashes=preservation();
 let app:ElectronApplication|undefined,win!:Page,base='',origin='';const rendererErrors:string[]=[];const backends:number[]=[];const instances:unknown[]=[];let vid='',pid='',vaultRoot='';
 const req=async<T>(url:string,method='GET',body?:unknown):Promise<T>=>{
  const response=await fetch(base+url,{method,headers:{Origin:origin,'X-Resmon-Library':'1',...(body===undefined?{}:{'Content-Type':'application/json'})},...(body===undefined?{}:{body:JSON.stringify(body)})});
  expect(response.ok,await response.clone().text()).toBe(true);return response.json() as Promise<T>;
 };
 const project=async()=> (await req<{project:Project}>(`/api/evidence/projects/${pid}?expected_vault_id=${vid}`)).project;
 const notes=async()=> (await req<{notes:SavedNote[]}>(`/api/evidence/projects/${pid}/notes?expected_vault_id=${vid}`)).notes;
 const evidenceRows=()=>python("import sqlite3,sys,json;c=sqlite3.connect(sys.argv[1]);print(json.dumps({t:list(c.execute('SELECT * FROM '+t+' ORDER BY id')) for t in ['evidence_projects','evidence_project_files','evidence_notes']}));c.close()",env.RESMON_DB_PATH);
 const launch=async()=>{
  app=await _electron.launch({args:['.',`--user-data-dir=${profile}`],cwd:FRONTEND_ROOT,env,timeout:180_000});const mainPid=app.process().pid!;win=await app.firstWindow();win.on('pageerror',error=>{rendererErrors.push(error.stack??error.message);receipt('renderer-errors',rendererErrors);});win.on('console',message=>{if(message.type()==='error'){rendererErrors.push(message.text());receipt('renderer-errors',rendererErrors);}});await win.waitForSelector('.app-main');
  const port=await win.evaluate(()=>window.resmonAPI!.getBackendPort());expect(Number(port)).toBeGreaterThan(0);expect(port).not.toBe('8742');base=`http://127.0.0.1:${port}`;origin=new URL(win.url()).origin;expect(origin).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
  const rows=execFileSync('ps',['-axo','pid=,ppid=,command='],{encoding:'utf8'}).split('\n').map(l=>l.trim().match(/^(\d+)\s+(\d+)\s+(.+)$/)).filter(m=>m&&Number(m[2])===mainPid&&m[3].includes('resmon.py'));
  expect(rows).toHaveLength(1);const backendPid=Number(rows[0]![1]);backends.push(backendPid);
  const identity=await app.evaluate(({app})=>({pid:process.pid,state:process.env.RESMON_STATE_DIR,database:process.env.RESMON_DB_PATH,reports:process.env.RESMON_REPORTS_DIR,portFile:process.env.RESMON_PORT_FILE,profile:app.getPath('userData')}));
  expect(identity.state).toBe(state);expect(identity.database).toBe(env.RESMON_DB_PATH);expect(identity.profile).toBe(profile);expect(fs.readFileSync(env.RESMON_PORT_FILE,'utf8').trim()).toBe(port);
  const health=await req<{pid:number;started_at:string;identity:{runtime_id:string;schema_version:number}}>('/api/health');expect(health.pid).toBe(backendPid);expect(health.identity.schema_version).toBe(17);
  instances.push({...identity,mainStart:started(mainPid),backendPid,backendStart:started(backendPid),health,source:REPO_ROOT,port,origin});receipt('instances',instances);
  await app.evaluate(({session,shell,dialog},args)=>{
   const g=globalThis as unknown as {evidenceNetwork:{allowed:string[];blocked:string[];opens:string[];downloads:string[];workerUrls:string[]}};g.evidenceNetwork={allowed:[],blocked:[],opens:[],downloads:[],workerUrls:[]};
   session.defaultSession.webRequest.onBeforeRequest({urls:['*://*/*']},(details,callback)=>{const local=details.url.startsWith(args.base+'/')||details.url.startsWith(args.origin+'/');(local?g.evidenceNetwork.allowed:g.evidenceNetwork.blocked).push(details.url);callback({cancel:!local});});
   shell.openExternal=async url=>{g.evidenceNetwork.opens.push(url);};shell.openPath=async target=>{g.evidenceNetwork.opens.push(target);return 'External viewer forbidden in Evidence fixture';};
   dialog.showOpenDialog=async()=>({canceled:false,filePaths:[args.parent]});
   session.defaultSession.on('will-download',(_event,item)=>g.evidenceNetwork.downloads.push(item.getFilename()));
  },{base,origin,parent});
 };
 const pick=async(name:string)=>{await win.getByRole('region',{name:'Current collection files'}).getByRole('button',{name:new RegExp('^'+escaped(name)+' ')}).click();await expect(win.getByRole('region',{name:'Evidence reader'}).getByRole('heading',{name,exact:true})).toBeVisible();};
 const plain=async(item:LibraryFile,body:string)=>{const p=await project();await req(`/api/evidence/projects/${pid}/notes`,'POST',{expected_vault_id:vid,expected_revision:p.revision,file_id:item.file_id,version_id:item.version_id,kind:'note',body,anchor:null});};
 const nativeScreenshot=async(name:string)=>{const bytes=await app!.evaluate(async({BrowserWindow})=>Array.from((await BrowserWindow.getAllWindows()[0].webContents.capturePage()).toPNG()));fs.writeFileSync(path.join(out,`evidence-${name}-native.png`),Buffer.from(bytes));};
 const settle=()=>win.evaluate(()=>new Promise<void>(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>resolve()))));
 try{
  await launch();await win.evaluate(()=>{location.hash='/library';});await win.getByRole('button',{name:'Choose parent folder',exact:true}).click();await win.getByRole('button',{name:'Create managed vault',exact:true}).click();await expect(win.getByLabel('Import PDF, TXT or MD')).toBeEnabled();
  await win.getByLabel('Import PDF, TXT or MD').setInputFiles(names.map(n=>path.join(originals,n)));await expect(win.getByText(/7 retained, 0 exact duplicates/)).toBeVisible();
  const status=await req<LibraryStatus>('/api/library');vid=status.vault!.vault_id;vaultRoot=path.join(parent,status.vault!.label);const catalog=(await req<LibraryPage>(`/api/library/files?expected_vault_id=${vid}`)).files;
  const item=(name:string)=>catalog.find(f=>f.original_name===name)!;const pdf=item('two-pages.pdf'),txt=item('unicode.txt');
  await win.getByRole('region',{name:'Library files'}).getByRole('button',{name:/^two-pages.pdf /}).click();await win.getByRole('link',{name:'Open in Evidence / add to project'}).click();await win.waitForSelector('.evidence-page');
  await win.getByLabel('New project name',{exact:true}).fill('Synthetic Evidence project');await win.getByRole('button',{name:'Create project',exact:true}).click();
  await expect(win.getByRole('button',{name:'Add selected Library file to project'})).toBeEnabled();await win.getByRole('button',{name:'Add selected Library file to project'}).click();await expect(win.getByLabel('Canonical page text')).toHaveValue(ALPHA);
  pid=(await req<{projects:Project[]}>(`/api/evidence/projects?expected_vault_id=${vid}`)).projects[0].project_id;
  await expect(win.getByRole('region',{name:'PDF page image'})).toContainText('Page 1 of 2 rendered · PDF.js 6.3.289');
  const dimensions=await win.locator('canvas[data-pdf-version]').evaluate(el=>{const c=el as HTMLCanvasElement;const pixels=c.getContext('2d')!.getImageData(0,0,c.width,c.height).data;let dark=0;for(let i=0;i<pixels.length;i+=4)if(pixels[i]<150&&pixels[i+1]<150&&pixels[i+2]<150&&pixels[i+3]>0)dark++;return {width:c.width,height:c.height,dark};});expect(dimensions.width*dimensions.height).toBeLessThanOrEqual(4_000_000);expect(dimensions.dark).toBeGreaterThan(10);receipt('pdf-canvas',dimensions);
  const selectPassage=async(quote:string)=>{await win.getByLabel('Find on current canonical page').fill(quote);await win.getByLabel('Find on current canonical page').press('Enter');await win.getByRole('button',{name:'Use selected passage'}).click();};
  await selectPassage(ALPHA);await win.getByLabel('Note body',{exact:true}).fill('PDF passage body');await win.getByRole('button',{name:'Save passage',exact:true}).click();await expect.poll(async()=> (await notes()).length).toBe(1);
  await win.getByRole('button',{name:'Edit saved body',exact:true}).click();await win.getByLabel('Note body',{exact:true}).fill('Edited PDF passage body');
  // Hold the actual committed response, then type more before delivery. The
  // saved snapshot and the newer unsaved draft must remain distinguishable.
  const noteUrl=`${base}/api/evidence/projects/${pid}/notes/${(await notes())[0].note_id}`;
  await win.evaluate(target=>{
   const original=window.fetch;const state:HeldSave={ready:false,status:0,body:'',release:()=>{},restore:()=>{window.fetch=original;}};
   (window as unknown as {evidenceHeldSave:HeldSave}).evidenceHeldSave=state;
   window.fetch=async(input,init)=>{const response=await original(input,init);if(input===target&&init?.method==='PATCH'){state.status=response.status;state.body=await response.clone().text();await new Promise<void>(resolve=>{state.release=resolve;state.ready=true;});}return response;};
  },noteUrl);
  await win.getByRole('button',{name:'Save body',exact:true}).click();await expect.poll(()=>win.evaluate(()=>(window as unknown as {evidenceHeldSave:HeldSave}).evidenceHeldSave.ready)).toBe(true);
  const heldNote=await win.evaluate(()=>{const s=(window as unknown as {evidenceHeldSave:HeldSave}).evidenceHeldSave;return {status:s.status,body:s.body};});receipt('held-note-upstream',heldNote);expect(heldNote.status).toBe(200);await expect.poll(async()=>(await notes())[0].body).toBe('Edited PDF passage body');
  await win.getByLabel('Note body',{exact:true}).fill('Newer unsaved body after submit');await win.evaluate(()=>{const s=(window as unknown as {evidenceHeldSave:HeldSave}).evidenceHeldSave;s.restore();s.release();});
  await expect(win.getByText('Saved the submitted record. Newer unsaved changes remain in the editor.',{exact:true})).toBeVisible();await expect(win.getByLabel('Note body',{exact:true})).toHaveValue('Newer unsaved body after submit');await expect.poll(async()=>(await notes())[0].body).toBe('Edited PDF passage body');receipt('held-note-draft',{stored:'Edited PDF passage body',unsaved:'Newer unsaved body after submit',transport:'actual native fetch/PATCH response held in renderer before API delivery; exact original Response released after later typing'});
  await win.getByRole('button',{name:'Use plain note',exact:true}).click();await win.getByLabel('Note body',{exact:true}).fill('Plain PDF note');await win.getByRole('button',{name:'Save note',exact:true}).click();await expect.poll(async()=> (await notes()).length).toBe(2);
  await win.getByRole('button',{name:'Next page',exact:true}).click();await expect(win.getByLabel('Canonical page text')).toHaveValue(BETA);await expect(win.getByRole('region',{name:'PDF page image'})).toContainText('Page 2 of 2 rendered');await win.screenshot({path:path.join(out,'evidence-pdf-page2.png')});
  await win.getByRole('button',{name:'Choose from Library',exact:true}).click();for(const name of ['unicode.txt','hostile.md','image-only.pdf']){await win.getByRole('button',{name:`Add ${name}`,exact:true}).click();await expect(win.getByRole('button',{name:'Choose from Library',exact:true})).toBeEnabled();}await win.getByRole('button',{name:'Close Library chooser'}).click();
  expect((await project()).file_count).toBe(4);await pick('unicode.txt');const canonical=fs.readFileSync(path.join(originals,'unicode.txt'),'utf8').replace(/\r\n|\r/g,'\n');await expect(win.getByLabel('Canonical page text')).toHaveValue(canonical);
  await win.getByLabel('Find on current canonical page').fill('repeat needle');await win.getByLabel('Find on current canonical page').press('Enter');await win.getByRole('button',{name:'Find next literal match'}).click();await win.getByRole('button',{name:'Use selected passage'}).click();await win.getByLabel('Note body',{exact:true}).fill('Unicode second occurrence');await win.getByRole('button',{name:'Save passage',exact:true}).click();await expect.poll(async()=> (await notes()).length).toBe(3);
  const unicode=(await notes()).find(n=>n.file_id===txt.file_id)!;expect(unicode.start_codepoint).toBe(Array.from(canonical.slice(0,canonical.lastIndexOf('repeat needle'))).length);expect(unicode.end_codepoint!-unicode.start_codepoint!).toBe(13);
  await plain(txt,'Plain text note');await plain(item('hostile.md'),'UNSELECTED_MD_NOTE');await plain(item('image-only.pdf'),'UNSELECTED_IMAGE_NOTE');await win.getByRole('button',{name:'Refresh project'}).click();await expect(win.getByRole('button',{name:'Export selected evidence',exact:true})).toBeEnabled();
  const saved=await notes();expect(saved).toHaveLength(6);receipt('six-notes',saved);expect(preservation()).toEqual(originalHashes);
  // Held real upstream text success/error after selection change; no stale pane.
  for(const outcome of ['success','error'] as const){
   const pattern=`**/api/evidence/projects/${pid}/reader/${txt.file_id}*representation=text*`;let held:Route|undefined,upstream:APIResponse|undefined;
   await pick('unicode.txt');await expect(win.getByLabel('Canonical page text')).toHaveValue(canonical);await win.route(pattern,async route=>{upstream=await route.fetch();held=route;});await win.getByRole('button',{name:'Recheck page'}).click();await expect.poll(()=>Boolean(held)).toBe(true);
   await pick('hostile.md');await expect(win.getByLabel('Canonical page text')).toHaveValue(fs.readFileSync(path.join(originals,'hostile.md'),'utf8'));
   if(outcome==='success')await held!.fulfill({response:upstream!}).catch(()=>{});else await held!.fulfill({status:409,contentType:'application/json',body:JSON.stringify({detail:{message:'STALE_READER_ERROR'}})}).catch(()=>{});
   await settle();expect(await win.getByText('STALE_READER_ERROR',{exact:false}).count()).toBe(0);await expect(win.getByLabel('Canonical page text')).toHaveValue(fs.readFileSync(path.join(originals,'hostile.md'),'utf8'));await win.unroute(pattern);
  }
  expect(await win.locator('.evidence-canonical script,.evidence-canonical img,.evidence-canonical a').count()).toBe(0);
  await pick('image-only.pdf');await expect(win.getByRole('region',{name:'Evidence reader'})).toContainText('Canonical page text: no text');await expect(win.getByRole('region',{name:'PDF page image'})).toContainText('Page 1 of 1 rendered');
  // Both actual ZIP downloads: exactly two members/four of six notes.
  const bundleReceipts:unknown[]=[];
  for(const include of [false,true]){
   await win.getByRole('button',{name:'Export selected evidence',exact:true}).click();const dialog=win.getByRole('region',{name:'Selected evidence bundle'});
   for(const name of ['two-pages.pdf','unicode.txt'])await dialog.getByLabel(new RegExp('^'+escaped(name)+' ')).check();if(include)await dialog.getByLabel('Include retained files',{exact:true}).check();
   const target=path.join(exports,include?'selected-files.zip':'selected-metadata.zip');await app!.evaluate(({session},destination)=>{session.defaultSession.once('will-download',(_event,download)=>{download.setSavePath(destination);});},target);
   await dialog.getByRole('button',{name:'Download selected ZIP'}).click();await expect.poll(()=>fs.existsSync(target)&&fs.statSync(target).size>0).toBe(true);
   const result=JSON.parse(python(`import sys,zipfile,json,hashlib
with zipfile.ZipFile(sys.argv[1]) as z:
 assert z.testzip() is None
 print(json.dumps({'names':z.namelist(),'manifest':json.loads(z.read('manifest.json')),'markdown':z.read('notes.md').decode(),'hashes':{n:hashlib.sha256(z.read(n)).hexdigest() for n in z.namelist()}}))`,target)) as {names:string[];manifest:{mode:string;vault_id:string;project:{project_id:string};files:{file_id:string;version_id:string;content_path?:string;notes:SavedNote[]}[]};markdown:string;hashes:Record<string,string>};
   expect(result.manifest.mode).toBe(include?'include_retained_files':'metadata_only');expect(result.manifest.vault_id).toBe(vid);expect(result.manifest.project.project_id).toBe(pid);expect(new Set(result.manifest.files.map(f=>f.file_id))).toEqual(new Set([pdf.file_id,txt.file_id]));
   const expectedNotes=saved.filter(n=>[pdf.file_id,txt.file_id].includes(n.file_id));expect(new Set(result.manifest.files.flatMap(f=>f.notes.map(n=>n.note_id)))).toEqual(new Set(expectedNotes.map(n=>n.note_id)));
   const expectedPaths=['manifest.json','notes.md'];if(include)for(const f of result.manifest.files){const source=catalog.find(x=>x.file_id===f.file_id)!;expect(f.content_path).toBe(source.relative_path);expectedPaths.push(source.relative_path);expect(result.hashes[source.relative_path]).toBe(source.sha256);}expect(result.names.sort()).toEqual(expectedPaths.sort());expect(result.names.length).toBe(new Set(result.names).size);
   for(const forbidden of [root,parent,'UNSELECTED_MD_NOTE','UNSELECTED_IMAGE_NOTE'])expect(JSON.stringify(result.manifest)+result.markdown).not.toContain(forbidden);
   bundleReceipts.push({target,sha256:hash(fs.readFileSync(target)),method:'actual Electron ZIP, scripted Save destination',...result});await win.screenshot({path:path.join(out,include?'evidence-bundle-files.png':'evidence-bundle-metadata.png')});await dialog.getByRole('button',{name:'Close export'}).click();
  }
  receipt('bundles',bundleReceipts);
  // Hold a completely built HTTP bundle and retire its dialog before delivery.
  await win.getByRole('button',{name:'Export selected evidence',exact:true}).click();const dialog=win.getByRole('region',{name:'Selected evidence bundle'});await dialog.getByLabel(/^two-pages.pdf /).check();let heldBundle:Route|undefined,upstreamBundle:APIResponse|undefined;
  const bundlePattern=`**/api/evidence/projects/${pid}/bundle`;await win.route(bundlePattern,async route=>{upstreamBundle=await route.fetch();heldBundle=route;});await dialog.getByRole('button',{name:'Download selected ZIP'}).click();await expect.poll(()=>Boolean(heldBundle)).toBe(true);await pick('unicode.txt');await expect(dialog).toHaveCount(0);await heldBundle!.fulfill({response:upstreamBundle!}).catch(()=>{});await settle();await win.unroute(bundlePattern);
  expect(await app!.evaluate(()=>(globalThis as unknown as {evidenceNetwork:{downloads:string[]}}).evidenceNetwork.downloads.length)).toBe(2);
  // Reopen the exact saved passage after actual main/backend restart.
  receipt('network-before-restart',await app!.evaluate(()=>(globalThis as unknown as {evidenceNetwork:unknown}).evidenceNetwork));const beforeRestart=evidenceRows();const oldPid=app!.process().pid!;await app!.close();expect(alive(oldPid)).toBe(false);await launch();await win.evaluate(projectId=>{location.hash='/evidence?project_id='+projectId;},pid);await win.waitForSelector('.evidence-page');
  await expect(win.getByRole('button',{name:'Reopen saved passage',exact:true})).toHaveCount(2);await win.getByRole('button',{name:'Reopen saved passage',exact:true}).first().click();await expect(win.getByLabel('Canonical page text')).toHaveValue(ALPHA);await expect(win.getByText(/^Saved passage resolved against/)).toBeVisible();expect(evidenceRows()).toBe(beforeRestart);
  await app!.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].webContents.setZoomFactor(2));await win.getByLabel('Find on current canonical page').focus();await expect(win.getByLabel('Find on current canonical page')).toBeFocused();const geometry=await win.getByLabel('Find on current canonical page').evaluate(el=>{const main=document.querySelector('.app-main')!;return {right:el.getBoundingClientRect().right,width:innerWidth,scroll:document.documentElement.scrollWidth,mainScroll:main.scrollWidth,mainWidth:main.clientWidth,dpr:devicePixelRatio};});expect(geometry.right).toBeLessThanOrEqual(geometry.width);expect(geometry.scroll).toBe(geometry.width);expect(geometry.mainScroll).toBe(geometry.mainWidth);receipt('zoom200',geometry);await win.screenshot({path:path.join(out,'evidence-zoom200.png')});await nativeScreenshot('zoom200');await app!.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].webContents.setZoomFactor(1));
  for(const theme of ['dark','light'] as const){await app!.evaluate(({nativeTheme},value)=>{nativeTheme.themeSource=value;},theme);await settle();await win.screenshot({path:path.join(out,`evidence-${theme}.png`)});await nativeScreenshot(theme);}
  const retained=path.join(vaultRoot,pdf.relative_path),raw=fs.readFileSync(retained);fs.renameSync(retained,retained+'.held');try{await win.getByRole('button',{name:'Recheck page'}).click();await expect(win.getByRole('region',{name:'Evidence reader'}).getByRole('alert').first()).toBeVisible();expect(await notes()).toEqual(saved);await win.screenshot({path:path.join(out,'evidence-missing-refusal.png')});}finally{fs.renameSync(retained+'.held',retained);}expect(fs.readFileSync(retained)).toEqual(raw);await win.getByRole('button',{name:'Recheck page'}).click();await expect(win.getByLabel('Canonical page text')).toHaveValue(ALPHA);await expect(win.getByText(/^Saved passage resolved against/)).toBeVisible();
  await win.getByRole('button',{name:'Remove two-pages.pdf from collection',exact:true}).click();await expect.poll(async()=> (await notes()).filter(n=>n.file_id===pdf.file_id).every(n=>n.membership_state==='removed')).toBe(true);expect(fs.readFileSync(retained)).toEqual(raw);await win.getByRole('button',{name:'Reopen saved passage',exact:true}).first().click();await expect(win.getByRole('region',{name:'Saved evidence notes'})).toContainText('File removed from this collection.');
  await win.getByRole('button',{name:'Choose from Library',exact:true}).click();await win.getByRole('button',{name:'Add two-pages.pdf',exact:true}).click();await expect.poll(async()=> (await notes()).filter(n=>n.file_id===pdf.file_id).every(n=>n.membership_state==='member')).toBe(true);
  for(const name of ['encrypted.pdf','malformed.pdf','actions.pdf']){await win.getByRole('button',{name:`Add ${name}`,exact:true}).click();await expect(win.getByRole('button',{name:'Choose from Library',exact:true})).toBeEnabled();if(name==='actions.pdf'){await expect(win.getByRole('region',{name:'PDF page image'})).toContainText('rendered');}else await expect(win.getByRole('region',{name:'Evidence reader'}).getByRole('alert').first()).toBeVisible();}
  await win.getByRole('button',{name:'Close Library chooser'}).click();
  const network=await app!.evaluate(()=>(globalThis as unknown as {evidenceNetwork:unknown}).evidenceNetwork) as {allowed:string[];blocked:string[];opens:string[];downloads:string[]};expect(network.blocked).toEqual([]);expect(network.opens).toEqual([]);expect(network.allowed.some(url=>url.endsWith('/pdfjs/6.3.289/build/pdf.worker.min.js'))).toBe(true);receipt('network-local-only',network);
  // Held real project-detail responses cannot replace the later selected project.
  const other=(await req<{project:Project}>('/api/evidence/projects','POST',{expected_vault_id:vid,name:'Held-response project B'})).project;
  await win.evaluate(()=>{location.hash='/library';});await win.getByRole('heading',{name:'Library',exact:true}).waitFor();await win.evaluate(()=>{location.hash='/evidence';});
  const chooseProject=async(name:string)=>win.getByRole('region',{name:'Project collections'}).getByRole('button',{name:new RegExp('^'+escaped(name)+' ')}).click();
  for(const outcome of ['success','error'] as const){
   const pattern=new RegExp('/api/evidence/projects/'+pid+'\\?');let held:Route|undefined,upstream:APIResponse|undefined;
   await win.route(pattern,async route=>{upstream=await route.fetch();held=route;});await chooseProject('Synthetic Evidence project');await expect.poll(()=>Boolean(held)).toBe(true);await chooseProject(other.name);
   await expect(win.getByRole('heading',{name:other.name,exact:true})).toBeVisible();
   if(outcome==='success')await held!.fulfill({response:upstream!}).catch(()=>{});else await held!.fulfill({status:409,contentType:'application/json',body:JSON.stringify({detail:{message:'STALE_PROJECT_ERROR'}})}).catch(()=>{});
   await settle();await expect(win.getByRole('heading',{name:other.name,exact:true})).toBeVisible();expect(await win.getByText('STALE_PROJECT_ERROR',{exact:false}).count()).toBe(0);await win.unroute(pattern);
  }
  await chooseProject('Synthetic Evidence project');await pick('two-pages.pdf');await expect(win.getByLabel('Canonical page text')).toHaveValue(ALPHA);
  for(const outcome of ['success','error'] as const){
   await win.getByLabel('Page',{exact:true}).fill('1');await expect(win.getByLabel('Canonical page text')).toHaveValue(ALPHA);
   const pattern=`**/api/evidence/projects/${pid}/reader/${pdf.file_id}*page=1&representation=text*`;let held:Route|undefined,upstream:APIResponse|undefined;
   await win.route(pattern,async route=>{upstream=await route.fetch();held=route;});await win.getByRole('button',{name:'Recheck page'}).click();await expect.poll(()=>Boolean(held)).toBe(true);await win.getByRole('button',{name:'Cancel page read'}).click();await win.getByLabel('Page',{exact:true}).fill('2');await expect(win.getByLabel('Canonical page text')).toHaveValue(BETA);
   if(outcome==='success')await held!.fulfill({response:upstream!}).catch(()=>{});else await held!.fulfill({status:409,contentType:'application/json',body:JSON.stringify({detail:{message:'STALE_PAGE_ERROR'}})}).catch(()=>{});
   await settle();await expect(win.getByLabel('Canonical page text')).toHaveValue(BETA);expect(await win.getByText('STALE_PAGE_ERROR',{exact:false}).count()).toBe(0);await win.unroute(pattern);
  }
  receipt('held-responses',{file:['success','error'],project:['success','error'],pageAfterCancel:['success','error'],bundle:'complete HTTP response retired before download',notesUnchanged:(await notes()).length===saved.length});expect((await notes()).length).toBe(saved.length);
  // Existing real confirmations, synthetic state only. No credentials were set.
  const beforeReset=evidenceRows();await win.evaluate(()=>{location.hash='/settings/advanced';});for(const label of ['Erase the paper corpus','Reset all settings']){await win.getByRole('button',{name:label,exact:true}).click();await win.getByPlaceholder('Type CONFIRM').fill('CONFIRM');const response=win.waitForResponse(r=>r.url().includes('/api/admin/'));await win.getByRole('button',{name:'Confirm',exact:true}).click();expect((await response).status()).toBe(200);}expect(evidenceRows()).toBe(beforeReset);expect(preservation()).toEqual(originalHashes);for(const f of catalog)expect(hash(fs.readFileSync(path.join(vaultRoot,f.relative_path)))).toBe(f.sha256);receipt('preservation',{originalHashes,after:preservation(),beforeReset:hash(beforeReset),afterReset:hash(evidenceRows()),fileCount:catalog.length});
 }finally{
  if(win&&!win.isClosed()){await win.screenshot({path:path.join(out,'evidence-terminal.png')}).catch(()=>{});receipt('terminal-renderer',{url:win.url(),errors:rendererErrors,body:await win.locator('body').innerText().catch(()=> 'unavailable')});}
  if(app){receipt('network-at-cleanup',await app.evaluate(()=>(globalThis as unknown as {evidenceNetwork:unknown}).evidenceNetwork).catch(()=> 'unavailable'));const owned=app.process().pid!;await app.close().catch(()=>{});await expect.poll(()=>alive(owned)).toBe(false);}await expect.poll(()=>backends.filter(alive)).toEqual([]);receipt('cleanup',{root,instances,backends,remaining:backends.filter(alive),at:new Date().toISOString(),preservedState:true});
 }
});
