/**
 * The journey driver for the renderer resmon ships today.
 *
 * This is the only file in the suite that knows a class name, a hash route or
 * the text on a button. Everything above it is written in the words of the
 * parity register, and everything below it is a real Electron process over a
 * real backend. When the 3.0 renderer exists, the work is one more file of this
 * shape — not forty-five rewritten specs.
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
import * as os from 'os';
import * as path from 'path';
import { execFileSync, spawnSync } from 'child_process';
import * as http from 'http';
import * as net from 'net';
import { createHash } from 'crypto';
import { pathToFileURL } from 'url';
import { _electron as electron, expect } from '@playwright/test';
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
import type { EmbeddingBackfill, EmbeddingProviderChoice } from '../driver';
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
// Slice 4's, in its own import for the same reason.
import type { ComposerChoice, LibraryItem, TurnChoiceFacts, VaultOnDisk } from '../driver';
// The saved-configuration round trip's own shapes, in their own import for the same reason.
import type { ImportOutcome } from '../driver';
import { startProviderEndpoint } from '../fixtures/provider-endpoint';
import type { ProviderEndpoint } from '../fixtures/provider-endpoint';
// The register refresh's, in its own import for the same reason.
import type {
  EvidenceBundle, EvidencePageView, ExportedFile, OfflineDocument, OpenedCitation, ReopenedPassage,
  SavedEvidenceNote, SelectedAnswerPreview, SelectedAnswerView, SourceWallCellView, SourceWallReading,
  SourceWallView, StoredAnswer, StoredEvidenceNote, StoredSourceWall,
} from '../driver';
import { startSelectedAnswerEndpoint } from '../fixtures/selected-answer-endpoint';
import type { SelectedAnswerEndpoint } from '../fixtures/selected-answer-endpoint';
import type { Session } from './session';

/**
 * The places only the Atlas interface has. The classic renderer has nowhere to
 * take a person for them, so its driver answers them by skipping the journey
 * and saying why, never by going somewhere else.
 */
type AtlasOnlyPlace = 'Today' | 'Appearance settings';
const ATLAS_ONLY: readonly Place[] = ['Today', 'Appearance settings'];

/** The hash behind each place in the sidebar. The only route table in the suite. */
const PLACES: Record<Exclude<Place, AtlasOnlyPlace>, string> = {
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
  // — the register refresh --------------------------------------------------
  Library: '/library',
  Evidence: '/evidence',
  'Source wall': '/source-wall',
};

