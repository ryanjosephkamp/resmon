/**
 * The journey driver for the Atlas interface: the journeys Atlas can take so
 * far, in its own markup.
 *
 * It is partial on purpose, and `candidate.ts` says so out loud for the rest:
 * a journey this file does not implement is skipped with the reason "not in
 * Atlas yet", never driven through the classic renderer and never failed. The
 * run's skip count is then the measurement the switch-over waits on.
 *
 * Every method waits for a state before it reads the screen, as the classic
 * driver's guard requires of that file.
 */
import { execFileSync } from 'child_process';
import { createHash } from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { expect, type Locator, type TestInfo } from '@playwright/test';
import type {
  AnalyticsView, AssistantPanelFacts, BackupResult, FirstRunCard, KeyField, ObservedRequest, RestoreCard, AssistantTurn, BackendFacts, ComposerChoice, LibraryItem, SavedTranscript, TurnChoiceFacts, VaultOnDisk, ConfigurationExport, CoverageAudit, DaemonPanel, DeliveryRecord,
  DrawnAppearance, EmailSettings, EvidenceBundle, EvidencePageView, ReopenedPassage, SavedEvidenceNote,
  OpenedCitation, SelectedAnswerPreview, SelectedAnswerView,
  ExplorerList, ExportedFile, ImportOutcome, InterruptedRow, JourneyDriver, NotificationPreferences, Place,
  PlateReading, ProfileCreation, ProfileMatches, QueuedPaper, RankedList, RoutineFacts, RunHandle, RunNowAnswer,
  SourceOutcome, SourceWallCellView, SourceWallReading, SourceWallView, ThemeChoice, TodayReading, UpcomingFire,
  WatchdogFinding, WatchdogView, WhyPanel,
} from '../driver';
import type { DeliveryDestination, EmbeddingBackfill, EmbeddingProviderChoice } from '../driver';
import type { SharedWordingGroup, SharedWordingPairReading, SharedWordingReading } from '../driver';
import { writeTheAuthoredAgentCommand, writeTheLapsedSummarizer } from '../fixtures/authored-commands';
import { JOURNEY_EMBEDDING_MODEL, startEmbeddingEndpoint } from '../fixtures/embedding-endpoint';
import { startProviderEndpointFor } from '../fixtures/provider-endpoint';
import { startSelectedAnswerEndpointFor } from '../fixtures/selected-answer-endpoint';
import type { Session } from './session';

/** The hash behind each place Atlas has. */
const ATLAS_PLACES: Partial<Record<Place, string>> = {
  Today: '/today',
  'Appearance settings': '/settings',
  // Routines and the calendar are both Watches in Atlas: each watch on its
  // Searches tab, and the month ahead's fires on its Calendar tab.
  Routines: '/watches',
  Calendar: '/watches/calendar',
  'Watch Profiles': '/watches/people',
  // Atlas lists every source with its limits, and whether it can be asked
  // about a person, where a person chooses sources: Ask the sources.
  Repositories: '/search/ask',
  // Settings is one group at a time; the background service is "In the
  // background", where the classic interface had it under Advanced.
  'Advanced settings': '/settings/background',
  'Email settings': '/settings/email',
  'Notification settings': '/settings/notifications',
  // Saved configurations are Search › Saved: the searches saved from Ask the
  // sources and the copy kept of every watch.
  'Saved configurations': '/search/saved',
  // Health: the Source wall is the section itself, and the watchdog its second tab.
  'Source wall': '/health',
  Watchdog: '/health/watchdog',
  Analytics: '/health/analytics',
  // Ask is the assistant and its saved conversations in one place: the
  // conversations are the rail beside the one open.
  Chats: '/ask',
  'AI settings': '/settings/ai',
  // The explorer is Search › Your collection, and a run's results are opened
  // from the run log beside Ask the sources.
  Explorer: '/search',
  Results: '/search/ask',
  'Storage settings': '/settings/storage',
  Tutorials: '/settings/tutorials',
};

/** The Email group's fields, by the journey's word for each. */
const EMAIL_FIELD: Record<keyof EmailSettings, string> = {
  server: '#smtp-server',
  port: '#smtp-port',
  username: '#smtp-username',
  sender: '#smtp-from',
  recipients: '#smtp-to',
};

/** The words each theme card is labeled with in Settings. */
const THEME_CARD: Record<ThemeChoice, string> = {
  system: 'Follow the system',
  light: 'Light',
  dark: 'Dark',
};

export type AtlasDriver = Pick<JourneyDriver,
  'open' | 'reopenTheApp' | 'chooseTheme' | 'chooseAccent' | 'readAppearance' | 'readThePlate'
  | 'readToday' | 'markAllRead' | 'scanForSharedWording' | 'openTheSharedWordingPair'
  | 'runDive' | 'runSweep' | 'readRunPanelOutcomes' | 'cancelRunFromMonitor' | 'openReport' | 'readReportTabs'
  | 'readCoverageSentence' | 'readReportOutcomes' | 'exportReferences' | 'readInterruptedRow' | 'restartRun'
  | 'rankTheExplorerBy' | 'readExplorerList' | 'readExplorerTitles' | 'collapseDuplicates' | 'openFirstPaper'
  | 'enableRankingByMeaning' | 'chooseAnEmbeddingProvider' | 'embedThePapersStillMissing'
  | 'readWhyPanel' | 'savePapersFromRun' | 'readReadingQueue' | 'markPaperRead' | 'removeFromReadingQueue'
  | 'exportReadingQueue'
  | 'listRoutineNames' | 'readRoutine' | 'activateRoutine' | 'deactivateRoutine' | 'toggleDesktopNotification'
  | 'readUpcomingFires' | 'runNowControlIsOnTheRow' | 'askForThisRoutineToRunNow' | 'readDeliveryRecord'
  | 'skipDelivery' | 'readCoverageAudit' | 'writeRoutineIntent'
  | 'createWatchProfile' | 'readProfileMatches' | 'readBasisBadgesInTheExplorer' | 'readTheHelpOnThisPage'
  | 'readWhatThisPlaceSays'
  | 'readDaemonPanel' | 'saveConfiguration' | 'exportConfigurations' | 'importConfigurations'
  | 'configureEmail' | 'readEmailSettings' | 'sendATestEmail' | 'setNotificationPreferences'
  | 'readNotificationPreferences'
  | 'readTheSourceWall' | 'readTheSourceWallCell' | 'readWatchdog' | 'muteTheFinding' | 'readConnectedIdentity'
  | 'readAnalytics' | 'measureKeywordYield' | 'followTheChartIntoTheExplorer'
  | 'chooseAParentFolderForTheLibrary' | 'createTheManagedVault' | 'importIntoTheLibrary' | 'readTheLibraryItems'
  | 'associateTheLibraryItemWithPaper' | 'readTheVaultOnDisk'
  | 'startAnEvidenceProjectFrom' | 'addToTheEvidenceProject' | 'openTheEvidenceProject' | 'readTheEvidencePage'
  | 'saveAnEvidencePassage' | 'saveAnEvidenceNote' | 'readTheSavedEvidenceNotes' | 'reopenTheSavedPassage'
  | 'exportSelectedEvidence'
  | 'askFromSelectedEvidence' | 'openEachCitationOfTheAnswer' | 'openTheSavedAnswer' | 'exportTheOpenAnswerAsHtml'
  | 'askTheAssistant' | 'answerTheApprovalCard' | 'readSavedConversations' | 'openTheAssistantWithTheKeyboard'
  | 'readTheAssistantPanel' | 'readTheChatsPage' | 'openTheSavedChat' | 'exportTheOpenChat'
  | 'fixTheChoicesForThisConversation' | 'readTheComposerChoices' | 'readTheTurnsChoices'
  | 'setTheAppWideAssistantDefaults' | 'readAiLaneStatus' | 'readRunLog' | 'readTheReport'
  | 'observeOwnRequests' | 'readSidebarPlaces' | 'readTheFirstRunCard' | 'skipTheFirstRunCard' | 'eraseWith'
  | 'saveKeyFor' | 'readKeyFields' | 'readSourceDetails' | 'readRequiredAttributions'
  | 'readTabsHere' | 'framesHere' | 'readExternalLinks' | 'chooseGoogleDrivesFolderForBackups' | 'backUpNow'
  | 'readRestoreCard'
  // The setup a person does on a screen, taken through Atlas's own.
  | 'createRoutine' | 'fireRoutineNow' | 'addDeliveryTarget' | 'restoreIntoFreshState'
  | 'useAnAuthoredAgentCommand' | 'useAnAuthoredAgentCommandThatRecordsItsArguments' | 'useAnAuthoredProviderOnAKey'
  | 'useAnAuthoredSummarizerThatIsNotSignedIn' | 'useAnAuthoredModelForSelectedAnswers'>;

/** The reading-queue filter buttons, by the journey's word for each. */
const QUEUE_FILTER: Record<'to read' | 'read' | 'all', string> = { 'to read': 'To read', read: 'Read', all: 'All' };

/**
 * The journey's words for each state the run's live panel draws. The panel
 * says "12 found" or "did not answer"; the journeys were written against the
 * first run panel's vocabulary, and the state underneath is the same one.
 */
const PANEL_WORDS: Record<string, string> = {
  pending: 'pending',
  asking: 'querying',
  answered: 'done',
  no_answer: 'no answer',
  not_queried: 'not queried',
  not_recorded: 'reason not recorded',
  error: 'error',
  cancelled: 'cancelled',
  not_reached: 'not asked',
};

