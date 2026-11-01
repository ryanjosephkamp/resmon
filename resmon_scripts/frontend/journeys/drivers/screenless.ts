/**
 * What the journeys take without a screen: the engine's own record, the
 * test's fixtures, the processes, and the files on disk. Atlas's driver
 * (`atlas.ts`) drives every screen; the candidate (`candidate.ts`) takes from
 * here only the members `borrowed.ts` lists, each with its reason.
 *
 * **A fact about the backend is read from the backend.** Where a journey is
 * "the screen and the record agree", the screen half is read in `atlas.ts`
 * and the record half comes from `session.api`, over the app's own token.
 * Reading the SQLite file would be easier and would also make the suite unable
 * to run against an installed app.
 *
 * **Where the app has no user path, the driver says so by using the API and the
 * spec's ledger row records it.** The app spawns its backend with
 * `RESMON_DISABLE_SCHEDULER=1`, so no fire in this suite comes from
 * APScheduler, and the corpus-wide near-duplicate scan has no control in any
 * interface (`API_SETUP` in `borrowed.ts`).
 */
import * as fs from 'fs';
import * as path from 'path';
import { execFileSync, spawnSync } from 'child_process';
import * as http from 'http';
import * as net from 'net';
import { pathToFileURL } from 'url';
import { _electron as electron, expect } from '@playwright/test';
import type { TestInfo } from '@playwright/test';
import type {
  BackendFacts, CorpusCounts, GateRun, JourneyDriver, McpAnswer, OfflineDocument, ProviderRequest, RawAnswer,
  RunFacts, StoredAnswer, StoredEvidenceNote, StoredSourceWall,
} from '../driver';
import { providerEndpointOf } from '../fixtures/provider-endpoint';
import { selectedAnswerEndpointOf } from '../fixtures/selected-answer-endpoint';
import { readTheAgentCommandArguments } from '../fixtures/authored-commands';
import type { Session } from './session';

/** The members this file implements: `SCREENLESS` and `API_SETUP` in `borrowed.ts`. */
export type ScreenlessDriver = Pick<JourneyDriver,
  | 'backend'
  | 'takePicture'
  | 'waitForRunToSettle'
  | 'reportExists'
  | 'readAssistantSettings'
  | 'refusedConnections'
  | 'releaseTheSource'
  | 'theSourceGoesDown'
  | 'theSourceComesBack'
  | 'killTheBackend'
  | 'closeTheApp'
  | 'anAddressThatRefusesConnections'
  | 'runTheGate'
  | 'readDeliveredFiles'
  | 'readFeedFile'
  | 'readTheFileOffline'
  | 'readWhatTheAgentCommandReceived'
  | 'readWhatTheProviderReceived'
  | 'theAuthoredModelCitesTextItWasNotSent'
  | 'readWhatTheAuthoredModelReceived'
  | 'askOverTheRawSocket'
  | 'askTheMcpServer'
  | 'scanForNearDuplicates'
>;

