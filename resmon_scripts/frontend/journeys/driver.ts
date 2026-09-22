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
  | 'Storage settings';

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

/* ========================================================================== *
 *  Slice 2b — the reading queue, the local API's own boundary, and the two
 *  rows whose journey is a gate rather than a screen.
 *
 *  Kept in one block at the end of the file on purpose: slice 2a is adding its
 *  own verbs to the same interface on its own branch, and two appended blocks
 *  merge where two interleaved edits would not. Nothing above this line
 *  changed meaning — a verb slice 1 wrote still does what its spec assumed.
 * ========================================================================== */

/** One paper in the reading queue, as the queue names it. */
export interface QueuedPaper {
  /** The document id the row carries — the same id the local API uses. */
  id: number;
  title: string;
  /** What the queue says its state is: `To read` or `Read`. */
  state: string;
}

/**
 * An answer to a request made **from outside the app**, over a plain socket.
 *
 * This is the one place the suite deliberately does not go through the app's
 * own transport. J42's journey is precisely that somebody other than this
 * renderer cannot get an answer, and a request sent with the app's own helper
 * would carry the app's own credentials and prove the opposite of the point.
 */
export interface RawAnswer {
  status: number;
  /** The `detail.reason` the guard names, where it names one. */
  reason: string | null;
  body: string;
}

/** A request the app made for itself, as a watcher outside the page sees it. */
export interface ObservedRequest {
  url: string;
  /** The `Authorization` header, or null where the request carried none. */
  authorization: string | null;
}

/** What an external MCP harness finds when it points itself at this app. */
export interface McpAnswer {
  /** `serverInfo` from the server's own `initialize`. */
  server: { name: string; version: string };
  /** The tools the server publishes over `tools/list`. */
  toolNames: string[];
  /** The length of `mcp_server.TOOLS` in the build under test — the denominator. */
  declaredToolCount: number;
  /** The `health` tool's own answer, as a harness receives it. */
  health: Record<string, any>;
}

/** One destination a routine's report goes to. */
export interface DeliveryDestination {
  id: number;
  channel: 'folder' | 'feed' | 'webhook';
  /** The folder or address the target was given. */
  destination: string;
}

/** One delivery, as the routine's own "Where did this go?" record shows it. */
export interface DeliveryRecord {
  id: number;
  channel: string;
  /** What the screen calls the state, in the words a person reads. */
  state: string;
  /**
   * The state the backend recorded, in its own vocabulary — `delivered`,
   * `awaiting_review`, `skipped`, `failed`.
   *
   * Both, because the row is "whether it got there" and the two halves are
   * different claims: a screen label a spec asserted on would be a renderer
   * coupling, and a stored token alone would not establish that anybody can
   * see it.
   */
  recorded: string;
  /** What the row says in its detail column — a timestamp, or an error. */
  detail: string;
}

export interface JourneyDriver {
  // — the reading queue (J28) ------------------------------------------------
  /** Save every paper this run found, from the run's own Papers tab. */
  savePapersFromRun(run: RunHandle): Promise<QueuedPaper[]>;
  /** The queue as the page shows it under one of its own filters. */
  readReadingQueue(filter: 'to read' | 'read' | 'all'): Promise<QueuedPaper[]>;
  /** Mark this paper read, from its row. */
  markPaperRead(paper: QueuedPaper): Promise<void>;
  /** Take this paper out of the queue, from its row. */
  removeFromReadingQueue(paper: QueuedPaper): Promise<void>;
  /** Tick these papers in the queue and export them in this format. */
  exportReadingQueue(papers: QueuedPaper[], format: 'bibtex' | 'ris' | 'csv'): Promise<string>;
  /** Every paper title the Explorer lists — what the corpus still holds. */
  readExplorerTitles(): Promise<string[]>;

  // — the local API's own boundary (J42) -------------------------------------
  /**
   * Ask this app's backend from outside the app, over a plain socket.
   *
   * `token: 'none'` sends nothing; `'this app'` reads the token file this
   * instance published. `host` overrides the `Host` header, which is how a
   * rebound hostname is tried.
   */
  askOverTheRawSocket(request: {
    route: string; token: 'none' | 'this app'; host?: string;
  }): Promise<RawAnswer>;
  /** Go to this place and report every backend request the app made getting there. */
  observeOwnRequests(place: Place): Promise<ObservedRequest[]>;

  // — delivery (J40) ---------------------------------------------------------
  /**
   * Give this routine somewhere to send its report.
   *
   * A `folder` or `feed` destination with no `destination` gets a fresh
   * directory of this session's own, because those two channels refuse a
   * directory that does not already exist — resmon does not create folders
   * inside somebody's Dropbox — and the answer says which directory it used.
   */
  addDeliveryTarget(routine: string, target: {
    channel: 'folder' | 'feed' | 'webhook';
    destination?: string;
    mode?: 'automatic' | 'review';
  }): Promise<DeliveryDestination>;
  /**
   * The routine's own delivery record, from its "Where did this go?" panel,
   * once every delivery has stopped moving.
   */
  readDeliveryRecord(routine: string): Promise<DeliveryRecord[]>;
  /** Press Skip on this delivery's row. */
  skipDelivery(routine: string, delivery: DeliveryRecord): Promise<void>;
  /** Every file under a folder destination, by path relative to it. */
  readDeliveredFiles(destination: string): Promise<string[]>;
  /** The Atom file a feed destination holds, as bytes on disk. */
  readFeedFile(destination: string): Promise<{ path: string; text: string }>;

  // — an external harness (J44) ----------------------------------------------
  /**
   * Start the build's own MCP server against this app's state directory, as a
   * harness would, and ask it who it found and what it can do.
   */
  askTheMcpServer(): Promise<McpAnswer>;
}

/**
 * The two rows whose journey is a gate rather than a screen (J43, and J16 next
 * door in slice 2a).
 *
 * Re-exported from the seam because a spec may import this module and nothing
 * else — `register.spec.ts` enforces that, and it is what stops a spec reaching
 * for `child_process` and building its own idea of what the gate is. There is
 * no renderer in this path and therefore no driver: a candidate build runs
 * exactly the same gate out of its own checkout.
 */
export { runGate } from './fixtures/gates';
export type { GateOutcome } from './fixtures/gates';
