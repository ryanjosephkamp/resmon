/**
 * The seam.
 *
 * A journey spec says what a person does and what they must then be able to
 * see. It never says which element that is. Everything below is written in the
 * words of the register's journeys — "run a dive", "read the coverage
 * sentence", "back up now" — and a driver behind it maps those onto one
 * renderer. `drivers/classic.ts` does it for the renderer resmon ships today;
 * when the 3.0 renderer exists it supplies a second driver and every spec in
 * this directory runs against it without being rewritten.
 *
 * That is the whole point of the suite, so it is enforced rather than asked
 * for: `register.spec.ts` greps every spec file in this directory for a
 * renderer call and for an import of anything but this module, and fails on a
 * hit. A spec that reaches the renderer directly is a spec that will have to be
 * rewritten, and the cost of rewriting forty-four of them is the reason the 3.0
 * redesign has a parity register at all.
 *
 * **Backend facts do not come off the screen.** `resmon.backend` reads them
 * over the app's own local HTTP API, with the app's own token, because the API
 * is the contract a renderer rebuild does not change and a database file is not
 * a user journey. Reading SQLite directly would also make the suite unable to
 * run against an installed app, which it one day has to.
 */
import { test as base, expect } from '@playwright/test';
import { createDriver, driverName } from './drivers';
import { armExitProbe } from './fixtures/exit-probe';
import type { SourceReply } from './fixtures/source-endpoint';

export { expect };

/** Where a person is in the app, named as the sidebar names it. */
export type Place =
  | 'Deep Dive'
  | 'Deep Sweep'
  | 'Routines'
  | 'Explorer'
  | 'Results'
  | 'Monitor'
  | 'Calendar'
  | 'Saved configurations'
  | 'Storage settings'
  // — slice 2a ---------------------------------------------------------------
  // Kept in their own block so slice 2b's additions are a union rather than a
  // conflict. Every one of these is a row in `frontend/src/routes.ts`; a place
  // that is not in that table cannot be reached by a person either.
  | 'Analytics'
  | 'Watchdog'
  | 'Watch Profiles'
  | 'Repositories'
  | 'AI settings'
  | 'Email settings'
  | 'Notification settings'
  | 'Cloud Storage settings'
  | 'Advanced settings'
  | 'Tutorials';

/** One run, as the app and the API both identify it. */
export interface RunHandle {
  readonly id: number;
}

export interface DiveRequest {
  /** A source slug, as the Repositories page names it. */
  source: string;
  keywords: string[];
  /** How far back to look. Omitted means the form's own default. */
  days?: number;
  /** The result cap. Omitted means the form's own default. */
  cap?: number;
}

export interface SweepRequest {
  sources: string[];
  query: string;
  cap?: number;
}

/** What a screen says about one source of one run. */
export interface SourceOutcome {
  /** The source slug the screen attributes the line to. */
  source: string;
  /** The short verdict — "answered", "did not answer", "no API key configured". */
  label: string;
  /** The sentence underneath it, where the screen shows one. */
  note: string;
}

export interface RunFacts {
  status: string;
  /** The reason a stopped run gives for stopping, where it has one. */
  interruptedReason: string | null;
}

export interface RoutineFacts {
  name: string;
  active: boolean;
  desktopNotification: boolean;
}

/** The "Why am I seeing this?" panel, read as a person reads it. */
export interface WhyPanel {
  /** Every keyword the panel says matched, with the field it says it matched in. */
  matches: { keyword: string; field: string }[];
  /** Everything the panel says resmon cannot see. */
  cannotSee: string[];
  /** The whole panel's text, for an assertion no structured read covers. */
  text: string;
}

/** One upcoming fire the calendar holds. */
export interface UpcomingFire {
  /** The routine the event names. */
  routine: string;
  /** When the calendar says it fires, in the machine's own timezone. */
  when: Date;
  title: string;
  /** Whether the month currently on screen actually draws this one. */
  drawn: boolean;
}

/** An interrupted run's row, as Results renders it. */
export interface InterruptedRow {
  badge: string;
  /** The sentence under the badge: why it stopped and when it was last seen. */
  note: string;
}