/** `YYYY-MM-DD`, in the machine's own timezone, as the engine's date fields want it. */
function isoDate(at: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}`;
}

export function createScreenlessDriver(session: Session, testInfo: TestInfo): ScreenlessDriver {
  const win = () => session.win;

  /**
   * Ask an Evidence or Library route the way the Evidence page asks it.
   *
   * Those routes refuse anything without `X-Resmon-Library: 1` from the
   * renderer's own origin — a browser guard, not authentication — and
   * `session.api` sends no such header, which is why J34 read its vault off the
   * disk instead. J35–J37 need the app's own record of a saved passage and a
   * saved answer, offsets included, and the screen does not print those. So the
   * request is made from inside the window, where the Origin is the renderer's
   * and the token comes from the bridge the app itself uses.
   */
  const evidenceRequest = async <T>(method: string, route: string): Promise<T> => win().evaluate(
    async ([m, r]) => {
      const backend = (window as unknown as { resmonAPI: { getBackendPort(): string } })
        .resmonAPI.getBackendPort();
      const response = await e2eFetch(`http://127.0.0.1:${backend}${r}`, {
        method: m,
        headers: { 'X-Resmon-Library': '1' },
        signal: AbortSignal.timeout(60_000),
      });
      const text = await response.text();
      if (!response.ok) throw new Error(`${m} ${r} answered HTTP ${response.status}: ${text.slice(0, 400)}`);
      return text ? JSON.parse(text) : null;
    },
    [method, route] as const,
  ) as Promise<T>;

  /** This app's vault, and a project in it by the name a person gave it, or null. */
  const findEvidenceProject = async (name: string): Promise<{ vault: string; id: string } | null> => {
    const status = await evidenceRequest<{ vault: { vault_id: string } | null }>('GET', '/api/library');
    expect(status.vault, 'this app has no Library vault for Evidence to read').toBeTruthy();
    const vault = status.vault!.vault_id;
    const { projects } = await evidenceRequest<{ projects: { project_id: string; name: string }[] }>(
      'GET', `/api/evidence/projects?expected_vault_id=${vault}`,
    );
    const found = projects.find((project) => project.name === name);
    return found ? { vault, id: found.project_id } : null;
  };

  const evidenceProject = async (name: string): Promise<{ vault: string; id: string }> => {
    const found = await findEvidenceProject(name);
    expect(found, `Evidence holds no project called ${name}`).toBeTruthy();
    return found!;
  };

  const evidenceNotesOf = async (name: string): Promise<StoredEvidenceNote[]> => {
    const project = await evidenceProject(name);
    const { notes } = await evidenceRequest<{ notes: StoredEvidenceNote[] }>(
      'GET', `/api/evidence/projects/${project.id}/notes?expected_vault_id=${project.vault}`,
    );
    return notes;
  };

  const answerOf = async (name: string, id: string): Promise<StoredAnswer> => {
    const project = await evidenceProject(name);
    return evidenceRequest('GET', `/api/evidence/projects/${project.id}/answers/${id}?expected_vault_id=${project.vault}`);
  };

  /**
   * The token this instance published for other clients on this machine.
   *
   * Read off disk, from `<state dir>/api-token-<port>`, because that is where a
   * client that is not this renderer finds it — the MCP server's own discovery
   * path. Asking the renderer for it would be asking the app to hand out its
   * credential, which is not a thing any other caller can do.
   */
  const publishedToken = (): string => {
    const file = path.join(session.stateDir, `api-token-${session.port}`);
    expect(fs.existsSync(file), `this instance published no token file at ${file}`).toBe(true);
    return fs.readFileSync(file, 'ascii').trim();
  };

  /**
   * The reader a saved-answer HTML file is opened in, as an Electron main script.
   *
   * Not resmon: a bare window with nothing of the app in it, launched after the
   * app has quit. It permits exactly one request — the file, once — and records
   * every other one, every window the document tries to open and every
   * navigation away from itself, so "it reads offline" is the absence of a
   * recorded attempt rather than the absence of a network. The same shape as
   * the reader `e2e/portable-briefing.spec.ts` uses, with `show: false` so a
   * journey run still puts nothing on the screen.
   */
  const offlineReaderMain = (target: string): string => `
const { app, BrowserWindow, session } = require('electron');
const target = ${JSON.stringify(target)};
globalThis.offlineReader = { refused: [], escapes: [] };
app.whenReady().then(() => {
  let opened = false;
  session.defaultSession.webRequest.onBeforeRequest({ urls: ['<all_urls>'] }, (details, callback) => {
    const theFile = details.url === target && !opened;
    if (theFile) opened = true; else globalThis.offlineReader.refused.push(details.url);
    callback({ cancel: !theFile });
  });
  session.defaultSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  const win = new BrowserWindow({ show: false, width: 1000, height: 850,
    webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true } });
  win.webContents.setWindowOpenHandler((details) => {
    globalThis.offlineReader.escapes.push(details.url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (event, url) => {
    if (url.split('#')[0] !== target) { globalThis.offlineReader.escapes.push(url); event.preventDefault(); }
  });
  win.loadURL(target);
});
app.on('window-all-closed', () => app.quit());
`;

  const backend: BackendFacts = {
    port: async () => session.port,
    health: () => session.api('GET', '/api/health'),
    execution: (run) => session.api('GET', `/api/executions/${run.id}`),
    executions: () => session.api('GET', '/api/executions?limit=200'),
    searchRecord: (run) => session.api('GET', `/api/executions/${run.id}/search-record`),
    routines: () => session.api('GET', '/api/routines'),
    corpusCounts: async (): Promise<CorpusCounts> => {
      // Over the API, because a restore has to be checkable against an
      // installed app one day and because a count of rows in a file is not
      // something a user ever sees. `/api/explorer/search` reports a total for
      // an unfiltered query, which is the number the Explorer's own header shows.
      const documents = await session.api<{ total: number }>(
        'POST', '/api/explorer/search', { page: 1, page_size: 1 },
      );
      const executions = await session.api<unknown[]>('GET', '/api/executions?limit=500');
      const routines = await session.api<unknown[]>('GET', '/api/routines');
      return {
        documents: Number(documents.total ?? 0),
        executions: executions.length,
        routines: routines.length,
      };
    },
    ownedByThisApp: async () => {
      // "This resmon" rather than "a resmon": the backend answering the window
      // must be a child of the window's own Electron process. `ps` is how the
      // suite next door establishes the same thing; a machine without it gets
      // `null` and the spec reports rather than asserts.
      if (process.platform === 'win32') return null;
      const health = await backend.health();
      try {
        const parent = execFileSync('ps', ['-o', 'ppid=', '-p', String(health.pid)], { encoding: 'utf8' });
        return Number(parent.trim()) === session.app.process().pid;
      } catch {
        return null;
      }
    },
    zeroReasonVocabulary: async () => {
      // Read out of the build under test rather than out of this file. The
      // register was written saying "one of the nine zero reasons" and the
      // module at this base declares ten, which is exactly the drift a list
      // typed into a spec would have hidden.
      const source = fs.readFileSync(
        path.join(session.root.repo, 'resmon_scripts', 'implementation_scripts', 'zero_reason.py'),
        'utf8',
      );
      const tuple = /ZERO_REASONS\s*=\s*\(([\s\S]*?)\)/.exec(source);
      expect(tuple, 'the build under test has no ZERO_REASONS tuple to count').toBeTruthy();
      return [...tuple![1].matchAll(/["']([a-z_]+)["']/g)].map((m) => m[1]);
    },

    // — slice 2a -------------------------------------------------------------

    routeInventory: async () => {
      // FastAPI's own document, from the process that is running. `paths` is
      // the whole HTTP surface the person's app offers, which is what "the app
      // has no such route" has to be measured against.
      const document = await session.api<{ paths: Record<string, unknown> }>('GET', '/openapi.json');
      return Object.keys(document.paths ?? {}).sort();
    },
    serviceStatus: () => session.api('GET', '/api/service/status'),
    daemonStatus: () => session.api('GET', '/api/service/daemon-status'),
    sourceCatalog: async () => {
      const catalog = await session.api<any>('GET', '/api/repositories/catalog');
      // The endpoint has been a bare list and a wrapped one; take whichever
      // shape the build under test serves rather than assuming either.
      return Array.isArray(catalog) ? catalog : (catalog.repositories ?? catalog.sources ?? []);
    },
    embeddingsStatus: () => session.api('GET', '/api/embeddings/status'),
    watchdogFindings: () => session.api('GET', '/api/watchdog'),
    profiles: async () => {
      const answer = await session.api<any>('GET', '/api/profiles');
      return Array.isArray(answer) ? answer : (answer.profiles ?? []);
    },
    credentials: () => session.api('GET', '/api/credentials'),
    onboarding: () => session.api('GET', '/api/onboarding'),
    aiSettings: () => session.api('GET', '/api/settings/ai'),
    linkStatus: () => session.api('GET', '/api/links/status'),
    eraseCorpus: (word: string) => session.api('POST', '/api/admin/erase-corpus', { confirm: word }),
    configurations: async () => {
      const rows = await session.api<Record<string, any>[]>('GET', '/api/configurations');
      // The route parses `parameters` before it answers. A build that did not
      // would hand back a string, and a string compared with an object differs
      // for a reason that has nothing to do with the round trip being measured.
      return rows.map((row) => {
        if (typeof row.parameters !== 'string') return row;
        try { return { ...row, parameters: JSON.parse(row.parameters) }; } catch { return row; }
      });
    },

    // — the register refresh -------------------------------------------------

    evidenceNotes: (project) => evidenceNotesOf(project),
    selectedAnswer: (project, answerId) => answerOf(project, answerId),
    sourceWall: () => session.api<StoredSourceWall>('GET', '/api/coverage/source-wall?limit=12'),
    // — the Atlas interface: facts any renderer can read ---------------------
    appearance: () => session.api('GET', '/api/appearance'),
    collectionMap: () => session.api('GET', '/api/map'),
    today: () => session.api('GET', '/api/today'),
    sharedWording: () => session.api('GET', '/api/shared-wording'),
    sharedWordingPair: (a, b) => session.api('GET', `/api/shared-wording/pairs/${a}/${b}`),
    collectPapers: async (request) => {
      const to = new Date();
      const from = new Date(to.getTime() - (request.days ?? 30) * 24 * 60 * 60 * 1000);
      const started = await session.api<{ execution_id: number }>('POST', '/api/search/dive', {
        repository: request.source,
        query: request.keywords.join(' '),
        keywords: request.keywords,
        date_from: isoDate(from),
        date_to: isoDate(to),
        max_results: request.cap ?? 20,
      });
      const run = { id: started.execution_id };
      await expect.poll(async () => String((await backend.execution(run)).status), { timeout: 150_000 })
        .not.toMatch(/^(running|cancelling)$/);
      return run;
    },
  };

  return {
    backend,

    takePicture: async (name) => {
      const dir = process.env.RESMON_JOURNEY_SCREENSHOT_DIR
        ? path.resolve(process.env.RESMON_JOURNEY_SCREENSHOT_DIR)
        : path.join(__dirname, '..', 'screenshots');
      fs.mkdirSync(dir, { recursive: true });
      await win().screenshot({ path: path.join(dir, `${name}.png`) });
      // Also into Playwright's own report, so a CI failure carries the picture
      // of the moment it failed rather than of the end of the run.
      await testInfo.attach(name, {
        body: await win().screenshot(),
        contentType: 'image/png',
      });
    },

    waitForRunToSettle: async (run): Promise<RunFacts> => {
      let row: Record<string, any> = {};
      await expect.poll(async () => {
        row = await backend.execution(run);
        // `cancelling` is a run still doing work: a cooperative cancel finishes
        // the current batch and flushes before it becomes `cancelled`.
        return ['running', 'cancelling'].includes(String(row.status));
      }, { timeout: 150_000 }).toBe(false);
      return {
        status: String(row.status),
        interruptedReason: (row.interrupted_reason as string | null) ?? null,
      };
    },

    reportExists: async (run) => {
      // The same request the report viewer makes, and the same field it reads.
      const report = await session.api<{ report_text?: string }>(
        'GET', `/api/executions/${run.id}/report`,
      ).catch(() => ({} as { report_text?: string }));
      return String(report.report_text ?? '').trim().length > 0;
    },

    readAssistantSettings: async () => session.api('GET', '/api/settings/assistant'),

    refusedConnections: () => session.refused(),

    releaseTheSource: () => session.source.release(),

    theSourceGoesDown: () => session.source.answerWith('dead'),

    theSourceComesBack: () => session.source.answerWith('paper'),

    killTheBackend: async () => { await session.killBackend(); },

    closeTheApp: () => session.quit(),

    anAddressThatRefusesConnections: async () => new Promise((resolve, reject) => {
      // Bound and then closed: the operating system has just told us this port
      // was free, and nothing of this suite's is now on it. Loopback, so the
      // launch guard permits the attempt and the failure is a refusal rather
      // than a timeout.
      const probe = net.createServer();
      probe.once('error', reject);
      probe.listen(0, '127.0.0.1', () => {
        const { port } = probe.address() as net.AddressInfo;
        probe.close(() => resolve({ host: '127.0.0.1', port }));
      });
    }),

    runTheGate: async (args): Promise<GateRun> => {
      // The build's own interpreter, the build's own repository, and a state
      // directory of this session's own so the gate cannot touch anybody's
      // corpus. `spawnSync` rather than `execFileSync`: a non-zero exit is the
      // answer this returns, not an exception it throws away.
      const command = `${session.python} ${args.join(' ')}`;
      const run = spawnSync(session.python, args, {
        cwd: path.join(session.root.repo, 'resmon_scripts'),
        encoding: 'utf8',
        timeout: 240_000,
        env: {
          ...process.env,
          RESMON_STATE_DIR: session.stateDir,
          PYTHONDONTWRITEBYTECODE: '1',
          PYTHON_KEYRING_BACKEND: 'keyring.backends.null.Keyring',
        },
      });
      return {
        command,
        exitCode: run.status,
        output: `${run.stdout ?? ''}${run.stderr ?? ''}`,
      };
    },

    readDeliveredFiles: async (destination) => {
      const found: string[] = [];
      const walk = (dir: string, prefix: string): void => {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
          const here = prefix ? `${prefix}/${entry.name}` : entry.name;
          if (entry.isDirectory()) walk(path.join(dir, entry.name), here);
          else found.push(here);
        }
      };
      if (fs.existsSync(destination)) walk(destination, '');
      return found.sort();
    },

    readFeedFile: async (destination) => {
      // `<target>/resmon/<routine slug>/feed.xml`, found rather than composed:
      // the slug is the delivery module's own and a spec that spelled it out
      // would be asserting this suite's idea of it.
      const found: string[] = [];
      const walk = (dir: string): void => {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
          const here = path.join(dir, entry.name);
          if (entry.isDirectory()) walk(here);
          else if (entry.name === 'feed.xml') found.push(here);
        }
      };
      if (fs.existsSync(destination)) walk(destination);
      expect(found, `no feed.xml was written under ${destination}`).toHaveLength(1);
      return { path: found[0], text: fs.readFileSync(found[0], 'utf8') };
    },

    readTheFileOffline: async (file): Promise<OfflineDocument> => {
      const target = pathToFileURL(file.path).href;
      const dir = fs.mkdtempSync(path.join(session.stateDir, 'offline-reader-'));
      const main = path.join(dir, 'reader.js');
      fs.writeFileSync(main, offlineReaderMain(target));
      // Nothing of resmon's environment: this is somebody else's reader.
      const env: Record<string, string> = {};
      for (const [key, value] of Object.entries(process.env)) {
        if (typeof value === 'string' && !key.startsWith('RESMON_') && key !== 'ELECTRON_RUN_AS_NODE') env[key] = value;
      }
      const reader = await electron.launch({
        args: [main, `--user-data-dir=${path.join(dir, 'profile')}`],
        cwd: session.root.frontend,
        env,
        timeout: 120_000,
      });
      try {
        const page = await reader.firstWindow({ timeout: 60_000 });
        await expect(page.locator('main')).toBeVisible({ timeout: 60_000 });
        expect(page.url(), 'the reader is not showing the file it was given').toBe(target);
        /** Focus this element, press Enter, and wait for the fragment it navigates to. */
        const follow = async (selector: string, expected: string): Promise<string> => {
          const arrived = page.waitForURL((url) => url.hash === expected, { timeout: 15_000 }).catch(() => undefined);
          await page.locator(selector).focus();
          await page.keyboard.press('Enter');
          await arrived;
          return new URL(page.url()).hash;
        };
        const citations: OfflineDocument['citations'] = [];
        const references = page.locator('#answer a[id^="reference-"]');
        for (let i = 0; i < await references.count(); i += 1) {
          const reference = String(await references.nth(i).getAttribute('id'));
          const href = String(await references.nth(i).getAttribute('href'));
          const arrivedAt = await follow(`#${reference}`, href);
          const quote = page.locator(href);
          const fields = quote.locator('dd');
          // The source section the quote sits in, and the excerpt it froze: the
          // text a reader without resmon has to check the quote against.
          const source = quote.locator('xpath=ancestor::section[contains(concat(" ", @class, " "), " source ")][1]');
          const startField = source.locator(':scope > dl.meta > dt').filter({ hasText: /^start_codepoint$/ })
            .locator('xpath=following-sibling::dd[1]');
          const returnedTo = await follow(`${href} a`, `#${reference}`);
          citations.push({
            reference,
            href,
            arrivedAt,
            quote: (await quote.locator('div.literal').textContent()) ?? '',
            start: Number(await fields.nth(1).textContent()),
            end: Number(await fields.nth(2).textContent()),
            excerpt: (await source.locator(':scope > div.literal').first().textContent()) ?? '',
            excerptStart: Number(await startField.textContent()),
            returnedTo,
            returnFocused: await page.evaluate((id) => document.activeElement?.id === id, reference),
          });
        }
        const observed = await reader.evaluate(() => (globalThis as unknown as {
          offlineReader: { refused: string[]; escapes: string[] };
        }).offlineReader);
        return {
          refused: observed.refused,
          escapes: observed.escapes,
          activeElements: await page.locator(
            'script,img,form,input,iframe,object,embed,base,svg,link,video,audio,picture,source,meta[http-equiv="refresh"]',
          ).count(),
          hrefs: await page.locator('a').evaluateAll((links) => links.map((link) => link.getAttribute('href') ?? '')),
          text: ((await page.locator('body').textContent()) ?? '').replace(/\s+/g, ' ').trim(),
          saysUnvalidated: (await page.getByRole('heading', { name: 'Incomplete / unvalidated output' }).count()) > 0,
          citations,
        };
      } finally {
        await reader.close().catch(() => { /* already gone */ });
      }
    },

    readWhatTheAgentCommandReceived: async (): Promise<string[][]> => readTheAgentCommandArguments(session),

    readWhatTheProviderReceived: async (): Promise<ProviderRequest[]> => {
      // Whichever driver pointed the app at it: what it received is the same read.
      const provider = providerEndpointOf(session);
      expect(provider, 'this journey never started an authored provider').toBeTruthy();
      return provider!.calls().map((call) => ({
        path: call.path,
        authorization: call.authorization,
        model: call.model,
        body: call.body,
      }));
    },

    theAuthoredModelCitesTextItWasNotSent: (quote) => {
      const selectedModel = selectedAnswerEndpointOf(session);
      expect(selectedModel, 'this journey never started an authored model').toBeTruthy();
      selectedModel!.citeTextItWasNotSent(quote);
    },

    readWhatTheAuthoredModelReceived: () => {
      const selectedModel = selectedAnswerEndpointOf(session);
      expect(selectedModel, 'this journey never started an authored model').toBeTruthy();
      return selectedModel!.calls().map((call) => ({ raw: call.raw, userPayload: call.userPayload }));
    },

    askOverTheRawSocket: async (request): Promise<RawAnswer> => {
      // `http.request` rather than `fetch`: `Host` is a forbidden header for
      // `fetch`, and a wrong `Host` is half of what this row is about. This is
      // also the only call in the suite that does not go through the app — the
      // journey is that somebody who is not this renderer gets refused, and a
      // request made with the app's own helper would carry the app's own
      // credentials and prove the opposite.
      const headers: Record<string, string> = {};
      if (request.token === 'this app') headers.Authorization = `Bearer ${publishedToken()}`;
      if (request.host) headers.Host = request.host;
      return new Promise<RawAnswer>((resolve, reject) => {
        const call = http.request({
          host: '127.0.0.1', port: Number(session.port), path: request.route, method: 'GET', headers,
          timeout: 30_000,
        }, (response) => {
          let body = '';
          response.setEncoding('utf8');
          response.on('data', (chunk) => { body += chunk; });
          response.on('end', () => {
            let reason: string | null = null;
            try { reason = JSON.parse(body)?.detail?.reason ?? null; } catch { reason = null; }
            resolve({ status: response.statusCode ?? 0, reason, body });
          });
        });
        call.on('timeout', () => { call.destroy(new Error(`GET ${request.route} did not answer`)); });
        call.on('error', reject);
        call.end();
      });
    },

    askTheMcpServer: async (): Promise<McpAnswer> => {
      const scripts = path.join(session.root.repo, 'resmon_scripts');
      // The harness's own environment: this app's state directory, and no port.
      // That is exactly how a person configures it — the server reads the port
      // out of the port file the running app wrote and the token out of
      // `api-token-<port>` beside it, which is the discovery half of the row.
      //
      // The state directory is spelled out in all four variables the app itself
      // was launched with rather than in `RESMON_STATE_DIR` alone, and that is
      // not tidiness. `config.PORT_FILE` falls back to the *database's* parent,
      // so a harness given only `RESMON_STATE_DIR` reads a port file belonging
      // to some other resmon — which is precisely the wrong-instance failure
      // this row exists to check, and it would be this harness causing it. B3
      // says the live daemon is never attached to, and the surest way to keep
      // that true is never to leave a path pointing anywhere but here.
      const env = {
        ...process.env,
        RESMON_STATE_DIR: session.stateDir,
        RESMON_DB_PATH: path.join(session.stateDir, 'resmon.db'),
        RESMON_REPORTS_DIR: path.join(session.stateDir, 'reports'),
        RESMON_PORT_FILE: path.join(session.stateDir, 'resmon.port'),
        PYTHONPATH: scripts,
        PYTHONDONTWRITEBYTECODE: '1',
        PYTHON_KEYRING_BACKEND: 'keyring.backends.null.Keyring',
      };
      // Three JSON-RPC messages down stdin, then EOF. `serve()` reads until
      // stdin closes, so one write is a whole conversation and there is no
      // half-open pipe to leave behind — which is the failure mode this suite
      // already paid for once in `session.ts`.
      const conversation = [
        { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} },
        { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} },
        { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'health', arguments: {} } },
      ].map((message) => JSON.stringify(message)).join('\n') + '\n';
      const run = spawnSync(session.python, [path.join(scripts, 'mcp_server.py')], {
        cwd: scripts, env, input: conversation, encoding: 'utf8', timeout: 120_000,
      });
      expect(
        run.status,
        `the MCP server exited ${run.status}: ${(run.stderr || '').slice(-1_000)}`,
      ).toBe(0);
      const answers = new Map<number, any>();
      for (const line of String(run.stdout || '').split('\n')) {
        if (!line.trim()) continue;
        const parsed = JSON.parse(line);
        answers.set(parsed.id, parsed);
      }
      expect([...answers.keys()].sort(), 'the MCP server did not answer all three messages')
        .toEqual([1, 2, 3]);
      // The denominator comes out of the build under test, not out of this
      // file: `mcp_server.TOOLS` is the list the contract is frozen against and
      // a number typed here would go stale the first time a tool is added.
      const declared = Number(execFileSync(
        session.python,
        ['-c', 'import mcp_server; print(len(mcp_server.TOOLS))'],
        { cwd: scripts, env, encoding: 'utf8' },
      ).trim());
      const health = JSON.parse(answers.get(3).result.content[0].text);
      return {
        server: answers.get(1).result.serverInfo,
        toolNames: (answers.get(2).result.tools as { name: string }[]).map((t) => t.name),
        declaredToolCount: declared,
        health,
      };
    },

    scanForNearDuplicates: async () => {
      // No screen starts this: the scan is corpus-wide and the app has no
      // button for it at this base, so it is asked for over the API. The row's
      // journey is what a person *sees* afterwards, which is the Explorer, and
      // that half is all on screen. The spec's ledger records that the scan
      // itself had no screen to start it from.
      await session.api('POST', '/api/links/scan', {});
      let status: any = {};
      await expect.poll(async () => {
        status = await session.api('GET', '/api/links/status');
        return Boolean(status.run?.running);
      }, { timeout: 120_000 }).toBe(false);
      return {
        links: Number(status.links ?? 0),
        byMethod: (status.by_method ?? {}) as Record<string, number>,
      };
    },
  };
}
