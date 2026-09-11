/** Real retained copies and bounded reads through Electron/HTTP. Synthetic only.
 * Pickers, OS-open results and download destinations are scripted. No viewer claim. */
import {test,expect,_electron,type ElectronApplication,type Page,type Route} from '@playwright/test';
import {execFileSync} from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {createHash} from 'crypto';
import {FRONTEND_ROOT,REPO_ROOT,launchEnv,ensureScreenshotDir} from './fixtures/resmon-app';
import type {LibraryFile,LibraryPage,LibraryStatus,TextEnvelope} from '../src/api/library';
const hash=(raw:Buffer|string)=>createHash('sha256').update(raw).digest('hex');
const alive=(pid:number)=>{try{process.kill(pid,0);return true;}catch{return false;}};
const started=(pid:number)=>execFileSync('ps',['-p',String(pid),'-o','lstart='],{encoding:'utf8'}).trim();

test('owned vault, 123 items, exact text/Open/inventory, delayed responses, restart and reset retention',async()=>{
 test.setTimeout(300_000);
 // Electron canonicalizes /var to /private/var on macOS. Supply the physical
 // newly-created root everywhere so exact state/profile assertions still hold.
 const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'resmon-library-journey-')));
 const state=path.join(root,'state'),originals=path.join(root,'originals'),parent=path.join(root,'vault-parent'),exports=path.join(root,'exports');
 for(const d of [state,originals,parent,exports])fs.mkdirSync(d);
 const env=launchEnv(state,true);env.RESMON_DISABLE_SCHEDULER='1';
 const out=ensureScreenshotDir();const receipt=(name:string,data:unknown)=>fs.writeFileSync(path.join(out,`library-${name}.json`),JSON.stringify(data,null,2));
 const python=(source:string,...args:string[])=>execFileSync(env.RESMON_PYTHON,['-c',source,...args],{cwd:REPO_ROOT,env,encoding:'utf8'});
 python(`import sys
sys.path.insert(0,'resmon_scripts')
from implementation_scripts import database as d
d.init_db(sys.argv[1]);c=d.get_connection(sys.argv[1])
for i in range(2):d.insert_document(c,{'source_repository':'synthetic','external_id':str(i),'title':'Library synthetic paper '+str(i),'metadata_hash':'library'+str(i)})
c.commit();c.close()`,env.RESMON_DB_PATH);
 const originalData:{name:string;bytes:Buffer}[]=[{name:'A <b>literal.txt',bytes:Buffer.from('one target\r\ntwo target\rlast\n<script>window.libraryExecuted=true</script>\n<img src="https://library.invalid/probe"> [link](https://library.invalid/) $(fiction)\n')},{name:'B notes.md',bytes:Buffer.from('# Authored notes\nUnicode λ and target\n')},{name:'C source.pdf',bytes:Buffer.from('%PDF-1.4\n% authored envelope, not a parser fixture\n%%EOF')}];
 for(const f of originalData)fs.writeFileSync(path.join(originals,f.name),f.bytes);
 const preservation=()=>originalData.map(f=>({name:f.name,sha256:hash(fs.readFileSync(path.join(originals,f.name)))}));const before=preservation();
 let app:ElectronApplication|undefined;let win!:Page;let base='',origin='';const instances:unknown[]=[];const backendPids:number[]=[];const forbidden:string[]=[];
 const launch=async()=>{
  app=await _electron.launch({args:['.',`--user-data-dir=${path.join(root,'profile')}`],cwd:FRONTEND_ROOT,env,timeout:180_000});
  const pid=app.process().pid!;const processStart=started(pid);win=await app.firstWindow();await win.waitForSelector('.app-main');
  const port=await win.evaluate(()=>window.resmonAPI!.getBackendPort());expect(port).not.toBe('8742');expect(Number(port)).toBeGreaterThan(0);base=`http://127.0.0.1:${port}`;origin=new URL(win.url()).origin;
  expect(origin).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
  const processRows=execFileSync('ps',['-axo','pid=,ppid=,command='],{encoding:'utf8'}).split('\n');
  const owned=processRows.map(l=>l.trim().match(/^(\d+)\s+(\d+)\s+(.+)$/)).filter(m=>m&&Number(m[2])===pid&&m[3].includes('resmon.py'));
  expect(owned).toHaveLength(1);const backendPid=Number(owned[0]![1]);backendPids.push(backendPid);
  const identity=await app.evaluate(({app})=>({mainPid:process.pid,state:process.env.RESMON_STATE_DIR,database:process.env.RESMON_DB_PATH,reports:process.env.RESMON_REPORTS_DIR,portFile:process.env.RESMON_PORT_FILE,profile:app.getPath('userData')}));
  expect(identity.state).toBe(state);expect(identity.database).toBe(env.RESMON_DB_PATH);expect(identity.profile).toBe(path.join(root,'profile'));
  const instance={...identity,mainStart:processStart,backendPid,backendStart:started(backendPid),backendCommand:owned[0]![3],port,source:REPO_ROOT,origin};instances.push(instance);receipt('instances',instances);
  expect(fs.readFileSync(env.RESMON_PORT_FILE,'utf8').trim()).toBe(port);
  await win.route('**/*',route=>{const url=route.request().url();if(/^https?:/.test(url)&&!url.startsWith(base+'/')&&!url.startsWith(origin+'/')){forbidden.push(url);return route.abort();}return route.continue();});
  // Preserve the production IPC handler, intercept only its OS dependency.
  await app.evaluate(({dialog,shell},chosen)=>{
   dialog.showOpenDialog=async()=>({canceled:false,filePaths:[chosen]});
   const g=globalThis as unknown as {libraryOpenPaths:string[];libraryOpenFailure:boolean};g.libraryOpenPaths=[];g.libraryOpenFailure=false;
   shell.openPath=async target=>{g.libraryOpenPaths.push(target);return g.libraryOpenFailure?'authored OS-open refusal':'';};
  },parent);
  const health=await fetch(base+'/api/health');const h=await health.json();expect(h.pid).toBe(backendPid);expect(h.identity.schema_version).toBe(16);
  await win.evaluate(()=>{location.hash='/library';});await win.waitForSelector('.library-page');
 };
 const req=async<T>(suffix:string,method='GET',body?:unknown):Promise<T>=>{
  const r=await fetch(base+'/api/library'+suffix,{method,headers:{Origin:origin,'X-Resmon-Library':'1',...(body===undefined?{}:{'Content-Type':'application/json'})},body:body===undefined?undefined:JSON.stringify(body)});
  expect(r.ok,await r.clone().text()).toBe(true);return r.json() as Promise<T>;
 };
 const select=async(name:string)=>{await win.getByRole('button',{name:new RegExp(name.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')+' (text/|application/)')}).click();await expect(win.getByRole('heading',{name,exact:true})).toBeVisible();};
 try{
  await launch();await win.getByText('Choose parent folder',{exact:true}).click();await expect(win.getByText(parent,{exact:true})).toBeVisible();
  expect((await req<LibraryStatus>('')).vault).toBeNull();await win.getByRole('button',{name:'Create managed vault',exact:true}).click();await expect(win.getByLabel('Import PDF, TXT or MD')).toBeEnabled();
  await win.getByLabel('Import PDF, TXT or MD').setInputFiles(originalData.map(f=>path.join(originals,f.name)));await expect(win.getByText(/3 retained, 0 exact duplicates/)).toBeVisible();
  const status=await req<LibraryStatus>('');const vid=status.vault!.vault_id,vaultRoot=path.join(parent,status.vault!.label),q=`?expected_vault_id=${vid}`;
  let page=await req<LibraryPage>('/files'+q);const imported=page.files;
  for(const f of imported){const original=originalData.find(o=>o.name===f.original_name)!;expect(fs.readFileSync(path.join(vaultRoot,f.relative_path))).toEqual(original.bytes);expect(hash(original.bytes)).toBe(f.sha256);}
  expect(await win.getByRole('region',{name:'Library files'}).locator('b,script,img,a').count()).toBe(0);
  expect(preservation()).toEqual(before);receipt('imports',{status,files:imported,originals:before});
  const txt=imported.find(f=>f.media_type==='text/plain')!,pdf=imported.find(f=>f.media_type==='application/pdf')!;
  await select(txt.original_name);const detail=win.getByRole('region',{name:'Selected Library item'});
  for(const id of ['1','2']){await win.getByLabel('Existing paper ID').fill(id);await win.getByText('Associate paper',{exact:true}).click();await expect(win.getByText(new RegExp(`Linked local paper ${id}`))).toBeVisible();}
  const databaseDump=()=>python("import sqlite3,sys;from pathlib import Path;c=sqlite3.connect(Path(sys.argv[1]).as_uri()+'?mode=ro',uri=True);print('\\n'.join(c.iterdump()));c.close()",env.RESMON_DB_PATH);const beforeRead=hash(databaseDump());
  await win.getByText('Read text',{exact:true}).click();const lines=win.getByRole('region',{name:'Literal retained lines'});await expect(lines).toContainText('<script>window.libraryExecuted=true</script>');
  expect(await lines.locator('script,img,a').count()).toBe(0);expect(await win.evaluate(()=>(window as unknown as {libraryExecuted?:boolean}).libraryExecuted)).toBeUndefined();
  await win.getByLabel('Find in this text').fill('target');await expect(win.getByText('1 of 2 matches',{exact:true})).toBeVisible();await win.getByText('Next match',{exact:true}).click();await expect(win.getByText('2 of 2 matches',{exact:true})).toBeVisible();
  await expect(win.locator('[data-library-line="1"]')).toBeFocused();await win.getByText('Previous match',{exact:true}).click();await expect(win.locator('[data-library-line="0"]')).toBeFocused();
  await win.getByLabel('Find in this text').fill('absent');await expect(win.getByText('No matches.',{exact:true})).toBeVisible();await win.getByLabel('Find in this text').fill('');await expect(win.getByText('Next match',{exact:true})).toBeDisabled();
  const text=await req<TextEnvelope>(`/files/${txt.file_id}/text${q}&expected_version_id=${txt.version_id}`);expect(text.text).toBe(originalData[0].bytes.toString().replace(/\r\n|\r/g,'\n'));receipt('text',text);expect(hash(databaseDump())).toBe(beforeRead);receipt('read-preservation',{beforeDatabaseDump:beforeRead,afterDatabaseDump:hash(databaseDump()),originals:preservation()});
  await win.screenshot({path:path.join(out,'library-reader.png')});
  await app!.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].webContents.setZoomFactor(2));await win.getByLabel('Find in this text').focus();await expect(win.getByLabel('Find in this text')).toBeFocused();
  const geometry=await win.getByLabel('Find in this text').evaluate(el=>({rect:el.getBoundingClientRect().toJSON(),width:innerWidth,scroll:document.documentElement.scrollWidth}));expect(geometry.rect.right).toBeLessThanOrEqual(geometry.width);expect(geometry.scroll).toBe(geometry.width);receipt('zoom200',geometry);
  const png=await app!.evaluate(async({BrowserWindow})=>(await BrowserWindow.getAllWindows()[0].webContents.capturePage()).toPNG().toString('base64'));fs.writeFileSync(path.join(out,'library-zoom200.png'),Buffer.from(png,'base64'));await app!.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].webContents.setZoomFactor(1));
  await win.getByText('Close reader',{exact:true}).click();await expect(win.getByText('Read text',{exact:true})).toBeFocused();
  const settle=()=>win.evaluate(()=>new Promise<void>(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>resolve()))));
  // Hold actual upstream success/error responses and release only after selection changes.
  for(const outcome of ['success','error'] as const){
   let held:Route|undefined;const pattern=`**/api/library/files/${txt.file_id}/text*`;
   await win.route(pattern,async route=>{held=route;});await win.getByText('Read text',{exact:true}).click();await expect.poll(()=>!!held).toBe(true);
   await select('B notes.md');await win.getByText('Read text',{exact:true}).click();await expect(win.getByRole('region',{name:'Literal retained lines'})).toContainText('# Authored notes');
   const finished=win.waitForEvent('requestfinished',r=>r.url()===held!.request().url());
   if(outcome==='success'){const upstream=await held!.fetch();await held!.fulfill({response:upstream});}else await held!.fulfill({status:409,contentType:'application/json',body:JSON.stringify({detail:{message:'authored stale error'}})});
   await finished;await settle();await expect(win.getByRole('region',{name:'Literal retained lines'})).toContainText('# Authored notes');expect(await win.getByText('authored stale error',{exact:false}).count()).toBe(0);await win.unroute(pattern);await select(txt.original_name);
  }
  for(const outcome of ['success','error'] as const){
   let held:Route|undefined;const pattern=`**/api/library/files/${txt.file_id}/text*`;
   await win.route(pattern,route=>{held=route;});await win.getByText('Read text',{exact:true}).click();await expect.poll(()=>!!held).toBe(true);await win.getByText('Close reader',{exact:true}).click();
   const finished=win.waitForEvent('requestfinished',r=>r.url()===held!.request().url());
   if(outcome==='success')await held!.fulfill({response:await held!.fetch()});else await held!.fulfill({status:409,contentType:'application/json',body:JSON.stringify({detail:{message:'closed reader old error'}})});
   await finished;await settle();expect(await win.getByRole('region',{name:'Retained text reader'}).count()).toBe(0);expect(await win.getByText('closed reader old error',{exact:false}).count()).toBe(0);await expect(win.getByText('Read text',{exact:true})).toBeFocused();await win.unroute(pattern);
  }
  // Neither an old Open nor inventory result may act after selection changes.
  await app!.evaluate(({BrowserWindow})=>{const g=globalThis as unknown as {libraryDownloads:string[]};g.libraryDownloads=[];BrowserWindow.getAllWindows()[0].webContents.session.on('will-download',(_event,item)=>g.libraryDownloads.push(item.getFilename()));});
  for(const kind of ['open','export'] as const)for(const outcome of ['success','error'] as const){
   await select(txt.original_name);let held:Route|undefined;const pattern=kind==='open'?`**/api/library/files/${txt.file_id}/open`:'**/api/library/export*';
   await win.route(pattern,route=>{held=route;});await win.getByText(kind==='open'?'Open externally':'Export complete JSON inventory',{exact:true}).click();await expect.poll(()=>!!held).toBe(true);await select(pdf.original_name);
   const finished=win.waitForEvent('requestfinished',r=>r.url()===held!.request().url());
   if(outcome==='success')await held!.fulfill({response:await held!.fetch()});else await held!.fulfill({status:409,contentType:'application/json',body:JSON.stringify({detail:{message:'authored stale action error'}})});
   await finished;await settle();await win.unroute(pattern);
   expect(await app!.evaluate(()=>(globalThis as unknown as {libraryOpenPaths:string[]}).libraryOpenPaths)).toEqual([]);
   expect(await app!.evaluate(()=>(globalThis as unknown as {libraryDownloads:string[]}).libraryDownloads)).toEqual([]);
   expect(await win.getByText('authored stale action error',{exact:false}).count()).toBe(0);
  }
  await win.getByText('Read text',{exact:true}).click();await expect(win.getByRole('alert')).toContainText('PDF is retained');
  await win.getByText('Open externally',{exact:true}).click();await expect(win.getByText(/Open requested/)).toBeVisible();
  expect(await app!.evaluate(()=>(globalThis as unknown as {libraryOpenPaths:string[]}).libraryOpenPaths)).toEqual([path.join(vaultRoot,pdf.relative_path)]);
  await app!.evaluate(()=>{(globalThis as unknown as {libraryOpenFailure:boolean}).libraryOpenFailure=true;});await win.getByText('Open externally',{exact:true}).click();await expect(win.getByText(/authored OS-open refusal/)).toBeVisible();
  await win.screenshot({path:path.join(out,'library-pdf-refusal.png')});receipt('open',{file:pdf,paths:await app!.evaluate(()=>(globalThis as unknown as {libraryOpenPaths:string[]}).libraryOpenPaths),method:'real button/backend/IPC; OS shell.openPath intercepted, no viewer launched'});
  // Reimport identical originals, a renamed duplicate and new bytes under an existing name.
  await win.getByLabel('Import PDF, TXT or MD').setInputFiles(originalData.map(f=>path.join(originals,f.name)));await expect(win.getByText(/0 retained, 3 exact duplicates/)).toBeVisible();
  const alias=path.join(originals,'Renamed exact.txt');fs.writeFileSync(alias,originalData[0].bytes);
  await win.getByLabel('Import PDF, TXT or MD').setInputFiles(alias);await expect(win.getByText(/0 retained, 1 exact duplicates/)).toBeVisible();
  expect((await req<{file:LibraryFile}>(`/files/${txt.file_id}${q}`)).file.original_name).toBe(txt.original_name);
  const changedDir=path.join(originals,'distinct-selection');fs.mkdirSync(changedDir);const changed=path.join(changedDir,'B notes.md');fs.writeFileSync(changed,'# Different authored bytes, same selected filename\n');
  await win.getByLabel('Import PDF, TXT or MD').setInputFiles(changed);await expect(win.getByText(/1 retained, 0 exact duplicates/)).toBeVisible();
  const four=(await req<LibraryPage>('/files'+q)).files;expect(four).toHaveLength(4);expect(four.filter(f=>f.original_name==='B notes.md')).toHaveLength(2);expect(new Set(four.map(f=>f.version_id)).size).toBe(4);
  receipt('duplicates',{aliasHash:hash(fs.readFileSync(alias)),changedHash:hash(fs.readFileSync(changed)),files:four});expect(preservation()).toEqual(before);
  const marker=path.join(vaultRoot,'vault.json'),markerBytes=fs.readFileSync(marker);
  for(const mode of ['missing','wrong'] as const){
   await select(txt.original_name);
   if(mode==='missing')fs.renameSync(marker,marker+'.held');else fs.writeFileSync(marker,JSON.stringify({version:1,vault_id:'44444444-4444-4444-8444-444444444444'}));
   try{
    await win.getByText('Read text',{exact:true}).click();await expect(win.getByRole('region',{name:'Retained text reader'}).getByRole('alert')).toContainText('Cannot read here');
    await win.getByText('Refresh Library',{exact:true}).click();await expect(win.getByLabel('Import PDF, TXT or MD')).toBeDisabled();
   }finally{if(mode==='missing')fs.renameSync(marker+'.held',marker);else fs.writeFileSync(marker,markerBytes);}
   await win.getByText('Refresh Library',{exact:true}).click();await expect(win.getByLabel('Import PDF, TXT or MD')).toBeEnabled();
  }
  receipt('marker-restoration',{sha256:hash(fs.readFileSync(marker)),originalSha256:hash(markerBytes)});
  for(let i=0;i<119;i++){
   const bytes=Buffer.from(`authored item ${i}`);const r=await fetch(base+`/api/library/files${q}&filename=${encodeURIComponent(`item-${String(i).padStart(3,'0')}.txt`)}`,{method:'POST',headers:{Origin:origin,'X-Resmon-Library':'1','Content-Type':'application/octet-stream'},body:bytes});expect(r.status).toBe(201);
  }
  await win.getByText('Refresh Library',{exact:true}).click();await expect(win.getByRole('region',{name:'Library files'}).locator('.library-item')).toHaveCount(50);await win.getByText('Next 50 items',{exact:true}).click();await expect(win.getByRole('region',{name:'Library files'}).locator('.library-item')).toHaveCount(50);await win.getByText('Next 50 items',{exact:true}).click();await expect(win.getByRole('region',{name:'Library files'}).locator('.library-item')).toHaveCount(23);
  page=await req<LibraryPage>('/files'+q);const all=[...page.files];const ceiling=page.through_id;while(page.has_more){page=await req<LibraryPage>(`/files${q}&through_id=${ceiling}&before_id=${page.next_before_id}`);all.push(...page.files);}expect(new Set(all.map(f=>f.file_id)).size).toBe(123);receipt('paging',{ceiling,count:all.length,ids:all.map(f=>f.file_id)});
  const destination=path.join(exports,'complete.json');await app!.evaluate(({BrowserWindow},target)=>{BrowserWindow.getAllWindows()[0].webContents.session.once('will-download',(_e,item)=>item.setSavePath(target));},destination);
  await win.getByText('Export complete JSON inventory',{exact:true}).click();await expect.poll(()=>fs.existsSync(destination)).toBe(true);
  const inventory=JSON.parse(fs.readFileSync(destination,'utf8')) as {vault_id:string;files:{file_id:string;version_id:string}[]};expect(inventory.vault_id).toBe(vid);expect(inventory.files).toHaveLength(123);expect(new Set(inventory.files.map(f=>f.file_id))).toEqual(new Set(all.map(f=>f.file_id)));expect(fs.readFileSync(destination,'utf8')).not.toContain(parent);receipt('inventory',{destination,sha256:hash(fs.readFileSync(destination)),count:inventory.files.length,method:'actual Electron download with scripted save path'});
  const oldPid=app!.process().pid!;await app!.close();expect(alive(oldPid)).toBe(false);await launch();expect((await req<LibraryStatus>('')).vault!.vault_id).toBe(vid);
  await win.getByLabel('Search filenames').fill('A <b>literal');await win.getByText('Search Library',{exact:true}).click();await select(txt.original_name);await win.getByText('Read text',{exact:true}).click();await expect(win.getByRole('region',{name:'Literal retained lines'})).toContainText('one target');
  await win.evaluate(()=>{location.hash='/settings/advanced';});await win.getByRole('button',{name:'Erase the paper corpus',exact:true}).click();await win.getByPlaceholder('Type CONFIRM').fill('CONFIRM');
  const erased=win.waitForResponse(r=>r.url().endsWith('/api/admin/erase-corpus'));await win.getByRole('button',{name:'Confirm',exact:true}).click();expect((await erased).status()).toBe(200);
  await win.getByRole('button',{name:'Reset all settings',exact:true}).click();await win.getByPlaceholder('Type CONFIRM').fill('CONFIRM');const reset=win.waitForResponse(r=>r.url().endsWith('/api/admin/reset-settings'));await win.getByRole('button',{name:'Confirm',exact:true}).click();expect((await reset).status()).toBe(200);
  const afterDetail=await req<{file:LibraryFile}>(`/files/${txt.file_id}${q}`);expect(afterDetail.file.paper_links).toEqual([]);expect((await req<LibraryStatus>('')).counts.items).toBe(123);
  expect(preservation()).toEqual(before);for(const f of imported)expect(hash(fs.readFileSync(path.join(vaultRoot,f.relative_path)))).toBe(f.sha256);
  receipt('retention',{originals:preservation(),retained:imported.map(f=>({file_id:f.file_id,sha256:hash(fs.readFileSync(path.join(vaultRoot,f.relative_path)))})),afterDetail,forbidden});expect(forbidden).toEqual([]);
 }finally{
  if(app){const pid=app.process().pid!;await app.close().catch(()=>{});await expect.poll(()=>alive(pid)).toBe(false);}
  await expect.poll(()=>backendPids.filter(alive)).toEqual([]);receipt('cleanup',{at:new Date().toISOString(),backendPids,remaining:backendPids.filter(alive),instances,root,preservedState:true,forbidden});
 }
});