export interface BackupResult {
  /** The bundle directory the app reports writing. */
  directory: string;
  /** The manifest, as the app wrote it. */
  manifest: Record<string, unknown>;
}

/** The one-time card a restored app shows about what it did not bring back. */
export interface RestoreCard {
  text: string;
  /** The credential entries the card says the user must re-enter. */
  keyringEntries: string[];
}

/** The counts a person would compare across a restore. */
export interface CorpusCounts {
  documents: number;
  executions: number;
  routines: number;
}

/**
 * Facts read over the app's own local API with the app's own token.
 *
 * Named methods rather than a URL a spec passes in: a spec that could name a
 * path could name a renderer route, and then the seam has a hole in it.
 */
export interface BackendFacts {
  /** The port the app's own backend answers on. Never the daemon's. */
  port(): Promise<string>;
  health(): Promise<Record<string, any>>;
  execution(run: RunHandle): Promise<Record<string, any>>;
  executions(): Promise<Record<string, any>[]>;
  /** The reproducible search record — per-source outcomes and zero reasons. */
  searchRecord(run: RunHandle): Promise<Record<string, any>>;
  routines(): Promise<Record<string, any>[]>;
  /** Documents, executions and routines: what a person compares over a restore. */
  corpusCounts(): Promise<CorpusCounts>;
  /**
   * Every zero reason the build under test knows, from its own source.
   *
   * This is the denominator for "the recorded reason is one of the zero
   * reasons": a list read out of the build being measured, not a list typed
   * into a spec that would go stale the first time somebody adds a reason.
   */
  zeroReasonVocabulary(): Promise<string[]>;
  /**
   * Whether the backend answering this window is a child of this window's own
   * Electron process — the difference between "a resmon" and "this resmon".
   * `null` where the machine cannot be asked (no `ps`).
   */
  ownedByThisApp(): Promise<boolean | null>;

  // — slice 2a ---------------------------------------------------------------

  /**
   * Every route the backend under test actually serves, from its own OpenAPI
   * document.
   *
   * The denominator for "the app does not offer X at all". A grep of the
   * repository would answer a question about a checkout; this answers the
   * question about the process that is running, which is the one a person
   * meets.
   */
  routeInventory(): Promise<string[]>;
  /** What the app says about the daemon service it could install. */
  serviceStatus(): Promise<Record<string, any>>;
  /**
   * What the app finds when it actually looks for a running daemon.
   *
   * Independent of `serviceStatus()` on purpose: that one answers "is a unit
   * installed for this user", which is a fact about the machine, and this one
   * answers "is one listening for this state directory", which is the fact B3
   * cares about.
   */
  daemonStatus(): Promise<Record<string, any>>;
  /** Every source the catalog holds, as the Repositories page is served it. */
  sourceCatalog(): Promise<Record<string, any>[]>;
  /** What the backend says about the semantic index: present, and why not when absent. */
  embeddingsStatus(): Promise<Record<string, any>>;
  /** The watchdog's findings, as the Watchdog page is served them. */
  watchdogFindings(): Promise<Record<string, any>>;
  /** The saved watch profiles. */
  profiles(): Promise<Record<string, any>[]>;
  /** Every stored credential, as the Repositories page is told about them. */
  credentials(): Promise<Record<string, any>>;
  /** The onboarding card's state: whether it is still owed, and what retired it. */
  onboarding(): Promise<Record<string, any>>;
  /** The saved AI settings — which lane is on, and which model. */
  aiSettings(): Promise<Record<string, any>>;
  /** The near-duplicate link scan's state and what it has found. */
  linkStatus(): Promise<Record<string, any>>;
  /**
   * Ask the backend to erase the corpus with this word.
   *
   * The Danger Zone's refusal has to be the backend's rather than the screen's:
   * a disabled button is a courtesy, and an endpoint that erased a corpus for
   * anybody who asked would pass a journey that only watched the button.
   */
  eraseCorpus(word: string): Promise<Record<string, any>>;
}