/** `YYYY-MM-DD`, in the machine's own timezone, as the date inputs want it. */
function isoDate(at: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}`;
}

/**
 * A name as a literal inside a regular expression.
 *
 * Source and file names are what this driver matches most, and they carry the
 * characters a pattern treats specially: a file name has a dot in it, and `.`
 * matches anything.
 */
function literally(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function createClassicDriver(session: Session, testInfo: TestInfo): JourneyDriver {
  const win = () => session.win;

  /** The authored model provider, once a journey has asked for one. */
  let provider: ProviderEndpoint | null = null;

  /**
   * The landmark a place publishes once React Router — not the address bar —
   * has actually arrived there.
   *
   * Both halves are `NavLink`s, and a `NavLink` takes its class from the
   * router's own `useLocation`. So this is not "something that page happens to
   * draw": it is the router saying which route is mounted, in the markup. The
   * sidebar's entry carries `active` for the place, and a Settings or About tab
   * carries `tab-active` for the tab within it — which is the difference
   * between `/settings/email` and `/settings/advanced`, both of which are the
   * same sidebar entry and the same `<h1>`.
   *
   * A query string is not part of the route (`/explorer?q=…` is the Explorer),
   * so it is dropped before the lookup.
   */
  const landmarksFor = (hash: string): string[] => {
    const route = hash.split('?')[0];
    const section = route.startsWith('/settings/') ? '/settings'
      : route.startsWith('/about-resmon/') ? '/about-resmon'
        : route;
    const landmarks = [`.sidebar-nav a.sidebar-link.active[href="#${section}"]`];
    if (section !== route) landmarks.push(`.settings-nav a.tab-active[href="#${route}"]`);
    return landmarks;
  };

  const goto = async (hash: string): Promise<void> => {
    // A HashRouter change is not a document navigation, so setting the hash is
    // what a sidebar click does; `goto` against the same document would not
    // drive React Router at all.
    await win().evaluate((h) => { window.location.hash = `#${h}`; }, hash);
    await win().locator('.app-main').waitFor({ state: 'visible', timeout: 30_000 });
    // **Reading the hash back is not arriving.** It proves the write landed in
    // the document — including a document that is about to be replaced, which
    // is what the slice-3 reviewer watched happen: J23 set `#/settings/email`
    // just after `reopenTheApp()`, the read-back passed, the relaunched window
    // came up on the Dashboard, and the row then spent thirty seconds waiting
    // for a field on a page it was not on. The trailing 400 ms sleep that used
    // to end this function covered that on a quiet laptop and did not under a
    // full-suite load: the last duration-based wait in the driver, and the same
    // shape as every flake this suite has already paid for.
    //
    // So the wait is for the destination's own landmark instead. If the hash
    // was lost the class never appears and the failure names the route rather
    // than a control on it.
    for (const landmark of landmarksFor(hash)) {
      await expect(
        win().locator(landmark),
        `the app never arrived at ${hash}: nothing matched ${landmark}`,
      ).toHaveCount(1, { timeout: 30_000 });
    }
    await win().waitForLoadState('networkidle').catch(() => { /* the long-poll pages never idle */ });
  };

  /**
   * Wait until the app has **stored** what the click asked for.
   *
   * This is the readiness predicate for every write in this driver, and it is
   * deliberately not a screen assertion. A screen assertion after a write is
   * only sound when the state it names could not already have been true, and
   * the suite has now paid twice for one that could: `activateRoutine` waited
   * for a `.badge` matching `hasText: 'Active'`, and Playwright's `hasText`
   * string form is a **case-insensitive substring** — so "Inactive", the badge
   * that was already on the row, satisfied it. The wait returned in the same
   * millisecond as the click, the spec's very next line read the badge, and
   * J03 failed in three seconds against a healthy seven-second run. Five red
   * Journeys jobs across four branches, one of them on a pull request whose
   * whole content was a word in a markdown file, and three people each spent
   * half an hour ruling out their own diff.
   *
   * The record cannot be satisfied early in that way: it is what the write
   * produced, read back from the app's own API. So a write settles in two
   * steps — the record first, then the screen agreeing with it — and the
   * second step is written so that it, too, is false before the write.
   *
   * The project learned this shape expensively somewhere else: text visible in
   * a textarea was once treated as proof that a note had been saved.
   */
  const stored = async <T>(
    what: string,
    read: () => Promise<T>,
    holds: (value: T) => boolean,
    timeout = 30_000,
  ): Promise<void> => {
    await expect
      .poll(async () => holds(await read()), { timeout, message: `the app never recorded ${what}` })
      .toBe(true);
  };

  /** One routine's record, by the name a person gave it. */
  const routineRecord = async (name: string): Promise<Record<string, any>> => {
    const routines = await session.api<Record<string, any>[]>('GET', '/api/routines');
    const found = routines.find((r) => r.name === name);
    expect(found, `no routine named ${name}`).toBeTruthy();
    return found!;
  };

  /**
   * One tab of the report viewer, read only once the app has put something in
   * it. See `readRunLog` for why the visible body is not that moment.
   */
  const readViewerTab = async (
    run: RunHandle, tab: 'Log' | 'Report', emptySentence: string,
  ): Promise<string> => {
    await openResultsRow(run);
    const button = win().locator('.report-viewer .tab-bar .tab-btn', { hasText: tab }).first();
    await button.click();
    await expect(button, `the report viewer never switched to ${tab}`)
      .toHaveClass(/tab-active/, { timeout: 30_000 });
    const body = win().locator('.report-viewer-body');
    await expect(body).toBeVisible({ timeout: 30_000 });
    // The same request the viewer makes, and the same field it reads.
    const field = tab === 'Log' ? 'log_text' : 'report_text';
    const held = await session.api<Record<string, string>>(
      'GET', `/api/executions/${run.id}/${tab.toLowerCase()}`,
    ).catch(() => ({} as Record<string, string>));
    if (String(held[field] ?? '').trim().length > 0) {
      await expect(body, `the app holds a ${tab.toLowerCase()} for this run and the page shows none`)
        .not.toHaveText(emptySentence, { timeout: 30_000 });
    }
    return (await body.innerText()).trim();
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
    // **The head is on screen before the results are.** While the page is
    // fetching, that first paragraph says `Searching…`; the block itself is
    // there either way, so waiting for it to be visible is not waiting for the
    // list. Until slice 4 the gap was covered by `goto`'s trailing 400 ms, and
    // removing that left this read — a sixth of the kind the review found five
    // of — measuring an unfinished page. The page publishes its own loaded
    // state in that sentence, so this waits for it.
    await expect(head, 'the Explorer never finished searching')
      .not.toHaveText('Searching…', { timeout: 60_000 });
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
   *
   * **This is only a wait for a turn that has already begun.** A second ask
   * finds the session idle from the first, so "nothing is running" is true
   * before the backend has claimed the new turn — the same shape, one level
   * down. The callers therefore wait for the message request to be answered
   * before they call this at all, and that ordering is the reason this function
   * can be about *finishing* rather than about starting.
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
    // The turn is over on the backend. The panel's own indicator is then given
    // a bounded chance to catch up — and its failure to is **reported, not
    // thrown**, because it turns out not to be a wait at all.
    //
    // After a denied write, `.assistant-thinking` stays up for as long as this
    // is willing to watch it, over a session the backend reports as finished.
    // That is a finding about the panel rather than a reason to fail a row, and
    // a driver that threw here would fail J13 for a thing J13 is not about. The
    // authoritative terminal state is the one above, which the app publishes;
    // this line exists so that the disagreement is on the record every time it
    // happens rather than being smoothed over by a longer sleep.
    const caughtUp = await expect.poll(
      async () => win().locator('.assistant-thinking').count(),
      { timeout: 10_000 },
    ).toBe(0).then(() => true).catch(() => false);
    if (!caughtUp) {
      console.log('[journeys] NOT VERIFIED: the assistant panel was still showing its thinking '
        + 'indicator after the app itself reported the turn finished. The turn is settled — that '
        + 'is read from the conversation\'s own record — and the panel had not caught up.');
    }
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

  /** Every source's slug and the name the catalog gives it. */
  const catalogNames = async (): Promise<{ slug: string; name: string }[]> =>
    (await backend.sourceCatalog()).map((entry) => ({ slug: String(entry.slug), name: String(entry.name) }));

  /**
   * The slug for a source as a screen names it.
   *
   * `SourceOutcome.source` is a slug, and the run panel used to print one.
   * Since #219 it prints the catalog's name — `arXiv`, `Springer Nature` —
   * while the report's coverage table still prints the slug, so J19 and J29
   * compared `arXiv` with `arxiv` and failed on `main` over two surfaces that
   * agreed. A name the catalog does not know is returned as it was shown,
   * rather than guessed at.
   */
  const asSlug = (shown: string, entries: { slug: string; name: string }[]): string => (
    entries.some((entry) => entry.slug === shown)
      ? shown
      : (entries.find((entry) => entry.name === shown)?.slug ?? shown));

  /**
   * Fill in Deep Sweep's form: tick these sources, add the query as a keyword,
   * and set the cap where one is given.
   *
   * Shared by `runSweep` and `saveConfiguration`, which press different buttons
   * under the same form — and a configuration saved from a form filled some
   * other way would not be the one a person's sweep would have used.
   */
  const fillTheSweepForm = async (request: { sources: string[]; query: string; cap?: number }): Promise<void> => {
    // **A checkbox is found by either of the source's two names.** Since "The
    // app reads as one interface" (#219) the label carries the catalog's name —
    // `arXiv` — where it used to carry the slug, and the `^arxiv$` this matched
    // found nothing: J02, J19, J21, J29 and J38 each timed out on their first
    // tick, on `main`, for a form that was working. Both spellings are accepted
    // rather than the new one alone, because the classic leg launches a build
    // from before the rename and this checkout launches one after it, and in
    // both a person is ticking the same source.
    const entries = await catalogNames();
    for (const source of request.sources) {
      const name = entries.find((entry) => entry.slug === source)?.name ?? source;
      await win().locator('.repo-checkbox-grid label.checkbox-label')
        .filter({ hasText: new RegExp(`^(${literally(source)}|${literally(name)})$`) })
        .locator('input[type="checkbox"]')
        .check();
    }
    await win().locator('.keyword-input-row input').fill(request.query);
    await win().locator('.keyword-input-row button', { hasText: 'Add' }).click();
    if (request.cap !== undefined) {
      await win().locator('.range-row input[type="range"]').fill(String(request.cap));
    }
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

  /* ---------------------------------------------------------------------- *
   *  Slice 4's helpers.
   * ---------------------------------------------------------------------- */

  /** Where the recording shim writes what it was handed, once one is in place. */
  const agentArgumentLog = path.join(session.stateDir, 'authored-agent-arguments');

  /** The record separator the shim writes after each invocation's arguments. */
  const END_OF_INVOCATION = '--journey-end-of-invocation--';

  /**
   * Point Settings → AI at the repository's own agent-CLI double.
   *
   * A one-line shim around it, run under the same interpreter the backend uses,
   * written into this session's own state directory so it is removed with
   * everything else this run made.
   *
   * With `recordArguments`, the shim first appends every argument it was given
   * to a log and then execs the double unchanged. **NUL-separated**, because
   * the last argument is the person's own prompt and a prompt with a newline in
   * it would otherwise be read back as several arguments — which is precisely
   * the kind of silent corruption this row is about.
   */
  const pointTheAssistantAtTheDouble = async (
    options: { recordArguments: boolean },
  ): Promise<void> => {
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
    const record = options.recordArguments
      ? `{ for argument in "$@"; do printf '%s\\0' "$argument"; done; `
        + `printf '%s\\0' '${END_OF_INVOCATION}'; } >> "${agentArgumentLog}"\n`
      : '';
    fs.writeFileSync(command, `#!/bin/sh\n${record}exec "${python}" "${double}" "$@"\n`, { mode: 0o755 });
    await session.api('PUT', '/api/settings/ai', { settings: { ai_cli_path: command } });
    // The panel reads the lane when it opens, so the window has to see the
    // setting. Reopening is what a person would do, and it also proves the
    // setting survived being written.
    await session.relaunch();
  };

  /**
   * The parent folder this journey chose for its vault.
   *
   * Kept here rather than asked of the app, because the app does not publish
   * it: the status carries the child's label and not the root it sits under.
   * The driver knows it because the driver is what answered the picker.
   */
  let libraryParent: string | null = null;

  /**
   * Where the vault this app made actually is.
   *
   * The parent a person chose plus the label the app gave the child it
   * created — so nothing here guesses a directory name, and a name the app
   * changed would show up as a missing directory rather than as a quietly
   * different assertion.
   */
  const vaultDirectory = (): string => {
    expect(libraryParent, 'this journey never chose a parent folder for a Library').toBeTruthy();
    // Off the filesystem rather than out of the API, for two reasons. The
    // Library routes are guarded by a header this app sends for itself and
    // `session.api` does not, so asking them would mean widening the seam for
    // one row; and the row's whole claim is that the person owns a directory,
    // which is a question the directory answers. The contract says an existing
    // folder is never adopted, so exactly one child is the expected answer and
    // a second one is a finding rather than a tie to break.
    const children = fs.readdirSync(libraryParent!)
      .filter((entry) => entry.startsWith('resmon-library-'));
    expect(children, `the chosen parent ${libraryParent} holds no single managed vault`)
      .toHaveLength(1);
    return path.join(libraryParent!, children[0]);
  };

  /** Click the Library row with this name, and wait for its detail to be the one open. */
  const selectTheLibraryItem = async (name: string): Promise<void> => {
    await goto('/library');
    const row = win().getByRole('region', { name: 'Library files' })
      .locator('.library-item').filter({ hasText: name }).first();
    await expect(row, `the Library lists nothing called ${name}`).toBeVisible({ timeout: 60_000 });
    await row.click();
    await expect(win().getByRole('heading', { name, exact: true })).toBeVisible({ timeout: 30_000 });
  };

  /** The open item's own detail, as a person reads it. */
  const readLibraryDetail = async (): Promise<LibraryItem> => {
    const detail = win().getByRole('region', { name: 'Selected Library item' });
    await expect(detail).toBeVisible({ timeout: 30_000 });
    /** One `<dd>` by the `<dt>` beside it, which is how the detail is labelled. */
    const value = async (term: string): Promise<string> => (
      await detail.locator(`dt:text-is("${term}") + dd`).innerText()).trim();
    const associations = detail.locator('h3:text-is("Local paper associations") ~ ul li');
    return {
      name: (await detail.locator('h2').innerText()).trim(),
      mediaType: (await value('Retained format')).split('·')[0].trim(),
      sha256: await value('SHA256 of imported bytes'),
      fileId: await value('File'),
      versionId: await value('Immutable version'),
      associations: (await associations.allInnerTexts()).map((t) => t.trim()),
    };
  };

  /** The assistant panel, opened if a journey has not opened it already. */
  const assistantPanel = async () => {
    if (!await win().getByTestId('assistant-panel').count()) {
      await win().getByTestId('assistant-trigger').click();
    }
    const panel = win().getByTestId('assistant-panel');
    await expect(panel).toBeVisible({ timeout: 30_000 });
    return panel;
  };

  /**
   * What the composer's own three controls hold.
   *
   * Scoped to the panel rather than asked of the window: Settings → AI has a
   * field labelled `Model` too, and this row deliberately puts a different
   * value in each of them.
   */
  const readComposer = async (): Promise<ComposerChoice> => {
    const panel = await assistantPanel();
    const controls = panel.locator('fieldset.assistant-choices');
    // A direct child of the body: the same summary component is also drawn
    // inside every turn's own disclosure down in the transcript, and those are
    // a different claim about a different moment.
    const fixed = panel.locator('.assistant-body > .assistant-choice-summary');
    // One or the other, never neither — waiting for that is what stops a read
    // landing between the descriptor arriving and the panel drawing either.
    await expect
      .poll(async () => (await controls.count()) + (await fixed.count()), { timeout: 30_000 })
      .toBeGreaterThan(0);
    if (!await controls.count()) {
      return {
        stillChangeable: false,
        connection: '',
        model: '',
        effort: '',
        fixedAs: (await fixed.first().innerText()).trim(),
      };
    }
    const connection = panel.getByLabel('Connection', { exact: true });
    await expect(connection).toBeVisible({ timeout: 30_000 });
    const model = panel.getByLabel('Model', { exact: true });
    const effort = panel.getByLabel('Effort', { exact: true });
    // The API adapters have no effort at all, and the composer says so in a
    // sentence where the control would be. Reading the sentence keeps this
    // honest for both connections instead of reporting an empty string.
    const effortValue = (await effort.count())
      ? await effort.inputValue()
      : (await panel.getByText('Effort: Not supported by this adapter', { exact: true })
        .innerText()).trim();
    return {
      stillChangeable: true,
      connection: (await connection.locator('option:checked').innerText()).trim(),
      model: (await model.count()) ? await model.inputValue() : '',
      effort: effortValue,
      fixedAs: (await fixed.count()) ? (await fixed.first().innerText()).trim() : '',
    };
  };

  /* ---------------------------------------------------------------------- *
   *  The register refresh's helpers: Evidence, its answers, and the wall.
   * ---------------------------------------------------------------------- */

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

  /** The name of the Evidence project a journey last opened. */
  let openProject: string | null = null;
  const theOpenProject = (): string => {
    expect(openProject, 'this journey has not opened an Evidence project').toBeTruthy();
    return openProject!;
  };

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

  /** One Library item's identity, by the name it was imported under. */
  interface LibraryRecord { original_name: string; file_id: string; version_id: string; media_type: string }
  const libraryFile = async (name: string): Promise<LibraryRecord> => {
    const status = await evidenceRequest<{ vault: { vault_id: string } | null }>('GET', '/api/library');
    const { files } = await evidenceRequest<{ files: LibraryRecord[] }>(
      'GET', `/api/library/files?expected_vault_id=${status.vault!.vault_id}`,
    );
    const found = files.find((file) => file.original_name === name);
    expect(found, `the Library holds nothing called ${name}`).toBeTruthy();
    return found!;
  };

  const evidenceNotesOf = async (name: string): Promise<StoredEvidenceNote[]> => {
    const project = await evidenceProject(name);
    const { notes } = await evidenceRequest<{ notes: StoredEvidenceNote[] }>(
      'GET', `/api/evidence/projects/${project.id}/notes?expected_vault_id=${project.vault}`,
    );
    return notes;
  };

  const answersOf = async (name: string): Promise<{ answer_id: string }[]> => {
    const project = await evidenceProject(name);
    const { answers } = await evidenceRequest<{ answers: { answer_id: string }[] }>(
      'GET', `/api/evidence/projects/${project.id}/answers?expected_vault_id=${project.vault}`,
    );
    return answers;
  };

  const answerOf = async (name: string, id: string): Promise<StoredAnswer> => {
    const project = await evidenceProject(name);
    return evidenceRequest('GET', `/api/evidence/projects/${project.id}/answers/${id}?expected_vault_id=${project.vault}`);
  };

  /** The states a saved answer does not leave. */
  const TERMINAL_ANSWER_STATES = ['succeeded', 'refused', 'failed', 'cancelled', 'interrupted'];

  const evidenceReader = () => win().getByRole('region', { name: 'Evidence reader' });
  const evidenceNotesPanel = () => win().getByRole('region', { name: 'Saved evidence notes' });
  const answerArticle = () => win().getByRole('article', { name: 'Selected evidence answer' });

  /** Select a file of the open project, and wait for the reader to be on it. */
  const pickTheCollectionFile = async (name: string): Promise<void> => {
    const item = win().getByRole('region', { name: 'Current collection files' })
      .getByRole('button', { name: new RegExp(`^${literally(name)} `) });
    await expect(item, `the project holds no file called ${name}`).toBeVisible({ timeout: 30_000 });
    await item.click();
    await expect(item).toHaveAttribute('aria-pressed', 'true', { timeout: 30_000 });
    await expect(evidenceReader().getByRole('heading', { name, exact: true })).toBeVisible({ timeout: 30_000 });
  };

  /** Ask the reader for another physical page of the PDF it has open. */
  const turnTheReaderTo = async (page: number): Promise<void> => {
    const input = evidenceReader().getByLabel('Page', { exact: true });
    await expect(input, 'the reader offers no page control here').toBeEnabled({ timeout: 60_000 });
    await input.fill(String(page));
    await expect(evidenceReader().getByRole('heading', { name: `Canonical text · physical page ${page}` }))
      .toBeVisible({ timeout: 30_000 });
  };

  /**
   * The page the reader is on, once it has finished reading it.
   *
   * **The pane can show the previous page for a moment.** A new page number
   * renders before the effect that clears the old text has run, so a read
   * taken straight after turning the page could report page 1's text under
   * page 2's heading. The wait is therefore for the app's own extraction of
   * this exact page, asked of the same route the reader asks, and then for the
   * pane to agree with it — the record first, the screen second, as everywhere
   * else in this driver. A spec still compares the result with the sentence it
   * authored, so this cannot make a wrong extraction look right.
   */
  const readTheReaderPage = async (file: string): Promise<EvidencePageView> => {
    const reader = evidenceReader();
    await expect(reader.getByRole('heading', { name: file, exact: true })).toBeVisible({ timeout: 60_000 });
    const heading = reader.getByRole('heading', { name: /^Canonical text · (physical|logical) page \d+$/ });
    await expect(heading).toBeVisible({ timeout: 60_000 });
    const page = Number(/(\d+)$/.exec((await heading.innerText()).trim())![1]);
    const pane = reader.getByLabel('Canonical page text');
    // The reader's own read first. The backend reads one bounded PDF page at a
    // time and answers a second request with `reader_busy`, which is what the
    // first draft of this method got by asking while the window was still
    // asking: J35 failed in four seconds on a healthy app.
    await expect(pane.or(reader.getByRole('alert')).first()).toBeVisible({ timeout: 60_000 });
    await expect(reader.getByText('Reading this exact retained page…', { exact: true })).toHaveCount(0, { timeout: 60_000 });
    const project = await evidenceProject(theOpenProject());
    const item = await libraryFile(file);
    let held: { status: string; text: string } = { status: '', text: '' };
    await expect.poll(async () => {
      try {
        held = await evidenceRequest('GET',
          `/api/evidence/projects/${project.id}/reader/${item.file_id}?expected_vault_id=${project.vault}`
          + `&version_id=${item.version_id}&page=${page}&representation=text`);
        return 'read';
      } catch (error) {
        // Busy is the one refusal worth asking again about; anything else is
        // the answer, and is returned so the failure names it.
        return /reader_busy/.test(String(error)) ? 'busy' : String(error);
      }
    }, { timeout: 60_000, message: `the app never read page ${page} of ${file} for itself` }).toBe('read');
    if (held.status === 'extracted') {
      await expect(pane, 'the app extracted this page and the reader does not show what it extracted')
        .toHaveValue(held.text, { timeout: 60_000 });
    } else {
      await expect(reader.getByRole('alert').first()).toBeVisible({ timeout: 60_000 });
    }
    let image = '';
    if (item.media_type === 'application/pdf') {
      // The canvas reports on itself in a status line once PDF.js has drawn
      // the page, or in an alert when it could not.
      const region = reader.getByRole('region', { name: 'PDF page image' });
      const said = region.getByText(/^Page \d+ of \d+ rendered/).or(region.getByRole('alert')).first();
      await expect(said, 'the PDF image never said whether it drew the page').toBeVisible({ timeout: 60_000 });
      image = (await said.innerText()).trim();
    }
    const examined = reader.locator('p').filter({ hasText: /pages examined by text extraction/ }).first();
    return {
      file,
      page,
      text: (await pane.count()) ? await pane.inputValue() : '',
      image,
      examined: (await examined.count()) ? (await examined.innerText()).trim() : '',
    };
  };

  /** Type this body into the note editor, save it, and wait for the record and the notice. */
  const saveTheOpenNote = async (body: string, button: 'Save passage' | 'Save note'): Promise<string> => {
    const panel = evidenceNotesPanel();
    const before = (await evidenceNotesOf(theOpenProject())).length;
    await panel.getByLabel('Note body', { exact: true }).fill(body);
    await panel.getByRole('button', { name: button, exact: true }).click();
    await stored(`the ${button === 'Save passage' ? 'passage' : 'note'} that was saved`,
      () => evidenceNotesOf(theOpenProject()), (notes) => notes.length === before + 1);
    const notice = panel.getByText(/^Saved (this exact evidence record|the submitted record)/);
    await expect(notice, 'the record was stored and the panel never said so').toBeVisible({ timeout: 30_000 });
    return (await notice.innerText()).trim();
  };

  /** A folder of this session's own for downloads, by its real path. */
  const downloadsDir = (): string => {
    // Real path, because the app reports a download by the path it was saved
    // to and `os.tmpdir()` on a Mac is a symlink into `/private`.
    const dir = path.join(fs.realpathSync(session.stateDir), 'downloads');
    fs.mkdirSync(dir, { recursive: true });
    return dir;
  };
  let downloadsMade = 0;

  /**
   * Answer the next download's destination with this path.
   *
   * The same seam `exportTheOpenChat` uses: the request, the bytes and the
   * app's own download flow are real, and only the save dialog is answered,
   * because nothing automated can operate it.
   */
  const theNextDownloadGoesTo = async (target: string): Promise<void> => {
    await session.app.evaluate(({ session: electronSession }, destination) => {
      electronSession.defaultSession.once('will-download', (_event, item) => {
        item.setSavePath(destination);
      });
    }, target);
  };

  /** Wait until the app's own Downloads record says this file finished, not merely began. */
  const theDownloadHasCompleted = async (target: string): Promise<void> => {
    await expect.poll(() => win().evaluate((wanted) => (window as unknown as {
      resmonAPI: { getDownloads(): Promise<{ path: string; state: string }[]> };
    }).resmonAPI.getDownloads().then((items) => items.find((item) => item.path === wanted)?.state ?? ''), target), {
      timeout: 60_000, message: `the download to ${target} never completed`,
    }).toBe('completed');
  };

  /** The authored model a J36 or J37 journey answers its selected evidence with. */
  let selectedModel: SelectedAnswerEndpoint | null = null;

  /** The saved answer on screen, once it shows the state and cleanup the app recorded. */
  const readTheAnswerHere = async (id: string): Promise<SelectedAnswerView> => {
    const saved = await answerOf(theOpenProject(), id);
    const article = answerArticle();
    await expect(article, `the page is not showing answer ${id}`).toContainText(`Answer ${id}`, { timeout: 60_000 });
    // The record first, then the screen agreeing with it. Until the article
    // prints the stored state it is showing the answer as it was mid-run.
    await expect(article).toContainText(
      `State: ${saved.state} · local transport cleanup: ${saved.cleanup_state}`, { timeout: 60_000 },
    );
    const rows = article.locator('.selected-answer-item');
    const items: SelectedAnswerView['items'] = [];
    for (let i = 0; i < await rows.count(); i += 1) {
      const row = rows.nth(i);
      items.push({
        text: (await row.locator('p').nth(1).innerText()).trim(),
        citations: (await row.getByRole('button', { name: /^Open citation / }).allInnerTexts())
          .map((t) => t.trim()),
      });
    }
    const unvalidated = article.getByRole('region', { name: 'Unvalidated answer text' });
    return {
      id,
      state: String(saved.state),
      items,
      unvalidated: (await unvalidated.count()) ? ((await unvalidated.locator('pre').textContent()) ?? '') : null,
      text: (await article.innerText()).trim(),
    };
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

  /** A journey this renderer cannot take: skipped, with the reason in the report. */
  const theClassicRendererHasNo = (what: string): never => {
    testInfo.skip(true, `The classic renderer has no ${what}; this journey belongs to the Atlas interface.`);
    throw new Error('unreachable: a skipped journey does not continue');
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
    name: 'classic',
    backend,

    open: async (place) => {
      if (ATLAS_ONLY.includes(place)) theClassicRendererHasNo(`${place} screen`);
      await goto(PLACES[place as Exclude<Place, AtlasOnlyPlace>]);
    },

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
      await fillTheSweepForm(request);
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
      const entries = await catalogNames();
      const out: SourceOutcome[] = [];
      for (let i = 0; i < count; i += 1) {
        const row = rows.nth(i);
        const reason = row.locator('.mon-repo-zero-reason');
        out.push({
          source: asSlug((await row.locator('.mon-repo-name').innerText()).trim(), entries),
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
      const read = await win().evaluate(() => Array.from(
        document.querySelectorAll('.coverage-table tbody tr'),
        (row) => {
          const cells = Array.from(row.querySelectorAll('td'), (c) => (c.textContent ?? '').trim());
          return { source: cells[0] ?? '', label: cells[1] ?? '', note: cells[4] ?? '' };
        },
      ));
      // The same mapping as the run panel's, so the day the report table
      // follows #219 the two still compare as the same sources.
      const entries = await catalogNames();
      return read.map((outcome) => ({ ...outcome, source: asSlug(outcome.source, entries) }));
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
      return { path: destination, text: fs.readFileSync(destination, 'utf8') };
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
      // `Boolean`, not `=== true`: `GET /api/routines` is declared with no
      // response model, so `is_active` arrives as SQLite's 1 and 0 rather than
      // as JSON booleans. A strict comparison here waited the full thirty
      // seconds and then said the app had never recorded the activation, which
      // was a fact about this predicate and not about the app.
      await stored(`${name} as active`, () => routineRecord(name), (r) => Boolean(r.is_active));
      // And only then the screen. `toHaveText` with a string is a **whole
      // text** comparison, unlike the `hasText: 'Active'` locator option this
      // replaces, which matched "Inactive" and made the wait a no-op.
      await expect(
        row.locator('.badge').first(),
        'the record says active and the row still does not',
      ).toHaveText('Active', { timeout: 30_000 });
    },

    deactivateRoutine: async (name) => {
      await goto(PLACES.Routines);
      const row = win().locator('.simple-table tbody tr').filter({ hasText: name }).first();
      await expect(row).toBeVisible({ timeout: 30_000 });
      await row.getByRole('button', { name: 'Deactivate', exact: true }).click();
      await stored(`${name} as inactive`, () => routineRecord(name), (r) => !r.is_active);
      await expect(
        row.locator('.badge').first(),
        'the record says inactive and the row still does not',
      ).toHaveText('Inactive', { timeout: 30_000 });
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
      //
      // The flip is read against the value the record held *before* the click,
      // because "it is on now" is true of a toggle that was already on. What
      // the journey is about is that the click changed something and that the
      // change was kept.
      const before = Boolean((await routineRecord(name)).notify_on_complete);
      await row.locator('.toggle-btn').nth(2).click();
      await stored(
        `${name}'s desktop notification as ${before ? 'off' : 'on'}`,
        () => routineRecord(name),
        (r) => Boolean(r.notify_on_complete) !== before,
      );
      await expect(
        row.locator('.toggle-btn').nth(2),
        'the record flipped the notification and the row still shows the old state',
      ).toHaveText(before ? 'OFF' : 'ON', { timeout: 30_000 });
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
      // **The page draws its empty row before its own fetch has resolved.**
      // `RoutinesPage` renders a single `No routines configured.` row on mount,
      // which this method filters out — so a read taken on arrival reports an
      // empty list for an app that has routines, and reports it as a fact
      // rather than as a failure. Until slice 4 that gap was covered by a
      // 400 ms sleep at the end of `goto`, which is exactly the kind of
      // load-bearing duration this suite is supposed not to have: it held up
      // five reads that never waited for anything of their own.
      //
      // So this waits for its own content instead — the table showing what the
      // app itself says it has. The denominator is the backend's own list, not
      // a number written here.
      //
      // Not a row count: a routine occupies more than one `tr` — its delivery
      // panel lives in a row of its own underneath it — so counting rows would
      // be waiting for a number that is never the number of routines. What
      // this waits for is the names it is about to read.
      const rows = win().locator('.simple-table tbody tr');
      const drawnNames = async (): Promise<string[]> => {
        const names: string[] = [];
        for (let i = 0; i < await rows.count(); i += 1) {
          const cell = rows.nth(i).locator('td').first();
          if (await cell.count()) names.push((await cell.innerText()).trim());
        }
        return names.filter((n) => n && n !== 'No routines configured.');
      };
      // Nothing configured is the one case this cannot tell from "not fetched
      // yet": the empty row is both states. It is also the only case where the
      // answer is the same either way, so the wait is skipped rather than
      // faked.
      const expected = (await backend.routines()).map((routine) => String(routine.name));
      if (expected.length) {
        await expect
          .poll(async () => {
            const drawn = await drawnNames();
            return expected.every((name) => drawn.includes(name));
          }, {
            timeout: 30_000,
            message: `the Routines page never drew all ${expected.length} routine(s) the app reports`,
          })
          .toBe(true);
      }
      return drawnNames();
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
      // Deep Sweep's own Save Configuration button, and the dialog it opens:
      // the form `runSweep` fills, saved instead of run. This method used to
      // POST `/api/configurations` itself, so on the row called *Saved
      // configurations* the saving was not a path a person takes, and nor was
      // anything after it. Deep Dive has the same button; Deep Sweep is the one
      // that takes several sources, which is what lets J21 put a key-required
      // source into the file it then exports.
      await goto(PLACES['Deep Sweep']);
      await standDownTheCompletionWidget();
      await fillTheSweepForm(from);
      const known = new Set((await backend.configurations()).map((c) => Number(c.id)));
      await win().getByRole('button', { name: 'Save Configuration', exact: true }).click();
      const dialog = win().locator('.modal-content')
        .filter({ has: win().getByRole('heading', { name: 'Save Configuration', exact: true }) });
      await expect(dialog, 'Save Configuration opened no dialog').toBeVisible({ timeout: 30_000 });
      await dialog.locator('input.form-input').fill(name);
      await dialog.getByRole('button', { name: 'Save', exact: true }).click();
      // The record first. A configuration with this name that did not exist
      // before the click is the only thing that can satisfy it.
      let id = 0;
      await stored(`a configuration saved as ${name}`, () => backend.configurations(), (all) => {
        const made = all.filter((c) => c.name === name && !known.has(Number(c.id)));
        if (made.length === 1) id = Number(made[0].id);
        return made.length === 1;
      });
      // Then the screen. The dialog closes only on a save the app accepted — a
      // refused save leaves it open with the name still typed in — so its
      // absence is false before the click and true only after the write.
      await expect(dialog, 'the app stored the configuration and its dialog stayed open')
        .toHaveCount(0, { timeout: 30_000 });
      return id;
    },

    exportConfigurations: async (kind) => {
      await goto(PLACES['Saved configurations']);
      // One tab per archive, because that is all the page will export at once:
      // both tab buttons clear the selection when they are pressed. This method
      // used to tick the Routine Configs rows, press Manual Configs — which
      // cleared them — tick those, and export, on the strength of a comment
      // saying the selection was one set across both tabs. It never was, and
      // nothing noticed, because nothing compared what was in the archive with
      // what was meant to be.
      const label = kind === 'routine' ? 'Routine Configs' : 'Manual Configs';
      const tab = win().locator('.tab-bar .tab-btn', { hasText: label });
      await tab.click();
      // The page marks the tab it is showing, so wait for that rather than for
      // a duration before reading the rows underneath it. A read taken
      // mid-switch is a read of the other tab.
      await expect(tab, `the ${label} tab never became the one on screen`)
        .toHaveClass(/tab-active/, { timeout: 30_000 });
      // "Every configuration of this kind" has a denominator, and it is the
      // app's own list rather than whatever the table happened to have drawn.
      const ofThisKind = (await backend.configurations())
        .filter((c) => (c.config_type === 'routine') === (kind === 'routine'));
      expect(ofThisKind.length, `the app holds no ${kind} configuration to export`).toBeGreaterThan(0);
      const rows = win().locator('.simple-table tbody tr').filter({ has: win().getByRole('checkbox') });
      await expect(rows, `the ${label} tab never drew the ${ofThisKind.length} configuration(s) the app holds`)
        .toHaveCount(ofThisKind.length, { timeout: 30_000 });
      for (let i = 0; i < ofThisKind.length; i += 1) await rows.nth(i).getByRole('checkbox').check();
      // Named with its count, so the click waits for the page to agree that
      // every one of them is selected rather than for the button merely to be
      // enabled by the first.
      const exportButton = win().getByRole('button', {
        name: `Export Selected (${ofThisKind.length})`, exact: true,
      });
      await expect(exportButton, 'the page did not select what was ticked').toBeEnabled({ timeout: 15_000 });
      const answered = win().waitForResponse(
        (r) => r.url().endsWith('/api/configurations/export') && r.request().method() === 'POST',
      );
      await exportButton.click();
      const response = await answered;
      expect(response.ok(), 'Export Selected was refused').toBe(true);
      const written = String((await response.json()).path ?? '');
      // The path is taken from the answer rather than read back off the
      // banner: the banner clears itself after ten seconds, and so does an
      // earlier Import's, which can land in the middle of this read. The
      // banner is then held to naming that same path, because the path a
      // person reads is the one they would hand back.
      await expect(win().locator('.page-content > .form-success'), 'the page never said where the export went')
        .toContainText(`Export saved to: ${written}`, { timeout: 30_000 });
      expect(fs.existsSync(written), `the export names ${written}, which is not there`).toBe(true);
      session.alsoRemoveOnClose(written);
      // The export is a zip of one JSON member per configuration, so the bytes
      // on disk are compressed and searching them for a secret would be a
      // check that passes for the wrong reason. The members are read out with
      // the interpreter the backend is already running under, and the archive
      // itself is left exactly as the app wrote it.
      const members = execFileSync(session.python, ['-c', `
import json, sys, zipfile
with zipfile.ZipFile(sys.argv[1]) as bundle:
    print(json.dumps({name: bundle.read(name).decode('utf-8') for name in bundle.namelist()}))
`, written], { encoding: 'utf8' });
      return { path: written, members: JSON.parse(members) as Record<string, string> };
    },

    importConfigurations: async (exported): Promise<ImportOutcome> => {
      await goto(PLACES['Saved configurations']);
      // The page's own two banners, and not the ones inside its dialogs.
      const success = win().locator('.page-content > .form-success');
      const refusal = win().locator('.page-content > .form-error');
      // A refusal still on screen from an earlier step would satisfy the wait
      // below before this import had done anything.
      await expect(refusal, 'the page was showing an error before Import was pressed')
        .toHaveCount(0, { timeout: 15_000 });
      const before = await backend.configurations();
      const chooser = win().waitForEvent('filechooser');
      await win().locator('button', { hasText: /^Import$/ }).click();
      const picker = await chooser;
      // What the page told the chooser to offer. The native dialog filters by
      // this, and it is not opened here: nothing automated can operate one, so
      // the chooser is answered with the file instead, and the spec's ledger
      // records that. A list that leaves out the file's own type is a dialog in
      // which a person could not have picked it.
      const chooserAccepts = (await picker.element().getAttribute('accept')) ?? '';
      // That file, at that path, unopened. Nothing here reads, copies, renames
      // or rewrites it; the import gets the bytes the export wrote.
      await picker.setFiles(exported.path);
      // Either what it imported or what it refused, and never neither. Read
      // with `allInnerTexts`, which does not wait, because the page clears both
      // banners five seconds after an import and a read that waited for an
      // element could outlive it.
      let said = '';
      let refused = '';
      await expect.poll(async () => {
        said = (await success.allInnerTexts()).join(' ').trim();
        refused = (await refusal.allInnerTexts()).join(' ').trim();
        return /^Imported \d+/.test(said) || refused.length > 0;
      }, {
        timeout: 30_000,
        message: `Import said neither what it imported from ${path.basename(exported.path)} nor what it refused`,
      }).toBe(true);
      const after = await backend.configurations();
      return {
        arrived: after.length - before.length,
        said: /^Imported \d+/.test(said) ? said : '',
        refusal: refused,
        chooserAccepts,
      };
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
      // A fresh state directory, then the restore staged, then a real start —
      // which is the only thing that moves a byte. `/api/restore` deliberately
      // does not restore: it writes a pointer, and the next startup does the
      // work.
      //
      // **The staging is not the person's, and the spec's ledger records it.**
      // The Storage card has a real control for this — `Restore from backup…`,
      // a folder picker, the verification report it draws, and `Restart to
      // restore` — and this method uses none of it: it posts the pointer to
      // `/api/restore` itself, which skips the picker, the report and the
      // button. J41's header said the restore here was the user's end to end;
      // the start is, and the staging is not.
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
      // The keyword card is the one whose heading names keywords, found by that
      // heading rather than by its position on the page: the cards above it are
      // conditional and counting from the top would break when one is absent.
      const card = win().locator('section.card')
        .filter({ has: win().locator('h2:text-matches("keywords", "i")') }).first();
      await expect(card, 'the page draws no keyword card').toBeVisible({ timeout: 30_000 });
      const rows = card.locator('.analytics-bar-row');
      // A corpus too small for a share to mean anything gets a sentence instead
      // of bars, which is an answer rather than an empty card.
      const thin = card.locator('p.analytics-thin');
      // The answer is in and the card is mounted; its *body* is a render later.
      // A bar count taken in between is zero, and zero bars with no sentence is
      // the one combination the card never means — so wait for the card to have
      // said something rather than for half a second to pass.
      await expect
        .poll(async () => (await rows.count()) + (await thin.count()), {
          timeout: 30_000,
          message: 'the keyword card drew neither a bar nor a sentence',
        })
        .toBeGreaterThan(0);
      const bars: Figure[] = [];
      for (let i = 0; i < await rows.count(); i += 1) {
        bars.push({
          label: (await rows.nth(i).locator('.analytics-bar-label').innerText()).trim(),
          value: (await rows.nth(i).locator('.analytics-bar-num').innerText()).trim(),
        });
      }
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
      // Which of the two exists depends on what this corpus drew, and neither
      // exists until Analytics has its data. Asking `count()` on arrival
      // answered "neither" and then quietly took the second one — a choice
      // made from an unfinished page rather than from the page. So wait for
      // one of them to be there before choosing between them.
      await expect
        .poll(async () => (await legend.count()) + (await bar.count()), {
          timeout: 60_000,
          message: 'nothing on Analytics offered a way into the Explorer',
        })
        .toBeGreaterThan(0);
      const link = (await legend.count()) ? legend : bar;
      await expect(link, 'nothing on Analytics offered a way into the Explorer').toBeVisible({ timeout: 60_000 });
      await link.click();
      await win().waitForFunction(() => window.location.hash.startsWith('#/explorer'), undefined, { timeout: 30_000 });
      // The hash having changed is not the router having arrived — the same
      // thing `goto` learned — so wait for the Explorer's own landmark before
      // reading the address back, and let `readExplorer` wait for the page to
      // stop searching. Neither needs a duration.
      for (const landmark of landmarksFor(PLACES.Explorer)) {
        await expect(
          win().locator(landmark),
          `the chart's link never arrived at the Explorer: nothing matched ${landmark}`,
        ).toHaveCount(1, { timeout: 30_000 });
      }
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
      // HTTP 200 is the request being accepted, not the mute being readable:
      // the watchdog answer is served from a cache keyed on a fingerprint that
      // includes `watchdog_mutes`, and the next read is the one that pays for
      // the gap. So wait for the app's own record of the finding to say muted.
      await stored(
        `"${titleFragment}" as muted`,
        () => backend.watchdogFindings(),
        (view) => ((view as { findings?: { title?: string; muted?: boolean }[] }).findings ?? [])
          .some((f) => String(f.title ?? '').includes(titleFragment) && f.muted === true),
      );
      // And the page's own refetch, which a hash change to the route it is
      // already on would not force. The chip is not on the card before the
      // mute, so this cannot be satisfied by the state it is waiting to leave.
      await expect(
        card.locator('.watchdog-chip-muted'),
        'the record says muted and the finding on screen still does not',
      ).toHaveCount(1, { timeout: 30_000 });
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
      const entry = win().getByTestId('profiles-list').locator('button.profiles-list-item')
        .filter({ hasText: name }).first();
      await entry.click();
      // The page marks the profile it is showing, and the matches panel is a
      // fetch behind that. Waiting for the selection first and then for the
      // panel means a read of an empty list is the app saying "none", rather
      // than the read arriving before the answer did.
      await expect(entry, `the Watch Profiles page never selected ${name}`)
        .toHaveClass(/active/, { timeout: 30_000 });
      // **"No papers have been matched to this profile yet" is also what the
      // page draws while it is still asking.** `matches` is null until the
      // fetch lands and the empty state is rendered for null, so a read taken
      // on arrival reports an absence that the app has not established — the
      // exact shape of the note once proved saved by text in a textarea. So
      // the panel is held against the app's own count for this profile.
      const profiles = await backend.profiles();
      const profile = (profiles as { id: number; display_name?: string }[])
        .find((p) => p.display_name === name);
      expect(profile, `no watch profile named ${name}`).toBeTruthy();
      const recorded = await session.api<{ total?: number }>(
        'GET', `/api/profiles/${profile!.id}/matches`,
      );
      const counts = win().getByTestId('basis-counts');
      await expect
        .poll(async () => (
          Number(recorded.total ?? 0) > 0
            ? await counts.count()
            : await win().getByTestId('no-matches').count()
        ), {
          timeout: 30_000,
          message: `the panel for ${name} never agreed with the ${recorded.total ?? 0} match(es) `
            + 'the app says it has',
        })
        .toBeGreaterThan(0);
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
      // **The badges arrive on a fetch the list does not wait for.** The page
      // calls `loadProfileMatches(results)` without awaiting it and clears
      // `loading` regardless — the same shape as the duplicate links next door
      // — so a read taken when the rows appear reports "no basis badge reached
      // the Explorer" over a corpus whose profiles have matches. The 800 ms
      // that used to stand here is the load-bearing duration that produces a
      // flake rather than a failure.
      //
      // So: where the app says a profile has matched something, wait for a
      // chip. Where it says nothing has matched there is nothing to wait for,
      // and waiting would be inventing a state.
      const profiles = await backend.profiles();
      let recorded = 0;
      for (const profile of profiles as { id: number }[]) {
        const matches = await session.api<{ total?: number }>(
          'GET', `/api/profiles/${profile.id}/matches`,
        );
        recorded += Number(matches.total ?? 0);
      }
      const chips = win().getByTestId('basis-matches').locator('span.basis-chip');
      if (recorded > 0) {
        await expect
          .poll(() => chips.count(), {
            timeout: 30_000,
            message: `the app records ${recorded} profile match(es) and the Explorer drew no badge`,
          })
          .toBeGreaterThan(0);
      }
      return (await chips.allInnerTexts()).map((t) => t.trim());
    },

    readExplorerList: async () => {
      await goto(PLACES.Explorer);
      // The "also appears in …" labels arrive on a **second** fetch that the
      // page does not wait for — `load()` calls `loadLinks(results)` without
      // awaiting it and clears `loading` regardless — so a list read the
      // moment the results land carries no labels, and reports that as a fact.
      // That is how J10 went red on a CI leg of this branch: `no paper says it
      // also appears somewhere else`, over a corpus whose scan had already
      // reported links.
      //
      // So where the app says it has links, wait for the page to be showing
      // one. Where it says it has none there is nothing to wait for, and
      // waiting would be inventing a state.
      const status = await backend.linkStatus();
      if (Number(status.links ?? 0) > 0) {
        await expect
          .poll(async () => win()
            .locator('li.explorer-item [data-testid="duplicate-links"]').count(), {
            timeout: 30_000,
            message: `the Explorer drew no "also appears in" label over a corpus the app reports `
              + `${status.links} near-duplicate link(s) in`,
          })
          .toBeGreaterThan(0);
      }
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

    chooseAnEmbeddingProvider: async (provider): Promise<EmbeddingProviderChoice> => {
      // Over the API, as `enableRankingByMeaning` is: the classic tab draws a
      // provider that cannot embed as a disabled option, so it cannot be
      // chosen there at all. What is checked is the engine's refusal at
      // configuration, which is the same for any interface. A provider the
      // engine would accept is not written, so this saves nothing either way.
      const page = await session.api<{ providers: { provider: string; state: string; reason: string }[] }>(
        'GET', '/api/settings/embeddings',
      );
      const answer = page.providers.find((p) => p.provider === provider);
      if (answer?.state !== 'no') return { refused: false, reason: '' };
      try {
        await session.api('PUT', '/api/settings/embeddings', {
          settings: { embedding_enabled: 'true', embedding_provider: provider },
        });
      } catch (error) {
        const refused = /answered HTTP 400: ([^\n]*)/.exec((error as Error).message);
        if (!refused) throw error;
        let reason = refused[1] ?? '';
        try { reason = String(JSON.parse(reason).detail ?? reason); } catch { /* the body was the sentence */ }
        return { refused: true, reason };
      }
      return { refused: false, reason: '' };
    },

    embedThePapersStillMissing: async (): Promise<EmbeddingBackfill> => {
      // Over the API, beside `enableRankingByMeaning`: the estimate, the
      // backfill and its status are the engine's own, and the sentences
      // returned here are put together from those answers rather than read
      // off the classic tab.
      type Coverage = { embedded: number; total: number };
      type Status = { coverage: Coverage; run: { running: boolean; finished_at: string | null; processed: number; total: number } };
      // Where a person does this, so the window leaves the page it was on. The
      // Explorer reads whether it can rank when it opens; left open across a
      // backfill made over the API, it would go on answering from before it.
      await goto(PLACES['AI settings']);
      const before = await session.api<Status>('GET', '/api/embeddings/status');
      const estimate = await session.api<{ documents: number; estimated_tokens: number; note: string }>(
        'GET', '/api/embeddings/estimate',
      );
      await session.api('POST', '/api/embeddings/backfill', {});
      let after = before;
      await expect.poll(async () => {
        after = await session.api<Status>('GET', '/api/embeddings/status');
        return !after.run.running && after.run.finished_at !== before.run.finished_at;
      }, { timeout: 120_000, message: 'the backfill never finished' }).toBe(true);
      const missing = before.coverage.total - before.coverage.embedded;
      return {
        before: { embedded: before.coverage.embedded, total: before.coverage.total },
        missing: `${missing} of ${before.coverage.total} papers have no vector.`,
        estimate: `${estimate.documents} papers to embed, about ${estimate.estimated_tokens} tokens. ${estimate.note}`,
        outcome: `Embedded ${after.run.processed} of ${after.run.total} papers.`,
        after: { embedded: after.coverage.embedded, total: after.coverage.total },
      };
    },

    rankTheExplorerBy: async (phrase): Promise<RankedList> => {
      await goto(`${PLACES.Explorer}?q=${encodeURIComponent(phrase)}`);
      const sort = win().getByTestId('explorer-sort');
      // `explorer-sort` is drawn only once the Explorer's *capability* answer
      // is in — a second fetch, separate from the results — and it is absent
      // both before that answer arrives and when the answer is "no ranking
      // here". Reading `count()` on arrival cannot tell those two apart, and
      // it reported the first as the second: `controlsPresent: false` over a
      // build that could rank perfectly well.
      //
      // The app publishes the answer, so this waits for the screen to agree
      // with it rather than for a duration.
      const capability = await session.api<{ capability?: { available?: boolean } }>(
        'GET', '/api/embeddings/status',
      );
      const canRank = capability.capability?.available === true;
      await expect
        .poll(async () => (await sort.count()) > 0, {
          timeout: 30_000,
          message: canRank
            ? 'the Explorer never drew its sort control over a build that reports it can rank'
            : 'the Explorer drew a sort control over a build that reports it cannot rank',
        })
        .toBe(canRank);
      const controlsPresent = (await sort.count()) > 0;
      if (!controlsPresent) {
        return { note: '', controlsPresent, list: await readExplorer() };
      }
      await sort.locator('select').selectOption('similarity');
      // `rank-note` is drawn on `!loading && meta.sort === 'similarity'`, so
      // the page itself only puts it there once the ranked answer is in and
      // rendered. It is absent before the sort changes, which is what makes it
      // a predicate rather than a coincidence — the two seconds that used to
      // stand here were covering the same wait with a guess.
      const note = win().getByTestId('rank-note');
      await expect(note, 'the Explorer never finished ranking by meaning').toBeVisible({ timeout: 60_000 });
      return {
        note: (await note.innerText()).trim(),
        controlsPresent,
        list: await readExplorer(),
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

    collapseDuplicates: async (on) => {
      const box = win().getByTestId('collapse-toggle').locator('input[type="checkbox"]');
      await expect(box, 'the Explorer offered no way to collapse duplicates').toBeVisible({ timeout: 30_000 });
      // Turning collapse on sends the page off to `/api/links/collapse-preview`
      // and it folds nothing until that answers, so the request is watched
      // rather than waited out. Turning it off needs no answer: the page drops
      // the grouping in the same render as the checkbox.
      const grouped = on
        ? win().waitForResponse((r) => r.url().includes('/api/links/collapse-preview'))
        : null;
      if (on) await box.check(); else await box.uncheck();
      await expect(box, `the collapse control did not turn ${on ? 'on' : 'off'}`)
        .toBeChecked({ checked: on, timeout: 15_000 });
      if (grouped) {
        expect((await grouped).ok(), 'the Explorer was refused its collapse grouping').toBe(true);
      }
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
      // Which keyring entries the app already reports as present, before the
      // save. The field is labelled with the source's display name and the
      // credential is stored under its slug, so rather than map one onto the
      // other — a second copy of the catalog, in the suite — this waits for
      // *a* credential to have become present that was not before.
      const presentNow = async (): Promise<string[]> => {
        const body = await backend.credentials() as
          { credentials?: Record<string, { present?: boolean }> };
        return Object.entries(body.credentials ?? {})
          .filter(([, state]) => state?.present === true).map(([name]) => name);
      };
      const before = new Set(await presentNow());
      const field = win().locator(`input[aria-label="API key for ${source}"]`);
      await expect(field, `${source} has no key field`).toBeVisible({ timeout: 30_000 });
      const saved = win().waitForResponse(
        (r) => r.url().includes('/api/credentials/') && r.request().method() === 'PUT',
      );
      await field.fill(value);
      await field.press('Enter');
      expect((await saved).ok(), 'the key the field submitted was refused').toBe(true);
      // HTTP 200 on the PUT is the keyring being asked, not the keyring
      // answering, and `readKeyFields` reads the presence state — so that is
      // what this waits for.
      await stored(
        `the key for ${source}`,
        presentNow,
        (names) => names.some((name) => !before.has(name)),
      );
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
      // The block renders nothing at all when no source in the catalog makes
      // attribution a condition — and it also renders nothing while the
      // catalog is still being fetched. `count()` on arrival read the second
      // and returned the first: an empty list where the honest answer is "not
      // yet". That is worse than a failure, because a spec asserting the
      // credits are present would have gone red for the wrong reason and one
      // asserting they are *absent* would have gone green for the wrong one.
      //
      // The catalog the page is served is the denominator, so wait for the
      // screen to agree with it.
      const catalog = await backend.sourceCatalog();
      const owed = catalog.filter(
        (entry) => entry.attribution_requirement === 'required' && entry.attribution,
      ).length;
      await expect
        .poll(async () => (await block.count()) > 0, {
          timeout: 30_000,
          message: owed
            ? `the Repositories page never drew the credits for the ${owed} source(s) that require them`
            : 'the Repositories page drew required credits for a catalog that requires none',
        })
        .toBe(owed > 0);
      if (!await block.count()) return [];
      return (await block.locator('li').allInnerTexts()).map((t) => t.replace(/\s+/g, ' ').trim());
    },

    useAnAuthoredAgentCommand: () => pointTheAssistantAtTheDouble({ recordArguments: false }),

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
      // Armed before the click, and awaited after it. Without this the
      // authoritative wait below can be satisfied by the *previous* turn: on a
      // second ask the session already exists and is idle, so "no conversation
      // is running" is true until the backend has claimed the new turn. That is
      // the bug one level down from the one this whole helper was written for.
      const claimed = win().waitForResponse(
        (r) => /\/api\/assistant\/sessions\/\d+\/messages$/.test(r.url())
          && r.request().method() === 'POST',
        { timeout: 120_000 },
      );
      await win().getByRole('button', { name: 'Send', exact: true }).click();
      const response = await claimed;
      expect(response.ok(), `the assistant refused the message: HTTP ${response.status()}`).toBe(true);
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
      // The list is drawn from the panel's own session state, and the empty
      // note is what it draws before that state arrives — so "no earlier
      // conversations" is what a read taken on the click gets, whether or not
      // there are any. The app knows how many it has; wait for the list to
      // show that many.
      const { sessions } = await session.api<{ sessions: { id: number }[] }>(
        'GET', '/api/assistant/sessions',
      );
      const open = win().locator('button.assistant-session-open');
      await expect
        .poll(() => open.count(), {
          timeout: 30_000,
          message: `the app has ${sessions.length} saved conversation(s) and the panel lists a different number`,
        })
        .toBe(sessions.length);
      return (await open.allInnerTexts()).map((t) => t.trim());
    },

    readTheFirstRunCard: async (): Promise<FirstRunCard> => {
      await goto('/');
      const card = win().getByTestId('first-run-card');
      // **`present: false` was a duration away from being a lie.** The card
      // renders nothing until `GET /api/onboarding` has answered, so a count
      // taken on arrival reports "the app shows no first-run card" for an app
      // that is about to show one — an absence asserted rather than observed,
      // which is the one thing this project will not ship. The app publishes
      // whether the card belongs on the page; wait for the screen to agree
      // with it, either way.
      const shows = Boolean((await backend.onboarding() as { show?: boolean }).show);
      await expect
        .poll(() => card.count(), {
          timeout: 30_000,
          message: shows
            ? 'the app says the first-run card belongs on the Dashboard and it never appeared'
            : 'the app says the first-run card is done with and it is still on the Dashboard',
        })
        .toBe(shows ? 1 : 0);
      if (!shows) return { present: false, steps: [], text: '' };
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
      return { path: destination, text: fs.readFileSync(destination, 'utf8') };
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
      if (ATLAS_ONLY.includes(place)) theClassicRendererHasNo(`${place} screen`);
      win().on('request', watch);
      try {
        await goto(PLACES[place as Exclude<Place, AtlasOnlyPlace>]);
        await expect.poll(() => seen.length, { timeout: 30_000 }).toBeGreaterThan(0);
        // The page goes on asking after the first answer; a moment here means
        // the list is what the page really sent rather than its first request.
        //
        // journeys:duration-ok an observation window, not a readiness
        // wait. The question the row asks is "does every request
        // this place makes carry the token", and there is no state that means
        // "it has finished making them": the page keeps polling for as long as
        // it is open. The settle that matters is the assertion above, that at
        // least one request was seen; this second is how much of the stream
        // the row is willing to claim to have looked at, and the spec says so.
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
      // The line exists only where the page has a status for the provider the
      // settings name, and that is a second fetch after the settings
      // themselves. Read on arrival, its absence meant "the page has not asked
      // yet" and was returned as "this lane has nothing to say" — the same
      // silent-empty-answer shape as the two above, and on a row whose whole
      // subject is what the lane says about itself.
      const [settings, cli] = await Promise.all([
        session.api<{ ai_provider?: string }>('GET', '/api/settings/ai'),
        session.api<{ providers?: { provider: string }[] }>('GET', '/api/settings/ai/cli-status'),
      ]);
      const expected = (cli.providers ?? [])
        .some((entry) => entry.provider === settings.ai_provider);
      await expect
        .poll(async () => (await status.count()) > 0, {
          timeout: 30_000,
          message: expected
            ? `Settings → AI never drew a status for the ${settings.ai_provider} lane the app reports one for`
            : 'Settings → AI drew a CLI status for a provider the app reports none for',
        })
        .toBe(expected);
      if (!await status.count()) return '';
      return (await status.first().innerText()).replace(/\s+/g, ' ').trim();
    },

    /**
     * The report viewer's Log or Report tab, read only once it holds one.
     *
     * **`.report-viewer-body` is visible on every tab, so waiting for it to be
     * visible waits for nothing.** The viewer fetches the report and the log
     * once when it mounts and renders `No report available.` / `No log
     * available.` for a value that is still `null` — which is byte-identical
     * to the answer for a run that genuinely has neither. A read taken before
     * the fetch lands therefore returns the app's own sentence for "there is
     * none", and a spec asserting on the text believes it. So where the app
     * says there is one, this waits for the page to be showing it.
     */
    readRunLog: async (run) => readViewerTab(run, 'Log', 'No log available.'),

    readTheReport: async (run) => readViewerTab(run, 'Report', 'No report available.'),

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
      // Named for the request, not `stored`: there is a module-level `stored`
      // predicate above and a local of that name shadowing it reads as the
      // predicate being used when it is not.
      const passwordAccepted = win().waitForResponse(
        (r) => r.url().includes('/api/credentials/smtp_password'),
      );
      await win().locator('.key-input-row button', { hasText: /^(Store|Replace)$/ }).click();
      expect(
        (await passwordAccepted).ok(),
        'the SMTP password was refused by the credential store',
      ).toBe(true);
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
      return { path: destination, text: fs.readFileSync(destination, 'utf8') };
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

    /* ---------------------------------------------------------------------- *
     *  Slice 4.
     * ---------------------------------------------------------------------- */

    useAnAuthoredAgentCommandThatRecordsItsArguments: () =>
      pointTheAssistantAtTheDouble({ recordArguments: true }),

    readWhatTheAgentCommandReceived: async (): Promise<string[][]> => {
      if (!fs.existsSync(agentArgumentLog)) return [];
      const invocations: string[][] = [];
      let current: string[] = [];
      // The trailing separator leaves one empty field, which is not an argument.
      const fields = fs.readFileSync(agentArgumentLog, 'utf8').split('\0');
      if (fields[fields.length - 1] === '') fields.pop();
      for (const field of fields) {
        if (field === END_OF_INVOCATION) { invocations.push(current); current = []; } else current.push(field);
      }
      expect(current, 'the agent command was recorded mid-invocation').toEqual([]);
      return invocations;
    },

    fixTheChoicesForThisConversation: async (choice): Promise<ComposerChoice> => {
      const panel = await assistantPanel();
      const model = panel.getByLabel('Model', { exact: true });
      await expect(model, 'the composer offers no model to choose').toBeEnabled({ timeout: 30_000 });
      await model.fill(choice.model);
      if (choice.effort !== undefined) {
        await panel.getByLabel('Effort', { exact: true }).selectOption(choice.effort);
      }
      return readComposer();
    },

    readTheComposerChoices: () => readComposer(),

    readTheTurnsChoices: async (): Promise<TurnChoiceFacts[]> => {
      const blocks = win().locator('details.assistant-turn-choices');
      const out: TurnChoiceFacts[] = [];
      for (let i = 0; i < await blocks.count(); i += 1) {
        const block = blocks.nth(i);
        // A `<details>` holds its body out of the layout until it is opened, so
        // a read of a closed one would report the summary and call it the
        // disclosure. A person opens it; so does this.
        if (!await block.evaluate((element) => (element as HTMLDetailsElement).open)) {
          await block.locator('summary').click();
        }
        const reported = block.locator('ol li');
        out.push({
          requested: (await block.locator('.assistant-choice-summary').innerText()).trim(),
          reported: (await reported.allInnerTexts()).map((t) => t.trim()),
          text: (await block.innerText()).trim(),
        });
      }
      return out;
    },

    chooseAParentFolderForTheLibrary: async (): Promise<string> => {
      // Somewhere of this session's own, outside the state directory, because
      // that is where a person puts a vault: a folder they keep. It is removed
      // with the session, so a run leaves no library behind on the machine.
      const parent = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'resmon-journey-library-')));
      session.alsoRemoveOnClose(parent);
      // The production IPC handler is untouched; only the OS dependency
      // answers, exactly as `e2e/library.spec.ts` does it. Nothing automated
      // can operate a native file dialog, and the spec's ledger says so.
      await session.app.evaluate(({ dialog }, chosen) => {
        dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [chosen] });
      }, parent);
      await goto('/library');
      await win().getByRole('button', { name: 'Choose parent folder', exact: true }).click();
      await expect(win().getByText(parent, { exact: true })).toBeVisible({ timeout: 30_000 });
      libraryParent = parent;
      return parent;
    },

    createTheManagedVault: async (): Promise<string> => {
      await goto('/library');
      await win().getByRole('button', { name: 'Create managed vault', exact: true }).click();
      // The control that only exists once there is somewhere to import into.
      await expect(win().getByLabel('Import PDF, TXT or MD')).toBeEnabled({ timeout: 60_000 });
      return vaultDirectory();
    },

    importIntoTheLibrary: async (files): Promise<string> => {
      await goto('/library');
      const staging = fs.mkdtempSync(path.join(os.tmpdir(), 'resmon-journey-import-'));
      session.alsoRemoveOnClose(staging);
      const paths = files.map((file) => {
        const target = path.join(staging, file.name);
        fs.writeFileSync(target, file.content);
        return target;
      });
      const control = win().getByLabel('Import PDF, TXT or MD');
      await expect(control).toBeEnabled({ timeout: 60_000 });
      await control.setInputFiles(paths);
      // The page's own account of what it did. Waiting for the sentence rather
      // than for a count is what stops a read landing between the upload
      // finishing and the list being refetched — and the page has a second
      // `role="status"` for "Loading Library…", so this waits for the one that
      // answers the question that was asked.
      const notice = win().getByText(/\d+ retained, \d+ exact duplicates reused/);
      await expect(notice).toBeVisible({ timeout: 120_000 });
      return (await notice.innerText()).trim();
    },

    readTheLibraryItems: async (): Promise<LibraryItem[]> => {
      await goto('/library');
      const rows = win().getByRole('region', { name: 'Library files' }).locator('.library-item');
      await expect(rows.first()).toBeVisible({ timeout: 60_000 });
      const out: LibraryItem[] = [];
      for (let i = 0; i < await rows.count(); i += 1) {
        await rows.nth(i).click();
        out.push(await readLibraryDetail());
      }
      return out;
    },

    associateTheLibraryItemWithPaper: async (name, paperId): Promise<string> => {
      await selectTheLibraryItem(name);
      const detail = win().getByRole('region', { name: 'Selected Library item' });
      await detail.getByLabel('Existing paper ID').fill(String(paperId));
      await detail.getByRole('button', { name: 'Associate paper', exact: true }).click();
      const notice = detail.locator('[role="status"]').first();
      await expect(notice).toContainText(`Linked local paper ${paperId}`, { timeout: 60_000 });
      return (await notice.innerText()).trim();
    },

    readTheVaultOnDisk: async (): Promise<VaultOnDisk> => {
      const directory = vaultDirectory();
      const entries: string[] = [];
      const walk = (at: string): void => {
        for (const entry of fs.readdirSync(at, { withFileTypes: true })) {
          const full = path.join(at, entry.name);
          entries.push(path.relative(directory, full));
          if (entry.isDirectory()) walk(full);
        }
      };
      walk(directory);
      const marker = path.join(directory, 'vault.json');
      const hashes: Record<string, string> = {};
      for (const entry of entries) {
        const full = path.join(directory, entry);
        if (!fs.statSync(full).isDirectory() && entry !== 'vault.json') {
          hashes[entry] = createHash('sha256').update(fs.readFileSync(full)).digest('hex');
        }
      }
      return {
        directory: path.basename(directory),
        marker: fs.existsSync(marker) ? fs.readFileSync(marker, 'utf8') : '',
        entries: entries.sort(),
        hashes,
      };
    },

    setTheAppWideAssistantDefaults: async (defaults) => {
      await goto(PLACES['AI settings']);
      // By id: this page carries a `Model` label of its own and so does the
      // assistant panel, which a journey may have left open over it.
      const model = win().locator('#assistant-model');
      await expect(model, 'Settings → AI offers no assistant model').toBeVisible({ timeout: 30_000 });
      await model.selectOption(defaults.model);
      if (defaults.effort !== undefined) {
        await win().locator('#assistant-effort').selectOption(defaults.effort);
      }
      await win().getByRole('button', { name: 'Save assistant settings', exact: true }).click();
      await expect(win().locator('.settings-saved')).toBeVisible({ timeout: 30_000 });
    },

    /* ---------------------------------------------------------------------- *
     *  The register refresh: the Evidence workspace (J35), its selected-
     *  evidence answers (J36), the portable HTML (J37) and the Source wall
     *  (J45). Appended, for the reason every block above is.
     * ---------------------------------------------------------------------- */

    startAnEvidenceProjectFrom: async (item, project): Promise<EvidencePageView> => {
      await selectTheLibraryItem(item);
      await win().getByRole('link', { name: 'Open in Evidence / add to project' }).click();
      await expect(win().getByRole('region', { name: 'Selected Library handoff' }),
        'Open in Evidence did not carry the Library item across').toContainText(item, { timeout: 30_000 });
      await win().getByLabel('New project name', { exact: true }).fill(project);
      await win().getByRole('button', { name: 'Create project', exact: true }).click();
      await stored(`a project called ${project}`, () => findEvidenceProject(project), (made) => made !== null);
      openProject = project;
      // Enabled only once the new project is the selected one: the handoff
      // adds to whichever project is open, so pressing it earlier would be
      // adding the file to nothing.
      const add = win().getByRole('button', { name: 'Add selected Library file to project' });
      await expect(add).toBeEnabled({ timeout: 30_000 });
      await add.click();
      return readTheReaderPage(item);
    },

    addToTheEvidenceProject: async (items): Promise<string[]> => {
      const chooser = win().getByRole('button', { name: 'Choose from Library', exact: true });
      await expect(chooser).toBeEnabled({ timeout: 30_000 });
      await chooser.click();
      await expect(win().getByRole('region', { name: 'Choose retained Library files' })).toBeVisible({ timeout: 30_000 });
      const members = win().getByRole('region', { name: 'Current collection files' });
      for (const item of items) {
        await win().getByRole('button', { name: `Add ${item}`, exact: true }).click();
        await expect(members.getByRole('button', { name: new RegExp(`^${literally(item)} `) }),
          `${item} was added and is not in the collection`).toBeVisible({ timeout: 30_000 });
        // The chooser's controls are disabled while the add is being saved.
        await expect(chooser).toBeEnabled({ timeout: 30_000 });
      }
      await win().getByRole('button', { name: 'Close Library chooser' }).click();
      return (await members.locator('button.evidence-item strong').allInnerTexts()).map((t) => t.trim());
    },

    openTheEvidenceProject: async (project) => {
      await goto(PLACES.Evidence);
      const button = win().getByRole('region', { name: 'Project collections' })
        .getByRole('button', { name: new RegExp(`^${literally(project)} `) });
      await expect(button, `Evidence lists no project called ${project}`).toBeVisible({ timeout: 60_000 });
      await button.click();
      await expect(button).toHaveAttribute('aria-pressed', 'true', { timeout: 30_000 });
      await expect(win().getByRole('heading', { name: project, exact: true })).toBeVisible({ timeout: 30_000 });
      openProject = project;
    },

    readTheEvidencePage: async (file, page): Promise<EvidencePageView> => {
      await pickTheCollectionFile(file);
      if (page !== undefined) await turnTheReaderTo(page);
      return readTheReaderPage(file);
    },

    saveAnEvidencePassage: async ({ file, page, quote, body }): Promise<string> => {
      await pickTheCollectionFile(file);
      if (page !== undefined) await turnTheReaderTo(page);
      // The page is settled before it is searched: a search run against the
      // previous page's text would select a passage the person never saw.
      await readTheReaderPage(file);
      const reader = evidenceReader();
      const find = reader.getByLabel('Find on current canonical page');
      await find.fill(quote);
      await find.press('Enter');
      // The reader's own count, which exists only once a search has run.
      await expect(reader.getByText(/literal match(es)? on this canonical page/),
        `the reader never reported searching for "${quote}"`).toBeVisible({ timeout: 30_000 });
      const use = reader.getByRole('button', { name: 'Use selected passage' });
      await expect(use, `the reader found no "${quote}" to use`).toBeEnabled({ timeout: 30_000 });
      await use.click();
      const panel = evidenceNotesPanel();
      await expect(panel.getByRole('heading', { name: 'New exact passage' })).toBeVisible({ timeout: 30_000 });
      await expect(panel.locator('form blockquote'),
        'the passage the panel is about to save is not the text that was found').toHaveText(quote);
      return saveTheOpenNote(body, 'Save passage');
    },

    saveAnEvidenceNote: async ({ file, body }): Promise<string> => {
      await pickTheCollectionFile(file);
      const panel = evidenceNotesPanel();
      await panel.getByRole('button', { name: 'Use plain note', exact: true }).click();
      await expect(panel.getByRole('heading', { name: 'New plain note' })).toBeVisible({ timeout: 30_000 });
      return saveTheOpenNote(body, 'Save note');
    },

    readTheSavedEvidenceNotes: async (): Promise<SavedEvidenceNote[]> => {
      const held = await evidenceNotesOf(theOpenProject());
      const articles = evidenceNotesPanel().locator('article.evidence-saved-note');
      await expect(articles, 'the panel does not list every record the app holds')
        .toHaveCount(held.length, { timeout: 30_000 });
      const out: SavedEvidenceNote[] = [];
      for (let i = 0; i < await articles.count(); i += 1) {
        const article = articles.nth(i);
        const [file, kind, page] = (await article.locator('h3').innerText()).trim().split(' · ');
        const quote = article.locator('blockquote');
        const identity = (await article.locator('.evidence-identity').innerText()).trim();
        out.push({
          file,
          kind,
          page: page ? Number(page.replace(/^page /, '')) : null,
          quote: (await quote.count()) ? ((await quote.textContent()) ?? '') : null,
          body: (await article.locator('p.evidence-literal').textContent()) ?? '',
          noteId: /^Note (\S+)/.exec(identity)?.[1] ?? '',
          versionId: /Version (\S+)/.exec(identity)?.[1] ?? '',
        });
      }
      return out;
    },

    reopenTheSavedPassage: async (quote): Promise<ReopenedPassage> => {
      const article = evidenceNotesPanel().locator('article.evidence-saved-note')
        .filter({ has: win().getByText(quote, { exact: true }) }).first();
      await expect(article, `no saved passage keeps "${quote}"`).toBeVisible({ timeout: 30_000 });
      const file = (await article.locator('h3').innerText()).trim().split(' · ')[0];
      await article.getByRole('button', { name: 'Reopen saved passage', exact: true }).click();
      const reader = evidenceReader();
      await expect(reader.getByRole('heading', { name: file, exact: true })).toBeVisible({ timeout: 30_000 });
      // "Unresolved until this exact page is checked" is the state it starts
      // in; the two sentences waited for here are the two it can end in.
      const resolution = reader.locator('.evidence-resolution');
      await expect(resolution, 'the reader never said whether the saved passage still matches')
        .toHaveText(/^Saved passage (resolved|unresolved:)/, { timeout: 60_000 });
      const heading = reader.getByRole('heading', { name: /^Canonical text · (physical|logical) page \d+$/ });
      const pane = reader.getByLabel('Canonical page text');
      return {
        file,
        page: Number(/(\d+)$/.exec((await heading.innerText()).trim())![1]),
        highlighted: (await pane.count())
          ? await pane.evaluate((element) => {
            const text = element as HTMLTextAreaElement;
            return text.value.slice(text.selectionStart, text.selectionEnd);
          })
          : '',
        resolution: (await resolution.innerText()).trim(),
      };
    },

    exportSelectedEvidence: async (files, { includeFiles }): Promise<EvidenceBundle> => {
      const open = win().getByRole('button', { name: 'Export selected evidence', exact: true });
      await expect(open).toBeEnabled({ timeout: 30_000 });
      await open.click();
      const dialog = win().getByRole('region', { name: 'Selected evidence bundle' });
      await expect(dialog).toBeVisible({ timeout: 30_000 });
      for (const file of files) await dialog.getByLabel(new RegExp(`^${literally(file)} `)).check();
      if (includeFiles) await dialog.getByLabel('Include retained files', { exact: true }).check();
      downloadsMade += 1;
      const target = path.join(downloadsDir(), `selected-evidence-${downloadsMade}.zip`);
      await theNextDownloadGoesTo(target);
      await dialog.getByRole('button', { name: 'Download selected ZIP' }).click();
      await expect(dialog.getByText(/^Complete (retained-file|metadata-only) ZIP download requested/),
        'the bundle was never offered').toBeVisible({ timeout: 120_000 });
      await theDownloadHasCompleted(target);
      // Read with the backend's own interpreter, as the configuration export
      // is, so the archive on disk is left exactly as the app wrote it.
      const read = JSON.parse(execFileSync(session.python, ['-c', `
import hashlib, json, sys, zipfile
with zipfile.ZipFile(sys.argv[1]) as bundle:
    assert bundle.testzip() is None
    names = bundle.namelist()
    print(json.dumps({'members': names, 'manifest': json.loads(bundle.read('manifest.json')),
                      'notes': bundle.read('notes.md').decode('utf-8'),
                      'hashes': {name: hashlib.sha256(bundle.read(name)).hexdigest() for name in names}}))
`, target], { encoding: 'utf8' }));
      await dialog.getByRole('button', { name: 'Close export' }).click();
      return {
        path: target,
        members: read.members,
        manifest: read.manifest,
        notesMarkdown: read.notes,
        hashes: read.hashes,
      };
    },

    useAnAuthoredModelForSelectedAnswers: async () => {
      selectedModel = await startSelectedAnswerEndpoint();
      session.alsoCloseOnClose(() => selectedModel!.close());
      // The CLI path points at a file that does not exist, on purpose. The
      // selection dialog offers the Claude Code connection beside the API one,
      // and a CLI path left blank is found wherever the installers put the real
      // one; an explicit path that is not an executable is reported as missing
      // and never falls through to another binary (`ai_cli.discover_cli`). So
      // this journey cannot start a signed-in agent CLI even by a misclick.
      await session.api('PUT', '/api/settings/ai', {
        settings: {
          ai_cli_path: path.join(session.stateDir, 'no-agent-cli-in-this-journey'),
          ai_custom_base_url: selectedModel.url,
        },
      });
      // The key goes to the credential store, through the route the API Key
      // field's Store button posts to. It is in memory inside this backend
      // process (see `journey_keyring` in fixtures/source-endpoint.ts), so it is
      // gone after a relaunch — a journey that relaunches and then sends again
      // has to store it again.
      await session.api('PUT', '/api/credentials/custom_llm_api_key', { value: 'journey-authored-selected-key' });
    },

    theAuthoredModelCitesTextItWasNotSent: (quote) => {
      expect(selectedModel, 'this journey never started an authored model').toBeTruthy();
      selectedModel!.citeTextItWasNotSent(quote);
    },

    readWhatTheAuthoredModelReceived: () => {
      expect(selectedModel, 'this journey never started an authored model').toBeTruthy();
      return selectedModel!.calls().map((call) => ({ raw: call.raw, userPayload: call.userPayload }));
    },

    askFromSelectedEvidence: async (request) => {
      const before = (await answersOf(theOpenProject())).map((answer) => answer.answer_id);
      const panel = win().getByRole('region', { name: 'Evidence answers' });
      const start = panel.getByRole('button', { name: 'New selected-evidence answer' });
      await expect(start).toBeEnabled({ timeout: 30_000 });
      await start.click();
      const dialog = win().getByRole('dialog', { name: 'Select evidence for an answer' });
      await expect(dialog).toBeVisible({ timeout: 30_000 });
      for (const choice of request.select) {
        if (choice.page !== undefined) {
          await dialog.getByLabel(`Physical page for ${choice.file}`).fill(String(choice.page));
          await dialog.getByRole('button', { name: `Add ${choice.file} page`, exact: true }).click();
        } else {
          await dialog.getByRole('button', { name: `Add ${choice.file} logical page 1`, exact: true }).click();
        }
      }
      // The dialog's own list is its record of what was added, and a selection
      // that silently failed to add would otherwise surface only as a shorter
      // preview.
      await expect(dialog.locator('fieldset ol > li'), 'a selection was pressed and not added')
        .toHaveCount(request.select.length, { timeout: 15_000 });
      for (const body of request.includeNotes ?? []) {
        await dialog.getByLabel(new RegExp(`^Include note body: ${literally(body)}`)).check();
      }
      await dialog.getByLabel('Answer format').selectOption(request.format);
      await dialog.getByLabel('Question or briefing instruction').fill(request.instruction);
      await dialog.getByLabel('Connection', { exact: true }).selectOption('api_key:custom');
      await dialog.getByLabel('Model', { exact: true }).fill(request.model);
      await dialog.getByRole('button', { name: 'Preview selected content' }).click();
      const disclosure = dialog.getByRole('region', { name: 'Exact disclosure preview' });
      await expect(disclosure.getByRole('heading', { name: 'Inspect before Send' }),
        'the preview never arrived').toBeVisible({ timeout: 120_000 });
      const preview: SelectedAnswerPreview = { sources: [], notes: [], text: '' };
      const articles = disclosure.locator('article');
      for (let i = 0; i < await articles.count(); i += 1) {
        const article = articles.nth(i);
        const head = (await article.locator('h4').innerText()).trim();
        const body = (await article.locator('pre').textContent()) ?? '';
        const source = /^(S\d+) · (.+) · page (\d+)$/.exec(head);
        if (source) preview.sources.push({ id: source[1], file: source[2], page: Number(source[3]), text: body });
        else preview.notes.push(body);
      }
      preview.text = (await disclosure.innerText()).trim();
      await disclosure.getByRole('button', { name: 'Send selected evidence' }).click();
      let id = '';
      await stored('a new saved answer', async () => {
        const fresh = (await answersOf(theOpenProject())).map((answer) => answer.answer_id)
          .filter((answer) => !before.includes(answer));
        id = fresh[0] ?? '';
        return fresh.length;
      }, (count) => count === 1, 60_000);
      await stored(`answer ${id} to finish, with its local cleanup confirmed`, () => answerOf(theOpenProject(), id),
        (answer) => TERMINAL_ANSWER_STATES.includes(String(answer.state)) && answer.cleanup_state === 'confirmed',
        150_000);
      await expect(dialog, 'the selection dialog outlived the Send it admitted').toHaveCount(0, { timeout: 30_000 });
      return { preview, answer: await readTheAnswerHere(id) };
    },

    openEachCitationOfTheAnswer: async (): Promise<OpenedCitation[]> => {
      const article = answerArticle();
      await expect(article).toBeVisible({ timeout: 30_000 });
      const buttons = article.getByRole('button', { name: /^Open citation / });
      const out: OpenedCitation[] = [];
      for (let i = 0; i < await buttons.count(); i += 1) {
        const label = (await buttons.nth(i).innerText()).trim();
        await buttons.nth(i).click();
        const excerpt = article.getByRole('region', { name: 'Saved citation excerpt' });
        await expect(excerpt.getByRole('heading', { name: `Frozen citation · ${label.split(' · ')[0]}` }))
          .toBeVisible({ timeout: 30_000 });
        // Either the current reader's verdict on the exact range, or the
        // excerpt's own alert when the current original could not be checked.
        const verdict = excerpt.locator('.evidence-resolution')
          .filter({ hasText: /^(Citation matched|Saved citation unresolved:)/ })
          .or(excerpt.getByRole('alert')).first();
        await expect(verdict, `${label} never said whether it matched the current text`)
          .toBeVisible({ timeout: 60_000 });
        const pane = excerpt.getByLabel('Canonical page text');
        out.push({
          label,
          frozen: (await excerpt.locator('pre').first().textContent()) ?? '',
          highlighted: (await pane.count())
            ? await pane.evaluate((element) => {
              const text = element as HTMLTextAreaElement;
              return text.value.slice(text.selectionStart, text.selectionEnd);
            })
            : '',
          resolution: (await verdict.innerText()).trim(),
        });
      }
      return out;
    },

    openTheSavedAnswer: async (answerId): Promise<SelectedAnswerView> => {
      const history = win().getByRole('region', { name: 'Saved answer history' });
      const row = history.getByRole('button').filter({ hasText: answerId });
      await expect(row, `the history lists no answer ${answerId}`).toBeVisible({ timeout: 60_000 });
      await row.click();
      return readTheAnswerHere(answerId);
    },

    exportTheOpenAnswerAsHtml: async (): Promise<ExportedFile> => {
      const article = answerArticle();
      await expect(article).toBeVisible({ timeout: 30_000 });
      downloadsMade += 1;
      const target = path.join(downloadsDir(), `selected-answer-${downloadsMade}.html`);
      await theNextDownloadGoesTo(target);
      await article.getByRole('button', { name: 'Export HTML', exact: true }).click();
      await expect(article.getByText(/^The selected HTML was handed to the browser download flow\./),
        'the page never said it handed the HTML over').toBeVisible({ timeout: 60_000 });
      await theDownloadHasCompleted(target);
      return { path: target, text: fs.readFileSync(target, 'utf8') };
    },

    closeTheApp: () => session.quit(),

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

    readTheSourceWall: async (): Promise<SourceWallView> => {
      await goto(PLACES['Source wall']);
      const served = await backend.sourceWall();
      const verdict = win().getByTestId('source-wall-verdict');
      // The record first, then the screen agreeing with it: the headline is
      // composed by the backend, so the page is loaded when it prints that one.
      await expect(verdict.locator('.source-wall-headline'), 'the wall never drew the verdict the app composed')
        .toHaveText(served.verdict.headline, { timeout: 60_000 });
      const rows = win().locator('table.source-wall-grid tbody tr');
      await expect(rows, 'the wall draws a different number of sources from the grid it was served')
        .toHaveCount(served.sources.length, { timeout: 30_000 });
      const legend = win().getByTestId('source-wall-legend').locator('li');
      const out: SourceWallView = {
        verdict: {
          level: String(await verdict.getAttribute('data-level')),
          headline: (await verdict.locator('.source-wall-headline').innerText()).trim(),
          detail: (await verdict.locator('.source-wall-detail-line').allInnerTexts()).map((t) => t.trim()),
        },
        window: (await win().getByTestId('source-wall-window').innerText()).trim(),
        legend: [],
        rows: [],
      };
      for (let i = 0; i < await legend.count(); i += 1) {
        const entry = legend.nth(i);
        out.legend.push({
          label: (await entry.locator('.source-wall-legend-name').innerText()).trim(),
          glyph: ((await entry.locator('.source-wall-swatch').textContent()) ?? '').trim(),
          count: Number((await entry.locator('.source-wall-legend-count').innerText()).trim()),
        });
      }
      for (let i = 0; i < await rows.count(); i += 1) {
        const row = rows.nth(i);
        const cells = row.getByTestId('source-wall-cell');
        const drawn: SourceWallCellView[] = [];
        for (let j = 0; j < await cells.count(); j += 1) {
          const cell = cells.nth(j);
          // `<source>, <run> <date>: <label>` — the label is what follows the
          // last colon; none of the backend's labels contains one.
          const announced = String(await cell.getAttribute('aria-label'));
          drawn.push({
            state: String(await cell.getAttribute('data-state')),
            glyph: ((await cell.textContent()) ?? '').trim(),
            label: announced.slice(announced.lastIndexOf(': ') + 2),
          });
        }
        out.rows.push({ source: (await row.locator('th[scope="row"]').innerText()).trim(), cells: drawn });
      }
      return out;
    },

    readTheSourceWallCell: async (source, column): Promise<SourceWallReading> => {
      await goto(PLACES['Source wall']);
      const served = await backend.sourceWall();
      const record = served.sources.find((row) => row.name === source);
      expect(record, `the wall was served no row for ${source}`).toBeTruthy();
      const row = win().locator('table.source-wall-grid tbody tr')
        .filter({ has: win().locator('th[scope="row"]', { hasText: new RegExp(`^${literally(source)}$`) }) });
      await expect(row, `the wall draws no single row for ${source}`).toHaveCount(1, { timeout: 60_000 });
      await row.getByTestId('source-wall-cell').nth(column).click();
      const pane = win().getByTestId('source-wall-detail');
      // The pane shows the backend's sentence for the cell; waiting for that
      // sentence is what tells two cells of the same source apart.
      await expect(pane.locator('.source-wall-reading-note'), 'the reading pane never showed this cell')
        .toHaveText(record!.cells[column].note, { timeout: 30_000 });
      const state = pane.locator('.source-wall-reading-state');
      const glyph = ((await state.locator('.source-wall-swatch').textContent()) ?? '').trim();
      return {
        head: (await pane.locator('.source-wall-reading-head').innerText()).trim(),
        label: ((await state.textContent()) ?? '').replace(glyph, '').trim(),
        note: (await pane.locator('.source-wall-reading-note').innerText()).trim(),
      };
    },

    // — the Atlas interface (J46, J47, J48): not this renderer's ---------------
    chooseTheme: async () => theClassicRendererHasNo('theme choice'),
    chooseAccent: async () => theClassicRendererHasNo('accent color'),
    readAppearance: async () => theClassicRendererHasNo('theme or accent'),
    readThePlate: async () => theClassicRendererHasNo('collection map'),
    readToday: async () => theClassicRendererHasNo('Today screen'),
    markAllRead: async () => theClassicRendererHasNo('Mark all read'),
  };
}
