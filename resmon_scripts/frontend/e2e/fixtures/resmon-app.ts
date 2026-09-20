/**
 * The launch fixture: one real resmon — Electron main process, its own spawned
 * Python backend, its own empty database — per worker.
 *
 * Four things about this are load-bearing and none is obvious.
 *
 * **It never touches the user's data, and never the daemon.** `RESMON_STATE_DIR`
 * points at a fresh temp directory, so `tryAttachToDaemon()` reads no lock file,
 * finds no daemon, and spawns its own backend on a free port of the app's own
 * choosing. `RESMON_DB_PATH`, `RESMON_REPORTS_DIR` and `RESMON_PORT_FILE` are
 * pinned into the same temp directory: in a checkout (as opposed to a packaged
 * app) `main.ts` sets none of those, so without pinning them the backend would
 * write `resmon.db` into the repository root. Port 8742 — a live launchd daemon
 * over a different database — is never bound and never probed. Every spec
 * asserts the discovered backend port is not 8742.
 *
 * **The backend port is discovered, not fixed.** `main.ts` picks a free port and
 * hands it to the preload over the `resmon:backend-connection` IPC, so
 * `backendPort()` reads it back out of the renderer rather than pinning a port
 * the app would have to be told about. Nothing here needs a fixed port, which is
 * one fewer `RESMON_E2E` branch in `main.ts`.
 *
 * **`RESMON_STATE_DIR` does not isolate Electron itself, and that was found the
 * hard way.** It isolates the *backend's* state — database, reports, daemon lock
 * — but Chromium keeps its own profile in `app.getPath('userData')`, which in a
 * checkout is the real `~/Library/Application Support/resmon` the installed app
 * uses. The first run of this fixture returned a 1440x900 window whose renderer
 * reported a 1200x723 viewport, because that profile carried a persisted
 * per-origin zoom factor of 1.2 from somebody's real session. A screenshot taken
 * that way is not evidence of anything, and the suite was also writing into the
 * user's own profile. `--user-data-dir` — a Chromium switch, handled before any
 * app code runs, so it costs no `RESMON_E2E` branch — points the profile at the
 * same temp directory. Zoom is then 1 and the profile is the suite's own.
 *
 * **The app is worker-scoped, not test-scoped.** Launching once and navigating
 * between routes is what makes a 14-route pass ~20 s instead of ~110 s, and it
 * is the shape a per-PR CI job can afford. The cost is that the routes are not
 * isolated from each other: a timer or a pending request started on one route
 * can log after the next route has been entered, and it will be tagged with the
 * route that was current when it fired. The two collectors record the tag, so a
 * misattribution is visible as a surprising route rather than invisible — but it
 * is a real limitation, and it is stated in the report under P2.
 */
import { test as base, _electron as electron } from '@playwright/test';
import type { ElectronApplication, Page, ConsoleMessage, Request } from '@playwright/test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

// ---------------------------------------------------------------------------
// The local API token, for the suite's own backend calls (2.2 lock-down)
// ---------------------------------------------------------------------------
//
// The backend now refuses any request without its token. The *app* gets the
// token from the preload and sends it itself — that is what the suite is here
// to prove, so nothing below touches `window.fetch` or the app's own requests.
//
// What needs the token is the suite's own seeding and inspection: a spec that
// creates a routine through the API instead of forty clicks, or reads back what
// a click saved. Those calls go through `e2eFetch` (defined in Node and, by the
// launch hook below, in the renderer) or carry `e2eAuth(url)` headers on
// `win.request`. A spec that calls the backend with plain `fetch` gets a 401,
// which is the point: nothing is silently authenticated.
//
// Node side: the token is read from `<RESMON_STATE_DIR>/api-token-<port>`, the
// file the spawned backend publishes, for every state directory a spec has
// launched the app with. Renderer side: from `window.resmonAPI.getApiToken()`,
// the same bridge the app uses.
const launchedStateDirs = new Set<string>();

function tokenForPort(port: string): string | null {
  for (const dir of launchedStateDirs) {
    try {
      const token = fs.readFileSync(path.join(dir, `api-token-${port}`), 'ascii').trim();
      if (token) return token;
    } catch { /* not this instance */ }
  }
  return null;
}