// — slice 2a ---------------------------------------------------------------
//
// Kept in one block, with slice 2b building its own alongside, so the two
// deliveries merge as a union. Every name below is what the *person* does or
// reads; where the app has no user path for a step, the method says so in its
// comment and the spec's ledger row records it.

/** What the Advanced tab says about the background service. */
export interface DaemonPanel {
  /** The status sentence, as the panel writes it. */
  status: string;
  /** Whether the control that installs and removes the service is on screen at all. */
  controlPresent: boolean;
  /** Whether that control is currently set to "installed". */
  controlOn: boolean;
  /** The whole panel, for an assertion no structured read covers. */
  text: string;
}

/** One labelled figure on a screen — a tile, a bar, a row. */
export interface Figure {
  label: string;
  value: string;
}

/** What the Analytics page draws. */
export interface AnalyticsView {
  /** Every card's heading, in the order the page stacks them. */
  headings: string[];
  /** The corpus tiles: `Papers`, `Authors`, `Sources used`, `DOI coverage`. */
  tiles: Figure[];
  /** Per-source contribution, as the bars label it. */
  sources: Figure[];
  /** Every card that says it has not enough data to draw yet. */
  notEnoughYet: string[];
}

/** One thing the Watchdog says. */
export interface WatchdogFinding {
  /** The severity chip: `Broken`, `Looks unusual` or `Advice`. */
  severity: string;
  /** `Source · arxiv`, as the card writes it. */
  scope: string;
  title: string;
  muted: boolean;
}

export interface WatchdogView {
  /** The single verdict card's heading. */
  verdict: string;
  findings: WatchdogFinding[];
  /** Every scope the page says it cannot judge yet, with its reason. */
  notEnoughHistory: string[];
  /** The Muted section's own heading, or '' when there is none. */
  mutedHeading: string;
}

/** A watch profile as the editor previews it and the list shows it. */
export interface ProfileCreation {
  id: number;
  /** The sentence the editor showed about what its matches will mean. */
  warningAtCreation: string;
  /** The chip the saved profile carries in the list, or '' when it carries none. */
  chipInList: string;
}

/** What a profile's own page says about the papers it matched. */
export interface ProfileMatches {
  /** `3 paper(s): 1 ORCID match, 2 name only`, as the page writes it. */
  counts: string;
  /** Per paper: the basis chip and the author string the match recorded. */
  items: { basis: string; author: string; title: string }[];
}

/** The Explorer's own account of a page of papers. */
export interface ExplorerList {
  /** The sentence above the list: `2 papers in your corpus`. */
  countSentence: string;
  /** One entry per row on screen. */
  rows: {
    title: string;
    /** Every "also appears in …" label the row carries. */
    alsoAppearsAs: string[];
    /** The distance the row shows when the list is ranked, or ''. */
    distance: string;
  }[];
  /** The note the page prints when rows have been folded together, or ''. */
  collapseNote: string;
}

/** What the Explorer says about a ranked list. */
export interface RankedList {
  /** `Closest to: … — using … · N ranked, M not embedded yet and listed last`. */
  note: string;
  /** Whether the semantic controls are on screen at all. */
  controlsPresent: boolean;
  list: ExplorerList;
}

/** The coverage audit panel, read as a person reads it. */
export interface CoverageAudit {
  /** `Comparing against …` plus what the panel says about that choice. */
  intent: string;
  /** The reason the panel gives for having nothing to show, or ''. */
  reason: string;
  /** The `Showing 25 of N.` line under each list, or '' where the list is short enough. */
  offTargetShowing: string;
  missedShowing: string;
  /** What the panel says it cannot see. */
  cannotSee: string;
  /** The whole panel. */
  text: string;
}

/** What a stored credential looks like when it is read back. */
export interface KeyField {
  /** The catalog name of the source the field belongs to. */
  source: string;
  /** What the field shows when it is not being edited — the mask, where one is shown. */
  shown: string;
  /** What the field's value actually is. A stored key must never be here. */
  value: string;
}

