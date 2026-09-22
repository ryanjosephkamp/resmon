/**
 * The journey driver for the renderer resmon ships today.
 *
 * This is the only file in the suite that knows a class name, a hash route or
 * the text on a button. Everything above it is written in the words of the
 * parity register, and everything below it is a real Electron process over a
 * real backend. When the 3.0 renderer exists, the work is one more file of this
 * shape — not forty-four rewritten specs.
 *
 * Two rules it follows throughout.
 *
 * **A fact about the backend is read from the backend.** Where the journey is
 * "the screen and the record agree", the screen half is read here and the
 * record half comes from `session.api`, over the app's own token. Reading the
 * SQLite file would be easier and would also make the suite unable to run
 * against an installed app, which is the direction this is going.
 *
 * **Where the app has no user path, the driver says so by using the API and the
 * spec's ledger row records it.** Two of these are load-bearing and neither is
 * a shortcut: the app spawns its backend with `RESMON_DISABLE_SCHEDULER=1`, so
 * no fire in this suite comes from APScheduler; and `Run now` is on a routine
 * row only once that routine has missed a fire. Both are noted at the methods
 * concerned.
 */
import * as fs from 'fs';
import * as path from 'path';
import { execFileSync, spawnSync } from 'child_process';
import { expect } from '@playwright/test';
import type { TestInfo } from '@playwright/test';
import type {
  BackendFacts, BackupResult, CorpusCounts, DiveRequest, InterruptedRow, JourneyDriver,
  Place, RestoreCard, RoutineFacts, RunFacts, RunHandle, SourceOutcome, SweepRequest,
  UpcomingFire, WhyPanel,
} from '../driver';
// Slice 2a's own reads, kept in their own import so slice 2b's merge beside them.
import type {
  AnalyticsView, AssistantTurn, CoverageAudit, DaemonPanel, ExplorerList, Figure,
  FirstRunCard, GateRun, KeyField, ProfileCreation, ProfileMatches, RankedList,
  WatchdogFinding, WatchdogView,
} from '../driver';
import { JOURNEY_EMBEDDING_MODEL, startEmbeddingEndpoint } from '../fixtures/embedding-endpoint';
import type { Session } from './session';

/** The hash behind each place in the sidebar. The only route table in the suite. */
const PLACES: Record<Place, string> = {
  'Deep Dive': '/dive',
  'Deep Sweep': '/sweep',
  Routines: '/routines',
  Explorer: '/explorer',
  Results: '/results',
  Monitor: '/monitor',
  Calendar: '/calendar',
  'Saved configurations': '/configurations',
  'Storage settings': '/settings/storage',
  // — slice 2a ---------------------------------------------------------------
  Analytics: '/analytics',
  Watchdog: '/watchdog',
  'Watch Profiles': '/profiles',
  Repositories: '/repositories',
  'AI settings': '/settings/ai',
  'Email settings': '/settings/email',
  'Notification settings': '/settings/notifications',
  'Cloud Storage settings': '/settings/cloud',
  'Advanced settings': '/settings/advanced',
  Tutorials: '/about-resmon/tutorials',
};