/** For a backend a spec starts itself (not through Electron): where its token file is. */
export function registerStateDir(dir: string): void {
  launchedStateDirs.add(dir);
}

/** `Authorization` for a suite-side request to a backend this suite launched; `{}` for any other URL. */
export function e2eAuth(url: string): Record<string, string> {
  const match = /^http:\/\/127\.0\.0\.1:(\d+)\//.exec(url);
  const token = match ? tokenForPort(match[1]) : null;
  return token ? { Authorization: `Bearer ${token}` } : {};
}

declare global {
  /** `fetch` plus the backend's token, for the suite's own calls. Defined in Node and in the renderer. */
  function e2eFetch(input: string, init?: RequestInit): Promise<Response>;
}

(globalThis as unknown as { e2eFetch: typeof e2eFetch }).e2eFetch = (input, init) => {
  const headers = new Headers(init?.headers);
  for (const [name, value] of Object.entries(e2eAuth(String(input)))) {
    if (!headers.has(name)) headers.set(name, value);
  }
  return fetch(input, { ...init, headers });
};

const RENDERER_E2E_FETCH = `(() => {
  const api = window.resmonAPI;
  window.e2eFetch = (input, init) => {
    const headers = new Headers(init && init.headers);
    const token = api && api.getApiToken ? api.getApiToken() : null;
    const base = api ? 'http://127.0.0.1:' + api.getBackendPort() + '/' : null;
    if (token && base && String(input).startsWith(base) && !headers.has('Authorization')) {
      headers.set('Authorization', 'Bearer ' + token);
    }
    return fetch(input, Object.assign({}, init, { headers }));
  };
})();`;

// Every launch in the suite goes through `_electron.launch`, whether from
// `launchResmon` or a spec's own call, so this is the one place both halves
// are wired: the state directory is recorded for `e2eAuth`, and `e2eFetch` is
// registered as a context init script before the app has created its window
// (the backend starts first), so it exists in every renderer document from the
// first. Nothing else about the launched app is wrapped.
const realLaunch = electron.launch.bind(electron);
electron.launch = (async (options?: Parameters<typeof electron.launch>[0]) => {
  const dir = options?.env?.RESMON_STATE_DIR;
  if (dir) launchedStateDirs.add(dir);
  const launched = await realLaunch(options);
  await launched.context().addInitScript(RENDERER_E2E_FETCH);
  return launched;
}) as typeof electron.launch;

export const FRONTEND_ROOT = path.resolve(__dirname, '..', '..');
export const REPO_ROOT = path.resolve(FRONTEND_ROOT, '..', '..');
/**
 * Where a run's screenshots land.
 *
 * Inside `e2e/screenshots/` by default, which is **gitignored** from phase
 * 1.8.7: the spike committed 15 PNGs and 1.8.6 added three, and every stacked
 * branch afterwards conflicted on them, because two branches that both run the
 * suite both rewrite every file. CI uploads the directory as a workflow
 * artifact and `npm run e2e:review` overrides this to a directory outside the
 * repository, so a review run leaves the working tree untouched.
 */
export const SCREENSHOT_DIR = process.env.RESMON_E2E_SCREENSHOT_DIR
  ? path.resolve(process.env.RESMON_E2E_SCREENSHOT_DIR)
  : path.join(__dirname, '..', 'screenshots');

/** Fixed so a screenshot means the same thing on every machine — see RESMON_E2E in main.ts. */
export const WINDOW_WIDTH = 1440;
export const WINDOW_HEIGHT = 900;

/**
 * The size a window of `WINDOW_WIDTH` x `WINDOW_HEIGHT` can actually take on a
 * given work area.
 *
 * `RESMON_E2E` asks for a fixed size so a screenshot is evidence rather than a
 * picture of somebody's monitor. A **display smaller than the request** is the
 * case that was missed: the macOS CI runner's work area is 1024x684, macOS
 * clamps the window to it, and then reports it as maximized. Two specs asserted
 * the requested numbers literally and went red on a runner where the app was
 * behaving perfectly.
 *
 * So the property is "the window took the size it asked for, as far as the
 * display allows", and the clamp is computed from the same work area the main
 * process reports rather than assumed away.
 */