/** The card a fresh install shows about what it has not been given yet. */
export interface FirstRunCard {
  present: boolean;
  /** One entry per step, with the mark the card draws beside it. */
  steps: { id: string; mark: string; text: string }[];
  /** The whole card. */
  text: string;
}

/** One turn with the assistant, as the panel shows it. */
export interface AssistantTurn {
  /** Everything the assistant said, bubble by bubble. */
  said: string[];
  /** The tool rows the panel drew, by the short name it printed. */
  toolCalls: string[];
  /** The approval card's exact call line, or '' when no card is being held. */
  approvalCall: string;
  /** What the approval card says the call would do, in a sentence. */
  approvalTitle: string;
  /** The error banner, or ''. */
  error: string;
}

/** The result of running an existing gate as a subprocess. */
export interface GateRun {
  /** The command, as it was run. */
  command: string;
  exitCode: number | null;
  output: string;
}

/**
 * Everything a journey does.
 *
 * Every method is one thing a person does or one thing they read. Adding a
 * method is fine; adding a selector to a spec is not.
 */
export interface JourneyDriver {
  /** Which renderer is under test — `classic` or `candidate`. */
  readonly name: string;

  // — where the person is ----------------------------------------------------
  open(place: Place): Promise<void>;
  /** Close the window and open it again over the same state, as a person would. */
  reopenTheApp(): Promise<void>;
  /** A picture of what is on screen now, into the run's artifact directory. */
  takePicture(name: string): Promise<void>;

  // — the shell --------------------------------------------------------------
  /** What the header says about the backend this window is talking to. */
  readConnectedIdentity(): Promise<{ status: string; details: string }>;

  // — running ----------------------------------------------------------------
  runDive(request: DiveRequest): Promise<RunHandle>;
  runSweep(request: SweepRequest): Promise<RunHandle>;
  waitForRunToSettle(run: RunHandle): Promise<RunFacts>;
  /**
   * Per-source outcomes as the live run panel shows them. With
   * `{ settled: true }`, wait until no source is still pending or being
   * queried — the panel a person is left looking at when the run is over.
   */
  readRunPanelOutcomes(run: RunHandle, options?: { settled?: boolean }): Promise<SourceOutcome[]>;
  /** Stop a running sweep from the Monitor, as the row's button does. */
  cancelRunFromMonitor(run: RunHandle): Promise<void>;
  /** Let a held authored source answer. */
  releaseTheSource(): void;

  // — reports ----------------------------------------------------------------
  openReport(run: RunHandle): Promise<void>;
  /** The report's one-line account of who answered and who could not. */
  readCoverageSentence(run: RunHandle): Promise<string>;
  /** Per-source outcomes as the report's own table shows them. */
  readReportOutcomes(run: RunHandle): Promise<SourceOutcome[]>;
  /** The tabs the report viewer offers, in the order it offers them. */
  readReportTabs(): Promise<string[]>;
  /** Does this run have a report at all, and does it have content? */
  reportExists(run: RunHandle): Promise<boolean>;
  /** Select these runs in Results and export their references in this format. */
  exportReferences(runs: RunHandle[], format: 'bibtex' | 'ris' | 'csv'): Promise<string>;

  // — routines ---------------------------------------------------------------
  createRoutine(routine: { name: string; cron: string; sources: string[]; keywords: string[] }): Promise<number>;
  activateRoutine(name: string): Promise<void>;
  deactivateRoutine(name: string): Promise<void>;
  /** Fire the routine now, and return the execution it produced. */
  fireRoutineNow(name: string): Promise<RunHandle>;
  /** Flip the desktop-notification switch on the routine's own row. */
  toggleDesktopNotification(name: string): Promise<void>;
  readRoutine(name: string): Promise<RoutineFacts>;
  /** Do the routines still exist, by name? */
  listRoutineNames(): Promise<string[]>;

  // — the corpus -------------------------------------------------------------
  /** Open the first paper the Explorer lists, and return its title. */
  openFirstPaper(): Promise<string>;
  /** Open "Why am I seeing this?" for the paper that is open, and read it. */
  readWhyPanel(): Promise<WhyPanel>;