/** `YYYY-MM-DD`, in the machine's own timezone, as the date inputs want it. */
function isoDate(at: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}`;
}

export function createClassicDriver(session: Session, testInfo: TestInfo): JourneyDriver {
  const win = () => session.win;

  const goto = async (hash: string): Promise<void> => {
    // A HashRouter change is not a document navigation, so setting the hash is
    // what a sidebar click does; `goto` against the same document would not
    // drive React Router at all.
    await win().evaluate((h) => { window.location.hash = `#${h}`; }, hash);
    await win().waitForFunction((h) => window.location.hash.startsWith(`#${h}`), hash, { timeout: 15_000 });
    await win().locator('.app-main').waitFor({ state: 'visible', timeout: 30_000 });
    await win().waitForLoadState('networkidle').catch(() => { /* the long-poll pages never idle */ });
    await win().waitForTimeout(400);
  };

  /** Open Results and click the row for this run, which mounts the report viewer. */
  const openResultsRow = async (run: RunHandle): Promise<void> => {
    await goto(PLACES.Results);
    const row = win().getByText(`Execution #${run.id}`, { exact: true }).locator('xpath=ancestor::tr');
    await expect(row).toBeVisible({ timeout: 30_000 });
    await row.click();
    await expect(win().locator('.report-viewer')).toBeVisible({ timeout: 30_000 });
  };


  /**
   * The Explorer's own account of the page it is showing.
   *
   * Shared by four slice-2a reads — the plain list, the ranked list, the
   * collapsed list and the one the Analytics chart hands off to — because all
   * four are asking the same screen the same question and a second copy would
   * be a second thing to keep in step.
   */
  const readExplorer = async (): Promise<ExplorerList> => {
    await expect(win().locator('.explorer-results-head')).toBeVisible({ timeout: 60_000 });
    const head = win().locator('.explorer-results-head p').first();
    const items = win().locator('li.explorer-item');
    const rows: ExplorerList['rows'] = [];
    for (let i = 0; i < await items.count(); i += 1) {
      const item = items.nth(i);
      const distance = item.locator('.explorer-distance');
      rows.push({
        title: (await item.locator('h3').innerText()).trim(),
        alsoAppearsAs: (await item.locator('[data-testid="duplicate-links"] .duplicate-link-text')
          .allInnerTexts()).map((t) => t.trim()),
        distance: (await distance.count()) ? (await distance.first().innerText()).trim() : '',
      });
    }
    const note = win().getByTestId('collapse-note');
    return {
      countSentence: (await head.innerText()).trim(),
      rows,
      collapseNote: (await note.count()) ? (await note.innerText()).trim() : '',
    };
  };

  /** What the assistant panel is showing right now. */
  const readAssistantPanel = async (): Promise<AssistantTurn> => {
    const said = (await win().locator('.assistant-message--assistant .assistant-bubble')
      .allInnerTexts()).map((t) => t.trim());
    const toolCalls = (await win().locator('.assistant-tool .assistant-tool-name')
      .allInnerTexts()).map((t) => t.trim());
    const card = win().getByTestId('permission-card').first();
    const hasCard = (await card.count()) > 0;
    const error = win().locator('.assistant-error');
    return {
      said,
      toolCalls,
      approvalCall: hasCard ? (await card.locator('pre').innerText()).trim() : '',
      approvalTitle: hasCard
        ? (await card.locator('.assistant-permission-title').innerText()).trim()
        : '',
      error: (await error.count()) ? (await error.first().innerText()).trim() : '',
    };
  };

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
  };

  return {
    name: 'classic',
    backend,

    open: (place) => goto(PLACES[place]),

    reopenTheApp: () => session.relaunch(),

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

    readConnectedIdentity: async () => {
      const status = win().locator('.connection-identity [role="status"]');
      await expect(status).not.toBeEmpty({ timeout: 30_000 });
      // The details are a closed `<details>`: the summary is the badge, and the
      // identifiers only exist in the layout once a person has opened it.
      const summary = win().locator('.connection-identity > summary');
      if (!await win().locator('.connection-identity[open]').count()) await summary.click();
      const details = win().locator('.connection-details');
      await expect(details).toBeVisible({ timeout: 15_000 });
      return {
        status: (await status.innerText()).trim(),
        details: (await details.innerText()).trim(),
      };
    },

    // — running ---------------------------------------------------------------

    runDive: async (request: DiveRequest): Promise<RunHandle> => {
      await goto(PLACES['Deep Dive']);
      await win().locator('select.form-select')
        .filter({ has: win().locator(`option[value="${request.source}"]`) })
        .selectOption(request.source);
      if (request.days !== undefined) {
        const to = new Date();
        const from = new Date(to.getTime() - request.days * 24 * 60 * 60 * 1000);
        await win().locator('.date-input-group input').first().fill(isoDate(from));
        await win().locator('.date-input-group input').nth(1).fill(isoDate(to));
      }
      for (const keyword of request.keywords) {
        await win().locator('.keyword-input-row input').fill(keyword);
        await win().locator('.keyword-input-row button', { hasText: 'Add' }).click();
      }
      if (request.cap !== undefined) {
        await win().locator('.range-row input[type="range"]').fill(String(request.cap));
      }
      const started = win().waitForResponse(
        (r) => r.url().endsWith('/api/search/dive') && r.request().method() === 'POST',
      );
      await win().locator('button', { hasText: 'Run Deep Dive' }).click();
      const response = await started;
      expect(response.ok(), 'the dive the form submitted was refused').toBe(true);
      const id = (await response.json()).execution_id as number;
      expect(id).toBeGreaterThan(0);
      return { id };
    },

    runSweep: async (request: SweepRequest): Promise<RunHandle> => {
      await goto(PLACES['Deep Sweep']);
      for (const source of request.sources) {
        await win().locator('.repo-checkbox-grid label.checkbox-label')
          .filter({ hasText: new RegExp(`^${source}$`) })
          .locator('input[type="checkbox"]')
          .check();
      }
      await win().locator('.keyword-input-row input').fill(request.query);
      await win().locator('.keyword-input-row button', { hasText: 'Add' }).click();
      if (request.cap !== undefined) {
        await win().locator('.range-row input[type="range"]').fill(String(request.cap));
      }
      const started = win().waitForResponse(
        (r) => r.url().endsWith('/api/search/sweep') && r.request().method() === 'POST',
      );
      await win().locator('button', { hasText: 'Run Deep Sweep' }).click();
      const response = await started;
      expect(response.ok(), 'the sweep the form submitted was refused').toBe(true);
      const id = (await response.json()).execution_id as number;
      expect(id).toBeGreaterThan(0);
      return { id };
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

    readRunPanelOutcomes: async (run, options): Promise<SourceOutcome[]> => {
      await goto(PLACES.Monitor);
      const tab = win().getByTestId(`mon-tab-${run.id}`);
      await expect(tab).toBeVisible({ timeout: 60_000 });
      await tab.click();
      const rows = win().locator('.mon-repo-row');
      await expect(rows.first()).toBeVisible({ timeout: 60_000 });
      if (options?.settled) {
        // The per-source statuses arrive over the progress stream. A run that
        // had already finished before the Monitor was opened is adopted with
        // nothing filled in, so a spec comparing the panel with the report has
        // to have been watching — which is the honest shape of the comparison
        // anyway, because that is what the user was doing.
        // Lower-cased before the comparison: the stylesheet upper-cases these,
        // so `innerText` reads "Pending", and a poll that compared against
        // "pending" was satisfied immediately by every state including the one
        // it was waiting to leave. It passed, and measured nothing.
        await expect.poll(async () => (await rows.locator('.mon-repo-status-text').allInnerTexts())
          .map((t) => t.trim().toLowerCase())
          .every((label) => !['pending', 'querying'].includes(label)),
        { timeout: 90_000 }).toBe(true);
      }
      const count = await rows.count();
      const out: SourceOutcome[] = [];
      for (let i = 0; i < count; i += 1) {
        const row = rows.nth(i);
        const reason = row.locator('.mon-repo-zero-reason');
        out.push({
          source: (await row.locator('.mon-repo-name').innerText()).trim(),
          label: (await row.locator('.mon-repo-status-text').innerText()).trim(),
          note: (await reason.count()) ? (await reason.innerText()).trim() : '',
        });
      }
      return out;
    },

    cancelRunFromMonitor: async (run) => {
      await goto(PLACES.Monitor);
      const tab = win().getByTestId(`mon-tab-${run.id}`);
      await expect(tab).toBeVisible({ timeout: 60_000 });
      await tab.click();
      await win().locator('.mon-header-meta button', { hasText: 'Cancel' }).click();
    },

    releaseTheSource: () => session.source.release(),

    // — reports ---------------------------------------------------------------

    openReport: (run) => openResultsRow(run),

    readCoverageSentence: async (run) => {
      await openResultsRow(run);
      const counts = win().locator('.report-viewer > .coverage-summary .coverage-counts');
      await expect(counts).toBeVisible({ timeout: 30_000 });
      return (await counts.innerText()).trim();
    },

    readReportOutcomes: async (run): Promise<SourceOutcome[]> => {
      await openResultsRow(run);
      // The per-source table is behind "View source details"; the summary
      // sentence is what the report shows first. Waiting for the summary
      // before looking for the button matters: the coverage block arrives on
      // its own request, and a `count()` taken before it lands reads zero and
      // skips the click, leaving a table that never appears.
      await expect(win().locator('.report-viewer > .coverage-summary'))
        .toBeVisible({ timeout: 30_000 });
      const details = win().locator('.coverage-summary button', { hasText: 'View source details' });
      await expect(details.first()).toBeVisible({ timeout: 30_000 });
      await details.first().click();
      const rows = win().locator('.coverage-table tbody tr');
      await expect(rows.first()).toBeVisible({ timeout: 30_000 });
      const count = await rows.count();
      const out: SourceOutcome[] = [];
      for (let i = 0; i < count; i += 1) {
        const cells = rows.nth(i).locator('td');
        out.push({
          source: (await cells.nth(0).innerText()).trim(),
          label: (await cells.nth(1).innerText()).trim(),
          note: (await cells.nth(4).innerText()).trim(),
        });
      }
      return out;
    },

    readReportTabs: async () => {
      const tabs = win().locator('.report-viewer .tab-bar .tab-btn');
      await expect(tabs.first()).toBeVisible({ timeout: 30_000 });
      return (await tabs.allInnerTexts()).map((t) => t.trim());
    },

    reportExists: async (run) => {
      // The same request the report viewer makes, and the same field it reads.
      const report = await session.api<{ report_text?: string }>(
        'GET', `/api/executions/${run.id}/report`,
      ).catch(() => ({} as { report_text?: string }));
      return String(report.report_text ?? '').trim().length > 0;
    },

    exportReferences: async (runs, format) => {
      await goto(PLACES.Results);
      for (const run of runs) {
        const row = win().getByText(`Execution #${run.id}`, { exact: true })
          .locator('xpath=ancestor::tr');
        await expect(row).toBeVisible({ timeout: 30_000 });
        await row.getByRole('checkbox').check();
      }
      const label = { bibtex: 'BibTeX', ris: 'RIS', csv: 'CSV' }[format];
      const extension = { bibtex: 'bib', ris: 'ris', csv: 'csv' }[format];
      const destination = path.join(session.stateDir, `journey-references.${extension}`);
      // The real Electron download, with only the destination picker replaced:
      // the request, the bytes and the serializer are all the app's own.
      await session.app.evaluate(({ BrowserWindow }, target) => {
        BrowserWindow.getAllWindows()[0].webContents.session.once('will-download', (_e, item) => {
          item.setSavePath(target as string);
        });
      }, destination);
      await win().getByRole('button', { name: label, exact: true }).click();
      await expect.poll(() => fs.existsSync(destination), { timeout: 30_000 }).toBe(true);
      await expect.poll(() => fs.statSync(destination).size, { timeout: 30_000 }).toBeGreaterThan(0);
      return fs.readFileSync(destination, 'utf8');
    },

    // — routines --------------------------------------------------------------

    createRoutine: async (routine) => {
      // Seeded through the API: the sweep-to-routine path is J39's journey, not
      // this one, and forty clicks through the editor would make this row fail
      // for reasons that belong to another row.
      const created = await session.api<{ id: number }>('POST', '/api/routines', {
        name: routine.name,
        schedule_cron: routine.cron,
        parameters: {
          repositories: routine.sources,
          keywords: routine.keywords,
          query: routine.keywords.join(' '),
          max_results: 10,
        },
        is_active: false,
      });
      return created.id;
    },

    activateRoutine: async (name) => {
      await goto(PLACES.Routines);
      const row = win().locator('.simple-table tbody tr').filter({ hasText: name }).first();
      await expect(row).toBeVisible({ timeout: 30_000 });
      await row.getByRole('button', { name: 'Activate', exact: true }).click();
      await expect(row.locator('.badge', { hasText: 'Active' })).toBeVisible({ timeout: 15_000 });
    },

    deactivateRoutine: async (name) => {
      await goto(PLACES.Routines);
      const row = win().locator('.simple-table tbody tr').filter({ hasText: name }).first();
      await expect(row).toBeVisible({ timeout: 30_000 });
      await row.getByRole('button', { name: 'Deactivate', exact: true }).click();
      await expect(row.locator('.badge', { hasText: 'Inactive' })).toBeVisible({ timeout: 15_000 });
    },

    fireRoutineNow: async (name): Promise<RunHandle> => {
      // Not a click, and the reason is worth writing down. `Run now` appears on
      // a routine's row *only* once that routine has missed a fire while resmon
      // was closed, and no fire can arrive on its own here: `electron/main.ts`
      // spawns the backend with `RESMON_DISABLE_SCHEDULER=1`, so the app's own
      // backend never owns an APScheduler at all — the launchd daemon does.
      // So this journey observes what a fire produces (a full execution with
      // its own report) and not what produces a fire. The scheduler half is
      // `test_routine_scheduler_sync.py` and `test_e2e_routine_fires.py`, and
      // the spec's ledger row says so rather than implying otherwise.
      const routines = await backend.routines();
      const routine = routines.find((r) => r.name === name);
      expect(routine, `no routine named ${name}`).toBeTruthy();
      const fired = await session.api<{ execution_id: number }>(
        'POST', `/api/routines/${routine!.id}/run`, {},
      );
      return { id: fired.execution_id };
    },

    toggleDesktopNotification: async (name) => {
      await goto(PLACES.Routines);
      const row = win().locator('.simple-table tbody tr').filter({ hasText: name }).first();
      await expect(row).toBeVisible({ timeout: 30_000 });
      // Three toggles share a class; Notify is the third column of them, in the
      // order the table's own header declares: Email, AI, Notify.
      await row.locator('.toggle-btn').nth(2).click();
      await win().waitForTimeout(600);
    },

    readRoutine: async (name): Promise<RoutineFacts> => {
      await goto(PLACES.Routines);
      const row = win().locator('.simple-table tbody tr').filter({ hasText: name }).first();
      await expect(row).toBeVisible({ timeout: 30_000 });
      const status = (await row.locator('.badge').first().innerText()).trim();
      const notify = (await row.locator('.toggle-btn').nth(2).innerText()).trim();
      return { name, active: status === 'Active', desktopNotification: notify === 'ON' };
    },

    listRoutineNames: async () => {
      await goto(PLACES.Routines);
      const rows = win().locator('.simple-table tbody tr');
      const count = await rows.count();
      const names: string[] = [];
      for (let i = 0; i < count; i += 1) {
        const cell = rows.nth(i).locator('td').first();
        if (await cell.count()) names.push((await cell.innerText()).trim());
      }
      return names.filter((n) => n && n !== 'No routines configured.');
    },

    // — the corpus ------------------------------------------------------------

    openFirstPaper: async () => {
      await goto(PLACES.Explorer);
      const first = win().locator('li.explorer-item').first();
      await expect(first).toBeVisible({ timeout: 30_000 });
      return (await first.locator('h3').innerText()).trim();
    },

    readWhyPanel: async (): Promise<WhyPanel> => {
      const panel = win().locator('li.explorer-item').first().locator('.why-panel');
      await panel.locator('.why-toggle').click();
      const body = panel.locator('.why-body');
      await expect(body).toBeVisible({ timeout: 30_000 });
      await expect(panel.locator('.why-limits-label')).toBeVisible({ timeout: 30_000 });

      const hits = panel.locator('ul.why-keywords li');
      const matches: { keyword: string; field: string }[] = [];
      for (let i = 0; i < await hits.count(); i += 1) {
        matches.push({
          keyword: (await hits.nth(i).locator('.why-keyword').innerText()).trim(),
          field: (await hits.nth(i).locator('.why-where').innerText()).trim(),
        });
      }
      const cannotSee = (await panel.locator('.why-limits li').allInnerTexts())
        .map((s) => s.trim());
      return { matches, cannotSee, text: (await body.innerText()).trim() };
    },

    // — the calendar ----------------------------------------------------------

    readUpcomingFires: async (): Promise<UpcomingFire[]> => {
      await goto(PLACES.Calendar);
      await expect(win().locator('.calendar-wrapper')).toBeVisible({ timeout: 30_000 });
      // The events the calendar is drawing, read out of the calendar's own
      // payload rather than off a month grid: the assertion this serves is
      // about *when* a fire is, and a day cell cannot carry a time.
      const events = await session.api<Record<string, any>[]>('GET', '/api/calendar/events');
      const drawn = (await win().locator('.calendar-wrapper .fc-event-title').allInnerTexts())
        .map((t) => t.trim());
      // Every scheduled fire the calendar holds, each saying whether the month
      // on screen draws it. Filtering to the drawn ones here would be wrong:
      // every fire of one routine carries the same title, so a title match
      // cannot tell one occurrence from another — what it can establish is
      // that the routine is on the grid at all.
      return events
        .filter((e) => e.status === 'scheduled')
        .map((e) => ({
          routine: String(e.title).replace(/^routine #\d+:\s*/, ''),
          when: new Date(String(e.start)),
          title: String(e.title),
          drawn: drawn.includes(String(e.title)),
        }));
    },

    // — saved configurations --------------------------------------------------

    saveConfiguration: async (name, from) => {
      const created = await session.api<{ id: number }>('POST', '/api/configurations', {
        name,
        config_type: 'manual_sweep',
        parameters: {
          repositories: from.sources,
          keywords: [from.query],
          query: from.query,
          max_results: 10,
        },
      });
      return created.id;
    },

    exportConfigurations: async () => {
      await goto(PLACES['Saved configurations']);
      // The table is split across two tabs and the selection is one set across
      // both, so "export every saved configuration" means visiting both. The
      // page opens on Routine Configs and a saved sweep is on the other one.
      for (const tab of ['Routine Configs', 'Manual Configs']) {
        await win().locator('.tab-bar .tab-btn', { hasText: tab }).click();
        await win().waitForTimeout(300);
        const rows = win().locator('.simple-table tbody tr');
        for (let i = 0; i < await rows.count(); i += 1) {
          const box = rows.nth(i).getByRole('checkbox');
          if (await box.count()) await box.check();
        }
      }
      const exportButton = win().locator('button', { hasText: /^Export Selected/ });
      await expect(exportButton, 'nothing was selectable to export').toBeEnabled({ timeout: 15_000 });
      await exportButton.click();
      const message = win().locator('.form-success');
      await expect(message).toContainText('Export saved to:', { timeout: 30_000 });
      // The banner carries a "Reveal in Finder" button beside the sentence, so
      // its innerText is two lines and only the first is a path.
      const written = (await message.innerText())
        .split('\n')[0].replace('Export saved to:', '').trim();
      expect(fs.existsSync(written), `the export names ${written}, which is not there`).toBe(true);
      session.alsoRemoveOnClose(written);
      // The export is a zip of one JSON member per configuration, so the bytes
      // on disk are compressed and searching them for a secret would be a
      // check that passes for the wrong reason. The members are read out with
      // the interpreter the backend is already running under.
      const members = execFileSync(session.python, ['-c', `
import json, sys, zipfile
with zipfile.ZipFile(sys.argv[1]) as bundle:
    print(json.dumps({name: bundle.read(name).decode('utf-8') for name in bundle.namelist()}))
`, written], { encoding: 'utf8' });
      return JSON.parse(members) as Record<string, string>;
    },

    importConfigurations: async (text) => {
      const before = await session.api<unknown[]>('GET', '/api/configurations');
      const file = path.join(session.stateDir, 'journey-import.json');
      fs.writeFileSync(file, text);
      await goto(PLACES['Saved configurations']);
      const chooser = win().waitForEvent('filechooser');
      await win().locator('button', { hasText: /^Import$/ }).click();
      (await chooser).setFiles(file);
      await expect(win().locator('.form-success')).toContainText('Imported', { timeout: 30_000 });
      const after = await session.api<unknown[]>('GET', '/api/configurations');
      return after.length - before.length;
    },

    // — storage ---------------------------------------------------------------

    backUpNow: async (options): Promise<BackupResult> => {
      await goto(PLACES['Storage settings']);
      await expect(win().getByTestId('backup-restore')).toBeVisible({ timeout: 30_000 });
      const box = win().locator('label')
        .filter({ hasText: 'Include the reports folder' })
        .locator('input[type="checkbox"]')
        .first();
      if (options.reports) await box.check(); else await box.uncheck();
      const answered = win().waitForResponse(
        (r) => r.url().endsWith('/api/backup') && r.request().method() === 'POST',
      );
      await win().getByRole('button', { name: 'Back up now', exact: true }).click();
      const response = await answered;
      expect(response.ok(), 'Back up now was refused').toBe(true);
      const body = await response.json();
      // The bundle is written where `export_directory` points, which in a fresh
      // state is the system temp directory — outside everything this session
      // otherwise cleans up.
      session.alsoRemoveOnClose(String(body.path));
      return { directory: String(body.path), manifest: body.manifest as Record<string, unknown> };
    },

    restoreIntoFreshState: async (bundle) => {
      // A fresh state directory, then the restore staged through the real
      // endpoint, then a real start — which is the only thing that moves a
      // byte. `/api/restore` deliberately does not restore: it writes a pointer,
      // and the next startup does the work.
      await session.relaunchOverFreshState();
      await session.api('POST', '/api/restore', { confirm: 'CONFIRM', path: bundle.directory });
      await session.relaunch();
    },

    readRestoreCard: async (): Promise<RestoreCard> => {
      await goto(PLACES['Storage settings']);
      const card = win().getByTestId('reentry-card');
      await expect(card).toBeVisible({ timeout: 30_000 });
      const entries = (await card.locator('li code').allInnerTexts()).map((s) => s.trim());
      return { text: (await card.innerText()).trim(), keyringEntries: entries };
    },

    // — a run whose process died ----------------------------------------------

    killTheBackend: async () => { await session.killBackend(); },

    readInterruptedRow: async (run): Promise<InterruptedRow> => {
      await goto(PLACES.Results);
      const row = win().locator('tr', { hasText: `Execution #${run.id}` }).first();
      await expect(row).toBeVisible({ timeout: 60_000 });
      const badge = row.locator('.badge', { hasText: 'interrupted' });
      await expect(badge).toBeVisible({ timeout: 30_000 });
      const note = win().getByTestId(`interrupted-note-${run.id}`);
      await expect(note).toBeVisible({ timeout: 30_000 });
      return {
        badge: (await badge.innerText()).trim(),
        note: (await note.innerText()).trim(),
      };
    },

    restartRun: async (run): Promise<RunHandle> => {
      await goto(PLACES.Results);
      await win().getByTestId(`restart-${run.id}`).click();
      let restarted = 0;
      await expect.poll(async () => {
        const list = await backend.executions();
        const made = list.filter((e) => e.restarted_from === run.id);
        if (made.length) restarted = made[0].id as number;
        return made.length;
      }, { timeout: 60_000 }).toBe(1);
      return { id: restarted };
    },


    // — slice 2a -------------------------------------------------------------
    //
    // One block, so slice 2b's verbs merge beside these rather than through
    // them. Nothing here is a new kind of thing: a read returns what the screen
    // says, an action does what the person's own control does, and where the
    // app offers no control the comment says so.

    readWhatThisPlaceSays: async () => {
      const main = win().locator('main.main-content');
      await expect(main).toBeVisible({ timeout: 30_000 });
      return (await main.innerText()).trim();
    },

    readSidebarPlaces: async () => {
      const links = win().locator('nav.sidebar-nav a.sidebar-link');
      await expect(links.first()).toBeVisible({ timeout: 30_000 });
      // The icon is a decorative glyph inside the same anchor, so the label is
      // what is left once it has been taken off the front.
      return (await links.allInnerTexts()).map((t) => t.replace(/^\s*\S\s*/, '').trim());
    },

    readTabsHere: async () => {
      const tabs = win().locator('.settings-nav .tab-btn, .tab-bar .tab-btn');
      if (!await tabs.count()) return [];
      return (await tabs.allInnerTexts()).map((t) => t.trim());
    },

    readTheHelpOnThisPage: async () => {
      const header = win().locator('button.page-help-header').first();
      await expect(header, 'this place offers no help block').toBeVisible({ timeout: 30_000 });
      // It persists open or closed per page in localStorage, so a run over a
      // reused profile can find it already open. Open it only when it is shut.
      if ((await header.getAttribute('aria-expanded')) !== 'true') await header.click();
      const body = win().locator('.page-help-body').first();
      await expect(body).toBeVisible({ timeout: 15_000 });
      return `${(await header.innerText()).trim()}\n${(await body.innerText()).trim()}`;
    },

    readDaemonPanel: async (): Promise<DaemonPanel> => {
      await goto(PLACES['Advanced settings']);
      const panel = win().locator('.settings-panel').first();
      await expect(panel).toBeVisible({ timeout: 30_000 });
      // The panel is the literal words "Loading service status…" until
      // /api/service/status answers, and reading it before then would report
      // the loading state as the daemon's state.
      await expect(panel).not.toContainText('Loading service status', { timeout: 30_000 });
      const text = (await panel.innerText()).trim();
      const status = (text.split('\n').find((line) => line.startsWith('Status:')) ?? '').trim();
      // One control does both jobs: a checkbox whose label is the sentence
      // about running in the background, behind a confirm dialog. There is no
      // separate Install button to look for, and this journey never ticks it.
      const control = win().locator('label')
        .filter({ hasText: 'Run resmon in the background' })
        .locator('input[type="checkbox"]')
        .first();
      const present = (await control.count()) > 0;
      return {
        status,
        controlPresent: present,
        controlOn: present ? await control.isChecked() : false,
        text,
      };
    },

    readAnalytics: async (): Promise<AnalyticsView> => {
      await goto(PLACES.Analytics);
      const page = win().locator('main.main-content');
      await expect(page).not.toContainText('Loading analytics', { timeout: 60_000 });
      const headings = (await win().locator('section.card > h2').allInnerTexts())
        .map((t) => t.trim());
      const tiles: Figure[] = [];
      const tile = win().locator('.analytics-tile');
      for (let i = 0; i < await tile.count(); i += 1) {
        tiles.push({
          label: (await tile.nth(i).locator('.analytics-tile-key').innerText()).trim(),
          value: (await tile.nth(i).locator('.analytics-tile-value').innerText()).trim(),
        });
      }
      // The first bar card is per source; the keyword card below it is empty
      // until it is asked for, so it contributes no rows here.
      const sources: Figure[] = [];
      const bars = win().locator('.analytics-bars').first().locator('.analytics-bar-row');
      for (let i = 0; i < await bars.count(); i += 1) {
        sources.push({
          label: (await bars.nth(i).locator('.analytics-bar-label').innerText()).trim(),
          value: (await bars.nth(i).locator('.analytics-bar-num').innerText()).trim(),
        });
      }
      const notEnoughYet = (await win().locator('p.analytics-thin').allInnerTexts())
        .map((t) => t.trim());
      return { headings, tiles, sources, notEnoughYet };
    },

    measureKeywordYield: async (): Promise<{ bars: Figure[]; notEnoughYet: string }> => {
      await goto(PLACES.Analytics);
      const button = win().getByRole('button', { name: 'Measure keyword contribution', exact: true });
      await expect(
        button,
        'the keyword view is supposed to be the one that only runs when asked',
      ).toBeVisible({ timeout: 60_000 });
      const answered = win().waitForResponse(
        (r) => r.url().includes('/api/analytics/keyword-contribution'),
      );
      await button.click();
      await answered;
      await win().waitForTimeout(500);
      // The keyword card is the one whose heading names keywords, found by that
      // heading rather than by its position on the page: the cards above it are
      // conditional and counting from the top would break when one is absent.
      const card = win().locator('section.card')
        .filter({ has: win().locator('h2:text-matches("keywords", "i")') }).first();
      await expect(card, 'the page draws no keyword card').toBeVisible({ timeout: 30_000 });
      const bars: Figure[] = [];
      const rows = card.locator('.analytics-bar-row');
      for (let i = 0; i < await rows.count(); i += 1) {
        bars.push({
          label: (await rows.nth(i).locator('.analytics-bar-label').innerText()).trim(),
          value: (await rows.nth(i).locator('.analytics-bar-num').innerText()).trim(),
        });
      }
      // A corpus too small for a share to mean anything gets a sentence instead
      // of bars, which is an answer rather than an empty card.
      const thin = card.locator('p.analytics-thin');
      return {
        bars,
        notEnoughYet: (await thin.count()) ? (await thin.first().innerText()).trim() : '',
      };
    },

    followTheChartIntoTheExplorer: async () => {
      await goto(PLACES.Analytics);
      // The volume chart's own segments carry a tooltip and no link; the link
      // the chart offers is its legend entry, and the source bar's label is the
      // same handoff from the card above it. Prefer the chart's, take the
      // other when this corpus drew no chart, and let the spec say which.
      const legend = win().locator('a.analytics-legend-link').first();
      const bar = win().locator('a.analytics-bar-link').first();
      const link = (await legend.count()) ? legend : bar;
      await expect(link, 'nothing on Analytics offered a way into the Explorer').toBeVisible({ timeout: 60_000 });
      await link.click();
      await win().waitForFunction(() => window.location.hash.startsWith('#/explorer'), undefined, { timeout: 30_000 });
      await win().waitForTimeout(800);
      const hash = await win().evaluate(() => window.location.hash);
      return { hash, list: await readExplorer() };
    },

    readWatchdog: async (): Promise<WatchdogView> => {
      await goto(PLACES.Watchdog);
      const verdictCard = win().locator('.watchdog-verdict');
      await expect(verdictCard).toBeVisible({ timeout: 60_000 });
      const verdict = (await verdictCard.locator('h2').innerText()).trim();
      const cards = win().locator('article.watchdog-finding');
      const findings: WatchdogFinding[] = [];
      for (let i = 0; i < await cards.count(); i += 1) {
        const card = cards.nth(i);
        const scope = card.locator('.watchdog-scope');
        findings.push({
          severity: (await card.locator('.watchdog-chip').first().innerText()).trim(),
          scope: (await scope.count()) ? (await scope.first().innerText()).trim() : '',
          title: (await card.locator('h3').innerText()).trim(),
          muted: (await card.locator('.watchdog-chip-muted').count()) > 0,
        });
      }
      const notEnoughHistory = (await win().locator('ul.watchdog-unjudged li').allInnerTexts())
        .map((t) => t.replace(/\s+/g, ' ').trim());
      const muted = win().locator('section.card').filter({ has: win().locator('h2:text-matches("^Muted")') });
      return {
        verdict,
        findings,
        notEnoughHistory,
        mutedHeading: (await muted.count()) ? (await muted.first().locator('h2').innerText()).trim() : '',
      };
    },

    muteTheFinding: async (titleFragment) => {
      await goto(PLACES.Watchdog);
      const card = win().locator('article.watchdog-finding')
        .filter({ hasText: titleFragment }).first();
      await expect(card, `no finding mentioning "${titleFragment}"`).toBeVisible({ timeout: 30_000 });
      const answered = win().waitForResponse((r) => r.url().includes('/api/watchdog/mute'));
      await card.getByRole('button', { name: 'Mute', exact: true }).click();
      expect((await answered).ok(), 'Mute was refused').toBe(true);
      await win().waitForTimeout(800);
    },

    theSourceGoesDown: () => session.source.answerWith('dead'),
    theSourceComesBack: () => session.source.answerWith('paper'),

    createWatchProfile: async (profile): Promise<ProfileCreation> => {
      await goto(PLACES['Watch Profiles']);
      await win().getByRole('button', { name: 'New profile', exact: true }).click();
      const editor = win().getByTestId('profile-editor');
      await expect(editor).toBeVisible({ timeout: 30_000 });
      await editor.locator('#profile-name').fill(profile.name);
      if (profile.orcid) await editor.locator('#profile-orcid').fill(profile.orcid);
      // Read the sentence *before* saving: the register's invariant is about
      // what a person is told at creation, and the saved profile's own copy of
      // it is a different surface.
      const preview = editor.getByTestId('basis-warning');
      await expect(preview).toBeVisible({ timeout: 15_000 });
      const warningAtCreation = (await preview.innerText()).trim();
      const created = win().waitForResponse(
        (r) => r.url().endsWith('/api/profiles') && r.request().method() === 'POST',
      );
      await editor.getByRole('button', { name: 'Save profile', exact: true }).click();
      const response = await created;
      expect(response.ok(), 'the profile the editor submitted was refused').toBe(true);
      const id = (await response.json()).id as number;
      const row = win().getByTestId('profiles-list').locator('li')
        .filter({ hasText: profile.name }).first();
      await expect(row).toBeVisible({ timeout: 30_000 });
      const chip = row.locator('span.basis-chip');
      return {
        id,
        warningAtCreation,
        chipInList: (await chip.count()) ? (await chip.first().innerText()).trim() : '',
      };
    },

    readProfileMatches: async (name): Promise<ProfileMatches> => {
      await goto(PLACES['Watch Profiles']);
      await win().getByTestId('profiles-list').locator('button.profiles-list-item')
        .filter({ hasText: name }).first().click();
      await win().waitForTimeout(800);
      const counts = win().getByTestId('basis-counts');
      const items: ProfileMatches['items'] = [];
      const list = win().getByTestId('profile-matches').locator('li');
      for (let i = 0; i < await list.count(); i += 1) {
        const item = list.nth(i);
        const author = item.locator('span.basis-author');
        items.push({
          basis: (await item.locator('span.basis-chip').first().innerText()).trim(),
          author: (await author.count()) ? (await author.first().innerText()).trim() : '',
          title: (await item.innerText()).split('\n')[0].trim(),
        });
      }
      return {
        counts: (await counts.count()) ? (await counts.innerText()).trim() : '',
        items,
      };
    },

    readBasisBadgesInTheExplorer: async () => {
      await goto(PLACES.Explorer);
      await expect(win().locator('li.explorer-item').first()).toBeVisible({ timeout: 30_000 });
      await win().waitForTimeout(800);
      return (await win().getByTestId('basis-matches').locator('span.basis-chip').allInnerTexts())
        .map((t) => t.trim());
    },

    readExplorerList: async () => {
      await goto(PLACES.Explorer);
      return readExplorer();
    },

    enableRankingByMeaning: async () => {
      // A deterministic model on loopback, spoken to over a real socket by the
      // backend's own client. What it cannot see is a real provider's own
      // behaviour, and the ledger row says so.
      const endpoint = await startEmbeddingEndpoint();
      session.alsoCloseOnClose(endpoint.close);
      await session.api('PUT', '/api/settings/embeddings', {
        settings: {
          embedding_enabled: 'true',
          embedding_provider: 'local',
          embedding_model: JOURNEY_EMBEDDING_MODEL,
          embedding_endpoint: endpoint.url,
        },
      });
      const probe = await session.api<{ ok: boolean; reason?: string }>('POST', '/api/embeddings/probe', {});
      expect(probe.ok, `the embedding probe said: ${probe.reason}`).toBe(true);
      return JOURNEY_EMBEDDING_MODEL;
    },

    rankTheExplorerBy: async (phrase): Promise<RankedList> => {
      await goto(`${PLACES.Explorer}?q=${encodeURIComponent(phrase)}`);
      const sort = win().getByTestId('explorer-sort');
      const controlsPresent = (await sort.count()) > 0;
      if (!controlsPresent) {
        return { note: '', controlsPresent, list: await readExplorer() };
      }
      await sort.locator('select').selectOption('similarity');
      await win().waitForTimeout(2_000);
      const note = win().getByTestId('rank-note');
      await expect(note).toBeVisible({ timeout: 30_000 });
      return {
        note: (await note.innerText()).trim(),
        controlsPresent,
        list: await readExplorer(),
      };
    },

    scanForNearDuplicates: async () => {
      // No screen starts this: the scan is corpus-wide and the app has no
      // button for it at this base. The row's journey is what a person *sees*
      // afterwards, which is the Explorer, and that half is all on screen.
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

    collapseDuplicates: async (on) => {
      const box = win().getByTestId('collapse-toggle').locator('input[type="checkbox"]');
      await expect(box, 'the Explorer offered no way to collapse duplicates').toBeVisible({ timeout: 30_000 });
      if (on) await box.check(); else await box.uncheck();
      await win().waitForTimeout(600);
    },

    writeRoutineIntent: async (name, intent) => {
      await goto(PLACES.Routines);
      const row = win().locator('.simple-table tbody tr').filter({ hasText: name }).first();
      await expect(row).toBeVisible({ timeout: 30_000 });
      await row.getByRole('button', { name: 'Edit', exact: true }).click();
      const field = win().locator('#routine-intent');
      await expect(field).toBeVisible({ timeout: 30_000 });
      await field.fill(intent);
      const saved = win().waitForResponse(
        (r) => /\/api\/routines\/\d+$/.test(r.url()) && r.request().method() === 'PUT',
      );
      await win().getByRole('button', { name: /^Save/ }).first().click();
      expect((await saved).ok(), 'the routine the editor submitted was refused').toBe(true);
      await win().waitForTimeout(800);
    },

    readCoverageAudit: async (name): Promise<CoverageAudit> => {
      await goto(PLACES.Routines);
      const row = win().locator('.simple-table tbody tr').filter({ hasText: name }).first();
      await expect(row).toBeVisible({ timeout: 30_000 });
      const toggle = win().getByTestId('coverage-toggle');
      await expect(toggle.first()).toBeVisible({ timeout: 30_000 });
      if ((await toggle.first().getAttribute('aria-expanded')) !== 'true') await toggle.first().click();
      const body = win().getByTestId('coverage-body').first();
      await expect(body).toBeVisible({ timeout: 30_000 });
      await expect(body).not.toContainText('Checking…', { timeout: 60_000 });
      const read = async (id: string): Promise<string> => {
        const node = win().getByTestId(id).first();
        return (await node.count()) ? (await node.innerText()).trim() : '';
      };
      const showing = win().locator('p.coverage-showing');
      const lines = (await showing.allInnerTexts()).map((t) => t.trim());
      return {
        intent: await read('coverage-intent'),
        reason: await read('coverage-reason'),
        // The two lists are in order — furthest first, missed second — so the
        // first "Showing" line belongs to the first list. Where a list is
        // short enough to be shown whole it prints no line at all.
        offTargetShowing: lines[0] ?? '',
        missedShowing: lines[1] ?? '',
        cannotSee: await read('coverage-cannot-see'),
        text: (await body.innerText()).trim(),
      };
    },

    saveKeyFor: async (source, value) => {
      await goto(PLACES.Repositories);
      const field = win().locator(`input[aria-label="API key for ${source}"]`);
      await expect(field, `${source} has no key field`).toBeVisible({ timeout: 30_000 });
      const saved = win().waitForResponse(
        (r) => r.url().includes('/api/credentials/') && r.request().method() === 'PUT',
      );
      await field.fill(value);
      await field.press('Enter');
      expect((await saved).ok(), 'the key the field submitted was refused').toBe(true);
      await win().waitForTimeout(800);
    },

    readKeyFields: async (): Promise<KeyField[]> => {
      await goto(PLACES.Repositories);
      const fields = win().locator('div.api-key-field input[aria-label^="API key for "]');
      await expect(fields.first()).toBeVisible({ timeout: 30_000 });
      const out: KeyField[] = [];
      for (let i = 0; i < await fields.count(); i += 1) {
        const field = fields.nth(i);
        out.push({
          source: String(await field.getAttribute('aria-label')).replace('API key for ', ''),
          // The mask is the field's placeholder, not its value: the value is
          // empty, which is the point. Reading `inputValue()` alone would pass
          // for a field that showed the key itself.
          shown: String(await field.getAttribute('placeholder') ?? ''),
          value: await field.inputValue(),
        });
      }
      return out;
    },

    readSourceDetails: async (source): Promise<Record<string, string>> => {
      await goto(PLACES.Repositories);
      const toggle = win().locator('span.repo-row-toggle').filter({ hasText: new RegExp(`^[▸▾]?\\s*${source}$`) }).first();
      await expect(toggle, `no row for ${source}`).toBeVisible({ timeout: 30_000 });
      if ((await toggle.getAttribute('aria-expanded')) !== 'true') await toggle.click();
      const grid = win().locator('tr.repo-details-row dl.details-grid').first();
      await expect(grid).toBeVisible({ timeout: 15_000 });
      const terms = await grid.locator('dt').allInnerTexts();
      const values = await grid.locator('dd').allInnerTexts();
      const out: Record<string, string> = {};
      terms.forEach((term, index) => { out[term.trim()] = (values[index] ?? '').trim(); });
      return out;
    },

    readRequiredAttributions: async () => {
      await goto(PLACES.Repositories);
      const block = win().getByTestId('required-attributions');
      if (!await block.count()) return [];
      return (await block.locator('li').allInnerTexts()).map((t) => t.replace(/\s+/g, ' ').trim());
    },

    useAnAuthoredAgentCommand: async () => {
      // A one-line shim around the repository's own agent-CLI double, run under
      // the same interpreter the backend uses. Written into this session's own
      // state directory, so it is removed with everything else this run made.
      const command = path.join(session.stateDir, 'authored-agent-command');
      const double = path.join(
        session.root.repo, 'resmon_scripts', 'verification_scripts', 'fixtures', 'fake_claude.py',
      );
      expect(
        fs.existsSync(double),
        'the build under test carries no agent-CLI double to drive the assistant with',
      ).toBe(true);
      // The interpreter has to be absolute: a bare name in a shebang is not
      // looked up on PATH the way a command is.
      const python = execFileSync(session.python, ['-c', 'import sys; print(sys.executable)'],
        { encoding: 'utf8' }).trim();
      fs.writeFileSync(command, `#!/bin/sh\nexec "${python}" "${double}" "$@"\n`, { mode: 0o755 });
      await session.api('PUT', '/api/settings/ai', { settings: { ai_cli_path: command } });
      // The panel reads the lane when it opens, so the window has to see the
      // setting. Reopening is what a person would do, and it also proves the
      // setting survived being written.
      await session.relaunch();
    },

    askTheAssistant: async (text): Promise<AssistantTurn> => {
      await win().getByTestId('assistant-trigger').click();
      const panel = win().getByTestId('assistant-panel');
      await expect(panel).toBeVisible({ timeout: 30_000 });
      const composer = win().getByLabel('Message the assistant');
      await expect(composer, 'the assistant is not available in this app').toBeEnabled({ timeout: 30_000 });
      await composer.fill(text);
      await win().getByRole('button', { name: 'Send', exact: true }).click();
      // Settled means: it is no longer working, and it is either holding a card,
      // showing an error, or has said something.
      await expect.poll(async () => (
        await win().locator('.assistant-thinking').count() === 0
        || await win().getByTestId('permission-card').count() > 0
      ), { timeout: 120_000 }).toBe(true);
      await win().waitForTimeout(600);
      return readAssistantPanel();
    },

    answerTheApprovalCard: async (allow): Promise<AssistantTurn> => {
      const card = win().getByTestId('permission-card').first();
      await expect(card, 'the assistant is holding no approval card').toBeVisible({ timeout: 30_000 });
      const answered = win().waitForResponse((r) => r.url().includes('/api/assistant/permissions/'));
      await card.getByRole('button', { name: allow ? 'Allow' : 'Deny', exact: true }).click();
      expect((await answered).ok(), 'the answer to the approval card was refused').toBe(true);
      await expect.poll(
        async () => win().locator('.assistant-thinking').count(),
        { timeout: 120_000 },
      ).toBe(0);
      await win().waitForTimeout(600);
      return readAssistantPanel();
    },

    readSavedConversations: async () => {
      if (!await win().getByTestId('assistant-panel').count()) {
        await win().getByTestId('assistant-trigger').click();
        await expect(win().getByTestId('assistant-panel')).toBeVisible({ timeout: 30_000 });
      }
      await win().getByLabel('Earlier conversations').click();
      await win().waitForTimeout(800);
      return (await win().locator('button.assistant-session-open').allInnerTexts())
        .map((t) => t.trim());
    },

    readTheFirstRunCard: async (): Promise<FirstRunCard> => {
      await goto('/');
      const card = win().getByTestId('first-run-card');
      await win().waitForTimeout(800);
      if (!await card.count()) return { present: false, steps: [], text: '' };
      await expect(card).toBeVisible({ timeout: 30_000 });
      const items = card.locator('li[data-testid^="first-run-step-"]');
      const steps: FirstRunCard['steps'] = [];
      for (let i = 0; i < await items.count(); i += 1) {
        const item = items.nth(i);
        steps.push({
          id: String(await item.getAttribute('data-testid')).replace('first-run-step-', ''),
          // The mark carries its meaning in an aria-label rather than in the
          // glyph, which is the half a person using a screen reader gets.
          mark: String(await item.locator('.first-run-mark').getAttribute('aria-label') ?? ''),
          text: (await item.innerText()).replace(/\s+/g, ' ').trim(),
        });
      }
      return { present: true, steps, text: (await card.innerText()).trim() };
    },

    skipTheFirstRunCard: async () => {
      await goto('/');
      const dismissed = win().waitForResponse(
        (r) => r.url().includes('/api/onboarding/dismiss') && r.request().method() === 'POST',
      );
      await win().getByTestId('first-run-skip').click();
      expect((await dismissed).ok(), 'Skip was refused').toBe(true);
      await expect(win().getByTestId('first-run-card')).toHaveCount(0, { timeout: 30_000 });
    },

    eraseWith: async (action, word) => {
      await goto(PLACES['Advanced settings']);
      await win().getByRole('button', { name: action, exact: true }).click();
      const modal = win().locator('.modal-content');
      await expect(modal).toBeVisible({ timeout: 30_000 });
      const box = modal.getByPlaceholder('Type CONFIRM');
      if (await box.count()) await box.fill(word);
      const confirm = modal.getByRole('button', { name: 'Confirm', exact: true });
      if (await confirm.isDisabled()) {
        // The screen refuses before the backend is asked. That is a real
        // answer, and the spec asserts the HTTP refusal separately.
        await modal.getByRole('button', { name: 'Cancel', exact: true }).click();
        return { status: 0, body: 'the Confirm button stayed disabled' };
      }
      const answered = win().waitForResponse((r) => r.url().includes('/api/admin/'));
      await confirm.click();
      const response = await answered;
      return { status: response.status(), body: (await response.text()).slice(0, 400) };
    },

    framesHere: async () => win().locator('iframe, webview, object, embed').count(),

    readExternalLinks: async () => {
      const links = win().locator('main.main-content a[href^="http"]');
      const out: { text: string; href: string }[] = [];
      for (let i = 0; i < await links.count(); i += 1) {
        out.push({
          text: (await links.nth(i).innerText()).trim(),
          href: String(await links.nth(i).getAttribute('href')),
        });
      }
      return out;
    },

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

    refusedConnections: () => session.refused(),
  };
}