export function fittedWindowSize(
  workArea: { width: number; height: number },
): { width: number; height: number; clamped: boolean } {
  const width = Math.min(WINDOW_WIDTH, workArea.width);
  const height = Math.min(WINDOW_HEIGHT, workArea.height);
  return { width, height, clamped: width !== WINDOW_WIDTH || height !== WINDOW_HEIGHT };
}

/** A console message Chromium classified as an error, tagged with the route that was current. */
export interface ConsoleError {
  route: string;
  text: string;
  location: string;
}

/** A network request that never completed, tagged with the route that was current. */
export interface FailedRequest {
  route: string;
  url: string;
  failure: string;
}

export interface WorkerFixtures {
  app: ElectronApplication;
  win: Page;
  consoleErrors: ConsoleError[];
  failedRequests: FailedRequest[];
  currentRoute: { value: string };
}

export interface TestFixtures {
  /** Navigate to a hash route and wait for the routed content to mount. */
  goto: (hashPath: string) => Promise<void>;
  /** The backend port `main.ts` chose, read back out of the preload bridge. */
  backendPort: () => Promise<string>;
  /** Auto-use: empties the two collectors so a test only sees its own events. */
  freshCollectors: void;
}

function pythonPath(): string {
  const venv = process.platform === 'win32'
    ? path.join(REPO_ROOT, '.venv', 'Scripts', 'python.exe')
    : path.join(REPO_ROOT, '.venv', 'bin', 'python');
  if (fs.existsSync(venv)) return venv;
  // CI installs the backend's requirements into the runner's own interpreter
  // rather than into a venv inside the checkout.
  return process.env.RESMON_PYTHON || (process.platform === 'win32' ? 'python' : 'python3');
}

/**
 * The environment a launched resmon runs in.
 *
 * Exported because `default-behaviour.spec.ts` launches the app with exactly
 * this minus `RESMON_E2E`, and the two have to differ in nothing else for that
 * comparison to mean anything.
 */
export function launchEnv(stateDir: string, e2e: boolean): Record<string, string> {
  // Playwright's `env` is `{[k: string]: string}`, and `process.env` is not —
  // an unset variable is `undefined` there. Drop those rather than passing an
  // "UNSET=undefined" through to the app.
  const inherited: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (typeof v === 'string') inherited[k] = v;
  }
  const env: Record<string, string> = {
    ...inherited,
    RESMON_STATE_DIR: stateDir,
    RESMON_DB_PATH: path.join(stateDir, 'resmon.db'),
    RESMON_REPORTS_DIR: path.join(stateDir, 'reports'),
    RESMON_PORT_FILE: path.join(stateDir, 'resmon.port'),
    RESMON_PYTHON: pythonPath(),
  };
  if (e2e) {
    env.RESMON_E2E = '1';
    env.RESMON_E2E_WIDTH = String(WINDOW_WIDTH);
    env.RESMON_E2E_HEIGHT = String(WINDOW_HEIGHT);
  } else {
    delete env.RESMON_E2E;
    delete env.RESMON_E2E_WIDTH;
    delete env.RESMON_E2E_HEIGHT;
  }
  return env;
}

export async function launchResmon(e2e = true): Promise<{ app: ElectronApplication; stateDir: string }> {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'resmon-e2e-'));
  const app = await electron.launch({
    args: ['.', `--user-data-dir=${path.join(stateDir, 'electron-user-data')}`],
    cwd: FRONTEND_ROOT,
    env: launchEnv(stateDir, e2e),
    timeout: 180_000,
  });
  return { app, stateDir };
}