  // — the calendar -----------------------------------------------------------
  readUpcomingFires(): Promise<UpcomingFire[]>;

  // — saved configurations ---------------------------------------------------
  saveConfiguration(name: string, from: { sources: string[]; query: string }): Promise<number>;
  /**
   * Export every saved configuration, and return what is inside the file the
   * app wrote: one entry per member, keyed by the member's name.
   */
  exportConfigurations(): Promise<Record<string, string>>;
  /** Import a configuration file's text back, and return how many arrived. */
  importConfigurations(text: string): Promise<number>;

  // — storage ----------------------------------------------------------------
  backUpNow(options: { reports: boolean }): Promise<BackupResult>;
  /** Restore this bundle into a fresh state directory, through the real startup path. */
  restoreIntoFreshState(bundle: BackupResult): Promise<void>;
  readRestoreCard(): Promise<RestoreCard>;

  // — a run whose process died ----------------------------------------------
  /** Kill the backend the app spawned, as a force-quit would. */
  killTheBackend(): Promise<void>;
  readInterruptedRow(run: RunHandle): Promise<InterruptedRow>;
  /** Press Restart on that row, and return the run it started. */
  restartRun(run: RunHandle): Promise<RunHandle>;

  // — facts ------------------------------------------------------------------
  readonly backend: BackendFacts;

  // — slice 2a ---------------------------------------------------------------
  //
  // One block, so slice 2b's verbs merge beside these rather than through them.

  /** Everything the place a person is looking at actually says. */
  readWhatThisPlaceSays(): Promise<string>;
  /** Every place the sidebar offers, in the order it offers them. */
  readSidebarPlaces(): Promise<string[]>;
  /** The tabs the place a person is on offers, in order. */
  readTabsHere(): Promise<string[]>;
  /** Open this page's own help block and read it. */
  readTheHelpOnThisPage(): Promise<string>;

  /** What Settings → Advanced says about the background service. Installs nothing. */
  readDaemonPanel(): Promise<DaemonPanel>;

  /** What the Analytics page draws for the corpus it has. */
  readAnalytics(): Promise<AnalyticsView>;
  /**
   * Press the button that measures keyword yield, and read what the card then
   * draws — either the per-keyword bars, or the sentence it prints when the
   * corpus is too small for a share to mean anything.
   */
  measureKeywordYield(): Promise<{ bars: Figure[]; notEnoughYet: string }>;
  /**
   * Follow the link a chart offers into the Explorer, and report where it
   * landed and what it filtered to.
   */
  followTheChartIntoTheExplorer(): Promise<{ hash: string; list: ExplorerList }>;

  /** What the Watchdog says right now. */
  readWatchdog(): Promise<WatchdogView>;
  /** Press Mute on the finding whose title contains this. */
  muteTheFinding(titleFragment: string): Promise<void>;
  /** Make the authored source fail every request from now on, as an outage does. */
  theSourceGoesDown(): void;
  /** Make the authored source answer again. */
  theSourceComesBack(): void;

  /** Fill in the new-profile editor and save it, reading its live warning first. */
  createWatchProfile(profile: { name: string; orcid?: string }): Promise<ProfileCreation>;
  /** Open a profile and read what it says about the papers it matched. */
  readProfileMatches(name: string): Promise<ProfileMatches>;
  /** The basis chips the Explorer draws beside its papers. */
  readBasisBadgesInTheExplorer(): Promise<string[]>;

  /** The Explorer's list, as it stands. */
  readExplorerList(): Promise<ExplorerList>;
  /** Turn ranking by meaning on, against a deterministic model on loopback. */
  enableRankingByMeaning(): Promise<string>;
  /** Sort the Explorer by how close each paper is to this phrase, using the control. */
  rankTheExplorerBy(phrase: string): Promise<RankedList>;
  /** Scan the corpus for papers that look like the same work, and wait for it. */
  scanForNearDuplicates(): Promise<{ links: number; byMethod: Record<string, number> }>;
  /** Tick or untick "Collapse duplicates". */
  collapseDuplicates(on: boolean): Promise<void>;

