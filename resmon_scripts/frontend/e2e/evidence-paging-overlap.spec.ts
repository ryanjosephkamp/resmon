/**
 * The actual Electron app, on the defect itself.
 *
 * The renderer suite is jsdom: it can say what the page does with an answer,
 * not that the real bundle, in the real window, over real HTTP to the real
 * backend, writes anything when one control's answer arrives after another
 * control has started. Two fixes of this same shape before this one were
 * jsdom-only on the defect, so this drives it in the app.
 *
 * Real: the window, the renderer bundle, the backend process, its database,
 * the HTTP round trip, the vault on disk and the clicks. Authored: the first
 * collection page is rewritten to claim another page behind it, so the Next
 * control renders without importing fifty files; and the held page request is
 * answered with a refusal, which is the outcome this is about. The identity
 * of the instance under test is asserted and written to the receipt.
 */
import {test,expect,_electron,type ElectronApplication,type Page,type Route,type APIResponse} from '@playwright/test';
import fs from 'fs';import os from 'os';import path from 'path';
import {FRONTEND_ROOT,launchEnv,ensureScreenshotDir} from './fixtures/resmon-app';
import type {LibraryStatus} from '../src/api/library';
import type {Member,Project} from '../src/api/evidence';

test('an Evidence collection page that is refused still says so when Refresh project was pressed first',async()=>{
 test.setTimeout(300_000);
 const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'resmon-paging-overlap-')));
 const state=path.join(root,'state'),originals=path.join(root,'originals'),parent=path.join(root,'vault-parent'),profile=path.join(root,'profile');
 for(const directory of [state,originals,parent,profile])fs.mkdirSync(directory);
 const env=launchEnv(state,true);env.RESMON_DISABLE_SCHEDULER='1';
 const out=ensureScreenshotDir(),receipt=(name:string,data:unknown)=>fs.writeFileSync(path.join(out,`paging-overlap-${name}.json`),JSON.stringify(data,null,2));
 fs.writeFileSync(path.join(originals,'alpha.txt'),'Alpha evidence line.\n');
 fs.writeFileSync(path.join(originals,'beta.txt'),'Beta evidence line.\n');

 let app:ElectronApplication|undefined,win!:Page,base='',origin='';const rendererErrors:string[]=[];
 const req=async<T>(url:string):Promise<T>=>{
  const response=await e2eFetch(base+url,{headers:{Origin:origin,'X-Resmon-Library':'1'}});
  expect(response.ok,await response.clone().text()).toBe(true);return response.json() as Promise<T>;
 };
 try{
  app=await _electron.launch({args:['.',`--user-data-dir=${profile}`],cwd:FRONTEND_ROOT,env,timeout:180_000});
  win=await app.firstWindow();
  win.on('pageerror',error=>rendererErrors.push(error.stack??error.message));
  win.on('console',message=>{if(message.type()==='error')rendererErrors.push(message.text());});
  await win.waitForSelector('.app-main');
  const port=await win.evaluate(()=>window.resmonAPI!.getBackendPort());
  // The live daemon is never the thing under test.
  expect(Number(port)).toBeGreaterThan(0);expect(port).not.toBe('8742');
  base=`http://127.0.0.1:${port}`;origin=new URL(win.url()).origin;
  const identity=await app.evaluate(()=>({state:process.env.RESMON_STATE_DIR,database:process.env.RESMON_DB_PATH,reports:process.env.RESMON_REPORTS_DIR,portFile:process.env.RESMON_PORT_FILE}));
  expect(identity.state).toBe(state);expect(identity.database).toBe(env.RESMON_DB_PATH);
  receipt('instance',{...identity,port});
  await app.evaluate(({dialog},args)=>{dialog.showOpenDialog=async()=>({canceled:false,filePaths:[args.parent]});},{parent});

  await win.evaluate(()=>{location.hash='/library';});
  await win.getByRole('button',{name:'Choose parent folder',exact:true}).click();
  await win.getByRole('button',{name:'Create managed vault',exact:true}).click();
  await expect(win.getByLabel('Import PDF, TXT or MD')).toBeEnabled();
  await win.getByLabel('Import PDF, TXT or MD').setInputFiles([path.join(originals,'alpha.txt'),path.join(originals,'beta.txt')]);
  await expect(win.getByText(/2 retained, 0 exact duplicates/)).toBeVisible();
  const vid=(await req<LibraryStatus>('/api/library')).vault!.vault_id;

  await win.getByRole('region',{name:'Library files'}).getByRole('button',{name:/^alpha.txt /}).click();
  await win.getByRole('link',{name:'Open in Evidence / add to project'}).click();
  await win.waitForSelector('.evidence-page');
  await win.getByLabel('New project name',{exact:true}).fill('Paging overlap project');
  await win.getByRole('button',{name:'Create project',exact:true}).click();
  await expect(win.getByRole('button',{name:'Add selected Library file to project'})).toBeEnabled();
  await win.getByRole('button',{name:'Add selected Library file to project'}).click();
  await expect(win.getByRole('region',{name:'Current collection files'}).getByRole('button',{name:/^alpha.txt /})).toBeVisible();
  const pid=(await req<{projects:Project[]}>(`/api/evidence/projects?expected_vault_id=${vid}`)).projects[0].project_id;

  // Claim another page behind the first, so Next renders over two real rows
  // rather than fifty-one. Everything the renderer then does with it is its
  // own, and the paging request below is the real one it sends.
  const listPattern=`**/api/evidence/projects/${pid}/files?*`;
  let pageRequests=0;let held:Route|undefined;
  await win.route(listPattern,async route=>{
   pageRequests+=1;
   if(pageRequests===1||!new URL(route.request().url()).searchParams.get('after_id')){
    const upstream:APIResponse=await route.fetch();
    const body=await upstream.json() as {files:Member[];has_more:boolean;next_after_id:number|null};
    // The renderer validates the envelope strictly: `has_more` requires
    // `next_after_id` to be the last row's id, so this stays a legal page.
    expect(body.files.length).toBeGreaterThan(0);
    body.has_more=true;body.next_after_id=body.files[body.files.length-1].id;
    await route.fulfill({response:upstream,json:body});return;
   }
   held=route;
  });
  await win.getByRole('button',{name:'Refresh project',exact:true}).click();
  const next=win.getByRole('button',{name:'Next collection files',exact:true});
  await expect(next).toBeVisible();

  await next.click();
  await expect.poll(()=>Boolean(held)).toBe(true);
  // Paging never sets the page-level busy flag, so Refresh is live while the
  // page request is outstanding. This is the overlap, with no timing trick.
  const refresh=win.getByRole('button',{name:'Refresh project',exact:true});
  await expect(refresh).toBeEnabled();
  await refresh.click();
  await expect(refresh).toBeEnabled();

  await held!.fulfill({status:503,contentType:'application/json',body:JSON.stringify({detail:'Collection paging is unavailable.'})});
  const alert=win.getByRole('alert');
  await expect(alert).toBeVisible({timeout:15_000});
  await expect(alert).toContainText('Collection paging is unavailable.');
  receipt('refusal',{shown:await alert.textContent(),pageRequests,rendererErrors});
  // The deliberate 503 is logged by the browser itself. Nothing else is.
  expect(rendererErrors.filter(e=>!/status of 503/.test(e))).toEqual([]);
  await win.unroute(listPattern);
 } finally {
  await app?.close().catch(()=>{});
 }
});
