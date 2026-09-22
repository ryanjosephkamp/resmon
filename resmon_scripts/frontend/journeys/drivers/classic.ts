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
import { execFileSync } from 'child_process';
import { expect } from '@playwright/test';
import type { TestInfo } from '@playwright/test';
import type {
  BackendFacts, BackupResult, CorpusCounts, DiveRequest, InterruptedRow, JourneyDriver,
  Place, RestoreCard, RoutineFacts, RunFacts, RunHandle, SourceOutcome, SweepRequest,
  UpcomingFire, WhyPanel,
} from '../driver';
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

    refusedConnections: () => session.refused(),
  };
}