export const test = base.extend<TestFixtures, WorkerFixtures>({
  currentRoute: [async ({}, use) => { await use({ value: 'launch' }); }, { scope: 'worker' }],
  consoleErrors: [async ({}, use) => { await use([]); }, { scope: 'worker' }],
  failedRequests: [async ({}, use) => { await use([]); }, { scope: 'worker' }],

  app: [async ({}, use) => {
    const { app, stateDir } = await launchResmon(true);
    await use(app);
    await app.close().catch(() => { /* already gone */ });
    fs.rmSync(stateDir, { recursive: true, force: true });
  }, { scope: 'worker' }],

  win: [async ({ app, consoleErrors, failedRequests, currentRoute }, use) => {
    const win = await app.firstWindow({ timeout: 180_000 });

    // Q3's collectors. Attached before the first navigation so nothing on the
    // initial load is missed.
    win.on('console', (msg: ConsoleMessage) => {
      if (msg.type() !== 'error') return;
      const loc = msg.location();
      consoleErrors.push({
        route: currentRoute.value,
        text: msg.text(),
        location: `${loc.url}:${loc.lineNumber}:${loc.columnNumber}`,
      });
    });
    win.on('requestfailed', (req: Request) => {
      failedRequests.push({
        route: currentRoute.value,
        url: req.url(),
        failure: req.failure()?.errorText ?? 'unknown',
      });
    });
    // An uncaught exception in the renderer is not a `console` event; without
    // this a React render crash would leave the collector empty.
    win.on('pageerror', (err) => {
      consoleErrors.push({
        route: currentRoute.value,
        text: `[pageerror] ${err.message}`,
        location: 'uncaught',
      });
    });

    await win.waitForLoadState('domcontentloaded');
    await use(win);
  }, { scope: 'worker' }],

  // The collectors are worker-scoped because the listeners are attached once to
  // a worker-scoped window; without this they would accumulate across the whole
  // run and across spec files. They did, and it failed: `observability.spec.ts`
  // deliberately provokes a console error on `/analytics`, and because it runs
  // before `smoke.spec.ts` alphabetically, the Analytics smoke test inherited
  // the provocation and went red on 5 of 5 full-suite runs while the smoke file
  // alone was green on 5 of 5. Emptying them per test is what makes the two
  // agree. What it still cannot fix is a *late* event from the previous route
  // inside the same test — see the note at the top of this file.
  freshCollectors: [async ({ consoleErrors, failedRequests }, use) => {
    consoleErrors.length = 0;
    failedRequests.length = 0;
    await use();
  }, { auto: true }],

  goto: async ({ win, currentRoute }, use) => {
    await use(async (hashPath: string) => {
      currentRoute.value = hashPath;
      // A HashRouter change is not a document navigation, so `page.goto` against
      // the same document would not drive React Router. Setting `location.hash`
      // is what a sidebar click does.
      await win.evaluate((h) => { window.location.hash = `#${h}`; }, hashPath);
      await win.waitForFunction(
        (h) => window.location.hash.startsWith(`#${h}`),
        hashPath,
        { timeout: 15_000 },
      );
      await win.locator('.app-main').waitFor({ state: 'visible', timeout: 15_000 });
      // The two index routes redirect a tick later, and every page fires its
      // first data fetch on mount. Settle before screenshotting.
      await win.waitForLoadState('networkidle').catch(() => { /* long-poll pages never idle */ });
      await win.waitForTimeout(500);
    });
  },

  backendPort: async ({ win }, use) => {
    await use(async () => win.evaluate(
      () => (window as unknown as { resmonAPI: { getBackendPort(): string } }).resmonAPI.getBackendPort(),
    ));
  },
});

export { expect } from '@playwright/test';

/**
 * True when a console message or a request belongs to resmon rather than to
 * something resmon embeds.
 *
 * resmon renders **one** origin it does not own: the GitHub Pages blog in a
 * `<webview>` on About resmon → Blog. It emits its own console output and
 * leaves requests in flight when the user navigates away, and neither is
 * resmon failing.
 *
 * There used to be a second. About resmon → Tutorials embedded seventeen
 * `youtube-nocookie.com` iframes, and they contributed most of the noise this
 * scoping exists for: a "Permissions policy violation: compute-pressure is not
 * allowed in this document" from inside YouTube's player bundle on 1 of 5
 * runs, and `net::ERR_ABORTED` on 2–6 embed URLs per run when the next route
 * was entered before they finished loading. The embeds are gone — the tab
 * links to the videos instead — and `third-party.spec.ts` P9a now asserts that
 * the tab reaches no YouTube host at all.
 *
 * Asserting on a third party's own output makes the suite red for reasons no
 * change to this repository can fix. Asserting only on resmon's own origins
 * makes it a signal. The cost is real and is recorded in the report under P2:
 * **a broken blog webview is invisible to the smoke suite.** Third-party
 * events are printed rather than dropped, so a person reading the log can
 * still see them.
 *
 * "resmon's own" is: the renderer's static server and the backend, both on
 * `127.0.0.1`, plus messages with no source URL at all — which is what a
 * `page.evaluate` raises and what an uncaught exception with no script origin
 * reports.
 */
