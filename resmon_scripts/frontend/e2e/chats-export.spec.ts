/** Authored storage + real Electron/HTTP/fake-CLI/SSE/consent/download journey.
 * The CLI decides from synthetic directives, not from a model. Save paths are scripted. */
import { test, expect, _electron as electron, type Page } from '@playwright/test';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { createHash } from 'crypto';
import { FRONTEND_ROOT, REPO_ROOT, launchEnv, ensureScreenshotDir } from './fixtures/resmon-app';

const hostile = '<script>window.chatInjected=true</script>\n[unsafe](https://example.invalid)\n``````\n雪\n' + 'longword'.repeat(150);

test('Chats reaches 123 rows, reads/continues exact IDs and saves two literal persisted formats', async () => {
  test.setTimeout(240_000);
  const state = fs.mkdtempSync(path.join(os.tmpdir(), 'resmon-chats-'));
  const env = launchEnv(state, true);
  env.RESMON_DISABLE_SCHEDULER = '1';
  env.PYTHON_KEYRING_BACKEND = 'keyring.backends.null.Keyring';
  env.FAKE_CLAUDE_STATE = path.join(state, 'fake-cli-state');
  const cli = path.join(state, 'fake-claude');
  fs.writeFileSync(cli, `#!/bin/sh\nexec "${env.RESMON_PYTHON}" "${path.join(REPO_ROOT,'resmon_scripts/verification_scripts/fixtures/fake_claude.py')}" "$@"\n`, {mode:0o755});
  const py = (script:string, ...args:string[]) => execFileSync(env.RESMON_PYTHON, ['-c',script,...args], {env,encoding:'utf8',cwd:REPO_ROOT});
  py(`import sys,sqlite3
sys.path.insert(0,'resmon_scripts')
from implementation_scripts import database,assistant_store as s
p=sys.argv[1];database.init_db(p);c=database.get_connection(p)
for i in range(1,124):
 sid=s.create_session(c,runtime='claude_cli',title='Chat %03d %%_ 雪'%i)
 s.add_message(c,sid,role='user',content=sys.argv[2] if i==123 else 'authored '+str(i))
c.execute("UPDATE assistant_messages SET tool_calls='{malformed' WHERE session_id=123")
c.execute("UPDATE assistant_sessions SET created_at='2026-01-01',updated_at='2026-01-01'")
c.execute("INSERT INTO documents(source_repository,external_id,title,metadata_hash) VALUES ('arxiv','r04b-authored','Preserved fixture','r04b-authored')")
d=c.execute('SELECT last_insert_rowid()').fetchone()[0]
c.execute("INSERT INTO executions(execution_type,parameters,start_time,status,result_count) VALUES ('deep_dive','{}','2026-01-01','completed',1)")
e=c.execute('SELECT last_insert_rowid()').fetchone()[0]
c.execute('INSERT INTO execution_documents VALUES (?,?,1)',(e,d))
c.execute("INSERT INTO execution_sources(execution_id,source,status,result_count) VALUES (?,'arxiv','ok',1)",(e,))
c.execute('INSERT INTO reading_queue(document_id) VALUES (?)',(d,))
c.execute("INSERT OR REPLACE INTO app_settings(key,value) VALUES ('ai_cli_path',?)",(sys.argv[3],))
c.commit()`,env.RESMON_DB_PATH,hostile,cli);
  const inventory = () => JSON.parse(py(`import sqlite3,json,sys
c=sqlite3.connect('file:'+sys.argv[1]+'?mode=ro',uri=True)
t=[r[0] for r in c.execute("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")]
print(json.dumps({x:c.execute('SELECT * FROM "'+x+'" ORDER BY 1').fetchall() for x in t},default=lambda b:{'bytes_hex':b.hex()},sort_keys=True))`,env.RESMON_DB_PATH));
  const out = ensureScreenshotDir();
  const receipt = (name:string, value:unknown) => fs.writeFileSync(path.join(out,'chats-'+name+'.json'), JSON.stringify(value,null,2));
  const app = await electron.launch({args:['.',`--user-data-dir=${path.join(state,'electron-user-data')}`],cwd:FRONTEND_ROOT,env,timeout:180_000});
  try {
    const win = await app.firstWindow(); await win.waitForSelector('.app-main');
    const contacts:string[]=[];
    await win.route('https://**/*', route => {contacts.push(route.request().url());return route.abort();});
    const port = await win.evaluate(()=>(window as unknown as {resmonAPI:{getBackendPort():string}}).resmonAPI.getBackendPort());
    expect(port).not.toBe('8742');
    const get = async (url:string) => {const r=await win.request.get(`http://127.0.0.1:${port}${url}`);expect(r.ok()).toBe(true);return r.json();};
    const instance = await app.evaluate(({app})=>({pid:process.pid,profile:app.getPath('userData'),state:process.env.RESMON_STATE_DIR,db:process.env.RESMON_DB_PATH,reports:process.env.RESMON_REPORTS_DIR,portFile:process.env.RESMON_PORT_FILE}));
    receipt('instance',{...instance,port,source:REPO_ROOT,health:await get('/api/health'),at:new Date().toISOString()});
    const before=inventory();receipt('before',before);
    await win.getByRole('link',{name:'☏ Chats'}).click();
    const list=win.getByRole('region',{name:'Saved chats'});
    const ids:number[]=[];const sizes:number[]=[];
    for(const count of [50,50,23]) {
      await expect(list.locator('li')).toHaveCount(count);
      const titles=await list.locator('li strong').allTextContents();sizes.push(titles.length);
      ids.push(...titles.map(t=>Number(t.match(/Chat (\d+)/)![1])));
      if(count!==23)await list.getByText('Older chats').click();
    }
    expect(ids).toEqual(Array.from({length:123},(_,i)=>123-i));receipt('paging',{sizes,ids});
    await win.getByLabel('Filter saved titles').fill('Chat 123');
    await list.getByRole('button',{name:/Chat 123 .*Created/}).click();
    const transcript=win.getByRole('region',{name:'Saved transcript'});
    await expect(transcript.locator('.assistant-bubble')).toHaveText(hostile);
    expect(await win.evaluate(()=>('chatInjected' in window))).toBe(false);
    await expect(transcript.getByRole('heading',{name:'Chat 123 %_ 雪'})).toBeFocused();
    for(const format of ['json','markdown'] as const) {
      const destination=path.join(out,`chats-saved.${format==='json'?'json':'md'}`);
      await app.evaluate(({BrowserWindow}, target)=>{
        BrowserWindow.getAllWindows()[0].webContents.session.once('will-download',(_e,item)=>item.setSavePath(target));
      },destination);
      const responsePromise=win.waitForResponse(r=>r.url().endsWith(`/123/export?format=${format}`));
      await transcript.getByRole('button',{name:format==='json'?'Export JSON':'Export Markdown'}).click();
      const response=await responsePromise;expect(response.ok()).toBe(true);const body=await response.json();
      await expect.poll(()=>fs.existsSync(destination)&&fs.readFileSync(destination,'utf8')===body.text).toBe(true);
      const bytes=fs.readFileSync(destination);receipt('download-'+format,{session_id:body.session_id,format,bytes:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex'),destination,method:'scripted will-download setSavePath; no native chooser observation'});
      if(format==='json') { const doc=JSON.parse(bytes.toString());expect(doc.messages[0].content).toBe(hostile);expect(doc.messages[0].tool_calls.raw).toBe('{malformed');expect(doc.completion_status).toBe('unknown'); }
      else expect(bytes.toString()).toContain('```````\n'+hostile+'\n```````');
    }
    expect(inventory()).toEqual(before);
    const geometry=[];
    for(const appearance of ['light','dark'] as const) for(const [width,height] of [[960,600],[1280,800]]) {
      await app.evaluate(({BrowserWindow,nativeTheme},x)=>{nativeTheme.themeSource=x.appearance;BrowserWindow.getAllWindows()[0].setSize(x.width,x.height);},{appearance,width,height});
      await transcript.getByText('Export JSON',{exact:true}).focus();await expect(transcript.getByText('Export JSON',{exact:true})).toBeFocused();
      await win.keyboard.press('Tab');await expect(transcript.getByText('Refresh transcript',{exact:true})).toBeFocused();
      geometry.push(await win.evaluate(()=>({width:innerWidth,height:innerHeight,scroll:document.documentElement.scrollWidth})));
      await win.screenshot({path:path.join(out,`chats-${appearance}-${width}.png`)});
    }
    await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].webContents.setZoomFactor(2));
    await transcript.getByText('Continue in Ask',{exact:true}).focus();await expect(transcript.getByText('Continue in Ask',{exact:true})).toBeFocused();
    await win.screenshot({path:path.join(out,'chats-zoom200.png')});
    await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].webContents.setZoomFactor(1));receipt('geometry',geometry);
    await transcript.getByText('Continue in Ask',{exact:true}).click();
    const composer=win.getByLabel('Message the assistant');await expect(composer).toBeVisible();
    await composer.fill('SAY:R04b same-session answer');
    const stream=win.waitForResponse(r=>r.url().endsWith('/123/messages'));
    await composer.press('Enter');await expect(win.getByText('Earlier messages remain here; this new Claude session will receive your new message, not the earlier conversation.')).toBeVisible();await win.getByRole('button',{name:'Confirm and send',exact:true}).click();const response=await stream;const sse=await response.text();expect(sse).toContain('R04b same-session answer');
    await expect(win.getByRole('button',{name:'Stop',exact:true})).toBeHidden();
    const stored=await get('/api/assistant/sessions/123');expect(stored.messages.some((m:{content:string})=>m.content==='R04b same-session answer')).toBe(true);
    receipt('continuation',{request:response.request().postDataJSON(),sse,stored});
    const routinesBefore=await get('/api/routines');
    for(const decision of ['Deny','Allow']) {
      const args={name:`Chats ${decision}`,keywords:['synthetic'],sources:['arxiv'],schedule:'0 9 * * *',ai_enabled:false};
      await composer.fill(`CALL:create_routine ${JSON.stringify(args)}`);await composer.press('Enter');
      const card=win.getByTestId('permission-card');await expect(card).toBeVisible();
      await expect(card.locator('pre')).toHaveText(`create_routine(${JSON.stringify(args,null,2)})`);
      await win.getByLabel('Close the assistant').click();
      await win.getByLabel('Filter saved titles').fill('Chat 122');await list.getByRole('button',{name:/Chat 122 .*Created/}).click();
      await expect(transcript.getByText('Continue in Ask',{exact:true})).toBeDisabled();
      await expect(transcript.getByText('Export JSON',{exact:true})).toBeEnabled();
      await win.getByTestId('assistant-trigger').click();await expect(card).toBeVisible();
      await expect(win.getByLabel('New conversation')).toBeDisabled();
      const approval=win.waitForResponse(r=>/\/permissions\//.test(r.url())&&r.request().method()==='POST');
      await card.getByRole('button',{name:decision,exact:true}).click();const consent=await approval;
      expect(consent.request().postDataJSON()).toEqual({allow:decision==='Allow'});
      await expect(win.getByRole('button',{name:'Stop',exact:true})).toBeHidden();
      const after=await get('/api/routines');
      if(decision==='Deny')expect(after).toEqual(routinesBefore);
      else {const rows=Array.isArray(after)?after:after.routines;const previous=Array.isArray(routinesBefore)?routinesBefore:routinesBefore.routines;expect(rows).toHaveLength(previous.length+1);const made=rows.find((r:{name:string})=>r.name===args.name);expect(made.is_active).toBe(0);expect(made.last_executed_at).toBeNull();}
      receipt('consent-'+decision,{request_id:consent.url().split('/').pop(),payload:consent.request().postDataJSON(),before:routinesBefore,after});
    }
    await composer.fill('SAY:live fragment\nSLEEP:120');await composer.press('Enter');
    await expect(win.locator('.assistant-panel')).toContainText('live fragment');
    const partial=await get('/api/assistant/sessions/123/export?format=json');expect(JSON.parse(partial.text).messages.some((m:{role:string;content:string})=>m.role==='assistant'&&m.content.includes('live fragment'))).toBe(false);
    await win.getByRole('button',{name:'Stop',exact:true}).click();await expect(win.getByRole('button',{name:'Stop',exact:true})).toBeHidden();
    await composer.fill('RESULT_ERROR:R04b authored error');await composer.press('Enter');await expect(win.locator('.assistant-error')).toBeVisible();await expect(win.getByRole('button',{name:'Stop',exact:true})).toBeHidden();
    const after=inventory();receipt('after',after);
    const intentional=['assistant_sessions','assistant_messages','assistant_session_choices','assistant_turn_choices','routines','saved_configurations','sqlite_sequence'];
    expect(after.assistant_session_choices.every((r:unknown[])=>r[0]===123)).toBe(true);
    const chosenMessageIds=after.assistant_messages.filter((m:unknown[])=>m[1]===123).map((m:unknown[])=>m[0]);
    expect(after.assistant_turn_choices.every((r:unknown[])=>chosenMessageIds.includes(r[0]))).toBe(true);
    for(const table of Object.keys(before).filter(t=>!intentional.includes(t)))expect(after[table],table).toEqual(before[table]);
    expect(after.assistant_messages.filter((m:unknown[])=>m[1]!==123)).toEqual(before.assistant_messages.filter((m:unknown[])=>m[1]!==123));
    expect(contacts).toEqual([]);receipt('preservation',{tables:Object.keys(before),intentional,unexpectedContacts:contacts});
    await win.reload();await win.waitForSelector('.chats-page');await win.getByLabel('Filter saved titles').fill('Chat 123');await list.getByRole('button',{name:/Chat 123 .*Created/}).click();
    await expect(transcript).toContainText('Historical completion unknown');
  } finally {
    const pid=app.process().pid;
    await app.close().catch(()=>{});
    fs.rmSync(state,{recursive:true,force:true});
    receipt('cleanup',{pid,state,stateRemoved:!fs.existsSync(state),at:new Date().toISOString()});
  }
});
