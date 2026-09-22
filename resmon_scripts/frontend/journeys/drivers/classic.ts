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
import * as http from 'http';
import * as net from 'net';
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
// Slice 2b's additions, in their own import for the same reason its verbs are
// in their own block: two branches appending beats two branches interleaving.
import type {
  DeliveryRecord, McpAnswer, ObservedRequest, QueuedPaper, RawAnswer,
} from '../driver';
// Slice 3's, in its own import for the same reason.
import type {
  AssistantPanelFacts, EmailSettings, NotificationPreferences, ProviderRequest, RunNowAnswer,
  SavedTranscript,
} from '../driver';
import { startProviderEndpoint } from '../fixtures/provider-endpoint';
import type { ProviderEndpoint } from '../fixtures/provider-endpoint';
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
  // — slice 3 ---------------------------------------------------------------
  Chats: '/chats',
};

/** `YYYY-MM-DD`, in the machine's own timezone, as the date inputs want it. */
function isoDate(at: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}`;
}

export function createClassicDriver(session: Session, testInfo: TestInfo): JourneyDriver {
  const win = () => session.win;

  /** The authored model provider, once a journey has asked for one. */
  let provider: ProviderEndpoint | null = null;

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
    await reportViewerHasStoppedReloading();
  };

  /**
   * Wait until the report viewer has stopped calling this run live.
   *
   * **This is the fix for J19's coverage table, and the thing it was waiting
   * for was never a cell.** `ReportViewer` passes its own `isLive` to
   * `useSearchRecord` as the hook's `revision`, and that hook *blanks* its
   * state — `setState({ data: null })` — at the top of every effect run. So the
   * moment the window stops believing the run is still going, the whole
   * coverage block, tables and all, is removed from the DOM and fetched again.
   *
   * A cancelled run is exactly where that transition is late: the backend has
   * already written `cancelled`, so `waitForRunToSettle` has returned, while
   * the window's own execution context has not caught up. Open the report in
   * that window and the table renders, the read starts, the context catches up,
   * and the row the read is holding is detached mid-read. That is both shapes
   * this suite has seen — `.first().locator('td').first()` on a runner, and
   * `.nth(1)` on a laptop — and neither is a slow machine.
   *
   * So this waits for a terminal state the app puts on screen rather than for a
   * duration: the pulse the Progress tab draws while a run is live is gone. No
   * budget was raised to do it.
   */
  async function reportViewerHasStoppedReloading(): Promise<void> {
    await expect(win().locator('.report-viewer .tab-bar .sidebar-pulse'))
      .toHaveCount(0, { timeout: 60_000 });
  }


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
  /**
   * Wait until the assistant's turn has actually stopped, not until the panel
   * looks idle.
   *
   * **The `.assistant-thinking` poll this replaces was satisfied before the
   * turn began.** Its condition was "nothing is thinking, or a card is up", and
   * at the moment Send is clicked nothing is thinking yet — so the poll
   * returned immediately, a fixed 600 ms went by, and the panel was read
   * whenever that landed. On a fast laptop the double had usually finished; in
   * a full-suite run on a loaded machine it had not, and J13 read an empty tool
   * list off a turn that was still arriving. That is the same shape as the
   * coverage table: a read racing a write, waiting on a duration rather than on
   * a state.
   *
   * The app publishes the state. Every conversation's own record says whether
   * its runtime is still running and whether its turn's event bus is still
   * open, and a turn that is holding an approval card is *deliberately* still
   * running — so the card short-circuits, because that is a terminal state too:
   * the app is waiting for the person, not for itself.
   */
  const theTurnHasStoppedMoving = async (): Promise<void> => {
    await expect.poll(async () => {
      if (await win().getByTestId('permission-card').count() > 0) return true;
      const { sessions } = await session.api<{ sessions: { id: number }[] }>(
        'GET', '/api/assistant/sessions',
      );
      if (!sessions.length) return false;
      for (const saved of sessions) {
        const one = await session.api<{ running?: boolean;
          activity_observation?: { turn_claimed?: boolean } }>(
          'GET', `/api/assistant/sessions/${saved.id}`,
        );
        if (one.running || one.activity_observation?.turn_claimed) return false;
      }
      return true;
    }, { timeout: 120_000, message: 'the assistant never finished its turn' }).toBe(true);
    // The turn is over on the backend; the last event still has to reach the
    // panel. This is the one place a short settle is right — it is bounded by a
    // fact rather than standing in for one.
    await expect.poll(
      async () => win().locator('.assistant-thinking').count(),
      { timeout: 30_000 },
    ).toBe(0);
  };

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


  /**
   * Fold away the floating panel that the last finished run leaves expanded.
   *
   * A person would too, or would wait for it. It sits over the top-left of the
   * form, and the second run of a journey that runs twice cannot reach the
   * keyword row underneath it — Playwright's own words for it were "intercepts
   * pointer events", 60 retries deep, which is a half-minute of nothing before
   * a timeout that names a button rather than the thing covering it.
   */
  const standDownTheCompletionWidget = async (): Promise<void> => {
    const widget = win().locator('.floating-widget--expanded');
    if (!await widget.count()) return;
    // Its own close button, which is what a person would reach for.
    await widget.locator('.fw-close-btn').first().click().catch(() => { /* already gone */ });
    await expect(widget).toHaveCount(0, { timeout: 15_000 });
  };

  /* ---------------------------------------------------------------------- *
   *  Slice 2b's helpers. The reading queue's route is not in `PLACES` because
   *  nothing above it takes a `Place` for it, and widening that union is an
   *  edit to a line slice 2a is also standing on.
   * ---------------------------------------------------------------------- */

  /** Open a run's Papers tab — a deep link, which is how the run viewer opens one. */
  const openPapersTab = async (run: RunHandle): Promise<void> => {
    await win().evaluate((h) => { window.location.hash = h; }, `#/results?exec=${run.id}&tab=papers`);
    // A reload rather than a hash change: the run viewer reads `exec` and `tab`
    // when it mounts, and it is already mounted on whatever the last row was.
    await win().reload();
    await win().locator('.app-main').waitFor({ state: 'visible', timeout: 60_000 });
    await expect(win().getByTestId('execution-papers')).toBeVisible({ timeout: 60_000 });
  };

  /** The reading queue under one of the page's own three filters. */
  const readQueueUnder = async (
    filter: 'to read' | 'read' | 'all',
  ): Promise<QueuedPaper[]> => {
    await goto('/reading-queue');
    const key = { 'to read': 'to_read', read: 'read', all: 'all' }[filter];
    const control = win().getByTestId(`filter-${key}`);
    await expect(control).toBeVisible({ timeout: 30_000 });
    await control.click();
    await expect(control).toHaveAttribute('aria-pressed', 'true', { timeout: 15_000 });
    // Either a list or the page's own "nothing here" card — never neither, and
    // waiting for one of the two is what stops a read landing mid-fetch and
    // reporting an empty queue that is really an unfinished one.
    await expect
      .poll(async () => (await win().locator('.reading-item').count())
        + (await win().getByTestId('queue-empty').count()), { timeout: 30_000 })
      .toBeGreaterThan(0);
    const rows = win().locator('.reading-item');
    const out: QueuedPaper[] = [];
    for (let i = 0; i < await rows.count(); i += 1) {
      const row = rows.nth(i);
      const id = Number(String(await row.getAttribute('data-testid')).replace('paper-', ''));
      out.push({
        id,
        title: (await row.locator('.reading-item-title').innerText()).trim(),
        state: (await row.getByTestId(`state-${id}`).innerText()).trim(),
      });
    }
    return out;
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

  /** The id of the routine with this name, from the routine list itself. */
  const routineIdNamed = async (name: string): Promise<number> => {
    const routines = await session.api<Record<string, any>[]>('GET', '/api/routines');
    const found = routines.find((r) => r.name === name);
    expect(found, `no routine named ${name}`).toBeTruthy();
    return Number(found!.id);
  };

  /**
   * Open the delivery record on the Routines page.
   *
   * The panel lives in a row of its own under each routine and every one of
   * them carries the same `delivery-toggle`, so this refuses to guess when
   * there is more than one. A journey that needed two routines would need a
   * per-routine handle first, and picking the first of several silently is how
   * a row ends up asserting about the wrong one.
   */
  const openDeliveryPanel = async (): Promise<void> => {
    await goto(PLACES.Routines);
    const toggles = win().locator('[data-testid="delivery-toggle"]');
    await expect(toggles.first()).toBeVisible({ timeout: 30_000 });
    expect(
      await toggles.count(),
      'more than one routine is on this page, and the delivery panels cannot be told apart',
    ).toBe(1);
    if (!await win().getByTestId('delivery-body').count()) await toggles.first().click();
    await expect(win().getByTestId('delivery-body')).toBeVisible({ timeout: 30_000 });
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
      await standDownTheCompletionWidget();
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
      if (request.summarize) {
        await win().locator('label.checkbox-label')
          .filter({ hasText: 'Enable AI Summarization' })
          .locator('input[type="checkbox"]')
          .check();
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
      await standDownTheCompletionWidget();
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
      // Every row in one pass, rather than `count()` and then `nth(i)` a cell
      // at a time. The wait above is what stops the table being replaced under
      // this read; taking the whole table in a single turn of the renderer's
      // event loop is what makes that no longer something to get right twice.
      return win().evaluate(() => Array.from(
        document.querySelectorAll('.coverage-table tbody tr'),
        (row) => {
          const cells = Array.from(row.querySelectorAll('td'), (c) => (c.textContent ?? '').trim());
          return { source: cells[0] ?? '', label: cells[1] ?? '', note: cells[4] ?? '' };
        },
      ));
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
      // Through the API, and the reason is worth writing down. The user path is
      // the routine editor's own "What this routine is really looking for"
      // field, and `e2e/routine-intent.spec.ts` drives exactly that. What this
      // row is about is the *audit's* response to an intent existing, so the
      // shortest honest way to put one there is the same request the editor
      // makes. The spec's ledger records that the editor was not exercised here.
      const routines = await backend.routines();
      const routine = routines.find((r) => r.name === name);
      expect(routine, `no routine named ${name}`).toBeTruthy();
      await session.api('PUT', `/api/routines/${routine!.id}`, { intent });
      // The panel caches per routine and is invalidated by a save made through
      // the editor; a save made behind it is not seen until the page remounts.
      await goto(PLACES.Explorer);
      await goto(PLACES.Routines);
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
      // "Not checking any more" is not "has an answer". The panel caches per
      // routine and refetches on a remount, and between the two the body is a
      // rendered-but-empty box — which read as an intent of '' and failed a
      // comparison with a message naming the intent rather than the wait.
      await expect
        .poll(async () => (
          await win().getByTestId('coverage-intent').count()
          + await win().getByTestId('coverage-reason').count()
        ), { timeout: 60_000, message: 'the coverage panel settled with neither an intent nor a reason' })
        .toBeGreaterThan(0);
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
      // Away and back, not straight there. The page reads the credential state
      // once when it mounts, and a hash change to the route it is already on
      // does not remount it — so a field read immediately after a key was saved
      // would show the state the page was given before the save.
      await goto(PLACES.Explorer);
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
      // Only if it is shut. The trigger is replaced by the panel while the
      // panel is open, so a second turn in one journey has nothing to click.
      if (!await win().getByTestId('assistant-panel').count()) {
        await win().getByTestId('assistant-trigger').click();
      }
      const panel = win().getByTestId('assistant-panel');
      await expect(panel).toBeVisible({ timeout: 30_000 });
      const composer = win().getByLabel('Message the assistant');
      await expect(composer, 'the assistant is not available in this app').toBeEnabled({ timeout: 30_000 });
      await composer.fill(text);
      await win().getByRole('button', { name: 'Send', exact: true }).click();
      await theTurnHasStoppedMoving();
      return readAssistantPanel();
    },

    answerTheApprovalCard: async (allow): Promise<AssistantTurn> => {
      const card = win().getByTestId('permission-card').first();
      await expect(card, 'the assistant is holding no approval card').toBeVisible({ timeout: 30_000 });
      const answered = win().waitForResponse((r) => r.url().includes('/api/assistant/permissions/'));
      await card.getByRole('button', { name: allow ? 'Allow' : 'Deny', exact: true }).click();
      expect((await answered).ok(), 'the answer to the approval card was refused').toBe(true);
      await theTurnHasStoppedMoving();
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

    /* ====================================================================== *
     *  Slice 2b. Appended rather than interleaved: slice 2a is adding its own
     *  verbs to this same file on its own branch, and nothing above this line
     *  changed meaning.
     * ====================================================================== */

    // — the reading queue (J28) ---------------------------------------------

    savePapersFromRun: async (run): Promise<QueuedPaper[]> => {
      await openPapersTab(run);
      const cards = win().locator('.reading-papers .reading-item');
      await expect(cards.first()).toBeVisible({ timeout: 30_000 });
      const saved: QueuedPaper[] = [];
      for (let i = 0; i < await cards.count(); i += 1) {
        const card = cards.nth(i);
        const id = Number(String(await card.getAttribute('data-testid')).replace('paper-', ''));
        const title = (await card.locator('.reading-item-title').innerText()).trim();
        // The badge, not the click, is the receipt: `ExecutionPapers` renders
        // `queue_status` as the server returned it, so waiting for the badge is
        // waiting for the backend rather than for a piece of optimistic state.
        await card.getByTestId(`save-${id}`).click();
        await expect(card.getByTestId(`saved-${id}`)).toBeVisible({ timeout: 30_000 });
        saved.push({ id, title, state: 'To read' });
      }
      return saved;
    },

    readReadingQueue: (filter) => readQueueUnder(filter),

    markPaperRead: async (paper) => {
      await readQueueUnder('all');
      await win().getByTestId(`toggle-${paper.id}`).click();
      await expect(win().getByTestId(`state-${paper.id}`)).toHaveText('Read', { timeout: 30_000 });
    },

    removeFromReadingQueue: async (paper) => {
      await readQueueUnder('all');
      await win().getByTestId(`remove-${paper.id}`).click();
      await expect(win().getByTestId(`paper-${paper.id}`)).toHaveCount(0, { timeout: 30_000 });
    },

    exportReadingQueue: async (papers, format) => {
      await readQueueUnder('all');
      for (const paper of papers) await win().getByTestId(`select-${paper.id}`).check();
      const label = { bibtex: 'BibTeX', ris: 'RIS', csv: 'CSV' }[format];
      const extension = { bibtex: 'bib', ris: 'ris', csv: 'csv' }[format];
      const destination = path.join(session.stateDir, `journey-queue.${extension}`);
      // The real Electron download with only the destination picker replaced,
      // exactly as `exportReferences` does it above.
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

    readExplorerTitles: async () => {
      await goto(PLACES.Explorer);
      const items = win().locator('li.explorer-item');
      await expect(items.first()).toBeVisible({ timeout: 30_000 });
      return (await items.locator('h3').allInnerTexts()).map((t) => t.trim());
    },

    // — the local API's own boundary (J42) ----------------------------------

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

    observeOwnRequests: async (place): Promise<ObservedRequest[]> => {
      const seen: ObservedRequest[] = [];
      const watch = (request: { url(): string; headers(): Record<string, string> }): void => {
        if (/^http:\/\/127\.0\.0\.1:\d+\/api\//.test(request.url())) {
          seen.push({ url: request.url(), authorization: request.headers().authorization ?? null });
        }
      };
      win().on('request', watch);
      try {
        await goto(PLACES[place]);
        await expect.poll(() => seen.length, { timeout: 30_000 }).toBeGreaterThan(0);
        // The page goes on asking after the first answer; a moment here means
        // the list is what the page really sent rather than its first request.
        await win().waitForTimeout(1_000);
      } finally {
        win().off('request', watch);
      }
      return seen;
    },

    // — delivery (J40) ------------------------------------------------------

    addDeliveryTarget: async (routine, target) => {
      const id = await routineIdNamed(routine);
      // A folder and a feed destination are both refused unless the directory
      // already exists — `_deliver_folder` will not create one, deliberately,
      // because a mistyped path that silently succeeds is worse than one that
      // reports itself. So the journey makes the folder a person would have
      // chosen, inside this session's own state directory.
      let destination = target.destination ?? '';
      if (!destination && target.channel !== 'webhook') {
        destination = path.join(session.stateDir, `delivery-${target.channel}`);
        fs.mkdirSync(destination, { recursive: true });
      }
      const created = await session.api<{ id: number }>(
        'POST', `/api/routines/${id}/delivery-targets`,
        { channel: target.channel, target: destination, mode: target.mode ?? 'automatic', enabled: true },
      );
      return { id: created.id, channel: target.channel, destination };
    },

    readDeliveryRecord: async (routine): Promise<DeliveryRecord[]> => {
      const id = await routineIdNamed(routine);
      // Wait on the record, not on a screen: the drain is a worker thread and
      // a panel read while a row is still `queued` would be a snapshot of a
      // delivery in flight rather than of where the report went.
      let recorded: Record<number, string> = {};
      await expect.poll(async () => {
        const record = await session.api<{ deliveries: Record<string, any>[] }>(
          'GET', `/api/routines/${id}/deliveries`,
        );
        recorded = Object.fromEntries(record.deliveries.map((row) => [Number(row.id), String(row.state)]));
        return record.deliveries.length > 0
          && record.deliveries.every((row) => !['queued', 'delivering'].includes(String(row.state)));
      }, { timeout: 120_000 }).toBe(true);

      await openDeliveryPanel();
      const rows = win().locator('[data-testid^="delivery-row-"]');
      await expect(rows.first()).toBeVisible({ timeout: 30_000 });
      const out: DeliveryRecord[] = [];
      for (let i = 0; i < await rows.count(); i += 1) {
        const cells = rows.nth(i).locator('td');
        const rowId = Number(String(await rows.nth(i).getAttribute('data-testid')).replace('delivery-row-', ''));
        out.push({
          id: rowId,
          channel: (await cells.nth(1).locator('.delivery-channel').innerText()).trim(),
          state: (await cells.nth(2).innerText()).trim(),
          recorded: recorded[rowId] ?? '',
          detail: (await cells.nth(4).innerText()).trim(),
        });
      }
      return out;
    },

    skipDelivery: async (routine, delivery) => {
      await openDeliveryPanel();
      const row = win().getByTestId(`delivery-row-${delivery.id}`);
      await expect(row).toBeVisible({ timeout: 30_000 });
      await row.getByRole('button', { name: 'Skip', exact: true }).click();
      await expect(row.locator('.badge')).not.toHaveText(delivery.state, { timeout: 30_000 });
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

    // — an external harness (J44) -------------------------------------------

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

    // — slice 3 ---------------------------------------------------------------

    askForThisRoutineToRunNow: async (name): Promise<RunNowAnswer> => {
      const routines = await backend.routines();
      const routine = routines.find((r) => r.name === name);
      expect(routine, `no routine named ${name}`).toBeTruthy();
      // `session.api` throws on anything but 2xx, and a refusal is the answer
      // this row is about — so the whole answer is taken here, status, headers
      // and body, through the app's own transport and the app's own token. The
      // header is read rather than the prose because the app publishes the kind
      // of refusal separately from the sentence, and there are two different
      // 409s on this route: the routine is already running, and resmon is
      // already running as many executions as it allows.
      return win().evaluate(async (routineId) => {
        const port = (window as unknown as { resmonAPI: { getBackendPort(): string } })
          .resmonAPI.getBackendPort();
        const response = await e2eFetch(`http://127.0.0.1:${port}/api/routines/${routineId}/run`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: '{}',
        });
        const text = await response.text();
        let parsed: any = null;
        try { parsed = text ? JSON.parse(text) : null; } catch { parsed = null; }
        if (response.ok) {
          return { run: { id: Number(parsed?.execution_id) }, refusal: '', refusalKind: '' };
        }
        return {
          run: null,
          refusal: String(parsed?.detail ?? text),
          // Usually '': see `RunNowAnswer.refusalKind`. Read rather than
          // assumed, so the day the backend starts exposing it this stops
          // being a limit without anybody editing a comment.
          refusalKind: response.headers.get('X-Resmon-Conflict') || '',
        };
      }, routine!.id);
    },

    useAnAuthoredSummarizerThatIsNotSignedIn: async () => {
      // The summarization lane runs `claude -p --output-format json …` and
      // reads one JSON envelope off stdout. A CLI whose OAuth session has
      // lapsed answers with `is_error` set and says so in `result`, and exits
      // zero doing it — which is why the lane keys on the field rather than on
      // the status. This is that envelope, byte for byte as
      // `test_llm_subscription.py` recorded it from the real CLI.
      const command = path.join(session.stateDir, 'authored-summarizer');
      fs.writeFileSync(command, '#!/bin/sh\ncat <<\'JSON\'\n'
        + JSON.stringify({
          is_error: true,
          subtype: 'success',
          terminal_reason: 'api_error',
          result: 'Failed to authenticate: OAuth session expired and could not be refreshed',
          type: 'result',
        })
        + '\nJSON\n', { mode: 0o755 });
      // Through the settings the page writes, not around them: `ai_cli_path` is
      // only consulted for the provider `ai_provider` names, so both have to be
      // set or the lane looks for the binary in the usual places instead — and
      // on a developer's Mac it might find a real one.
      await session.api('PUT', '/api/settings/ai', {
        settings: { ai_provider: 'claude_code', ai_cli_path: command, ai_model: 'sonnet' },
      });
    },

    readAiLaneStatus: async () => {
      await goto(PLACES['AI settings']);
      const status = win().locator('[data-testid^="primary-cli-status-"]');
      if (!await status.count()) return '';
      return (await status.first().innerText()).replace(/\s+/g, ' ').trim();
    },

    readRunLog: async (run) => {
      await openResultsRow(run);
      await win().locator('.report-viewer .tab-bar .tab-btn', { hasText: 'Log' }).first().click();
      const text = win().locator('.report-viewer-body');
      await expect(text).toBeVisible({ timeout: 30_000 });
      return (await text.innerText()).trim();
    },

    readTheReport: async (run) => {
      await openResultsRow(run);
      await win().locator('.report-viewer .tab-bar .tab-btn', { hasText: 'Report' }).first().click();
      const text = win().locator('.report-viewer-body');
      await expect(text).toBeVisible({ timeout: 30_000 });
      return (await text.innerText()).trim();
    },

    configureEmail: async (settings, password) => {
      await goto(PLACES['Email settings']);
      const field = (label: string) => win().locator('.settings-form .form-field')
        .filter({ has: win().locator('.form-label', { hasText: label }) })
        .locator('input').first();
      await field('SMTP Server').fill(settings.server);
      await field('SMTP Port').fill(settings.port);
      await field('Username').fill(settings.username);
      await field('Sender Email').fill(settings.sender);
      await field('Recipient Email(s)').fill(settings.recipients);
      // The password is not a setting: it goes to the machine's own credential
      // store, by its own button, and only the fact of it comes back.
      await field('SMTP Password').fill(password);
      const stored = win().waitForResponse(
        (r) => r.url().includes('/api/credentials/smtp_password'),
      );
      await win().locator('.key-input-row button', { hasText: /^(Store|Replace)$/ }).click();
      expect((await stored).ok(), 'the SMTP password was refused by the credential store').toBe(true);
      const saved = win().waitForResponse(
        (r) => r.url().endsWith('/api/settings/email') && r.request().method() === 'PUT',
      );
      await win().locator('.form-actions button', { hasText: 'Save' }).first().click();
      expect((await saved).ok(), 'Settings → Email refused the save').toBe(true);
    },

    readEmailSettings: async (): Promise<EmailSettings> => {
      await goto(PLACES['Email settings']);
      const field = (label: string) => win().locator('.settings-form .form-field')
        .filter({ has: win().locator('.form-label', { hasText: label }) })
        .locator('input').first();
      await expect(field('SMTP Server')).toBeVisible({ timeout: 30_000 });
      return {
        server: await field('SMTP Server').inputValue(),
        port: await field('SMTP Port').inputValue(),
        username: await field('Username').inputValue(),
        sender: await field('Sender Email').inputValue(),
        recipients: await field('Recipient Email(s)').inputValue(),
      };
    },

    sendATestEmail: async () => {
      await goto(PLACES['Email settings']);
      const answered = win().waitForResponse((r) => r.url().endsWith('/api/settings/email/test'));
      await win().locator('.form-actions button', { hasText: 'Send Test Email' }).click();
      await answered;
      // The page clears this line after a few seconds, so it is read as soon as
      // it appears rather than after the next navigation.
      const line = win().locator('.settings-form .form-error, .settings-form .form-success');
      await expect(line.first()).toBeVisible({ timeout: 60_000 });
      return (await line.first().innerText()).replace(/\s+/g, ' ').trim();
    },

    setNotificationPreferences: async (preferences) => {
      await goto(PLACES['Notification settings']);
      const manual = win().locator('label.form-check')
        .filter({ hasText: 'Notify me when a manual execution completes' })
        .locator('input[type="checkbox"]');
      await expect(manual).toBeVisible({ timeout: 30_000 });
      await manual.setChecked(preferences.whenIRunSomethingMyself);
      const choice = {
        all: 'All automatic routines',
        selected: 'Only selected routines',
        none: 'None',
      }[preferences.forAutomaticRoutines];
      await win().locator('label.form-check').filter({ hasText: choice })
        .locator('input[type="radio"]').check();
      const saved = win().waitForResponse(
        (r) => r.url().endsWith('/api/settings/notifications') && r.request().method() === 'PUT',
      );
      await win().locator('button', { hasText: /^Save/ }).first().click();
      expect((await saved).ok(), 'Settings → Notifications refused the save').toBe(true);
    },

    readNotificationPreferences: async (): Promise<NotificationPreferences> => {
      await goto(PLACES['Notification settings']);
      const manual = win().locator('label.form-check')
        .filter({ hasText: 'Notify me when a manual execution completes' })
        .locator('input[type="checkbox"]');
      await expect(manual).toBeVisible({ timeout: 30_000 });
      const modes = [
        ['all', 'All automatic routines'],
        ['selected', 'Only selected routines'],
        ['none', 'None'],
      ] as const;
      let chosen: NotificationPreferences['forAutomaticRoutines'] = 'none';
      for (const [value, label] of modes) {
        const radio = win().locator('label.form-check').filter({ hasText: label })
          .locator('input[type="radio"]');
        if (await radio.isChecked()) chosen = value;
      }
      return {
        whenIRunSomethingMyself: await manual.isChecked(),
        forAutomaticRoutines: chosen,
      };
    },

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

    readTheChatsPage: async () => {
      await goto(PLACES.Chats);
      const list = win().getByRole('region', { name: 'Saved chats' });
      await expect(list).toBeVisible({ timeout: 30_000 });
      return (await list.locator('li strong').allInnerTexts()).map((t) => t.trim());
    },

    openTheSavedChat: async (titleFragment): Promise<SavedTranscript> => {
      await goto(PLACES.Chats);
      const list = win().getByRole('region', { name: 'Saved chats' });
      const row = list.locator('li button').filter({ hasText: titleFragment }).first();
      await expect(row, `no saved chat whose title contains "${titleFragment}"`)
        .toBeVisible({ timeout: 30_000 });
      await row.click();
      const transcript = win().getByRole('region', { name: 'Saved transcript' });
      const heading = transcript.getByRole('heading').first();
      await expect(heading).toBeVisible({ timeout: 30_000 });
      return {
        title: (await heading.innerText()).trim(),
        said: (await transcript.locator('.assistant-bubble').allInnerTexts())
          .map((t) => t.trim()),
        text: (await transcript.innerText()).replace(/\s+/g, ' ').trim(),
      };
    },

    exportTheOpenChat: async (format) => {
      const destination = path.join(session.stateDir, `journey-chat.${format === 'json' ? 'json' : 'md'}`);
      await session.app.evaluate(({ BrowserWindow }, target) => {
        BrowserWindow.getAllWindows()[0].webContents.session.once('will-download', (_e, item) => {
          item.setSavePath(target as string);
        });
      }, destination);
      const label = format === 'json' ? 'Export JSON' : 'Export Markdown';
      await win().getByRole('region', { name: 'Saved transcript' })
        .getByRole('button', { name: label, exact: true }).click();
      await expect.poll(() => fs.existsSync(destination), { timeout: 30_000 }).toBe(true);
      await expect.poll(() => fs.statSync(destination).size, { timeout: 30_000 }).toBeGreaterThan(0);
      return fs.readFileSync(destination, 'utf8');
    },

    openTheAssistantWithTheKeyboard: async () => {
      await goto('/');
      // The shortcut the app documents, on the modifier this platform uses.
      await win().keyboard.press(process.platform === 'darwin' ? 'Meta+Slash' : 'Control+Slash');
      const panel = win().getByTestId('assistant-panel');
      try {
        await expect(panel).toBeVisible({ timeout: 15_000 });
        return true;
      } catch {
        // Reported, not thrown: whether the keyboard alone opens it is the
        // row's question, and a driver that threw would turn a finding into a
        // stack trace.
        return false;
      }
    },

    readTheAssistantPanel: async (): Promise<AssistantPanelFacts> => {
      const panel = win().getByTestId('assistant-panel');
      const open = (await panel.count()) > 0 && await panel.isVisible();
      if (!open) {
        return {
          open: false, composerIsNamed: '', composerIsUsable: false, insideTheWindow: false,
          geometry: { panel: { x: 0, y: 0, width: 0, height: 0 }, window: { width: 0, height: 0 } },
          errorRoles: [],
        };
      }
      const composer = win().getByLabel('Message the assistant');
      const box = (await panel.boundingBox()) ?? { x: 0, y: 0, width: 0, height: 0 };
      const viewport = await win().evaluate(() => ({
        width: window.innerWidth, height: window.innerHeight,
      }));
      const errorRoles = await win().locator('.assistant-error').evaluateAll(
        (nodes) => nodes.map((node) => (node as HTMLElement).getAttribute('role') || ''),
      );
      return {
        open: true,
        composerIsNamed: String(await composer.getAttribute('aria-label') ?? ''),
        composerIsUsable: (await composer.count()) > 0 && await composer.isEnabled(),
        insideTheWindow: box.x >= 0 && box.y >= 0
          && box.x + box.width <= viewport.width + 1
          && box.y + box.height <= viewport.height + 1,
        geometry: { panel: box, window: viewport },
        errorRoles: errorRoles.filter((role) => role !== ''),
      };
    },

    useAnAuthoredProviderOnAKey: async ({ answer, key, model }) => {
      provider = await startProviderEndpoint(answer);
      session.alsoCloseOnClose(() => provider!.close());
      // Two settings groups, because they are two different questions: which
      // endpoint the app talks to, and which lane the assistant runs in. Both
      // through the routes the AI tab writes.
      await session.api('PUT', '/api/settings/ai', {
        settings: { ai_provider: 'custom', ai_custom_base_url: provider.url },
      });
      await session.api('PUT', '/api/settings/assistant', {
        settings: {
          assistant_runtime: 'api_key',
          assistant_provider: 'custom',
          assistant_model: model,
          assistant_effort: '',
        },
      });
      // The panel reads the lane when the window opens, so the window has to
      // see it. Reopening is what a person would do, and it also proves the
      // settings survived being written.
      await session.relaunch();
      // The credential goes to the credential store, not to the settings
      // database — the same route the API Key field's Store button posts to.
      // **After the relaunch, and that is not an ordering preference.** This
      // suite's keyring is an in-memory backend inside the backend process, so
      // it dies with that process; a credential stored before the relaunch
      // would be gone by the time the lane looked for it, and the row would
      // fail for a reason that belongs to the fixture rather than to the app.
      await session.api('PUT', '/api/credentials/custom_llm_api_key', { value: key });
    },

    readWhatTheProviderReceived: async (): Promise<ProviderRequest[]> => {
      expect(provider, 'this journey never started an authored provider').toBeTruthy();
      return provider!.calls().map((call) => ({
        path: call.path,
        authorization: call.authorization,
        model: call.model,
        body: call.body,
      }));
    },

    readAssistantSettings: async () => session.api('GET', '/api/settings/assistant'),

    runNowControlIsOnTheRow: async (name) => {
      await goto(PLACES.Routines);
      const routines = await backend.routines();
      const routine = routines.find((r) => r.name === name);
      expect(routine, `no routine named ${name}`).toBeTruthy();
      const row = win().locator('.simple-table tbody tr').filter({ hasText: name }).first();
      await expect(row).toBeVisible({ timeout: 30_000 });
      return (await win().getByTestId(`run-now-${routine!.id}`).count()) > 0;
    },
  };
}