export function isOwnOrigin(url: string): boolean {
  if (url === '' || url.startsWith(':')) return true;
  return url.startsWith('http://127.0.0.1:');
}

export function ensureScreenshotDir(): string {
  fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });
  return SCREENSHOT_DIR;
}

/** Opt-in selected-answer synthetic transport. No default fixture behavior changes.
 * Captures actual CLI argv/cwd/prompt and actual loopback HTTP requests. The
 * backend wrapper replaces only keyring storage with an in-memory test canary. */
export async function selectedEvidenceTransport(root:string,python:string) {
  const {createServer}=await import('http');const {createHash}=await import('crypto');const {execFileSync}=await import('child_process');const nodeProcessStart=execFileSync('ps',['-p',String(process.pid),'-o','lstart='],{encoding:'utf8'}).trim();
  const control=path.join(root,'selected-control.json'),capture=path.join(root,'selected-cli.jsonl'),cli=path.join(root,'selected-cli'),backend=path.join(root,'selected-python');
  fs.writeFileSync(control,JSON.stringify({fault:''}));
  const code=`import json,os,sys,time,subprocess,datetime\nfrom pathlib import Path\nargs=sys.argv[1:]\ndef arg(key):return args[args.index(key)+1]\nprompt=args[-1]\ntry:outer=json.loads(prompt)\nexcept ValueError:\n import runpy\n sys.argv=[${JSON.stringify(path.join(REPO_ROOT,'resmon_scripts/verification_scripts/fixtures/fake_claude.py'))},*args]\n runpy.run_path(sys.argv[0],run_name='__main__')\n sys.exit(0)\nfault=json.loads(Path(${JSON.stringify(control)}).read_text())['fault']\nnative=arg('--session-id')\nwith open(${JSON.stringify(capture)},'a') as f:f.write(json.dumps({'pid':os.getpid(),'parent_pid':os.getppid(),'process_start':subprocess.check_output(['ps','-p',str(os.getpid()),'-o','lstart='],text=True).strip(),'captured_at_utc':datetime.datetime.now(datetime.timezone.utc).isoformat(),'argv':args,'cwd':os.getcwd(),'environment':dict(os.environ),'config':json.loads(Path(arg('--mcp-config')).read_text()),'prompt':prompt,'fault':fault})+'\\n')\nprint(json.dumps({'type':'system','subtype':'init','session_id':native,'tools':[],'mcp_servers':[],'model':'reported-synthetic-cli'}),flush=True)\np=outer['payload'];s=p['sources'][0];quote=s['text'][:8]\nresult={'version':1,'request_sha256':outer['request_sha256'],'mode':p['mode'],'status':'answer','sections':[{'kind':'summary','items':[{'kind':'interpretation','text':'Synthetic literal <script>never_execute()</script> interpretation; support unchecked','citations':[{'source_id':s['source_id'],'start_codepoint':s['start_codepoint'],'end_codepoint':s['start_codepoint']+len(quote),'quote':quote}],'note_ids':[]}]}],'limitations':['Authored fixture, not live model quality.']}\nif p['notes']:result['sections'][0]['items'].append({'kind':'note_summary','text':'Authored owner-note summary; document support not established','citations':[],'note_ids':[p['notes'][0]['note_id']]})\nif fault=='invalid':result['sections'][0]['items'][0]['citations'][0]['quote']='WRONG'\nif fault=='unsupported':result['sections'][0]['items'][0]['citations']=[]\nif fault=='insufficient':result.update(status='insufficient_evidence',sections=[{'kind':'questions','items':[{'kind':'question','text':'Insufficient selected text','citations':[],'note_ids':[]}]}])\nif fault in ('partial_wait','crash_wait'):\n print(json.dumps({'type':'assistant','message':{'content':[{'type':'text','text':'UNVALIDATED partial <script>literal</script>'}]}}),flush=True)\n if fault=='crash_wait':\n  time.sleep(1.2)\n  print(json.dumps({'type':'assistant','message':{'content':[{'type':'text','text':' durable checkpoint'}]}}),flush=True)\n time.sleep(30)\nprint(json.dumps({'type':'assistant','message':{'content':[{'type':'text','text':json.dumps(result)}]}}),flush=True)\nif fault!='missing_done':print(json.dumps({'type':'result','subtype':'success','is_error':False,'usage':{'input_tokens':0,'output_tokens':12}}),flush=True)\n`;
  fs.writeFileSync(cli,`#!${python}\n${code}`,{mode:0o700});
  fs.writeFileSync(backend,`#!${python}\nimport sys,runpy,os\nimport keyring\nfrom keyring.backend import KeyringBackend\nclass SyntheticKeyring(KeyringBackend):\n priority=1\n def get_password(self,service,name):return 'SYNTHETIC_SELECTED_TEST_KEY' if name=='custom_llm_api_key' else None\n def set_password(self,*args):raise RuntimeError('No credential writes in this selected fixture')\n def delete_password(self,*args):raise RuntimeError('No credential deletes in this selected fixture')\nkeyring.set_keyring(SyntheticKeyring())\nsys.argv=sys.argv[1:]\nsys.path.insert(0,os.path.dirname(sys.argv[0]))\nrunpy.run_path(sys.argv[0],run_name='__main__')\n`,{mode:0o700});
  const requests:unknown[]=[],sockets=new Set<import('net').Socket>();
  const server=createServer((req,res)=>{const chunks:Buffer[]=[];req.on('data',d=>chunks.push(d));req.on('end',()=>{
    const raw=Buffer.concat(chunks).toString(),body=JSON.parse(raw),outer=JSON.parse(body.messages[1].content),p=outer.payload,s=p.sources[0],quote=Array.from(s.text as string).slice(0,8).join('');
    requests.push({url:req.url,method:req.method,headers:{...req.headers,authorization:'[synthetic-key]'},raw,body});fs.writeFileSync(path.join(root,'selected-api-requests.json'),JSON.stringify(requests,null,2));
    const fault=JSON.parse(fs.readFileSync(control,'utf8')).fault;const result={version:1,request_sha256:outer.request_sha256,mode:p.mode,status:'answer',sections:[{kind:'summary',items:[{kind:'interpretation',text:'Synthetic API briefing <img src="never">; support unchecked',citations:[{source_id:s.source_id,start_codepoint:s.start_codepoint,end_codepoint:s.start_codepoint+Array.from(quote).length,quote:fault==='invalid'?'WRONG':quote}],note_ids:[] as string[]}]}],limitations:['No real model called.']};if(p.notes.length)result.sections[0].items.push({...result.sections[0].items[0],kind:'note_summary',text:'Authored owner-note summary; document support not established',citations:[],note_ids:[p.notes[0].note_id]});
    const data=JSON.stringify({model:'reported-synthetic-api',choices:[{message:{content:JSON.stringify(result)},finish_reason:fault==='missing_done'?'length':'stop'}],usage:{prompt_tokens:0,completion_tokens:12}});
    res.writeHead(200,{'Content-Type':'application/json','Content-Length':Buffer.byteLength(data)});if(fault==='partial_wait')setTimeout(()=>res.end(data),2000);else res.end(data);
  });});
  server.on('connection',socket=>{sockets.add(socket);socket.on('close',()=>sockets.delete(socket));});await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));const address=server.address();if(!address||typeof address==='string'||address.port===8742)throw new Error('Invalid selected fixture port');
  return {cli,backend,control,capture,base:`http://127.0.0.1:${address.port}`,requests,setFault:(fault:string)=>fs.writeFileSync(control,JSON.stringify({fault})),captures:()=>fs.existsSync(capture)?fs.readFileSync(capture,'utf8').trim().split('\n').filter(Boolean).map(line=>JSON.parse(line)):[],receipt:()=>({root,cli,backend,control,capture,apiPort:address.port,serverPid:process.pid,serverProcessStart:nodeProcessStart,capturedAtUtc:new Date().toISOString(),cliSha256:createHash('sha256').update(fs.readFileSync(cli)).digest('hex'),backendSha256:createHash('sha256').update(fs.readFileSync(backend)).digest('hex'),keyring:'in-memory synthetic custom key only; no OS keyring access',guard:'unchanged inherited Python sitecustomize'}),close:async()=>{for(const socket of sockets)socket.destroy();await new Promise<void>((resolve,reject)=>server.close(e=>e?reject(e):resolve()));}};
}