/** A string as a regular expression that matches exactly it. */
function literally(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function isoDate(at: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}`;
}

/** A schedule as the watch editor offers it: the cadence's button, the time, and the day where it has one. */
interface EditorSchedule {
  cadence: 'Every day' | 'Weekdays' | 'Once a week' | 'Once a month';
  time: string;
  weekday?: string;
  monthDay?: string;
}

/**
 * The watch editor's choice that stores this cron expression, or null where
 * it offers none. The editor stores `M H * * *` for Every day, `M H * * 1-5`
 * for Weekdays, `M H * * D` for Once a week and `M H D * *` (days 1 to 28) for
 * Once a month, and nothing else; a journey asking for another schedule is
 * asking for one a person cannot make there, and the step says so.
 */
function editorSchedule(cron: string): EditorSchedule | null {
  const fields = cron.trim().split(/\s+/);
  if (fields.length !== 5) return null;
  const [minute = '', hour = '', day = '', month = '', weekday = ''] = fields;
  if (!/^\d{1,2}$/.test(minute) || !/^\d{1,2}$/.test(hour) || month !== '*') return null;
  if (Number(minute) > 59 || Number(hour) > 23) return null;
  const time = `${hour.padStart(2, '0')}:${minute.padStart(2, '0')}`;
  if (day === '*' && weekday === '*') return { cadence: 'Every day', time };
  if (day === '*' && weekday === '1-5') return { cadence: 'Weekdays', time };
  if (day === '*' && /^[0-6]$/.test(weekday)) return { cadence: 'Once a week', time, weekday };
  if (weekday === '*' && /^\d{1,2}$/.test(day) && Number(day) >= 1 && Number(day) <= 28) {
    return { cadence: 'Once a month', time, monthDay: day };
  }
  return null;
}

/** A routine's parameters, which the engine may hand back as the JSON text it stores. */
function parametersOf(raw: unknown): Record<string, unknown> {
  let value = raw;
  if (typeof value === 'string') {
    try { value = JSON.parse(value); } catch { return {}; }
  }
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

export function createAtlasDriver(session: Session, testInfo: TestInfo, backend: BackendFacts): AtlasDriver {
  const win = () => session.win;
  /** The folder chosen for the Library, which the vault is made inside. */
  let libraryParent: string | null = null;

  const notInAtlasYet = (what: string): never => {
    testInfo.skip(true, `Not in Atlas yet: ${what}.`);
    throw new Error('unreachable: a skipped journey does not continue');
  };

  /**
   * Wait until the engine has stored what the screen was asked to write: its
   * own record, read back over its API, as the classic driver's `stored` does.
   * Every setup step here ends on this, and reads the screen only afterwards,
   * for a state the screen could not have shown before the write.
   */
  const stored = async <T>(
    what: string, read: () => Promise<T>, holds: (value: T) => boolean, timeout = 30_000,
  ): Promise<void> => {
    await expect
      .poll(async () => holds(await read()), { timeout, message: `the app never recorded ${what}` })
      .toBe(true);
  };

  const goto = async (place: Place): Promise<void> => {
    const hash = ATLAS_PLACES[place];
    if (!hash) notInAtlasYet(`the ${place} screen`);
    await win().evaluate((h) => { window.location.hash = `#${h}`; }, hash ?? '');
    if (place === 'Today') {
      await expect(win().locator('nav[aria-label="Sections"] a[aria-current="page"]'))
        .toHaveText('Today', { timeout: 30_000 });
    } else if (hash === '/watches') {
      await expect(win().getByRole('heading', { name: 'Watches', level: 1 })).toBeVisible({ timeout: 30_000 });
      await expect(win().locator('section.watch-index')).toHaveAttribute('aria-busy', 'false', { timeout: 30_000 });
    } else if (hash === '/watches/calendar') {
      await expect(win().getByRole('heading', { name: 'Calendar', level: 1 })).toBeVisible({ timeout: 30_000 });
      await expect(win().locator('.page.watch-calendar')).toHaveAttribute('aria-busy', 'false', { timeout: 30_000 });
    } else if (hash === '/watches/people') {
      await expect(win().getByRole('heading', { name: 'People', level: 1 })).toBeVisible({ timeout: 30_000 });
      await expect(win().locator('.page.people')).toHaveAttribute('aria-busy', 'false', { timeout: 30_000 });
    } else if (hash?.startsWith('/settings/')) {
      await expect(win().getByRole('heading', { name: 'Settings', level: 1 })).toBeVisible({ timeout: 30_000 });
      await expect(win().locator('.settings-body > section.settings-group'))
        .toHaveAttribute('aria-busy', 'false', { timeout: 30_000 });
    } else if (hash === '/search/saved') {
      await expect(win().getByRole('heading', { name: 'Saved', level: 1 })).toBeVisible({ timeout: 30_000 });
      await expect(win().locator('.saved-page')).toHaveAttribute('aria-busy', 'false', { timeout: 30_000 });
    } else if (hash?.startsWith('/health')) {
      await expect(win().locator('nav[aria-label="Health"]')).toBeVisible({ timeout: 30_000 });
      await expect(win().locator('.page.health')).toHaveAttribute('aria-busy', 'false', { timeout: 30_000 });
    } else if (hash === '/search') {
      await expect(win().getByRole('heading', { name: 'Your collection', level: 1 })).toBeVisible({ timeout: 30_000 });
      await expect(win().locator('section.results')).toHaveAttribute('aria-busy', 'false', { timeout: 60_000 });
    } else if (hash === '/ask') {
      await expect(win().getByRole('heading', { name: 'Ask', level: 1 })).toBeVisible({ timeout: 30_000 });
      await expect(win().getByRole('region', { name: 'Saved chats' })).toHaveAttribute('aria-busy', 'false', { timeout: 30_000 });
    } else if (hash === '/search/ask') {
      await expect(win().getByRole('heading', { name: 'Ask the sources', level: 1 })).toBeVisible({ timeout: 30_000 });
      await expect(win().locator('.source').first()).toBeVisible({ timeout: 30_000 });
    } else {
      await expect(win().getByRole('heading', { name: 'Settings', level: 1 })).toBeVisible({ timeout: 30_000 });
    }
  };

  /**
   * Today, opened and settled: the index loaded. Arrived at, as a person
   * arrives at it: already on Today, the driver goes to Settings and back, so
   * the screen reads the engine again rather than showing what it read before
   * the journey's setup collected anything.
   */
  const openToday = async (): Promise<void> => {
    if (await win().evaluate(() => window.location.hash.startsWith('#/today'))) await goto('Appearance settings');
    await goto('Today');
    // Fresh: the list says it is busy while it re-reads the engine on arrival.
    await expect(win().locator('section.index')).toHaveAttribute('aria-busy', 'false', { timeout: 120_000 });
    await expect(win().locator('.index-bar h2')).toHaveText(/^New /);
  };

  const openSearch = async (): Promise<void> => {
    await win().evaluate(() => { window.location.hash = '#/search/ask'; });
    await expect(win().getByRole('heading', { name: 'Ask the sources', level: 1 })).toBeVisible({ timeout: 30_000 });
    await expect(win().locator('.source').first()).toBeVisible({ timeout: 30_000 });
    await expect(win().locator('section.runlog')).toHaveAttribute('aria-busy', 'false', { timeout: 30_000 });
  };

  const openRun = async (run: RunHandle): Promise<void> => {
    await win().evaluate((id) => { window.location.hash = `#/runs/${id}`; }, run.id);
    await expect(win().locator(`.run[data-run="${run.id}"]`)).toBeVisible({ timeout: 30_000 });
  };

  /** The run page, once the run has stopped running: what a person reads afterwards. */
  const openSettled = async (run: RunHandle): Promise<void> => {
    await openRun(run);
    await expect(win().locator('.run')).not.toHaveAttribute('data-status', 'running', { timeout: 150_000 });
  };

  /** A catalog row by slug, or by the source's name as the catalog writes it. */
  const sourceRow = async (source: string) => {
    const bySlug = win().locator(`.source[data-source="${source}"]`);
    if (await bySlug.count()) return bySlug;
    const byName = win().locator('.source').filter({
      has: win().locator('.source-name', { hasText: new RegExp(`^${source.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`) }),
    });
    await expect(byName, `Search lists no source "${source}"`).toHaveCount(1);
    return byName;
  };

  /**
   * Fill Ask the sources: the kind, these sources, these terms, the window and
   * the cap. Shared by `ask` and `saveConfiguration`, which press different
   * buttons under the same form, as the classic driver's two do.
   */
  const fillAsk = async (kind: 'Deep Dive' | 'Deep Sweep', sources: string[], terms: string[],
    days: number | undefined, cap: number | undefined): Promise<void> => {
    await openSearch();
    await win().getByRole('button', { name: kind, exact: true }).click();
    await expect(win().getByRole('button', { name: kind, exact: true })).toHaveAttribute('aria-pressed', 'true');
    for (const source of sources) await (await sourceRow(source)).locator('input').check();
    const field = win().getByLabel('Search terms');
    for (const term of terms) {
      await field.fill(term);
      await field.press('Enter');
    }
    if (days === undefined) {
      await win().getByRole('button', { name: 'Any time', exact: true }).click();
    } else {
      const to = new Date();
      const from = new Date(to.getTime() - days * 24 * 60 * 60 * 1000);
      await win().locator('.date input').first().fill(isoDate(from));
      await win().locator('.date input').nth(1).fill(isoDate(to));
    }
    if (cap !== undefined) await win().getByLabel('Most papers per source').fill(String(cap));
  };

  const ask = async (kind: 'Deep Dive' | 'Deep Sweep', sources: string[], terms: string[],
    days: number | undefined, cap: number | undefined, summarize = false): Promise<RunHandle> => {
    await fillAsk(kind, sources, terms, days, cap);
    if (summarize) await win().getByRole('checkbox', { name: 'Summarize each paper' }).check();
    const route = kind === 'Deep Dive' ? '/api/search/dive' : '/api/search/sweep';
    const started = win().waitForResponse((r) => r.url().endsWith(route) && r.request().method() === 'POST');
    await win().getByRole('button', { name: /^Ask / }).click();
    const response = await started;
    expect(response.status(), `${route} answered HTTP ${response.status()}`).toBeLessThan(300);
    const id = Number((await response.json()).execution_id);
    await expect(win().locator(`.run[data-run="${id}"]`)).toBeVisible({ timeout: 30_000 });
    return { id };
  };

  /** Search › Your collection, settled: the list read, the duplicate labels and folds with it. */
  const openCollection = async (query?: string): Promise<void> => {
    const onIt = await win().evaluate(() => window.location.hash === '#/search');
    if (!onIt) await win().evaluate(() => { window.location.hash = '#/search'; });
    await expect(win().getByRole('heading', { name: 'Your collection', level: 1 })).toBeVisible({ timeout: 30_000 });
    if (query !== undefined) {
      const field = win().getByLabel('Search your collection');
      if ((await field.inputValue()) !== query) {
        await field.fill(query);
        await field.press('Enter');
      }
    }
    await settledResults();
  };

  /**
   * Settings → AI, opened at Embeddings as a link to it opens it, and settled:
   * the group read and the counts drawn.
   */
  const openEmbeddings = async (): Promise<Locator> => {
    await win().evaluate(() => { window.location.hash = '#/settings/ai?focus=embeddings'; });
    await expect(win().getByRole('heading', { name: 'Settings', level: 1 })).toBeVisible({ timeout: 30_000 });
    await expect(win().locator('.settings-body > section.settings-group'))
      .toHaveAttribute('aria-busy', 'false', { timeout: 30_000 });
    const part = win().locator('section.embeddings');
    await expect(part.locator('[data-embeddings="facts"]')).toBeVisible({ timeout: 30_000 });
    await expect(part.getByRole('form', { name: 'Embedding settings' })).toBeVisible();
    return part;
  };

  /** The embedding form with its switch on, so the provider and model are on screen. */
  const embeddingForm = async (part: Locator): Promise<Locator> => {
    const form = part.getByRole('form', { name: 'Embedding settings' });
    const on = form.locator('[data-switch="embedding_enabled"]');
    if ((await on.getAttribute('aria-checked')) !== 'true') await on.click();
    await expect(on).toHaveAttribute('aria-checked', 'true');
    return form;
  };

  const settledResults = async (): Promise<void> => {
    const results = win().locator('section.results');
    await expect(results).toHaveAttribute('aria-busy', 'false', { timeout: 60_000 });
    await expect(results).not.toHaveAttribute('data-capability', 'unknown', { timeout: 30_000 });
    await expect(win().locator('.count-sentence')).not.toHaveText('', { timeout: 30_000 });
  };

  const readList = async (): Promise<ExplorerList> => {
    await settledResults();
    const rows = await win().locator('.result').evaluateAll((items) => items.map((item) => ({
      title: item.querySelector('.result-title')?.textContent?.trim() ?? '',
      alsoAppearsAs: [...item.querySelectorAll('.result-links li')].map((li) => li.textContent?.trim() ?? ''),
      distance: item.querySelector('.result-distance')?.textContent?.trim() ?? '',
    })));
    const note = win().locator('.collapse-note');
    return {
      countSentence: (await win().locator('.count-sentence').innerText()).trim(),
      rows,
      collapseNote: (await note.count()) ? (await note.innerText()).trim() : '',
    };
  };

  /** Library › Your files, opened and read once. */
  const openFiles = async (): Promise<void> => {
    await win().evaluate(() => { window.location.hash = '#/library/files'; });
    await expect(win().getByRole('heading', { name: 'Your files', level: 1 })).toBeVisible({ timeout: 30_000 });
    await expect(win().locator('.files-page')).toHaveAttribute('aria-busy', 'false', { timeout: 30_000 });
  };

  /** The vault the engine made inside the chosen folder: the one `resmon-library-*` there. */
  const vaultDirectory = (): string => {
    if (!libraryParent) throw new Error('no parent folder was chosen for the Library in this journey');
    const made = fs.readdirSync(libraryParent).filter((name) => name.startsWith('resmon-library-'));
    expect(made, 'the chosen folder does not hold exactly one library folder').toHaveLength(1);
    return path.join(libraryParent, made[0]!);
  };

  /** One file's record as the detail draws it, once the detail is that file's. */
  const readLibraryDetail = async (fileId: string): Promise<LibraryItem> => {
    const detail = win().getByRole('region', { name: 'Selected Library item' });
    await expect(detail).toHaveAttribute('data-file', fileId, { timeout: 30_000 });
    return {
      name: (await detail.locator('.lib-detail-name').innerText()).trim(),
      mediaType: (await detail.locator('[data-library="media"]').innerText()).trim(),
      sha256: (await detail.locator('[data-library="sha256"]').innerText()).trim(),
      fileId: (await detail.locator('[data-library="file-id"]').innerText()).trim(),
      versionId: (await detail.locator('[data-library="version-id"]').innerText()).trim(),
      associations: (await detail.locator('[data-library="links"] li').allInnerTexts()).map((t) => t.trim()),
    };
  };

  // — Evidence ---------------------------------------------------------------

  /** The project this journey has open, by the name a person gave it. */
  let openProject: string | null = null;
  const theOpenProject = (): string => {
    expect(openProject, 'this journey has not opened an Evidence project').toBeTruthy();
    return openProject!;
  };
  const evidenceReader = () => win().getByRole('region', { name: 'Evidence reader' });
  const evidenceNotesPanel = () => win().getByRole('region', { name: 'Saved evidence notes' });
  /** The rows of a list whose `selector` part shows exactly this name. */
  const named = (rows: Locator, selector: string, name: string): Locator =>
    rows.filter({ has: win().locator(selector, { hasText: new RegExp(`^${literally(name)}$`) }) });

  /** The open project's workspace, once it is the named project's. */
  const theWorkspaceIs = async (project: string): Promise<void> => {
    await expect(win().locator('section.ev-workspace h2.ev-title'), `the workspace is not ${project}'s`)
      .toHaveText(project, { timeout: 30_000 });
  };

  /** Library › Evidence, and the named project opened from its list. */
  const openTheProject = async (project: string): Promise<void> => {
    await win().evaluate(() => { window.location.hash = '#/library/evidence'; });
    await expect(win().getByRole('heading', { name: 'Evidence', level: 1 })).toBeVisible({ timeout: 30_000 });
    const button = named(win().getByRole('navigation', { name: 'Evidence projects' }).locator('button.ev-project'), '.lib-name', project);
    await expect(button, `Evidence lists no project called ${project}`).toBeVisible({ timeout: 60_000 });
    await button.click();
    await expect(button).toHaveAttribute('aria-pressed', 'true', { timeout: 30_000 });
    await theWorkspaceIs(project);
    openProject = project;
  };

  /** Select a file of the open project, and wait for the reader to be on it. */
  const pickTheProjectFile = async (name: string): Promise<void> => {
    const item = named(win().getByRole('region', { name: 'Files in this project' }).locator('button.library-file'), '.lib-name', name);
    await expect(item, `the project holds no file called ${name}`).toBeVisible({ timeout: 30_000 });
    await item.click();
    await expect(item).toHaveAttribute('aria-pressed', 'true', { timeout: 30_000 });
    await expect(evidenceReader().getByRole('heading', { name, exact: true })).toBeVisible({ timeout: 30_000 });
  };

  /** Ask the reader for one physical page of the PDF it has open, by number. */
  const turnTheReaderTo = async (page: number): Promise<void> => {
    const input = evidenceReader().getByLabel('Page', { exact: true });
    await expect(input, 'the reader offers no page control here').toBeEnabled({ timeout: 60_000 });
    await input.fill(String(page));
    await input.press('Enter');
    await expect(evidenceReader()).toHaveAttribute('data-page', String(page), { timeout: 30_000 });
  };

  /**
   * The page the reader is on, once it has finished reading it.
   *
   * The text pane carries the page number of the answer it shows, and a new
   * page's pane is not drawn until that page's answer has come (the reader
   * never keeps the previous page's text up while it reads the next one), so
   * the wait is for the pane's own page to be the reader's. The engine's
   * answer was checked against its hash before the pane drew it.
   */
  const readTheReaderPage = async (file: string): Promise<EvidencePageView> => {
    const reader = evidenceReader();
    await expect(reader.getByRole('heading', { name: file, exact: true })).toBeVisible({ timeout: 60_000 });
    const page = Number(await reader.getAttribute('data-page'));
    const pane = reader.getByLabel('Canonical page text');
    const examined = reader.locator('[data-evidence="examined"]');
    await expect(examined.or(reader.getByRole('alert')).first(), `the reader never read page ${page} of ${file}`)
      .toBeVisible({ timeout: 60_000 });
    await expect(reader.getByText('Reading this exact page.', { exact: true })).toHaveCount(0, { timeout: 60_000 });
    if (await pane.count()) await expect(pane).toHaveAttribute('data-page', String(page), { timeout: 30_000 });
    let image = '';
    if (await reader.getAttribute('data-media') === 'application/pdf') {
      // The page image reports on itself once PDF.js has drawn the page, or
      // in an alert when it could not.
      const region = reader.getByRole('region', { name: 'PDF page image' });
      const said = region.getByText(/^Page \d+ of \d+ rendered/).or(region.getByRole('alert')).first();
      await expect(said, 'the PDF image never said whether it drew the page').toBeVisible({ timeout: 60_000 });
      image = (await said.innerText()).trim();
    }
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
    const before = (await backend.evidenceNotes(theOpenProject())).length;
    await panel.getByLabel(button === 'Save passage' ? 'Your note on it (optional)' : 'Note', { exact: true }).fill(body);
    await panel.getByRole('button', { name: button, exact: true }).click();
    await expect.poll(async () => (await backend.evidenceNotes(theOpenProject())).length, {
      timeout: 30_000, message: `the app never recorded the ${button === 'Save passage' ? 'passage' : 'note'} that was saved`,
    }).toBe(before + 1);
    const notice = panel.locator('[data-evidence="saved"]');
    await expect(notice, 'the record was stored and the panel never said so').toBeVisible({ timeout: 30_000 });
    return (await notice.innerText()).trim();
  };

  /** Answer the next download's destination with this path; the bytes and the flow are the app's. */
  const theNextDownloadGoesTo = async (target: string): Promise<void> => {
    await session.app.evaluate(({ BrowserWindow }, destination) => {
      BrowserWindow.getAllWindows()[0].webContents.session.once('will-download', (_e, item) => {
        item.setSavePath(destination as string);
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
  let downloadsMade = 0;

  /** Settings › Sources, arrived at and read: the catalog and what the keychain holds. */
  const openSources = async (): Promise<void> => {
    await win().evaluate(() => { window.location.hash = '#/settings/sources'; });
    await expect(win().locator('section.sources')).toHaveAttribute('aria-busy', 'false', { timeout: 30_000 });
    await expect(win().locator('.source-entry').first()).toBeVisible({ timeout: 30_000 });
  };

  // — Ask ---------------------------------------------------------------------

  const conversation = () => win().locator('section.conv-pane');

  /** Ask, arrived at: the heading drawn and the saved conversations read. */
  const openAsk = async (): Promise<void> => {
    if (!await win().evaluate(() => window.location.hash.startsWith('#/ask'))) await goto('Chats');
    await expect(conversation()).toBeVisible({ timeout: 30_000 });
  };

  /**
   * The turn has finished, or is being held behind a card.
   *
   * The engine's record decides, as the classic driver's does: a conversation
   * whose turn is still claimed is still answering. Then the screen is given
   * the time to draw the engine's saved copy, which is when Atlas drops its
   * Working… line; Atlas keeps that line exactly until then, so here it is a
   * wait the screen owes, not a guess.
   */
  const theTurnHasSettled = async (): Promise<void> => {
    await expect.poll(async () => {
      if (await conversation().locator('.conv-card').count()) return true;
      const { sessions } = await session.api<{ sessions: { id: number }[] }>('GET', '/api/assistant/sessions');
      if (!sessions.length) return false;
      for (const saved of sessions) {
        const one = await session.api<{ running?: boolean; activity_observation?: { turn_claimed?: boolean } }>(
          'GET', `/api/assistant/sessions/${saved.id}`);
        if (one.running || one.activity_observation?.turn_claimed) return false;
      }
      return true;
    }, { timeout: 120_000, message: 'the assistant never finished its turn' }).toBe(true);
    if (!await conversation().locator('.conv-card').count()) {
      await expect(conversation().locator('.conv-working'), 'Ask still says Working… over a finished turn')
        .toHaveCount(0, { timeout: 30_000 });
    }
  };

  const readTheTurn = async (): Promise<AssistantTurn> => {
    const pane = conversation();
    const trimmed = (texts: string[]) => texts.map((t) => t.trim());
    const card = pane.locator('.conv-card').first();
    const held = (await card.count()) > 0;
    // A failure the engine kept with its turn is drawn under the message, and
    // the one that has just ended there is the announced one.
    const error = pane.locator('.conv-error, .conv-failed-message[role="alert"]');
    return {
      said: trimmed(await pane.locator('.conv-msg[data-role="assistant"] .conv-text').allInnerTexts()),
      toolCalls: trimmed(await pane.locator('.conv-call-name').allInnerTexts()),
      approvalCall: held ? (await card.locator('.conv-card-call').innerText()).trim() : '',
      approvalTitle: held ? (await card.locator('.conv-card-title').innerText()).trim() : '',
      error: (await error.count()) ? (await error.first().innerText()).trim() : '',
    };
  };

  /** The saved conversations' titles, once the rail shows as many as the engine keeps. */
  const readTheRail = async (): Promise<string[]> => {
    await openAsk();
    const { sessions } = await session.api<{ sessions: unknown[] }>('GET', '/api/assistant/sessions');
    const rows = win().getByRole('region', { name: 'Saved chats' }).locator('.conv-row strong');
    await expect.poll(() => rows.count(), {
      timeout: 30_000, message: `Ask never listed the ${sessions.length} conversation(s) the engine keeps`,
    }).toBe(sessions.length);
    return (await rows.allInnerTexts()).map((t) => t.trim());
  };

  /** What the composer holds, or what the conversation says it is fixed to. */
  const readTheComposer = async (): Promise<ComposerChoice> => {
    await openAsk();
    const controls = conversation().locator('fieldset.conv-choices');
    const fixed = conversation().locator('.conv-fixed');
    await expect.poll(async () => (await controls.count()) + (await fixed.count()), { timeout: 30_000 }).toBeGreaterThan(0);
    if (!await controls.count()) {
      return { stillChangeable: false, connection: '', model: '', effort: '', fixedAs: (await fixed.innerText()).trim() };
    }
    const connection = controls.getByLabel('Connection', { exact: true });
    const effort = controls.getByLabel('Effort', { exact: true });
    return {
      stillChangeable: await connection.isEnabled(),
      connection: (await connection.locator('option:checked').innerText()).trim(),
      model: await controls.getByLabel('Model', { exact: true }).inputValue(),
      effort: (await effort.count()) ? await effort.inputValue()
        : (await controls.locator('.conv-no-effort').innerText()).trim(),
      fixedAs: '',
    };
  };

  // — Settings › AI, set up for a journey ---------------------------------------

  /** Settings › AI › Summaries as a step sets it: the provider, and only the fields the step types. */
  interface SummaryLane {
    provider: string;
    model?: string;
    /** The command's path, for Claude Code or Codex. */
    command?: string;
    /** A custom endpoint's address. */
    endpoint?: string;
    /** A key, typed into the provider's own key field and stored by its own button. */
    key?: string;
  }

  /**
   * Settings › AI › Summaries, set as a person sets it: the provider, the
   * fields that provider shows, a key typed into the provider's key field and
   * stored by its button, then Save summary settings.
   *
   * The key goes where the classic driver's PUT sends it, the credential
   * store, which in this suite is an in-memory one inside this backend. The
   * command and the custom address are the ones Ask and selected answers use
   * too: Atlas keeps one of each for every part of Settings › AI, as the
   * engine does (`ai_cli_path`, `ai_custom_base_url`).
   */
  const setTheSummaryLane = async (lane: SummaryLane): Promise<void> => {
    await goto('AI settings');
    const form = win().getByRole('form', { name: 'Summary settings' });
    await expect(form, 'Settings › AI has no summary settings').toBeVisible({ timeout: 30_000 });
    await form.locator('#ai-provider').selectOption(lane.provider);
    if (lane.model !== undefined) await form.locator('#ai-model').fill(lane.model);
    if (lane.command !== undefined) await form.locator('#ai-cli-path').fill(lane.command);
    if (lane.endpoint !== undefined) await form.locator('#ai-base-url').fill(lane.endpoint);
    if (lane.key !== undefined) {
      const field = form.locator('[data-ai="key"] input[type="password"]');
      await expect(field, `Settings › AI shows no key field for ${lane.provider}`).toBeVisible({ timeout: 30_000 });
      const kept = win().waitForResponse((r) => r.url().includes('/api/credentials/') && r.request().method() === 'PUT');
      await field.fill(lane.key);
      await form.locator('[data-ai="key"]').getByRole('button', { name: /^(Store|Replace)$/ }).click();
      const response = await kept;
      expect(response.ok(), `the ${lane.provider} key was refused: HTTP ${response.status()}`).toBe(true);
      const name = decodeURIComponent(new URL(response.url()).pathname.split('/').pop() ?? '');
      await stored(`a stored ${name}`, () => backend.credentials(), (c) => c.credentials?.[name]?.status === 'present');
      await expect(field, 'the key was stored and its field still holds it').toHaveValue('', { timeout: 30_000 });
    }
    const holds = (s: Record<string, unknown>): boolean => s.ai_provider === lane.provider
      && (lane.model === undefined || s.ai_model === lane.model)
      && (lane.command === undefined || s.ai_cli_path === lane.command)
      && (lane.endpoint === undefined || s.ai_custom_base_url === lane.endpoint);
    // Where the engine already holds all of it, there is nothing to save, and
    // the screen says so by leaving Save disabled.
    if (holds(await backend.aiSettings())) return;
    const save = form.getByRole('button', { name: 'Save summary settings', exact: true });
    await expect(save, 'Settings › AI will not save the summary settings as typed').toBeEnabled({ timeout: 15_000 });
    await save.click();
    await stored(`the summary lane on ${lane.provider}`, () => backend.aiSettings(), holds);
    await expect(form.locator('.form-actions').getByRole('status'), 'the engine stored it and the form never said so')
      .toHaveText('Saved.', { timeout: 30_000 });
  };

  /** Settings › AI › Ask, set to run on a key: An API key, the provider, its model, then Save. */
  const runAskOnAKey = async (provider: string, model: string): Promise<void> => {
    await goto('AI settings');
    const form = win().getByRole('form', { name: 'Assistant settings' });
    await expect(form, 'Settings › AI has no Ask settings').toBeVisible({ timeout: 30_000 });
    await form.locator('#assistant-runtime').selectOption('api_key');
    await form.locator('#assistant-provider').selectOption(provider);
    await form.locator('#assistant-model').fill(model);
    await form.getByRole('button', { name: 'Save assistant settings', exact: true }).click();
    await stored(`Ask on a ${provider} key with ${model}`,
      () => session.api<Record<string, string>>('GET', '/api/settings/assistant'),
      (s) => s.assistant_runtime === 'api_key' && s.assistant_provider === provider && s.assistant_model === model);
    await expect(form.getByRole('status'), 'the engine stored it and the form never said so')
      .toHaveText(/^Saved\./, { timeout: 30_000 });
  };

  // — selected-evidence answers -------------------------------------------------

  /** The open project's Answers view. */
  const openTheAnswers = async (): Promise<void> => {
    const tab = win().getByRole('group', { name: 'In this project' }).getByRole('button', { name: 'Answers', exact: true });
    await expect(tab).toBeVisible({ timeout: 30_000 });
    if (await tab.getAttribute('aria-pressed') !== 'true') await tab.click();
    await expect(win().getByRole('navigation', { name: 'Saved answers' })).toHaveAttribute('aria-busy', 'false', { timeout: 30_000 });
  };
  const answerArticle = () => win().getByRole('article', { name: 'Saved answer' });

  /** The answer on screen, once it shows the state the app recorded for it. */
  const readTheAnswerHere = async (id: string): Promise<SelectedAnswerView> => {
    const saved = await backend.selectedAnswer(theOpenProject(), id);
    const article = answerArticle();
    await expect(article, `the page is not showing answer ${id}`).toHaveAttribute('data-answer', id, { timeout: 60_000 });
    // The record first, then the screen agreeing with it: until then it shows the answer mid-run.
    await expect(article).toHaveAttribute('data-state', String(saved.state), { timeout: 60_000 });
    const rows = article.locator('.ev-answer-item');
    const items: SelectedAnswerView['items'] = [];
    for (let i = 0; i < await rows.count(); i += 1) {
      const row = rows.nth(i);
      items.push({
        text: ((await row.locator('.ev-answer-text').textContent()) ?? '').trim(),
        citations: (await row.locator('button.ev-cite').allInnerTexts()).map((t) => t.trim()),
      });
    }
    const unvalidated = article.locator('[data-answer="unvalidated"]');
    return {
      id,
      state: String(await article.getAttribute('data-state')),
      items,
      unvalidated: (await unvalidated.count()) ? (await unvalidated.innerText()).trim() : null,
      text: (await article.innerText()).trim(),
    };
  };

  const openQueue = async (filter: 'to read' | 'read' | 'all'): Promise<void> => {
    await win().evaluate(() => { window.location.hash = '#/library'; });
    await expect(win().getByRole('heading', { name: 'Reading queue', level: 1 })).toBeVisible({ timeout: 30_000 });
    const button = win().getByRole('group', { name: 'Show' }).getByRole('button', { name: new RegExp(`^${QUEUE_FILTER[filter]}`) });
    await button.click();
    await expect(button).toHaveAttribute('aria-pressed', 'true');
    await expect(win().locator('section.queue')).toHaveAttribute('aria-busy', 'false', { timeout: 30_000 });
    await expect(win().locator('.queue-row, .queue-empty').first()).toBeVisible({ timeout: 30_000 });
  };

  const readQueue = async (): Promise<QueuedPaper[]> => win().locator('.queue-row').evaluateAll((rows) => rows.map((row) => ({
    id: Number((row as HTMLElement).dataset.document),
    title: row.querySelector('.queue-title')?.textContent?.trim() ?? '',
    state: row.querySelector('.queue-state')?.textContent?.trim() ?? '',
  })));

  // — watches ---------------------------------------------------------------

  const routineNamed = async (name: string): Promise<{ id: number; record: Record<string, unknown> }> => {
    const record = (await backend.routines()).find((r) => r.name === name);
    expect(record, `no routine named ${name}`).toBeTruthy();
    return { id: Number(record!.id), record: record! };
  };

  /**
   * A watch's own page, read fresh: arrived at from the Watches list, so the
   * page reads the engine on arrival rather than showing what an earlier visit
   * read before the journey changed something behind it.
   */
  const openWatch = async (name: string): Promise<number> => {
    const { id } = await routineNamed(name);
    await goto('Routines');
    await win().evaluate((routine) => { window.location.hash = `#/watches/${routine}`; }, id);
    const page = win().locator(`.watch-page[data-routine="${id}"]`);
    await expect(page).toBeVisible({ timeout: 30_000 });
    // A page visited before draws what it read then while it reads again.
    await expect(page).toHaveAttribute('aria-busy', 'false', { timeout: 30_000 });
    return id;
  };

  const openWatchTab = async (name: string, tab: string): Promise<number> => {
    const id = await openWatch(name);
    const button = win().getByRole('tab', { name: tab, exact: true });
    await button.click();
    await expect(button).toHaveAttribute('aria-selected', 'true');
    return id;
  };

  /** The record first, then the screen: the switch is drawn from the record. */
  const setScheduled = async (name: string, active: boolean): Promise<void> => {
    const id = await openWatch(name);
    const page = win().locator(`.watch-page[data-routine="${id}"]`);
    if ((await page.getAttribute('data-active')) !== String(active)) {
      await win().getByRole('button', { name: active ? 'Resume' : 'Pause', exact: true }).click();
    }
    await expect.poll(async () => Boolean((await routineNamed(name)).record.is_active), {
      timeout: 30_000, message: `the app never recorded ${name} as ${active ? 'active' : 'inactive'}`,
    }).toBe(active);
    await expect(page, 'the record changed and the page still shows the old state')
      .toHaveAttribute('data-active', String(active), { timeout: 30_000 });
    await expect(page.locator('.run-meta .watch-state')).toHaveText(active ? 'Watching' : 'Paused');
  };

  /** Every delivery of a routine settled in the engine: a read taken mid-drain is of a delivery in flight. */
  const settledDeliveries = async (id: number): Promise<Record<number, string>> => {
    let recorded: Record<number, string> = {};
    await expect.poll(async () => {
      const record = await session.api<{ deliveries: { id: number; state: string }[] }>('GET', `/api/routines/${id}/deliveries`);
      recorded = Object.fromEntries(record.deliveries.map((row) => [Number(row.id), String(row.state)]));
      return record.deliveries.length > 0
        && record.deliveries.every((row) => !['queued', 'delivering'].includes(String(row.state)));
    }, { timeout: 120_000 }).toBe(true);
    return recorded;
  };

  return {
    open: (place) => goto(place),

    // — health: the Source wall, the watchdog, this engine --------------------

    readTheSourceWall: async (): Promise<SourceWallView> => {
      await goto('Source wall');
      const served = await backend.sourceWall();
      const verdict = win().locator('[data-health="verdict"]');
      // The headline is composed by the engine, so the wall has been read once
      // the screen draws that one.
      await expect(verdict.locator('.wall-headline'), 'the wall never drew the verdict the app composed')
        .toHaveText(served.verdict.headline, { timeout: 60_000 });
      const rows = win().locator('table.wall-grid tbody tr');
      await expect(rows, 'the wall draws a different number of sources from the grid it was served')
        .toHaveCount(served.sources.length, { timeout: 30_000 });
      const legend = win().locator('[data-health="legend"] li');
      const out: SourceWallView = {
        verdict: {
          level: String(await verdict.getAttribute('data-level')),
          headline: (await verdict.locator('.wall-headline').innerText()).trim(),
          detail: (await verdict.locator('.wall-detail-line').allInnerTexts()).map((t) => t.trim()),
        },
        window: (await win().locator('[data-health="window"]').innerText()).trim(),
        legend: [],
        rows: [],
      };
      // A mark is drawn, not typed: each is an SVG whose `data-mark` names it.
      for (let i = 0; i < await legend.count(); i += 1) {
        const entry = legend.nth(i);
        out.legend.push({
          label: (await entry.locator('.wall-legend-name').innerText()).trim(),
          glyph: String(await entry.locator('svg.wall-mark').getAttribute('data-mark')),
          count: Number((await entry.locator('.wall-legend-count').innerText()).replace(/[^0-9]/g, '')),
        });
      }
      for (let i = 0; i < await rows.count(); i += 1) {
        const row = rows.nth(i);
        const cells = row.locator('button[data-health="cell"]');
        const drawn: SourceWallCellView[] = [];
        for (let j = 0; j < await cells.count(); j += 1) {
          const cell = cells.nth(j);
          // `<source>, <run> <when>: <label>`: the label follows the last colon.
          const announced = String(await cell.getAttribute('aria-label'));
          drawn.push({
            state: String(await cell.getAttribute('data-state')),
            glyph: String(await cell.locator('svg.wall-mark').getAttribute('data-mark')),
            label: announced.slice(announced.lastIndexOf(': ') + 2),
          });
        }
        out.rows.push({ source: (await row.locator('th[scope="row"]').innerText()).trim(), cells: drawn });
      }
      return out;
    },

    readTheSourceWallCell: async (source, column): Promise<SourceWallReading> => {
      await goto('Source wall');
      const served = await backend.sourceWall();
      const record = served.sources.find((row) => row.name === source);
      expect(record, `the wall was served no row for ${source}`).toBeTruthy();
      const row = win().locator('table.wall-grid tbody tr')
        .filter({ has: win().locator('th[scope="row"]', { hasText: source }) });
      await expect(row, `the wall draws no single row for ${source}`).toHaveCount(1, { timeout: 60_000 });
      await row.locator('button[data-health="cell"]').nth(column).click();
      const pane = win().locator('[data-health="reading"]');
      // The pane shows the engine's sentence for the cell; waiting for that
      // sentence is what tells two cells of the same source apart.
      await expect(pane.locator('.wall-reading-note'), 'the reading pane never showed this cell')
        .toHaveText(record!.cells[column]!.note, { timeout: 30_000 });
      return {
        head: (await pane.locator('.wall-reading-head').innerText()).replace(/\s+/g, ' ').trim(),
        label: (await pane.locator('.wall-reading-label').innerText()).trim(),
        note: (await pane.locator('.wall-reading-note').innerText()).trim(),
      };
    },

    readWatchdog: async (): Promise<WatchdogView> => {
      await goto('Watchdog');
      const served = await backend.watchdogFindings() as { findings?: unknown[] };
      const verdict = win().locator('[data-health="watchdog-verdict"]');
      await expect(verdict).toBeVisible({ timeout: 60_000 });
      // The page's own read agrees with the app's record before it is read:
      // the report is cached on a fingerprint, and a read taken across a
      // change would be of the state before it.
      const cards = win().locator('li.finding');
      await expect(cards, 'the watchdog draws a different number of findings from its record')
        .toHaveCount((served.findings ?? []).length, { timeout: 30_000 });
      const findings: WatchdogFinding[] = [];
      for (let i = 0; i < await cards.count(); i += 1) {
        const card = cards.nth(i);
        findings.push({
          severity: (await card.locator('.finding-severity').innerText()).trim(),
          scope: (await card.locator('.finding-scope').innerText()).trim(),
          title: (await card.locator('.finding-title').innerText()).trim(),
          muted: (await card.getAttribute('data-muted')) === 'true',
        });
      }
      const muted = win().locator('[data-health="muted"] h2');
      return {
        verdict: (await verdict.locator('.wall-headline').innerText()).trim(),
        findings,
        notEnoughHistory: (await win().locator('ul.unjudged li').allInnerTexts()).map((t) => t.replace(/\s+/g, ' ').trim()),
        mutedHeading: (await muted.count()) ? (await muted.innerText()).trim() : '',
      };
    },

    muteTheFinding: async (titleFragment) => {
      await goto('Watchdog');
      const card = win().locator('li.finding').filter({ hasText: titleFragment }).first();
      await expect(card, `no finding mentioning "${titleFragment}"`).toBeVisible({ timeout: 30_000 });
      // By the finding's key: the card names a source as the catalog does
      // ("arXiv"), the engine's own title by its slug ("arxiv").
      const key = await card.getAttribute('data-key');
      expect(key, `the finding mentioning "${titleFragment}" carries no key`).toBeTruthy();
      const answered = win().waitForResponse((r) => r.url().includes('/api/watchdog/mute'));
      await card.getByRole('button', { name: 'Mute', exact: true }).click();
      expect((await answered).ok(), 'Mute was refused').toBe(true);
      // Accepted is not yet readable: the next read of the report is the one
      // that pays for the change, so wait for the app's own record first.
      await expect.poll(async () => {
        const view = await backend.watchdogFindings() as { findings?: { key?: string; muted?: boolean }[] };
        return (view.findings ?? []).some((f) => f.key === key && f.muted === true);
      }, { timeout: 30_000, message: `"${titleFragment}" was never recorded as muted` }).toBe(true);
      await expect(card, 'the record says muted and the finding on screen still does not')
        .toHaveAttribute('data-muted', 'true', { timeout: 30_000 });
    },

    readAnalytics: async (): Promise<AnalyticsView> => {
      await goto('Analytics');
      // The corpus tile is the engine's count; the page has read it once the
      // tile agrees with the collection's own total.
      const corpus = await backend.corpusCounts();
      const papers = win().locator('[data-analytics="corpus"] .tile[data-tile="Papers"] dd');
      await expect(papers, 'the Papers tile never showed the collection\'s count')
        .toHaveText(new Intl.NumberFormat('en-US').format(corpus.documents), { timeout: 30_000 });
      const tiles = await win().locator('[data-analytics="corpus"] .tile').evaluateAll((items) => items.map((tile) => ({
        label: tile.querySelector('dt')?.textContent?.trim() ?? '',
        value: tile.querySelector('dd')?.textContent?.trim() ?? '',
      })));
      const sources = await win().locator('[data-analytics="sources"] .bar-row').evaluateAll((rows) => rows.map((row) => ({
        label: row.querySelector('.bar-name')?.textContent?.trim() ?? '',
        value: row.querySelector('.bar-figure')?.getAttribute('data-value') ?? '',
      })));
      return {
        headings: (await win().locator('.analytics .chart-card h2').allInnerTexts()).map((t) => t.trim()),
        tiles,
        sources,
        notEnoughYet: (await win().locator('[data-analytics="not-enough"]').allInnerTexts()).map((t) => t.trim()),
      };
    },

    measureKeywordYield: async () => {
      await goto('Analytics');
      const card = win().locator('[data-analytics="keywords"]');
      await card.locator('[data-analytics="measure"]').click();
      // Measured is either a row per term or the engine's sentence for too little.
      await expect(card.locator('[data-analytics="keyword-rows"] li, [data-analytics="not-enough"]').first())
        .toBeVisible({ timeout: 60_000 });
      await expect(card).toHaveAttribute('aria-busy', 'false', { timeout: 30_000 });
      const bars = await card.locator('[data-analytics="keyword-rows"] li').evaluateAll((rows) => rows.map((row) => ({
        label: row.getAttribute('data-keyword') ?? '',
        value: row.querySelector('.bar-figure')?.getAttribute('data-value') ?? '',
      })));
      return { bars, notEnoughYet: (await card.locator('[data-analytics="not-enough"]').allInnerTexts()).join(' ').trim() };
    },

    followTheChartIntoTheExplorer: async () => {
      await goto('Analytics');
      // A source's row opens the collection narrowed to that source.
      await win().locator('[data-analytics="sources"] .bar-row a.bar-name').first().click();
      await expect(win().getByRole('heading', { name: 'Your collection', level: 1 })).toBeVisible({ timeout: 30_000 });
      await expect(win().locator('[data-collection="filters"]')).toBeVisible({ timeout: 30_000 });
      const list = await readList();
      return { hash: await win().evaluate(() => window.location.hash), list };
    },

    // — library: your files ----------------------------------------------------

    chooseAParentFolderForTheLibrary: async (): Promise<string> => {
      // A folder of this session's own, removed with it, as the classic driver
      // does. The production IPC handler is untouched; only the OS dialog it
      // calls answers, because nothing automated can operate a native one.
      const parent = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'resmon-journey-library-')));
      session.alsoRemoveOnClose(parent);
      await session.app.evaluate(({ dialog }, chosen) => {
        dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [chosen] });
      }, parent);
      await openFiles();
      await win().getByRole('button', { name: 'Choose parent folder', exact: true }).click();
      await expect(win().locator('[data-library="parent"]')).toHaveText(parent, { timeout: 30_000 });
      libraryParent = parent;
      return parent;
    },

    createTheManagedVault: async (): Promise<string> => {
      await openFiles();
      await win().getByRole('button', { name: 'Create the library here', exact: true }).click();
      // The control that exists only once there is somewhere to import into.
      await expect(win().getByLabel('Import PDF, TXT or MD')).toBeEnabled({ timeout: 60_000 });
      return vaultDirectory();
    },

    importIntoTheLibrary: async (files): Promise<string> => {
      await openFiles();
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
      // The page's own account of what it did, written once every file was answered.
      const notice = win().locator('[data-library="imported"]');
      await expect(notice).toBeVisible({ timeout: 120_000 });
      return (await notice.innerText()).trim();
    },

    readTheLibraryItems: async (): Promise<LibraryItem[]> => {
      await openFiles();
      const rows = win().getByRole('region', { name: 'Library files' }).locator('button.library-file');
      await expect(rows.first()).toBeVisible({ timeout: 60_000 });
      const out: LibraryItem[] = [];
      for (let i = 0; i < await rows.count(); i += 1) {
        const row = rows.nth(i);
        await row.click();
        out.push(await readLibraryDetail(String(await row.getAttribute('data-file'))));
      }
      return out;
    },

    associateTheLibraryItemWithPaper: async (name, paperId): Promise<string> => {
      await openFiles();
      const row = win().locator('button.library-file').filter({ has: win().locator('.lib-name', { hasText: name }) });
      await row.click();
      const detail = win().getByRole('region', { name: 'Selected Library item' });
      await expect(detail).toHaveAttribute('data-file', String(await row.getAttribute('data-file')), { timeout: 30_000 });
      await detail.locator('#lib-paper').fill(String(paperId));
      await detail.getByRole('button', { name: 'Link', exact: true }).click();
      const notice = detail.locator('[data-library="linked"]');
      await expect(notice).toContainText(`Linked paper ${paperId}`, { timeout: 60_000 });
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

    // — the Evidence workspace -------------------------------------------------

    startAnEvidenceProjectFrom: async (item, project): Promise<EvidencePageView> => {
      await openFiles();
      const row = named(win().getByRole('region', { name: 'Library files' }).locator('button.library-file'), '.lib-name', item);
      await row.click();
      const detail = win().getByRole('region', { name: 'Selected Library item' });
      await expect(detail).toHaveAttribute('data-file', String(await row.getAttribute('data-file')), { timeout: 30_000 });
      await detail.getByRole('link', { name: 'Open in Evidence', exact: true }).click();
      const handoff = win().getByRole('region', { name: 'Brought from Your files' });
      await expect(handoff, 'Open in Evidence did not carry the Library item across').toContainText(item, { timeout: 30_000 });
      await win().getByLabel('A name for a new project', { exact: true }).fill(project);
      await win().getByRole('button', { name: 'Start', exact: true }).click();
      await theWorkspaceIs(project);
      openProject = project;
      // The handoff adds to the project that is open, and only when asked:
      // starting a project does not put anything in it.
      const add = handoff.getByRole('button', { name: `Add ${item} to this project`, exact: true });
      await expect(add).toBeEnabled({ timeout: 30_000 });
      await add.click();
      await expect(handoff).toHaveCount(0, { timeout: 30_000 });
      return readTheReaderPage(item);
    },

    addToTheEvidenceProject: async (items): Promise<string[]> => {
      const open = win().locator('section.ev-workspace .ev-head').getByRole('button', { name: 'Add files', exact: true });
      if (await open.getAttribute('aria-pressed') !== 'true') await open.click();
      const chooser = win().getByRole('region', { name: 'Add files from your library' });
      await expect(chooser).toBeVisible({ timeout: 30_000 });
      for (const item of items) {
        const choice = named(chooser.locator('label.choice'), 'span', item).getByRole('checkbox');
        await expect(choice, `the library offers no ${item} to add`).toBeVisible({ timeout: 30_000 });
        await choice.check();
      }
      await chooser.getByRole('button', { name: /^Add \d+ files?$/ }).click();
      const members = win().getByRole('region', { name: 'Files in this project' });
      for (const item of items) {
        await expect(named(members.locator('button.library-file'), '.lib-name', item),
          `${item} was added and is not in the project`).toBeVisible({ timeout: 30_000 });
      }
      await open.click();
      return (await members.locator('button.library-file .lib-name').allInnerTexts()).map((t) => t.trim());
    },

    openTheEvidenceProject: (project) => openTheProject(project),

    readTheEvidencePage: async (file, page): Promise<EvidencePageView> => {
      await pickTheProjectFile(file);
      if (page !== undefined) await turnTheReaderTo(page);
      return readTheReaderPage(file);
    },

    saveAnEvidencePassage: async ({ file, page, quote, body }): Promise<string> => {
      await pickTheProjectFile(file);
      if (page !== undefined) await turnTheReaderTo(page);
      // The page is settled before it is searched: a search of the previous
      // page's text would choose a passage the person never saw.
      await readTheReaderPage(file);
      const reader = evidenceReader();
      await reader.getByLabel('Find on this page’s text', { exact: true }).fill(quote);
      await reader.getByRole('button', { name: 'Find', exact: true }).click();
      await expect(reader.locator('[data-evidence="found"]'), `the reader never reported searching for "${quote}"`)
        .toHaveText(/^\d+ literal match(es)? on this page’s text only\.$/, { timeout: 30_000 });
      const use = reader.getByRole('button', { name: 'Use selected passage', exact: true });
      await expect(use, `the reader found no "${quote}" to use`).toBeEnabled({ timeout: 30_000 });
      await use.click();
      const panel = evidenceNotesPanel();
      await expect(panel.getByRole('heading', { name: 'New exact passage' })).toBeVisible({ timeout: 30_000 });
      await expect(panel.locator('[data-evidence="quote"]'),
        'the passage the panel is about to save is not the text that was found').toHaveText(quote);
      return saveTheOpenNote(body, 'Save passage');
    },

    saveAnEvidenceNote: async ({ file, body }): Promise<string> => {
      await pickTheProjectFile(file);
      const panel = evidenceNotesPanel();
      await expect(panel.getByRole('heading', { name: 'New plain note' })).toBeVisible({ timeout: 30_000 });
      return saveTheOpenNote(body, 'Save note');
    },

    readTheSavedEvidenceNotes: async (): Promise<SavedEvidenceNote[]> => {
      const held = await backend.evidenceNotes(theOpenProject());
      const records = evidenceNotesPanel().locator('ol.ev-saved > li');
      await expect(records, 'the panel does not list every record the app holds').toHaveCount(held.length, { timeout: 30_000 });
      const out: SavedEvidenceNote[] = [];
      for (let i = 0; i < await records.count(); i += 1) {
        const record = records.nth(i);
        const quote = record.locator('blockquote');
        const body = record.locator('.ev-body-text');
        const head = (await record.locator('.ev-saved-head').innerText()).trim();
        out.push({
          file: (await record.locator('.ev-saved-file').innerText()).trim(),
          kind: String(await record.getAttribute('data-kind')),
          page: /· page (\d+)/.test(head) ? Number(/· page (\d+)/.exec(head)![1]) : null,
          quote: (await quote.count()) ? ((await quote.textContent()) ?? '') : null,
          body: (await body.count()) ? ((await body.textContent()) ?? '') : '',
          noteId: String(await record.getAttribute('data-note')),
          versionId: String(await record.getAttribute('data-version')),
        });
      }
      return out;
    },

    reopenTheSavedPassage: async (quote): Promise<ReopenedPassage> => {
      const record = evidenceNotesPanel().locator('ol.ev-saved > li')
        .filter({ has: win().locator('blockquote', { hasText: new RegExp(`^${literally(quote)}$`) }) }).first();
      await expect(record, `no saved passage keeps "${quote}"`).toBeVisible({ timeout: 30_000 });
      const file = (await record.locator('.ev-saved-file').innerText()).trim();
      await record.getByRole('button', { name: 'Reopen the passage', exact: true }).click();
      const reader = evidenceReader();
      await expect(reader.getByRole('heading', { name: file, exact: true })).toBeVisible({ timeout: 30_000 });
      // "Unresolved until this exact page is read" is the state it starts in;
      // the two sentences waited for here are the two it can end in.
      const resolution = reader.locator('[data-evidence="resolution"]');
      await expect(resolution, 'the reader never said whether the saved passage still matches')
        .toHaveText(/^Saved passage (resolved|unresolved:)/, { timeout: 60_000 });
      const pane = reader.getByLabel('Canonical page text');
      return {
        file,
        page: Number(await reader.getAttribute('data-page')),
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
      const open = win().locator('section.ev-workspace .ev-head').getByRole('button', { name: 'Export selected evidence', exact: true });
      await expect(open).toBeEnabled({ timeout: 30_000 });
      if (await open.getAttribute('aria-pressed') !== 'true') await open.click();
      const dialog = win().getByRole('region', { name: 'Export selected evidence' });
      await expect(dialog).toBeVisible({ timeout: 30_000 });
      for (const file of files) await named(dialog.locator('label.choice'), 'span', file).getByRole('checkbox').check();
      if (includeFiles) await dialog.getByLabel(/^Include the files themselves/).check();
      downloadsMade += 1;
      const dir = path.join(fs.realpathSync(session.stateDir), 'downloads');
      fs.mkdirSync(dir, { recursive: true });
      const target = path.join(dir, `selected-evidence-${downloadsMade}.zip`);
      await theNextDownloadGoesTo(target);
      await dialog.getByRole('button', { name: 'Save the archive', exact: true }).click();
      await expect(dialog.locator('[data-evidence="exported"]'), 'the archive was never offered')
        .toHaveText(new RegExp(`^Saved a ${includeFiles ? 'files-and-records' : 'records-only'} archive`), { timeout: 120_000 });
      await theDownloadHasCompleted(target);
      // Read with the backend's own interpreter, so the archive on disk is
      // left exactly as the app wrote it.
      const read = JSON.parse(execFileSync(session.python, ['-c', `
import hashlib, json, sys, zipfile
with zipfile.ZipFile(sys.argv[1]) as bundle:
    assert bundle.testzip() is None
    names = bundle.namelist()
    print(json.dumps({'members': names, 'manifest': json.loads(bundle.read('manifest.json')),
                      'notes': bundle.read('notes.md').decode('utf-8'),
                      'hashes': {name: hashlib.sha256(bundle.read(name)).hexdigest() for name in names}}))
`, target], { encoding: 'utf8' }));
      await open.click();
      return { path: target, members: read.members, manifest: read.manifest, notesMarkdown: read.notes, hashes: read.hashes };
    },

    // — selected-evidence answers ----------------------------------------------

    askFromSelectedEvidence: async (request) => {
      await openTheAnswers();
      const start = win().getByRole('navigation', { name: 'Saved answers' }).getByRole('button', { name: 'New answer', exact: true });
      await expect(start).toBeEnabled({ timeout: 60_000 });
      await start.click();
      const composer = win().getByRole('region', { name: 'New answer from selected evidence' });
      // The connections arrive from the engine; nothing can be previewed before them.
      await expect(composer.getByLabel('Connection', { exact: true })).toBeEnabled({ timeout: 30_000 });
      for (const choice of request.select) {
        if (choice.page !== undefined) {
          await composer.getByLabel(`Page of ${choice.file}`, { exact: true }).fill(String(choice.page));
          await composer.getByRole('button', { name: `Add the page of ${choice.file}`, exact: true }).click();
        } else {
          await composer.getByRole('button', { name: `Add the text of ${choice.file}`, exact: true }).click();
        }
      }
      // The composer's own list is its record of what was added; a selection
      // that failed to add would otherwise surface only as a shorter preview.
      await expect(composer.getByRole('list', { name: 'Selected excerpts' }).locator('li'), 'a selection was pressed and not added')
        .toHaveCount(request.select.length, { timeout: 15_000 });
      for (const body of request.includeNotes ?? []) {
        await composer.getByLabel(`Include note: ${body}`, { exact: true }).check();
      }
      await composer.getByLabel('Answer as', { exact: true }).selectOption(request.format);
      await composer.getByLabel('Question or instruction', { exact: true }).fill(request.instruction);
      await composer.getByLabel('Connection', { exact: true }).selectOption('api_key:custom');
      await composer.getByLabel('Model', { exact: true }).fill(request.model);
      await composer.getByRole('button', { name: 'Show exactly what will be sent', exact: true }).click();
      const disclosure = composer.getByRole('region', { name: 'Exact disclosure' });
      await expect(disclosure.getByRole('heading', { name: 'Check before sending' }), 'the preview never arrived')
        .toBeVisible({ timeout: 120_000 });
      const preview: SelectedAnswerPreview = { sources: [], notes: [], text: '' };
      const articles = disclosure.locator('article.ev-source');
      for (let i = 0; i < await articles.count(); i += 1) {
        const article = articles.nth(i);
        const head = (await article.locator('h4').innerText()).trim();
        const body = (await article.locator('pre').textContent()) ?? '';
        const source = /^(S\d+) · (.+) · page (\d+)$/.exec(head);
        if (source) preview.sources.push({ id: source[1]!, file: source[2]!, page: Number(source[3]), text: body });
        else preview.notes.push(body);
      }
      preview.text = (await disclosure.innerText()).trim();
      await disclosure.getByRole('button', { name: 'Send', exact: true }).click();
      const article = answerArticle();
      await expect(article, 'Send was pressed and no answer opened').toBeVisible({ timeout: 60_000 });
      const id = String(await article.getAttribute('data-answer'));
      await expect.poll(async () => {
        const saved = await backend.selectedAnswer(theOpenProject(), id);
        return !['admitted', 'running'].includes(String(saved.state)) && saved.cleanup_state === 'confirmed';
      }, { timeout: 150_000, message: `answer ${id} never finished with its local cleanup confirmed` }).toBe(true);
      await expect(composer, 'the composer outlived the Send it admitted').toHaveCount(0, { timeout: 30_000 });
      return { preview, answer: await readTheAnswerHere(id) };
    },

    openEachCitationOfTheAnswer: async (): Promise<OpenedCitation[]> => {
      const article = answerArticle();
      await expect(article).toBeVisible({ timeout: 30_000 });
      const buttons = article.locator('button.ev-cite');
      const out: OpenedCitation[] = [];
      for (let i = 0; i < await buttons.count(); i += 1) {
        const label = (await buttons.nth(i).innerText()).trim();
        await buttons.nth(i).click();
        const excerpt = article.getByRole('region', { name: 'Saved citation' });
        await expect(excerpt.getByRole('heading', { name: `Frozen quote · ${label.split(' · ')[0]}` })).toBeVisible({ timeout: 30_000 });
        // The current reader's verdict on the exact range, or the excerpt's
        // own alert when the current original could not be checked.
        const verdict = excerpt.locator('[data-evidence="resolution"]')
          .filter({ hasText: /^(Citation matched|Saved citation unresolved:)/ })
          .or(excerpt.getByRole('alert')).first();
        await expect(verdict, `${label} never said whether it matched the current text`).toBeVisible({ timeout: 60_000 });
        const pane = excerpt.getByLabel('Canonical page text');
        out.push({
          label,
          frozen: (await excerpt.locator('pre.ev-quote').textContent()) ?? '',
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
      await openTheAnswers();
      const row = win().getByRole('navigation', { name: 'Saved answers' }).locator(`button.ev-answer-row[data-answer="${answerId}"]`);
      await expect(row, `the history lists no answer ${answerId}`).toBeVisible({ timeout: 60_000 });
      await row.click();
      return readTheAnswerHere(answerId);
    },

    exportTheOpenAnswerAsHtml: async () => {
      const article = answerArticle();
      await expect(article).toBeVisible({ timeout: 30_000 });
      downloadsMade += 1;
      const dir = path.join(fs.realpathSync(session.stateDir), 'downloads');
      fs.mkdirSync(dir, { recursive: true });
      const target = path.join(dir, `selected-answer-${downloadsMade}.html`);
      await theNextDownloadGoesTo(target);
      await article.getByRole('button', { name: 'Save as HTML', exact: true }).click();
      await expect(article.locator('[data-answer="saved"]'), 'the page never said it saved the HTML')
        .toHaveText(/^Saved the answer as one HTML file/, { timeout: 60_000 });
      await theDownloadHasCompleted(target);
      return { path: target, text: fs.readFileSync(target, 'utf8') };
    },

    readConnectedIdentity: async () => {
      // Atlas names the engine on Health's own tab rather than in a header.
      await win().evaluate(() => { window.location.hash = '#/health/engine'; });
      const status = win().locator('[data-health="status"]');
      await expect(status).toContainText('Connected', { timeout: 30_000 });
      const details = win().locator('[data-health="details"]');
      await expect(details).toBeVisible({ timeout: 15_000 });
      return {
        status: (await status.innerText()).trim(),
        details: (await details.innerText()).trim(),
      };
    },

    // — settings: the background service, email, notifications --------------

    readDaemonPanel: async (): Promise<DaemonPanel> => {
      await goto('Advanced settings');
      const panel = win().locator('section.service');
      // The goto waited for the three reads; the facts are drawn only once all are in.
      await expect(panel.locator('[data-service="window"] dd')).not.toHaveText('Asking.', { timeout: 30_000 });
      const control = panel.locator('[role="switch"][data-switch="service"]');
      const present = (await control.count()) > 0;
      return {
        status: (await panel.locator('[data-service="status"] dd').innerText()).replace(/\s+/g, ' ').trim(),
        controlPresent: present,
        controlOn: present ? (await control.getAttribute('aria-checked')) === 'true' : false,
        text: (await panel.innerText()).trim(),
      };
    },

    configureEmail: async (settings, password) => {
      await goto('Email settings');
      for (const [field, selector] of Object.entries(EMAIL_FIELD) as [keyof EmailSettings, string][]) {
        await win().locator(selector).fill(settings[field]);
      }
      // The password is not a setting: it goes to the machine's own credential
      // store by its own button, and only the fact of it comes back.
      await win().locator('#smtp-password').fill(password);
      const passwordAccepted = win().waitForResponse(
        (r) => r.url().includes('/api/credentials/smtp_password') && r.request().method() === 'PUT',
      );
      await win().locator('.password-row').getByRole('button', { name: /^(Store|Replace)$/ }).click();
      expect((await passwordAccepted).ok(), 'the SMTP password was refused by the credential store').toBe(true);
      const saved = win().waitForResponse(
        (r) => r.url().endsWith('/api/settings/email') && r.request().method() === 'PUT',
      );
      await win().locator('.email-form .form-actions').getByRole('button', { name: 'Save', exact: true }).click();
      expect((await saved).ok(), 'Settings › Email refused the save').toBe(true);
      // Saved means nothing is left unsaved: the button greys out again.
      await expect(win().locator('.email-form .form-actions').getByRole('button', { name: 'Save', exact: true }))
        .toBeDisabled({ timeout: 15_000 });
    },

    readEmailSettings: async (): Promise<EmailSettings> => {
      await goto('Email settings');
      await expect(win().locator(EMAIL_FIELD.server)).toBeVisible({ timeout: 30_000 });
      const read = async (field: keyof EmailSettings) => win().locator(EMAIL_FIELD[field]).inputValue();
      return {
        server: await read('server'),
        port: await read('port'),
        username: await read('username'),
        sender: await read('sender'),
        recipients: await read('recipients'),
      };
    },

    sendATestEmail: async () => {
      await goto('Email settings');
      const answered = win().waitForResponse((r) => r.url().endsWith('/api/settings/email/test'));
      await win().locator('[data-email="test"]').click();
      await answered;
      const line = win().locator('[data-email="test-result"]');
      await expect(line).toBeVisible({ timeout: 60_000 });
      return (await line.innerText()).replace(/\s+/g, ' ').trim();
    },

    setNotificationPreferences: async (preferences) => {
      if (preferences.forAutomaticRoutines === 'none') {
        // The engine notifies a watch whose own switch is on whatever the mode,
        // so "none" and "selected" do the same thing, and Atlas offers only the
        // choice that differs (`screens/settings/Notifications.tsx`).
        notInAtlasYet('a "none" choice for watches, which the engine treats as "selected"');
      }
      await goto('Notification settings');
      const section = win().locator('section.notifications');
      const saved = () => win().waitForResponse(
        (r) => r.url().endsWith('/api/settings/notifications') && r.request().method() === 'PUT',
      );
      const manual = section.locator('[role="switch"][data-switch="notify_manual"]');
      if (((await manual.getAttribute('aria-checked')) === 'true') !== preferences.whenIRunSomethingMyself) {
        const answered = saved();
        await manual.click();
        expect((await answered).ok(), 'Settings › Notifications refused the save').toBe(true);
      }
      const radio = section.locator(`input[name="notify-watches"][value="${preferences.forAutomaticRoutines}"]`);
      if (!(await radio.isChecked())) {
        const answered = saved();
        await radio.check();
        expect((await answered).ok(), 'Settings › Notifications refused the save').toBe(true);
      }
      await expect(section).toHaveAttribute('aria-busy', 'false', { timeout: 15_000 });
    },

    readNotificationPreferences: async (): Promise<NotificationPreferences> => {
      await goto('Notification settings');
      const section = win().locator('section.notifications');
      const manual = section.locator('[role="switch"][data-switch="notify_manual"]');
      await expect(manual).toBeVisible({ timeout: 30_000 });
      const every = await section.locator('input[name="notify-watches"][value="all"]').isChecked();
      return {
        whenIRunSomethingMyself: (await manual.getAttribute('aria-checked')) === 'true',
        forAutomaticRoutines: every ? 'all' : 'selected',
      };
    },

    // — saved searches -------------------------------------------------------

    saveConfiguration: async (name, from) => {
      // Ask the sources' own Save this search, under the form `runSweep` fills,
      // in Deep Sweep because that is the kind that takes several sources.
      await fillAsk('Deep Sweep', from.sources, [from.query], undefined, undefined);
      const known = new Set((await backend.configurations()).map((c) => Number(c.id)));
      await win().locator('[data-saved="keep"]').click();
      await win().locator('#keep-name').fill(name);
      const answered = win().waitForResponse(
        (r) => r.url().endsWith('/api/configurations') && r.request().method() === 'POST',
      );
      await win().locator('.keep-row').getByRole('button', { name: 'Save', exact: true }).click();
      const response = await answered;
      expect(response.status(), `Save this search answered HTTP ${response.status()}`).toBe(201);
      const id = Number((await response.json()).id);
      expect(known.has(id), 'Save this search answered with an id the app already held').toBe(false);
      // Then the screen, which says so only after the engine stored it.
      await expect(win().locator('[data-saved="kept"]')).toContainText(name, { timeout: 15_000 });
      return id;
    },

    exportConfigurations: async (kind): Promise<ConfigurationExport> => {
      await goto('Saved configurations');
      const all = await backend.configurations();
      const ofThisKind = all.filter((c) => (c.config_type === 'routine') === (kind === 'routine'));
      expect(ofThisKind.length, `the app holds no ${kind} configuration to export`).toBeGreaterThan(0);
      // Every row the engine holds is drawn before anything is chosen.
      await expect(win().locator('li.saved')).toHaveCount(all.length, { timeout: 30_000 });
      const clear = win().getByRole('button', { name: 'Clear the choice', exact: true });
      if (await clear.count()) await clear.click();
      for (const config of ofThisKind) {
        await win().locator(`li.saved[data-config="${config.id}"] .saved-pick input`).check();
      }
      const button = win().locator('[data-saved="export"]');
      await expect(button, 'the page did not choose what was ticked')
        .toHaveText(new RegExp(`^Export ${ofThisKind.length} `), { timeout: 15_000 });
      // A download, as every other export in Atlas is: the save dialog is
      // answered with a destination, and the bytes and the flow are the app's.
      downloadsMade += 1;
      const dir = path.join(fs.realpathSync(session.stateDir), 'downloads');
      fs.mkdirSync(dir, { recursive: true });
      const written = path.join(dir, `saved-configurations-${downloadsMade}.zip`);
      await theNextDownloadGoesTo(written);
      await button.click();
      await expect(win().locator('[data-saved="exported"]'), 'the page never said the export was made')
        .toBeVisible({ timeout: 30_000 });
      await theDownloadHasCompleted(written);
      expect(fs.existsSync(written), `the export was never saved to ${written}`).toBe(true);
      // Read out member by member, as the classic driver does: the archive is
      // compressed, so a search of its bytes for a secret would pass for the
      // wrong reason.
      const members = execFileSync(session.python, ['-c', `
import json, sys, zipfile
with zipfile.ZipFile(sys.argv[1]) as bundle:
    print(json.dumps({name: bundle.read(name).decode('utf-8') for name in bundle.namelist()}))
`, written], { encoding: 'utf8' });
      return { path: written, members: JSON.parse(members) as Record<string, string> };
    },

    importConfigurations: async (exported): Promise<ImportOutcome> => {
      await goto('Saved configurations');
      const said = win().locator('[data-saved="imported"]');
      const refused = win().locator('[data-saved="import-refused"]');
      const before = await backend.configurations();
      const chooser = win().waitForEvent('filechooser');
      await win().locator('[data-saved="import"]').click();
      const picker = await chooser;
      // What the page told the chooser to offer; the native dialog itself is
      // not opened, and the chooser is answered with the file the export wrote.
      const chooserAccepts = (await picker.element().getAttribute('accept')) ?? '';
      const answered = win().waitForResponse(
        (r) => r.url().endsWith('/api/configurations/import') && r.request().method() === 'POST',
      );
      await picker.setFiles(exported.path);
      await answered;
      // Either what it imported or what it refused, and never neither.
      await expect.poll(async () => (await said.count()) + (await refused.count()), {
        timeout: 30_000,
        message: `Import said neither what it imported from ${path.basename(exported.path)} nor what it refused`,
      }).toBeGreaterThan(0);
      await expect(win().locator('.saved-page')).toHaveAttribute('aria-busy', 'false', { timeout: 30_000 });
      const after = await backend.configurations();
      return {
        arrived: after.length - before.length,
        said: (await said.count()) ? (await said.innerText()).trim() : '',
        refusal: (await refused.count()) ? (await refused.innerText()).trim() : '',
        chooserAccepts,
      };
    },

    // — people ---------------------------------------------------------------

    createWatchProfile: async (profile): Promise<ProfileCreation> => {
      await goto('Watch Profiles');
      await win().getByRole('button', { name: 'New person', exact: true }).click();
      const editor = win().locator('form.person-editor');
      await expect(editor).toBeVisible({ timeout: 30_000 });
      await editor.locator('#person-name').fill(profile.name);
      if (profile.orcid) await editor.locator('#person-orcid').fill(profile.orcid);
      // Read before saving: the journey is about what a person is told while
      // they are still deciding, and the saved profile's copy is another surface.
      const note = editor.locator('[data-people="warning"]');
      const warns = (await note.getAttribute('data-state')) === 'warns';
      const warningAtCreation = warns ? (await note.locator('p').last().innerText()).trim() : '';
      const created = win().waitForResponse(
        (r) => r.url().endsWith('/api/profiles') && r.request().method() === 'POST',
      );
      await editor.getByRole('button', { name: 'Save person', exact: true }).click();
      const response = await created;
      expect(response.ok(), 'the person the editor submitted was refused').toBe(true);
      const id = Number((await response.json()).id);
      const row = win().locator(`.person[data-profile="${id}"]`);
      await expect(row).toBeVisible({ timeout: 30_000 });
      return { id, warningAtCreation, chipInList: (await row.locator('.basis-chip').innerText()).trim() };
    },

    readProfileMatches: async (name): Promise<ProfileMatches> => {
      const profile = (await backend.profiles()).find((p) => p.display_name === name);
      expect(profile, `no watch profile named ${name}`).toBeTruthy();
      const id = Number(profile!.id);
      await goto('Watch Profiles');
      await win().locator(`.person[data-profile="${id}"] .watch-name`).click();
      const page = win().locator(`.person-page[data-profile="${id}"]`);
      await expect(page).toHaveAttribute('aria-busy', 'false', { timeout: 30_000 });
      // The page's empty sentence is drawn only once the matches are read, but
      // the count is the app's own, so the read is held to it.
      const recorded = await session.api<{ total?: number }>('GET', `/api/profiles/${id}/matches`);
      await expect(page.locator(Number(recorded.total ?? 0) > 0 ? '[data-people="counts"]' : '[data-people="no-matches"]'))
        .toBeVisible({ timeout: 30_000 });
      const items = await page.locator('.match').evaluateAll((rows) => rows.map((row) => ({
        basis: row.querySelector('.basis-chip')?.textContent?.trim() ?? '',
        author: (row.querySelector('.match-author')?.textContent ?? '').trim().replace(/^as /, ''),
        title: row.querySelector('.result-title')?.textContent?.trim() ?? '',
      })));
      const counts = page.locator('[data-people="counts"]');
      return { counts: (await counts.count()) ? (await counts.innerText()).trim() : '', items };
    },

    readBasisBadgesInTheExplorer: async () => {
      await openCollection();
      // Where the app says a profile has matched something, wait for a badge;
      // where it says nothing has, there is nothing to wait for.
      let recorded = 0;
      for (const profile of await backend.profiles()) {
        const matches = await session.api<{ total?: number }>('GET', `/api/profiles/${profile.id}/matches`);
        recorded += Number(matches.total ?? 0);
      }
      const chips = win().locator('.result-people .basis-chip');
      if (recorded > 0) await expect(chips.first()).toBeVisible({ timeout: 30_000 });
      return (await chips.allInnerTexts()).map((t) => t.trim());
    },

    readTheHelpOnThisPage: async () => {
      const help = win().locator('details.place-help').first();
      await expect(help, 'this place offers no help block').toBeVisible({ timeout: 30_000 });
      if ((await help.getAttribute('open')) === null) await help.locator('summary').click();
      const body = help.locator('.place-help-body');
      await expect(body).toBeVisible({ timeout: 15_000 });
      return `${(await help.locator('summary').innerText()).trim()}\n${(await body.innerText()).trim()}`;
    },

    readWhatThisPlaceSays: async () => {
      const main = win().locator('main.stage');
      await expect(main).toBeVisible({ timeout: 30_000 });
      return (await main.innerText()).trim();
    },

    // — watches -------------------------------------------------------------

    createRoutine: async (routine) => {
      // Watches › New watch, as a person makes one: a name, the terms, the
      // sources, a schedule chosen in words, and "Start watching when saved"
      // turned off, because a journey's routine starts paused (J03 and J20
      // assert it) and an active one would ask real sources at its next fire.
      const schedule = editorSchedule(routine.cron);
      if (!schedule) throw new Error(`the watch editor offers no schedule that stores "${routine.cron}"`);
      await goto('Routines');
      await win().locator('[data-editor="new"]').click();
      const editor = win().getByRole('form', { name: 'A new watch' });
      await expect(editor, 'New watch did not open the editor').toBeVisible({ timeout: 30_000 });
      await editor.locator('#watch-name').fill(routine.name);
      const terms = editor.locator('#watch-terms');
      for (const term of routine.keywords) {
        await terms.fill(term);
        await terms.press('Enter');
      }
      await expect(editor.locator('.term'), 'the editor does not hold the terms typed').toHaveText(routine.keywords);
      for (const source of routine.sources) {
        const row = editor.locator(`.source[data-source="${source}"]`);
        await expect(row, `the watch editor lists no source "${source}"`).toBeVisible({ timeout: 60_000 });
        await row.locator('input').check();
      }
      const cadence = editor.getByRole('group', { name: 'How often' }).getByRole('button', { name: schedule.cadence, exact: true });
      await cadence.click();
      await expect(cadence).toHaveAttribute('aria-pressed', 'true');
      if (schedule.weekday !== undefined) await editor.getByLabel('Day of the week').selectOption(schedule.weekday);
      if (schedule.monthDay !== undefined) await editor.getByLabel('Day of the month').selectOption(schedule.monthDay);
      await editor.getByLabel('Time of day').fill(schedule.time);
      const start = editor.locator('[data-switch="is_active"]');
      if ((await start.getAttribute('aria-checked')) !== 'false') await start.click();
      await expect(start, 'the new watch would start watching when saved').toHaveAttribute('aria-checked', 'false');
      const save = editor.getByRole('button', { name: 'Save watch', exact: true });
      await expect(save, 'the editor will not save the watch as filled in').toBeEnabled({ timeout: 30_000 });
      const created = win().waitForResponse((r) => r.url().endsWith('/api/routines') && r.request().method() === 'POST');
      await save.click();
      const response = await created;
      expect(response.ok(), `Save watch was refused: HTTP ${response.status()}`).toBe(true);
      const id = Number((await response.json()).id);
      await stored(`${routine.name} as a paused watch on ${routine.cron}`,
        () => session.api<Record<string, unknown>>('GET', `/api/routines/${id}`),
        (record) => {
          const parameters = parametersOf(record.parameters);
          return record.name === routine.name && record.schedule_cron === routine.cron && !record.is_active
            && JSON.stringify(parameters.repositories) === JSON.stringify(routine.sources)
            && JSON.stringify(parameters.keywords) === JSON.stringify(routine.keywords);
        });
      await expect(win().locator(`.watch-page[data-routine="${id}"] [data-editor="said"]`),
        'the watch was stored and its page never said so').toHaveText('Saved, paused.', { timeout: 30_000 });
      return id;
    },

    fireRoutineNow: async (name): Promise<RunHandle> => {
      // The watch page's Run now, on every watch, paused or not. As with
      // `askForThisRoutineToRunNow`, the run starts in the window's own engine,
      // which never runs watches on a clock (`RESMON_DISABLE_SCHEDULER=1`), so
      // what this observes is the run a fire produces, not what produces one.
      const id = await openWatch(name);
      const answered = win().waitForResponse(
        (r) => r.url().endsWith(`/api/routines/${id}/run`) && r.request().method() === 'POST',
      );
      await win().getByRole('button', { name: 'Run now', exact: true }).click();
      const response = await answered;
      expect(response.ok(), `Run now on ${name} was refused: HTTP ${response.status()}`).toBe(true);
      const run: RunHandle = { id: Number((await response.json()).execution_id) };
      await stored(`run ${run.id} as ${name}'s`, () => backend.execution(run), (row) => Number(row.routine_id) === id);
      await expect(win().locator('.run-now-said'), 'the run was recorded and the page never said it started')
        .toHaveAttribute('data-run-started', String(run.id), { timeout: 30_000 });
      return run;
    },

    addDeliveryTarget: async (routine, target): Promise<DeliveryDestination> => {
      // A folder or a feed is refused unless the directory exists: the engine
      // will not make one, so a mistyped path reports itself rather than
      // quietly succeeding. So the journey makes the folder a person would
      // have chosen, inside this session's own state directory.
      let destination = target.destination ?? '';
      if (!destination && target.channel !== 'webhook') {
        destination = path.join(session.stateDir, `delivery-${target.channel}`);
        fs.mkdirSync(destination, { recursive: true });
      }
      const mode = target.mode ?? 'automatic';
      // The watch's own Where reports go tab, where a person adds one.
      const id = await openWatchTab(routine, 'Where reports go');
      const add = win().getByRole('form', { name: 'Add a destination' });
      await expect(add, `${routine}'s page offers no way to add a destination`).toBeVisible({ timeout: 30_000 });
      await add.getByLabel('Kind of destination', { exact: true }).selectOption(target.channel);
      await add.getByLabel('Where it goes', { exact: true }).fill(destination);
      await add.getByLabel('When reports go there', { exact: true }).selectOption(mode);
      const answered = win().waitForResponse(
        (r) => r.url().endsWith(`/api/routines/${id}/delivery-targets`) && r.request().method() === 'POST',
      );
      await add.getByRole('button', { name: 'Add', exact: true }).click();
      const response = await answered;
      expect(response.ok(), `the ${target.channel} destination was refused: HTTP ${response.status()}`).toBe(true);
      const created = Number((await response.json()).id);
      await stored(`a ${target.channel} destination for ${routine}`,
        () => session.api<{ targets: Record<string, unknown>[] }>('GET', `/api/routines/${id}/delivery-targets`),
        ({ targets }) => targets.some((t) => Number(t.id) === created && t.channel === target.channel
          && t.target === destination && t.mode === mode && Boolean(t.enabled)));
      await expect(win().locator(`.destinations li[data-target="${created}"]`), 'the destination was stored and the tab does not list it')
        .toBeVisible({ timeout: 30_000 });
      return { id: created, channel: target.channel, destination };
    },

    listRoutineNames: async () => {
      await goto('Routines');
      // The denominator is the engine's own list: wait until every name it
      // holds is drawn, rather than reading an empty list that is still loading.
      const expected = (await backend.routines()).map((r) => String(r.name));
      const names = win().locator('.watch-list .watch-name');
      await expect.poll(async () => {
        const drawn = (await names.allInnerTexts()).map((t) => t.trim());
        return expected.every((name) => drawn.includes(name));
      }, { timeout: 30_000, message: `Watches never drew all ${expected.length} watch(es) the app reports` }).toBe(true);
      return (await names.allInnerTexts()).map((t) => t.trim());
    },

    readRoutine: async (name): Promise<RoutineFacts> => {
      const id = await openWatch(name);
      const page = win().locator(`.watch-page[data-routine="${id}"]`);
      return {
        name: (await page.locator('.run-name').innerText()).trim(),
        active: (await page.getAttribute('data-active')) === 'true',
        desktopNotification: (await page.locator('[data-switch="notify_on_complete"]').getAttribute('aria-checked')) === 'true',
      };
    },

    activateRoutine: (name) => setScheduled(name, true),
    deactivateRoutine: (name) => setScheduled(name, false),

    toggleDesktopNotification: async (name) => {
      // Read against the record before the click: "it is on now" is true of a
      // switch that was already on. The journey is that the click changed
      // something and the change was kept.
      const before = Boolean((await routineNamed(name)).record.notify_on_complete);
      await openWatch(name);
      const toggle = win().locator('[data-switch="notify_on_complete"]');
      await expect(toggle).toHaveAttribute('aria-checked', String(before));
      await toggle.click();
      await expect.poll(async () => Boolean((await routineNamed(name)).record.notify_on_complete), {
        timeout: 30_000, message: `${name}'s desktop notification was never recorded as ${before ? 'off' : 'on'}`,
      }).toBe(!before);
      await expect(toggle, 'the record flipped and the switch still shows the old state')
        .toHaveAttribute('aria-checked', String(!before), { timeout: 30_000 });
    },

    readUpcomingFires: async (): Promise<UpcomingFire[]> => {
      await goto('Calendar');
      const month = win().locator('section.month-ahead');
      await expect(month).toHaveAttribute('data-state', 'read', { timeout: 30_000 });
      // Every fire the engine's calendar promises, each saying whether the
      // month on screen draws it. A drawn fire is matched by its watch and its
      // exact time, so one occurrence is told from the next.
      const names = new Map((await backend.routines()).map((r) => [Number(r.id), String(r.name)]));
      const events = await session.api<{ routine_id: number | null; start: string; title: string; status: string }[]>(
        'GET', '/api/calendar/events');
      const drawn = new Set(await month.locator('.fire').evaluateAll((marks) => marks.map(
        (mark) => `${(mark as HTMLElement).dataset.routine}|${(mark as HTMLElement).dataset.at}`,
      )));
      return events
        .filter((e) => e.status === 'scheduled')
        .map((e) => ({
          routine: names.get(Number(e.routine_id)) ?? String(e.title),
          when: new Date(String(e.start)),
          title: String(e.title),
          drawn: drawn.has(`${e.routine_id}|${e.start}`),
        }));
    },

    runNowControlIsOnTheRow: async (name) => {
      // On the watch's own page, which is where Atlas puts it, for every
      // watch: the engine runs a paused one once when asked.
      await openWatch(name);
      return (await win().getByRole('button', { name: 'Run now', exact: true }).count()) > 0;
    },

    askForThisRoutineToRunNow: async (name): Promise<RunNowAnswer> => {
      const id = await openWatch(name);
      const answered = win().waitForResponse(
        (r) => r.url().endsWith(`/api/routines/${id}/run`) && r.request().method() === 'POST',
      );
      await win().getByRole('button', { name: 'Run now', exact: true }).click();
      await answered;
      const said = win().locator('.run-now-said, .run-now-refusal');
      await expect(said, 'Run now was answered and the page said nothing').toBeVisible({ timeout: 30_000 });
      const started = await said.getAttribute('data-run-started');
      const text = (await said.innerText()).trim();
      // The kind of refusal is a response header the renderer is not given
      // cross-origin, so the app cannot read it either: '' here, as in the
      // classic driver, and the sentence is what the row asserts.
      return started
        ? { run: { id: Number(started) }, refusal: '', refusalKind: '' }
        : { run: null, refusal: text, refusalKind: '' };
    },

    readDeliveryRecord: async (name): Promise<DeliveryRecord[]> => {
      const { id } = await routineNamed(name);
      const recorded = await settledDeliveries(id);
      await openWatchTab(name, 'Where reports go');
      const rows = win().locator('.delivery-list .delivery-row');
      await expect(rows).toHaveCount(Object.keys(recorded).length, { timeout: 30_000 });
      // Each row drawn as the engine now records it, not as an earlier read had it.
      for (const [rowId, state] of Object.entries(recorded)) {
        await expect(win().locator(`.delivery-row[data-delivery="${rowId}"]`)).toHaveAttribute('data-state', state, { timeout: 30_000 });
      }
      return rows.evaluateAll((list, states) => list.map((row) => {
        const el = row as HTMLElement;
        const deliveryId = Number(el.dataset.delivery);
        return {
          id: deliveryId,
          channel: el.dataset.channel ?? '',
          state: el.querySelector('.delivery-state')?.textContent?.trim() ?? '',
          recorded: (states as Record<string, string>)[String(deliveryId)] ?? '',
          detail: el.querySelector('.delivery-detail')?.textContent?.trim() ?? '',
        };
      }), recorded);
    },

    skipDelivery: async (name, delivery) => {
      await openWatchTab(name, 'Where reports go');
      const row = win().locator(`.delivery-row[data-delivery="${delivery.id}"]`);
      await expect(row).toBeVisible({ timeout: 30_000 });
      await row.getByRole('button', { name: 'Skip', exact: true }).click();
      await expect(row).toHaveAttribute('data-state', 'skipped', { timeout: 30_000 });
    },

    writeRoutineIntent: async (name, intent) => {
      // Through the watch's own intent field, which is where a person writes it.
      await openWatchTab(name, 'What it finds');
      const field = win().getByLabel('What this watch is really looking for');
      await field.fill(intent);
      await win().locator('.intent-form').getByRole('button', { name: 'Save', exact: true }).click();
      await expect.poll(async () => (await routineNamed(name)).record.intent ?? '', {
        timeout: 30_000, message: `the intent for ${name} was never recorded`,
      }).toBe(intent);
      await expect(win().locator('[data-coverage="intent"]'), 'the audit never compared against the saved intent')
        .toContainText(intent, { timeout: 60_000 });
    },

    readCoverageAudit: async (name): Promise<CoverageAudit> => {
      await openWatchTab(name, 'What it finds');
      const panel = win().locator('.coverage');
      await expect(panel).toHaveAttribute('data-coverage-state', 'read', { timeout: 60_000 });
      await expect(panel.locator('[data-coverage="intent"], [data-coverage="reason"]').first()).toBeVisible();
      const read = async (key: string): Promise<string> => {
        const node = panel.locator(`[data-coverage="${key}"]`).first();
        return (await node.count()) ? (await node.innerText()).trim() : '';
      };
      return {
        intent: await read('intent'),
        reason: await read('reason'),
        offTargetShowing: await read('off-target-showing'),
        missedShowing: await read('missed-showing'),
        cannotSee: await read('cannot-see'),
        text: (await panel.innerText()).trim(),
      };
    },

    // — the collection ------------------------------------------------------

    rankTheExplorerBy: async (phrase): Promise<RankedList> => {
      await openCollection(phrase);
      const capability = await win().locator('section.results').getAttribute('data-capability');
      const control = win().getByRole('group', { name: 'Order' });
      if (capability !== 'available') {
        await expect(control).toHaveCount(0);
        // Absent, and not silently: the sentence in the control's place says why.
        const why = win().locator('[data-collection="ranking"]');
        await expect(why, 'the collection cannot rank and does not say why').toBeVisible({ timeout: 30_000 });
        return { note: (await why.innerText()).trim(), controlsPresent: false, list: await readList() };
      }
      await control.getByRole('button', { name: 'Closest in meaning' }).click();
      const note = win().locator('.rank-note').first();
      await expect(note).toContainText('Closest to:', { timeout: 60_000 });
      await settledResults();
      return { note: (await note.innerText()).trim(), controlsPresent: true, list: await readList() };
    },

    // — embeddings, in Settings → AI ------------------------------------------

    enableRankingByMeaning: async () => {
      // The same deterministic model on loopback the classic driver uses, set
      // up through Settings → AI → Embeddings as a person does: Ollama, the
      // model, the endpoint, a probe that must answer, then Save.
      const endpoint = await startEmbeddingEndpoint();
      session.alsoCloseOnClose(endpoint.close);
      const part = await openEmbeddings();
      const form = await embeddingForm(part);
      await form.getByLabel('Provider', { exact: true }).selectOption('local');
      await form.getByLabel('Model', { exact: true }).fill(JOURNEY_EMBEDDING_MODEL);
      await form.getByLabel('Ollama endpoint', { exact: true }).fill(endpoint.url);
      await form.getByRole('button', { name: 'Probe this model', exact: true }).click();
      const probe = form.locator('[data-embeddings="probe"]');
      await expect(probe, 'the probe drew no answer').toBeVisible({ timeout: 30_000 });
      expect(await probe.getAttribute('data-ok'), `the embedding probe said: ${await probe.innerText()}`).toBe('true');
      await form.getByRole('button', { name: 'Save embedding settings', exact: true }).click();
      await stored(`ranking by meaning on ${JOURNEY_EMBEDDING_MODEL}`,
        () => session.api<{ settings: Record<string, string> }>('GET', '/api/settings/embeddings'),
        ({ settings }) => ['true', '1'].includes(String(settings.embedding_enabled).trim().toLowerCase())
          && settings.embedding_provider === 'local'
          && settings.embedding_model === JOURNEY_EMBEDDING_MODEL && settings.embedding_endpoint === endpoint.url);
      await expect(form.locator('[data-embeddings="saved"]')).toBeVisible({ timeout: 30_000 });
      await expect(part).toHaveAttribute('data-embeddings-lane', 'set', { timeout: 30_000 });
      return JOURNEY_EMBEDDING_MODEL;
    },

    chooseAnEmbeddingProvider: async (provider): Promise<EmbeddingProviderChoice> => {
      const stored = await session.api<{ settings: Record<string, string>; providers: { provider: string; state: string }[] }>(
        'GET', '/api/settings/embeddings',
      );
      const expected = stored.providers.find((p) => p.provider === provider)?.state === 'no';
      const part = await openEmbeddings();
      const form = await embeddingForm(part);
      await form.getByLabel('Provider', { exact: true }).selectOption(provider);
      const refusal = form.locator('[data-embeddings="refusal"]');
      // The engine's own answer for the provider says which state to wait for.
      await expect(refusal, expected ? `choosing ${provider} drew no refusal`
        : `choosing ${provider} drew a refusal the engine does not make`).toHaveCount(expected ? 1 : 0, { timeout: 30_000 });
      if (!expected) return { refused: false, reason: '' };
      await expect(form.getByRole('button', { name: 'Save embedding settings', exact: true }),
        'a refused provider can still be saved').toBeDisabled();
      const after = await session.api<{ settings: Record<string, string> }>('GET', '/api/settings/embeddings');
      expect(after.settings.embedding_provider, 'a refused provider was stored').toBe(stored.settings.embedding_provider);
      return { refused: true, reason: (await refusal.innerText()).trim() };
    },

    embedThePapersStillMissing: async (): Promise<EmbeddingBackfill> => {
      type Status = { coverage: { embedded: number; total: number }; run: { running: boolean; finished_at: string | null } };
      const before = await session.api<Status>('GET', '/api/embeddings/status');
      const part = await openEmbeddings();
      // The count on screen is the engine's, before anything is sent.
      const missingFact = part.locator('[data-embeddings="missing"]');
      await expect(missingFact).toHaveAttribute('data-count', String(before.coverage.total - before.coverage.embedded));
      const missing = (await missingFact.locator('dd').innerText()).trim();
      const run = part.locator('[data-embeddings="backfill"]');
      await run.getByRole('button', { name: 'Estimate the work', exact: true }).click();
      const estimate = run.locator('[data-embeddings="estimate"]');
      await expect(estimate, 'no estimate was shown').toBeVisible({ timeout: 60_000 });
      const estimated = (await estimate.innerText()).replace(/\s+/g, ' ').trim();
      const documents = Number(await estimate.getAttribute('data-documents'));
      // The only way to start is the button the estimate puts there.
      await run.getByRole('button', { name: new RegExp(`^Embed ${documents} papers?$`) }).click();
      let after = before;
      await expect.poll(async () => {
        after = await session.api<Status>('GET', '/api/embeddings/status');
        return !after.run.running && after.run.finished_at !== before.run.finished_at;
      }, { timeout: 120_000, message: 'the backfill never finished' }).toBe(true);
      await expect(run).toHaveAttribute('data-running', 'false', { timeout: 30_000 });
      const outcome = run.locator('[data-embeddings="outcome"]');
      await expect(outcome).toBeVisible({ timeout: 30_000 });
      await expect(part.locator('[data-embeddings="embedded"] dd'))
        .toHaveText(new RegExp(`^${after.coverage.embedded.toLocaleString('en-US')} of `), { timeout: 30_000 });
      return {
        before: { embedded: before.coverage.embedded, total: before.coverage.total },
        missing,
        estimate: estimated,
        outcome: (await outcome.innerText()).trim(),
        after: { embedded: after.coverage.embedded, total: after.coverage.total },
      };
    },

    readExplorerList: async (): Promise<ExplorerList> => {
      await openCollection();
      // The labels come from a second read the list does not wait for; where
      // the engine holds links, wait until they are drawn.
      const status = await backend.linkStatus();
      if (Number(status.links ?? 0) > 0) {
        await expect(win().locator('.result-links li').first()).toBeVisible({ timeout: 30_000 });
      }
      return readList();
    },

    readExplorerTitles: async () => {
      await openCollection('');
      await expect(win().locator('.result').first()).toBeVisible({ timeout: 30_000 });
      return (await win().locator('.result .result-title').allInnerTexts()).map((t) => t.trim());
    },

    collapseDuplicates: async (on) => {
      await openCollection();
      const box = win().locator('.fold-toggle input');
      await expect(box).toBeVisible({ timeout: 30_000 });
      if (on) {
        const preview = win().waitForResponse((r) => r.url().endsWith('/api/links/collapse-preview'));
        await box.check();
        await preview;
        await expect(win().locator('.collapse-note')).toBeVisible({ timeout: 30_000 });
      } else {
        await box.uncheck();
        await expect(win().locator('.collapse-note')).toHaveCount(0);
      }
      await expect(box).toBeChecked({ checked: on });
      await settledResults();
    },

    openFirstPaper: async () => {
      await openCollection('');
      const first = win().locator('.result .result-title').first();
      await expect(first).toBeVisible({ timeout: 30_000 });
      const title = (await first.innerText()).trim();
      await first.click();
      await expect(win().locator('.paper[data-paper]')).toBeVisible({ timeout: 30_000 });
      await expect(win().locator('.paper-name')).toHaveText(title);
      return title;
    },

    readWhyPanel: async (): Promise<WhyPanel> => {
      const why = win().locator('.why');
      await expect(why.locator('.why-limits-label')).toBeVisible({ timeout: 30_000 });
      const matches = await why.locator('.why-keywords li').evaluateAll((items) => items.map((li) => ({
        keyword: li.querySelector('.why-keyword')?.textContent?.trim() ?? '',
        field: li.querySelector('.why-where')?.textContent?.trim() ?? '',
      })));
      return {
        matches,
        cannotSee: (await why.locator('.why-limits li').allInnerTexts()).map((t) => t.trim()),
        text: (await why.innerText()).trim(),
      };
    },

    savePapersFromRun: async (run): Promise<QueuedPaper[]> => {
      await openSettled(run);
      await win().getByRole('tab', { name: 'Papers' }).click();
      const rows = win().locator('.paper-row[data-document]');
      await expect(rows.first()).toBeVisible({ timeout: 30_000 });
      const saved: QueuedPaper[] = [];
      for (const row of await rows.all()) {
        const id = Number(await row.getAttribute('data-document'));
        const title = (await row.locator('.paper-title').innerText()).trim();
        await row.getByRole('button', { name: 'Save to read' }).click();
        await expect(win().locator(`.paper-row[data-document="${id}"]`)).toHaveAttribute('data-queue', 'to_read', { timeout: 30_000 });
        saved.push({ id, title, state: 'To read' });
      }
      return saved;
    },

    readReadingQueue: async (filter) => {
      await openQueue(filter);
      return readQueue();
    },

    markPaperRead: async (paper) => {
      await openQueue('all');
      const row = win().locator(`.queue-row[data-document="${paper.id}"]`);
      await row.getByRole('button', { name: 'Mark read' }).click();
      await expect(row.locator('.queue-state')).toHaveText('Read', { timeout: 30_000 });
    },

    removeFromReadingQueue: async (paper) => {
      await openQueue('all');
      await win().locator(`.queue-row[data-document="${paper.id}"]`).getByRole('button', { name: 'Remove' }).click();
      await expect(win().locator(`.queue-row[data-document="${paper.id}"]`)).toHaveCount(0, { timeout: 30_000 });
    },

    exportReadingQueue: async (papers, format): Promise<ExportedFile> => {
      await openQueue('all');
      for (const paper of papers) {
        await win().locator(`.queue-row[data-document="${paper.id}"]`).getByRole('checkbox').check();
      }
      const label = { bibtex: 'BibTeX', ris: 'RIS', csv: 'CSV' }[format];
      const extension = { bibtex: 'bib', ris: 'ris', csv: 'csv' }[format];
      const destination = path.join(session.stateDir, `journey-queue.${extension}`);
      await session.app.evaluate(({ BrowserWindow }, target) => {
        BrowserWindow.getAllWindows()[0].webContents.session.once('will-download', (_e, item) => {
          item.setSavePath(target as string);
        });
      }, destination);
      await win().locator('.queue-export').getByRole('button', { name: label, exact: true }).click();
      await expect.poll(() => fs.existsSync(destination), { timeout: 30_000 }).toBe(true);
      await expect.poll(() => fs.statSync(destination).size, { timeout: 30_000 }).toBeGreaterThan(0);
      return { path: destination, text: fs.readFileSync(destination, 'utf8') };
    },

    runDive: (request) => ask('Deep Dive', [request.source], request.keywords, request.days, request.cap, request.summarize),

    runSweep: (request) => ask('Deep Sweep', request.sources, [request.query], undefined, request.cap),

    readRunPanelOutcomes: async (run, options): Promise<SourceOutcome[]> => {
      await openRun(run);
      if (options?.settled) {
        await expect(win().locator('.run')).not.toHaveAttribute('data-status', 'running', { timeout: 150_000 });
        await win().getByRole('tab', { name: 'Progress' }).click();
        await expect(win().locator('.live-panel .live-row[data-state="pending"], .live-panel .live-row[data-state="asking"]'))
          .toHaveCount(0, { timeout: 30_000 });
      }
      const panel = win().locator('.live-panel').first();
      await expect(panel).toBeVisible({ timeout: 30_000 });
      return panel.locator('.live-row').evaluateAll((rows, words) => rows.map((row) => ({
        source: (row as HTMLElement).dataset.source ?? '',
        label: words[(row as HTMLElement).dataset.state ?? ''] ?? (row as HTMLElement).dataset.state ?? '',
        note: row.querySelector('.src-note')?.textContent?.trim() ?? '',
      })), PANEL_WORDS);
    },

    cancelRunFromMonitor: async (run) => {
      await openRun(run);
      const stopped = win().waitForResponse((r) => r.url().endsWith(`/api/executions/${run.id}/cancel`)
        && r.request().method() === 'POST');
      await win().getByRole('button', { name: 'Stop', exact: true }).click();
      // A stop is cooperative, so from the click until the run ends the page
      // says one was asked for. Read at once: the run may end soon after.
      await expect(win().locator('[data-run="stopping"]'), 'Stop was pressed and the page did not say the run is stopping')
        .toBeVisible({ timeout: 5_000 });
      expect((await stopped).status()).toBeLessThan(300);
    },

    openReport: (run) => openSettled(run),

    readReportTabs: async () => {
      const tabs = win().getByRole('tab');
      await expect(tabs.first()).toBeVisible({ timeout: 30_000 });
      return (await tabs.allInnerTexts()).map((t) => t.trim());
    },

    readCoverageSentence: async (run) => {
      await openSettled(run);
      const sentence = win().locator('[data-coverage-summary]');
      await expect(sentence).toBeVisible({ timeout: 30_000 });
      return (await sentence.innerText()).trim();
    },

    readReportOutcomes: async (run): Promise<SourceOutcome[]> => {
      await openSettled(run);
      await expect(win().locator('.recorded')).toBeVisible({ timeout: 30_000 });
      return win().locator('.recorded .recorded-row').evaluateAll((rows) => rows.map((row) => ({
        source: (row as HTMLElement).dataset.source ?? '',
        // The recorded category, as the record's own table words it.
        label: ((row as HTMLElement).dataset.category ?? '').replace('_', ' '),
        note: row.querySelector('.src-note')?.textContent?.trim() ?? '',
      })));
    },

    exportReferences: async (runs, format): Promise<ExportedFile> => {
      await openSearch();
      for (const run of runs) {
        const row = win().locator(`.run-row[data-run="${run.id}"]`);
        await expect(row).toBeVisible({ timeout: 30_000 });
        await row.getByRole('checkbox').check();
      }
      const label = { bibtex: 'BibTeX', ris: 'RIS', csv: 'CSV' }[format];
      const extension = { bibtex: 'bib', ris: 'ris', csv: 'csv' }[format];
      const destination = path.join(session.stateDir, `journey-references.${extension}`);
      // The real Electron download, with only the destination picker replaced.
      await session.app.evaluate(({ BrowserWindow }, target) => {
        BrowserWindow.getAllWindows()[0].webContents.session.once('will-download', (_e, item) => {
          item.setSavePath(target as string);
        });
      }, destination);
      await win().locator('.export-bar').getByRole('button', { name: label, exact: true }).click();
      await expect.poll(() => fs.existsSync(destination), { timeout: 30_000 }).toBe(true);
      await expect.poll(() => fs.statSync(destination).size, { timeout: 30_000 }).toBeGreaterThan(0);
      return { path: destination, text: fs.readFileSync(destination, 'utf8') };
    },

    readInterruptedRow: async (run): Promise<InterruptedRow> => {
      await openSearch();
      const row = win().locator(`.run-row[data-run="${run.id}"]`);
      await expect(row).toBeVisible({ timeout: 30_000 });
      await expect(row.locator('.run-status')).toHaveAttribute('data-status', 'interrupted', { timeout: 30_000 });
      return {
        badge: (await row.locator('.run-status').innerText()).trim(),
        note: (await row.locator('.run-note').innerText()).trim(),
      };
    },

    restartRun: async (run) => {
      await openSearch();
      const row = win().locator(`.run-row[data-run="${run.id}"]`);
      // Restart says what it will do before anything starts: the AI choice and
      // where the run is sent are read, then the restart is confirmed.
      await row.getByRole('button', { name: 'Restart…', exact: true }).click();
      await expect(row.locator('[data-run="restart-facts"]'), 'Restart started a run without saying what it does')
        .toContainText('Email and delivery', { timeout: 15_000 });
      await row.getByRole('button', { name: 'Restart this run', exact: true }).click();
      let next = 0;
      await expect.poll(async () => {
        const rows = await backend.executions();
        const restarted = rows.filter((r) => r.restarted_from === run.id);
        next = restarted.length === 1 ? Number(restarted[0].id) : 0;
        return restarted.length;
      }, { timeout: 30_000 }).toBe(1);
      return { id: next };
    },

    reopenTheApp: () => session.relaunch(),

    chooseTheme: async (theme) => {
      await goto('Appearance settings');
      const card = win().locator('.theme-card')
        .filter({ has: win().locator('.theme-label', { hasText: new RegExp(`^${THEME_CARD[theme]}$`) }) });
      await expect(card, `Settings draws no single "${THEME_CARD[theme]}" card`).toHaveCount(1);
      await card.click();
      await expect.poll(async () => (await backend.appearance()).theme, { timeout: 30_000 }).toBe(theme);
      await expect(card).toHaveAttribute('data-selected', 'true');
    },

    chooseAccent: async (hex) => {
      await goto('Appearance settings');
      const field = win().getByRole('textbox', { name: 'Hex color' });
      await expect(field).toBeVisible();
      await field.fill(hex);
      await field.press('Enter');
      await expect.poll(async () => (await backend.appearance()).accent, { timeout: 30_000 })
        .toBe(hex.toLowerCase());
    },

    readAppearance: async (): Promise<DrawnAppearance> => {
      // The page sets the theme on <html> before it draws anything, and the
      // accent beside it; waiting for the attribute is waiting for both.
      await expect(win().locator('html')).toHaveAttribute('data-theme', /^(light|dark)$/, { timeout: 30_000 });
      return win().evaluate(() => ({
        theme: document.documentElement.dataset.theme as 'light' | 'dark',
        accent: document.documentElement.style.getPropertyValue('--accent').trim().toLowerCase(),
      }));
    },

    readThePlate: async (): Promise<PlateReading> => {
      await openToday();
      // Drawn: the canvas records how long its last frame took, once it has one.
      await expect.poll(
        () => win().locator('.plate-canvas').evaluate((c) => (c as HTMLCanvasElement).dataset.frameMs ?? ''),
        { timeout: 120_000 },
      ).not.toBe('');
      const plt = win().locator('.cartouche .plt');
      await expect(plt).toHaveText(/^The plate: all [\d,]+ papers? on the map, placed /);
      const text = (await plt.innerText()).trim();
      const papers = Number((text.match(/all ([\d,]+) papers?/)?.[1] ?? '0').replace(/,/g, ''));
      const basis = text.slice(text.indexOf('placed '));
      return { papers, basis };
    },

    readToday: async (): Promise<TodayReading> => {
      await openToday();
      // Every number lit: the opening has finished, so what is read is what stays.
      await expect(win().locator('.entry .badge.dim')).toHaveCount(0, { timeout: 30_000 });
      const heading = win().locator('.index-bar h2');
      const total = Number(((await heading.locator('span').innerText()) || '0').replace(/,/g, ''));
      const full = (await heading.innerText()).trim();
      const groups: TodayReading['groups'] = [];
      for (const group of await win().locator('.index-scroll > section.group:not(.quietgroup)').all()) {
        groups.push({
          name: (await group.getAttribute('aria-label')) ?? '',
          count: Number(((await group.locator('.ghead .n').innerText()).match(/[\d,]+/)?.[0] ?? '0').replace(/,/g, '')),
        });
      }
      // One line per run, one part per outcome ("DBLP did not answer"); each
      // source's own sentence is behind the line's Why, and is not read here.
      const notes = (await win().locator('.index-scroll [role="note"] .trouble-part').allInnerTexts()).map((t) => t.trim());
      const numbers = (await win().locator('.entry .badge').allInnerTexts()).map(Number);
      const emptyLine = win().locator('.index-empty');
      const empty = (await emptyLine.count()) ? (await emptyLine.innerText()).trim() : null;
      return { heading: full.replace(/\s*[\d,]+$/, ''), total, groups, notes, numbers, empty };
    },

    // — Ask -----------------------------------------------------------------

    askTheAssistant: async (text): Promise<AssistantTurn> => {
      await openAsk();
      const composer = conversation().getByLabel('Message the assistant');
      await expect(composer, 'Ask cannot be sent to in this app').toBeEnabled({ timeout: 30_000 });
      await composer.fill(text);
      // Armed before the click: on a second ask the conversation is already
      // idle, so "nothing is running" holds until the engine claims the turn.
      const claimed = win().waitForResponse((r) => /\/api\/assistant\/sessions\/\d+\/messages$/.test(r.url())
        && r.request().method() === 'POST', { timeout: 120_000 });
      await conversation().getByRole('button', { name: 'Send', exact: true }).click();
      const response = await claimed;
      expect(response.ok(), `the assistant refused the message: HTTP ${response.status()}`).toBe(true);
      await theTurnHasSettled();
      return readTheTurn();
    },

    answerTheApprovalCard: async (allow): Promise<AssistantTurn> => {
      const card = conversation().locator('.conv-card').first();
      await expect(card, 'the assistant is holding no approval card').toBeVisible({ timeout: 30_000 });
      const answered = win().waitForResponse((r) => r.url().includes('/api/assistant/permissions/'));
      await card.getByRole('button', { name: allow ? 'Allow' : 'Deny', exact: true }).click();
      expect((await answered).ok(), 'the answer to the approval card was refused').toBe(true);
      await theTurnHasSettled();
      return readTheTurn();
    },

    readSavedConversations: () => readTheRail(),

    openTheAssistantWithTheKeyboard: async () => {
      await goto('Today');
      await win().keyboard.press(process.platform === 'darwin' ? 'Meta+Slash' : 'Control+Slash');
      try {
        await expect(conversation()).toBeVisible({ timeout: 15_000 });
        await expect(conversation().getByLabel('Message the assistant')).toBeFocused({ timeout: 15_000 });
        return true;
      } catch {
        return false;
      }
    },

    readTheAssistantPanel: async (): Promise<AssistantPanelFacts> => {
      const pane = conversation();
      const open = (await pane.count()) > 0 && await pane.isVisible();
      if (!open) {
        return {
          open: false, composerIsNamed: '', composerIsUsable: false, insideTheWindow: false,
          geometry: { panel: { x: 0, y: 0, width: 0, height: 0 }, window: { width: 0, height: 0 } }, errorRoles: [],
        };
      }
      const composer = pane.getByLabel('Message the assistant');
      const box = (await pane.boundingBox()) ?? { x: 0, y: 0, width: 0, height: 0 };
      const viewport = await win().evaluate(() => ({ width: window.innerWidth, height: window.innerHeight }));
      const errorRoles = await pane.locator('.conv-error, .conv-failed-message[role="alert"]').evaluateAll(
        (nodes) => nodes.map((node) => (node as HTMLElement).getAttribute('role') || ''));
      return {
        open: true,
        composerIsNamed: String(await composer.getAttribute('aria-label') ?? ''),
        composerIsUsable: (await composer.count()) > 0 && await composer.isEnabled(),
        insideTheWindow: box.x >= 0 && box.y >= 0 && box.x + box.width <= viewport.width + 1
          && box.y + box.height <= viewport.height + 1,
        geometry: { panel: box, window: viewport },
        errorRoles: errorRoles.filter((role) => role !== ''),
      };
    },

    readTheChatsPage: () => readTheRail(),

    openTheSavedChat: async (titleFragment): Promise<SavedTranscript> => {
      await openAsk();
      const row = win().getByRole('region', { name: 'Saved chats' }).locator('.conv-row').filter({ hasText: titleFragment }).first();
      await expect(row, `no saved chat whose title contains "${titleFragment}"`).toBeVisible({ timeout: 30_000 });
      await row.click();
      const title = conversation().locator('.conv-title');
      await expect(title).toContainText(titleFragment, { timeout: 30_000 });
      await expect(conversation().locator('.conv-saved')).toBeVisible({ timeout: 30_000 });
      return {
        title: (await title.innerText()).trim(),
        said: (await conversation().locator('.conv-text').allInnerTexts()).map((t) => t.trim()),
        text: (await conversation().innerText()).replace(/\s+/g, ' ').trim(),
      };
    },

    exportTheOpenChat: async (format) => {
      await expect(conversation().locator('.conv-saved'), 'no saved conversation is open').toBeVisible({ timeout: 30_000 });
      downloadsMade += 1;
      const dir = path.join(fs.realpathSync(session.stateDir), 'downloads');
      fs.mkdirSync(dir, { recursive: true });
      const target = path.join(dir, `journey-chat-${downloadsMade}.${format === 'json' ? 'json' : 'md'}`);
      await theNextDownloadGoesTo(target);
      await conversation().getByRole('button', { name: format === 'json' ? 'Export JSON' : 'Export Markdown', exact: true }).click();
      await expect(conversation().getByText(/^Saved as resmon-chat-\d+\.(json|md)\./)).toBeVisible({ timeout: 30_000 });
      await theDownloadHasCompleted(target);
      return { path: target, text: fs.readFileSync(target, 'utf8') };
    },

    fixTheChoicesForThisConversation: async (choice): Promise<ComposerChoice> => {
      await openAsk();
      const controls = conversation().locator('fieldset.conv-choices');
      if (!await controls.count()) {
        await win().getByRole('region', { name: 'Saved chats' }).getByRole('button', { name: 'New conversation' }).click();
      }
      const model = controls.getByLabel('Model', { exact: true });
      await expect(model, 'the composer offers no model to choose').toBeEnabled({ timeout: 30_000 });
      await model.fill(choice.model);
      if (choice.effort !== undefined) await controls.getByLabel('Effort', { exact: true }).selectOption(choice.effort);
      return readTheComposer();
    },

    readTheComposerChoices: () => readTheComposer(),

    readTheTurnsChoices: async (): Promise<TurnChoiceFacts[]> => {
      const blocks = conversation().locator('details.conv-turn');
      const out: TurnChoiceFacts[] = [];
      for (let i = 0; i < await blocks.count(); i += 1) {
        const block = blocks.nth(i);
        if (!await block.evaluate((element) => (element as HTMLDetailsElement).open)) await block.locator('summary').click();
        out.push({
          requested: (await block.locator('.conv-requested').innerText()).trim(),
          reported: (await block.locator('.conv-reported li').allInnerTexts()).map((t) => t.trim()),
          text: (await block.innerText()).trim(),
        });
      }
      return out;
    },

    setTheAppWideAssistantDefaults: async (defaults) => {
      await goto('AI settings');
      const form = win().getByRole('form', { name: 'Assistant settings' });
      const model = form.locator('#assistant-model');
      await expect(model, 'Settings → AI offers no assistant model').toBeVisible({ timeout: 30_000 });
      await model.selectOption(defaults.model);
      if (defaults.effort !== undefined) await form.locator('#assistant-effort').selectOption(defaults.effort);
      await form.getByRole('button', { name: 'Save assistant settings', exact: true }).click();
      await expect(form.getByRole('status')).toHaveText(/^Saved\./, { timeout: 30_000 });
    },

    // — Settings › AI, pointed at the journey's authored models and commands -----

    useAnAuthoredAgentCommand: async () => {
      // The command Ask runs is the one Summaries' Command field names: the
      // engine keeps one `ai_cli_path` for both, and Atlas shows its field once
      // Claude Code is the summary provider.
      await setTheSummaryLane({ provider: 'claude_code', command: writeTheAuthoredAgentCommand(session, { recordArguments: false }) });
    },

    useAnAuthoredAgentCommandThatRecordsItsArguments: async () => {
      await setTheSummaryLane({ provider: 'claude_code', command: writeTheAuthoredAgentCommand(session, { recordArguments: true }) });
    },

    useAnAuthoredSummarizerThatIsNotSignedIn: async () => {
      // Claude Code as the summary provider, its model, and the path to a
      // command whose sign-in has lapsed: the command is consulted only for
      // the provider chosen, so a path alone would leave the lane looking for
      // a real one where the installers put it.
      await setTheSummaryLane({ provider: 'claude_code', model: 'sonnet', command: writeTheLapsedSummarizer(session) });
    },

    useAnAuthoredProviderOnAKey: async ({ answer, key, model }) => {
      // Two parts of Settings › AI, because they are two questions: where the
      // custom endpoint is and the key it takes (Summaries, which keeps one of
      // each for every part), and which connection Ask runs on.
      const provider = await startProviderEndpointFor(session, answer);
      await setTheSummaryLane({ provider: 'custom', endpoint: provider.url });
      await runAskOnAKey('custom', model);
      // Ask takes a new conversation's connection from these defaults once per
      // window (`AskProvider` seeds its draft on the first status it reads), so
      // a default saved here reaches the composer only after the window is
      // reopened, as the classic driver reopens it for the same reason.
      await session.relaunch();
      // The key after the reopen, and not as an ordering preference: this
      // suite's keyring lives inside the backend process, so a key stored
      // before the reopen would be gone with it.
      await setTheSummaryLane({ provider: 'custom', key });
      // Checked before anything is sent: a composer still on Claude Code would
      // run whatever `claude` this machine has, since no command is set here.
      await openAsk();
      const controls = conversation().locator('fieldset.conv-choices');
      await expect(controls.getByLabel('Connection', { exact: true }), 'a new conversation does not start on the key saved for Ask')
        .toHaveValue('api_key:custom', { timeout: 30_000 });
      await expect(controls.getByLabel('Model', { exact: true }), 'a new conversation does not start on the model saved for Ask')
        .toHaveValue(model);
    },

    useAnAuthoredModelForSelectedAnswers: async () => {
      const model = await startSelectedAnswerEndpointFor(session);
      // The address and the key, under Summaries' custom endpoint, which is
      // the one address and the one key selected answers send to.
      await setTheSummaryLane({ provider: 'custom', endpoint: model.url, key: 'journey-authored-selected-key' });
      // Then the Claude Code command, set to a path with nothing at it, on
      // purpose. The answer composer offers Claude Code beside the API
      // connection, and a command left blank is found wherever the installers
      // put the real one; a path that is not an executable is reported missing
      // and never falls through to another binary (`ai_cli.discover_cli`). So
      // this journey cannot start a signed-in agent CLI even by a misclick.
      // Choosing Claude Code is what shows the command's field; the custom
      // address stays stored beside it.
      await setTheSummaryLane({ provider: 'claude_code', command: path.join(session.stateDir, 'no-agent-cli-in-this-journey') });
      await stored('the custom address kept beside the command', () => backend.aiSettings(),
        (settings) => settings.ai_custom_base_url === model.url);
      // Back to the project the person was working in, as they would go back.
      if (openProject) await openTheProject(openProject);
    },

    readAiLaneStatus: async () => {
      await goto('AI settings');
      const status = win().locator('[data-ai="lane-status"]');
      // As the classic driver does: the line exists where the engine reports
      // a status for the provider the settings name, and is waited for on that.
      const [settings, cli] = await Promise.all([
        session.api<{ ai_provider?: string }>('GET', '/api/settings/ai'),
        session.api<{ providers?: { provider: string }[] }>('GET', '/api/settings/ai/cli-status'),
      ]);
      const expected = (cli.providers ?? []).some((entry) => entry.provider === settings.ai_provider);
      await expect.poll(async () => (await status.count()) > 0, {
        timeout: 30_000,
        message: expected ? `Settings → AI never drew a status for the ${settings.ai_provider} lane`
          : 'Settings → AI drew a command status for a provider the engine reports none for',
      }).toBe(expected);
      if (!await status.count()) return '';
      // Under it, what the command said when asked whether it is signed in.
      // Read once the check has answered, so the line is the answer and not
      // "checking".
      const signIn = win().locator('[aria-labelledby="ai-summaries"] [data-ai="sign-in"]');
      await expect(signIn, 'Settings → AI did not ask the command whether it is signed in')
        .not.toHaveAttribute('data-state', /^(checking|unchecked)$/, { timeout: 30_000 });
      const lane = (await status.first().innerText()).replace(/\s+/g, ' ').trim();
      const said = (await signIn.locator('.ai-signin-state').innerText()).replace(/\s+/g, ' ').trim();
      return `${lane} ${said}`;
    },

    readRunLog: async (run) => {
      await openSettled(run);
      await win().getByRole('tab', { name: 'Log', exact: true }).click();
      const log = win().locator('.record-text.is-log');
      await expect(log, 'the run page shows no log for a run that finished').toBeVisible({ timeout: 30_000 });
      return log.innerText();
    },

    readTheReport: async (run) => {
      await openSettled(run);
      await win().getByRole('tab', { name: 'Report', exact: true }).click();
      const report = win().locator('.record-text.is-report');
      await expect(report, 'the run page shows no report for a run that finished').toBeVisible({ timeout: 30_000 });
      return report.innerText();
    },

    // — the edges ------------------------------------------------------------

    readTheFirstRunCard: async (): Promise<FirstRunCard> => {
      await goto('Today');
      const card = win().locator('[data-today="first-run"]');
      // The engine publishes whether the card belongs on Today; wait for the
      // screen to agree, either way, rather than reading an absence on arrival.
      const shows = Boolean((await backend.onboarding() as { show?: boolean }).show);
      await expect.poll(() => card.count(), {
        timeout: 30_000,
        message: shows ? 'the engine says the first-run card belongs on Today and it never appeared'
          : 'the engine says the first-run card is done with and it is still on Today',
      }).toBe(shows ? 1 : 0);
      if (!shows) return { present: false, steps: [], text: '' };
      const items = card.locator('li[data-step]');
      const steps: FirstRunCard['steps'] = [];
      for (let i = 0; i < await items.count(); i += 1) {
        const item = items.nth(i);
        steps.push({
          id: String(await item.getAttribute('data-step')),
          mark: String(await item.locator('.first-run-mark').getAttribute('aria-label') ?? ''),
          text: (await item.innerText()).replace(/\s+/g, ' ').trim(),
        });
      }
      return { present: true, steps, text: (await card.innerText()).trim() };
    },

    eraseWith: async (action, word) => {
      await win().evaluate(() => { window.location.hash = '#/settings/danger'; });
      await expect(win().getByRole('heading', { name: 'Danger zone', level: 2 })).toBeVisible({ timeout: 30_000 });
      const row = win().locator('.danger-row').filter({ has: win().locator('.danger-name', { hasText: new RegExp(`^${literally(action)}$`) }) });
      await row.getByRole('button', { name: action, exact: true }).click();
      const form = row.getByRole('group', { name: `Confirm: ${action}` });
      await expect(form).toBeVisible({ timeout: 30_000 });
      const box = form.getByPlaceholder('Type CONFIRM');
      if (await box.count()) await box.fill(word);
      const confirm = form.getByRole('button', { name: 'Confirm', exact: true });
      if (await confirm.isDisabled()) {
        // The screen refuses before the engine is asked: a real answer, and the
        // spec asserts the HTTP refusal separately.
        await form.getByRole('button', { name: 'Cancel', exact: true }).click();
        return { status: 0, body: 'the Confirm button stayed disabled' };
      }
      const answered = win().waitForResponse((r) => r.url().includes('/api/admin/'));
      await confirm.click();
      const response = await answered;
      return { status: response.status(), body: (await response.text()).slice(0, 400) };
    },

    saveKeyFor: async (source, value) => {
      await openSources();
      const field = win().getByLabel(`API key for ${source}`, { exact: true });
      await expect(field, `${source} has no key field`).toBeVisible({ timeout: 30_000 });
      const saved = win().waitForResponse((r) => r.url().includes('/api/credentials/') && r.request().method() === 'PUT');
      await field.fill(value);
      await field.press('Enter');
      expect((await saved).ok(), 'the key the field submitted was refused').toBe(true);
      // Stored, and the screen has read the keychain again: the field is empty.
      await expect(field).toHaveValue('', { timeout: 30_000 });
    },

    readKeyFields: async (): Promise<KeyField[]> => {
      await goto('Today');
      await openSources();
      const fields = win().locator('.source-key input[aria-label^="API key for "]');
      await expect(fields.first()).toBeVisible({ timeout: 30_000 });
      const out: KeyField[] = [];
      for (let i = 0; i < await fields.count(); i += 1) {
        const field = fields.nth(i);
        out.push({
          source: String(await field.getAttribute('aria-label')).replace('API key for ', ''),
          shown: String(await field.getAttribute('placeholder') ?? ''),
          value: await field.inputValue(),
        });
      }
      return out;
    },

    readSourceDetails: async (source): Promise<Record<string, string>> => {
      await openSources();
      const name = win().locator('.source-entry-name', { hasText: new RegExp(`^${literally(source)}$`) });
      await expect(name, `no row for ${source}`).toHaveCount(1, { timeout: 30_000 });
      if ((await name.getAttribute('aria-expanded')) !== 'true') await name.click();
      const grid = win().locator('.source-entry', { has: name }).locator('dl.source-details');
      await expect(grid).toBeVisible({ timeout: 15_000 });
      const terms = await grid.locator('dt').allInnerTexts();
      const values = await grid.locator('dd').allInnerTexts();
      const out: Record<string, string> = {};
      terms.forEach((term, index) => { out[term.trim()] = (values[index] ?? '').trim(); });
      return out;
    },

    readRequiredAttributions: async () => {
      await openSources();
      const block = win().locator('[data-sources="credits"]');
      const owed = (await backend.sourceCatalog())
        .filter((entry) => entry.attribution_requirement === 'required' && entry.attribution).length;
      await expect.poll(async () => (await block.count()) > 0, {
        timeout: 30_000,
        message: owed ? `Sources never drew the credits for the ${owed} source(s) that require them`
          : 'Sources drew required credits for a catalog that requires none',
      }).toBe(owed > 0);
      if (!await block.count()) return [];
      return (await block.locator('li').allInnerTexts()).map((t) => t.replace(/\s+/g, ' ').trim());
    },

    readTabsHere: async () => {
      // A place's own second-level navigation: Settings' rail, or a section's tabs.
      const tabs = win().locator('main.stage nav a, main.stage [role="tablist"] [role="tab"]');
      if (!await tabs.count()) return [];
      return (await tabs.allInnerTexts()).map((t) => t.replace(/\s+/g, ' ').trim());
    },

    framesHere: async () => win().locator('main.stage').locator('iframe, webview, object, embed').count(),

    readExternalLinks: async () => {
      const links = win().locator('main.stage a[href^="http"]');
      const out: { text: string; href: string }[] = [];
      for (let i = 0; i < await links.count(); i += 1) {
        out.push({ text: (await links.nth(i).innerText()).trim(), href: String(await links.nth(i).getAttribute('href')) });
      }
      return out;
    },

    chooseGoogleDrivesFolderForBackups: async (): Promise<string> => {
      // Google Drive for desktop keeps My Drive at
      // ~/Library/CloudStorage/GoogleDrive-<account>/My Drive on a Mac. A
      // folder of this session's, laid out the same, stands in for it; it is
      // removed with the session. resmon's part ends at writing into it.
      const parent = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'resmon-journey-drive-')));
      session.alsoRemoveOnClose(parent);
      const drive = path.join(parent, 'CloudStorage', 'GoogleDrive-journey@example.org', 'My Drive');
      fs.mkdirSync(drive, { recursive: true });
      await session.app.evaluate(({ dialog }, chosen) => {
        dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [chosen] });
      }, drive);
      // Settings › Backup's Where backups go, and its own Choose a folder.
      await goto('Storage settings');
      const where = win().locator('[data-backup="destination"]');
      await where.getByRole('button', { name: /^Choose (a|another) folder$/ }).click();
      await stored('the folder backups go to',
        () => session.api<{ export_directory: string }>('GET', '/api/settings/storage'),
        (settings) => settings.export_directory === drive);
      await expect(where, 'the folder was stored and the screen never said so').toContainText(drive, { timeout: 30_000 });
      return drive;
    },

    backUpNow: async (options): Promise<BackupResult> => {
      await goto('Storage settings');
      const box = win().getByRole('checkbox', { name: 'Include the reports folder' });
      await expect(box).toBeVisible({ timeout: 30_000 });
      if (options.reports) await box.check(); else await box.uncheck();
      const answered = win().waitForResponse((r) => r.url().endsWith('/api/backup') && r.request().method() === 'POST');
      await win().getByRole('button', { name: 'Back up now', exact: true }).click();
      const response = await answered;
      expect(response.ok(), 'Back up now was refused').toBe(true);
      const body = await response.json();
      session.alsoRemoveOnClose(String(body.path));
      await expect(win().locator('[data-backup="written"]')).toBeVisible({ timeout: 30_000 });
      return { directory: String(body.path), manifest: body.manifest as Record<string, unknown> };
    },

    restoreIntoFreshState: async (bundle) => {
      // A brand-new, empty state directory, as on another computer; then the
      // Storage group's own restore. The folder dialog is answered with the
      // bundle, because nothing automated can operate a native one; the check,
      // the staging and the report are the app's.
      await session.relaunchOverFreshState();
      await goto('Storage settings');
      await session.app.evaluate(({ dialog }, chosen) => {
        dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [chosen] });
      }, bundle.directory);
      const restore = win().locator('[data-backup="restore"]');
      await restore.getByRole('button', { name: 'Restore from a backup…', exact: true }).click();
      const report = restore.getByRole('group', { name: 'The backup, checked' });
      await expect(report, 'the chosen backup was never checked').toBeVisible({ timeout: 60_000 });
      await expect(report, 'the backup this journey wrote does not check out').toContainText('It checks out');
      const staged = win().waitForResponse((r) => r.url().endsWith('/api/restore') && r.request().method() === 'POST');
      await report.getByRole('button', { name: 'Stage this restore', exact: true }).click();
      const response = await staged;
      expect(response.ok(), `Stage this restore was refused: HTTP ${response.status()}`).toBe(true);
      const same = (a: unknown, b: string): boolean => {
        try { return fs.realpathSync(String(a)) === fs.realpathSync(b); } catch { return false; }
      };
      await stored('the restore as staged', () => session.api<{ pending_restore: { bundle?: unknown } | null }>('GET', '/api/backup/last'),
        (last) => same(last.pending_restore?.bundle, bundle.directory));
      await expect(restore.locator('[data-backup="pending"]'), 'the restore was staged and the card never said so')
        .toBeVisible({ timeout: 30_000 });
      // Then the start that applies it. Restart resmon now quits and reopens
      // the app from its own main process, which would leave this session
      // holding an app that has gone; quitting and opening it again, the
      // other way the card names, is the same start.
      await session.relaunch();
    },

    readRestoreCard: async (): Promise<RestoreCard> => {
      await goto('Storage settings');
      const card = win().locator('[data-backup="reentry"]');
      await expect(card).toBeVisible({ timeout: 30_000 });
      const entries = (await card.locator('li code').allInnerTexts()).map((t) => t.trim());
      return { text: (await card.innerText()).trim(), keyringEntries: entries };
    },

    skipTheFirstRunCard: async () => {
      await goto('Today');
      const card = win().locator('[data-today="first-run"]');
      const dismissed = win().waitForResponse((r) => r.url().includes('/api/onboarding/dismiss') && r.request().method() === 'POST');
      await card.getByRole('button', { name: 'Skip', exact: true }).click();
      expect((await dismissed).ok(), 'Skip was refused').toBe(true);
      await expect(card).toHaveCount(0, { timeout: 30_000 });
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
        // Arrived at from somewhere else, so the place asks the engine afresh.
        await goto('Appearance settings');
        await goto(place);
        await expect.poll(() => seen.length, { timeout: 30_000 }).toBeGreaterThan(0);
        // journeys:duration-ok an observation window, as the classic driver's
        // is: a place keeps asking for as long as it is open, so this is how
        // much of the stream the row claims to have looked at.
        await win().waitForTimeout(1_000);
      } finally {
        win().off('request', watch);
      }
      return seen;
    },

    readSidebarPlaces: async () => {
      // Atlas has no sidebar. The places a person can go are the top bar's
      // sections and Settings, and the second-level navigation each of those
      // opens onto: every one is read off the screen, never from the route table.
      const places: string[] = [];
      const read = async (selector: string) => {
        for (const text of await win().locator(selector).allInnerTexts()) {
          const name = text.replace(/\s+/g, ' ').trim();
          if (name && !places.includes(name)) places.push(name);
        }
      };
      await goto('Today');
      await read('nav[aria-label="Sections"] a');
      places.push((await win().locator('header.bar a[href="#/settings"]').getAttribute('aria-label')) ?? 'Settings');
      for (const hash of ['/search', '/library', '/health', '/watches', '/settings']) {
        await win().evaluate((h) => { window.location.hash = `#${h}`; }, hash);
        await expect(win().locator('main.stage h1').first()).toBeVisible({ timeout: 30_000 });
        await read('main.stage nav a, main.stage [role="tablist"] a, main.stage [role="tablist"] button');
      }
      return places;
    },

    markAllRead: async () => {
      await openToday();
      const button = win().getByRole('button', { name: 'Mark all read' });
      await expect(button).toBeEnabled({ timeout: 30_000 });
      await button.click();
      await expect.poll(async () => (await backend.today()).window, { timeout: 30_000 }).toBe('since_last_look');
      await expect(win().locator('.index-bar h2 span')).toHaveText('0', { timeout: 30_000 });
    },

    // — shared wording (J49) ----------------------------------------------------
    scanForSharedWording: async (): Promise<SharedWordingReading> => {
      await win().evaluate(() => { window.location.hash = '#/search/wording'; });
      await expect(win().getByRole('heading', { name: 'Shared wording', level: 1 })).toBeVisible({ timeout: 30_000 });
      const before = (await backend.sharedWording()).scan;
      const button = win().locator('[data-wording="scan-button"]');
      await expect(button).toBeEnabled({ timeout: 30_000 });
      await button.click();
      // The engine's own record of a scan finished after the press; a scan
      // stored before it would satisfy "ready" without the button doing anything.
      await stored('a finished shared-wording scan', () => backend.sharedWording(),
        (s) => s.state === 'ready' && !s.job.running && s.scan !== null
          && JSON.stringify(s.scan) !== JSON.stringify(before), 60_000);
      const served = await backend.sharedWording();
      const groups = {} as Record<SharedWordingGroup, number>;
      for (const group of served.groups) {
        const section = win().locator(`.wording-group[data-category="${group.category}"]`);
        await expect(section).toHaveAttribute('data-count', String(group.count), { timeout: 30_000 });
        groups[group.category] = Number(((await section.locator('.group-title .seg-n').innerText()) || '0').replace(/,/g, ''));
      }
      return { compared: (await win().locator('[data-wording="compared"]').innerText()).trim(), groups };
    },

    openTheSharedWordingPair: async (a, b): Promise<SharedWordingPairReading> => {
      const key = `${Math.min(a, b)}-${Math.max(a, b)}`;
      await win().locator(`.wording-row[data-pair="${key}"]`).click();
      const view = win().locator(`.wording-pair[data-pair="${key}"]`);
      await expect(view.locator('[data-wording="summary"] p').first()).toBeVisible({ timeout: 30_000 });
      const side = async (which: 'left' | 'right') => view.locator(`.wording-side[data-side="${which}"]`);
      const marked = async (which: 'left' | 'right') =>
        (await side(which)).locator('mark.wording-mark').allInnerTexts();
      return {
        left: Number(await (await side('left')).getAttribute('data-paper')),
        right: Number(await (await side('right')).getAttribute('data-paper')),
        summary: (await view.locator('[data-wording="summary"] p').allInnerTexts()).map((t) => t.trim()),
        longest: (await view.locator('[data-wording="longest"]').innerText()).trim(),
        share: (await view.locator('[data-wording="share"]').innerText()).trim(),
        marked: { left: await marked('left'), right: await marked('right') },
        limits: (await view.locator('[data-wording="limits"] li').allInnerTexts()).map((t) => t.trim()),
      };
    },
  };
}