  /** Write the sentence saying what a routine is really for. */
  writeRoutineIntent(name: string, intent: string): Promise<void>;
  /** Open "Is this finding what I meant?" on a routine and read it. */
  readCoverageAudit(name: string): Promise<CoverageAudit>;

  /** Save a key for a source, through the field a person types into. */
  saveKeyFor(source: string, value: string): Promise<void>;
  /** Read back every key field on the Repositories page. */
  readKeyFields(): Promise<KeyField[]>;
  /** One source's details, as the Repositories page opens them. */
  readSourceDetails(source: string): Promise<Record<string, string>>;
  /** The credits the page shows unconditionally, because their sources require them. */
  readRequiredAttributions(): Promise<string[]>;

  /**
   * Point the assistant at an authored agent command, the way Settings → AI
   * points it at a real one, and reopen the window so the panel re-reads it.
   *
   * The command is the repository's own `fake_claude.py`, which speaks the
   * agent-CLI protocol and makes real tool calls into this app's own backend
   * over real HTTP. What it replaces is the model; the permission round trip,
   * the MCP call, the SQLite write and everything the panel draws are the app's.
   */
  useAnAuthoredAgentCommand(): Promise<void>;
  /** Open the assistant, send this, and read what the panel shows. */
  askTheAssistant(text: string): Promise<AssistantTurn>;
  /** Answer the approval card the assistant is holding, and read the panel again. */
  answerTheApprovalCard(allow: boolean): Promise<AssistantTurn>;
  /** Every saved conversation the assistant's own drawer lists. */
  readSavedConversations(): Promise<string[]>;

  /** The card a fresh install shows on the Dashboard, or its absence. */
  readTheFirstRunCard(): Promise<FirstRunCard>;
  /** Press Skip on it, and wait for the app to have saved that. */
  skipTheFirstRunCard(): Promise<void>;

  /** Type the Danger Zone's word into this action and confirm it. */
  eraseWith(action: string, word: string): Promise<{ status: number; body: string }>;

  /** Every frame this place embeds. The expected answer is none. */
  framesHere(): Promise<number>;
  /** Every external link this place offers, with where it points. */
  readExternalLinks(): Promise<{ text: string; href: string }[]>;

  /**
   * Run one of the repository's own gates as a subprocess, under the
   * interpreter the build under test runs its backend with.
   *
   * The row's evidence stays the real gate. Re-implementing it here would be a
   * second thing to keep in step, and the one that drifted would be this one.
   */
  runTheGate(args: string[]): Promise<GateRun>;

  /** Every connection the run's guard refused. The expected answer is none. */
  refusedConnections(): { host: string; port: number }[];
}

export interface JourneyOptions {
  /** How the authored source answers this journey. Defaults to one record. */
  sourceReply: SourceReply;
}

export interface JourneyFixtures {
  resmon: JourneyDriver;
}

interface JourneyWorkerFixtures {
  /**
   * Nothing during the run; after the worker's last case, a probe that says
   * what is still holding the worker open if it fails to exit. Auto, because a
   * worker that hangs is a property of the suite rather than of one spec.
   */
  exitProbe: void;
}

/**
 * The test object every journey spec uses.
 *
 * Test-scoped rather than worker-scoped, unlike `e2e/`: three of these rows
 * kill a backend, restore over a state directory or relaunch the window, and a
 * shared app would make the rest of the suite depend on the order those ran in.
 * A launch costs seconds; a suite whose failures depend on ordering costs an
 * afternoon each time.
 */
export const journey = base.extend<JourneyOptions & JourneyFixtures, JourneyWorkerFixtures>({
  sourceReply: ['paper', { option: true }],

  exitProbe: [async ({}, use) => {
    await use();
    armExitProbe();
  }, { scope: 'worker', auto: true }],

  resmon: async ({ sourceReply }, use, testInfo) => {
    const driver = await createDriver({ sourceReply, testInfo });
    try {
      await use(driver.api);
    } finally {
      await driver.close();
    }
  },
});

export { driverName };
