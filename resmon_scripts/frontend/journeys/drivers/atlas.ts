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
import * as fs from 'fs';
import * as path from 'path';
import { expect, type TestInfo } from '@playwright/test';
import type {
  BackendFacts, ConfigurationExport, CoverageAudit, DaemonPanel, DeliveryRecord, DrawnAppearance, EmailSettings,
  ExplorerList, ExportedFile, ImportOutcome, InterruptedRow, JourneyDriver, NotificationPreferences, Place,
  PlateReading, ProfileCreation, ProfileMatches, QueuedPaper, RankedList, RoutineFacts, RunHandle, RunNowAnswer,
  SourceOutcome, ThemeChoice, TodayReading, UpcomingFire, WhyPanel,
} from '../driver';
import type { Session } from './session';

/** The hash behind each place Atlas has. */
const ATLAS_PLACES: Partial<Record<Place, string>> = {
  Today: '/today',
  'Appearance settings': '/settings',
  // Routines and the calendar are one place in Atlas: each watch, and the
  // month ahead's fires beneath them.
  Routines: '/watches',
  Calendar: '/watches',
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
  | 'readToday' | 'markAllRead'
  | 'runDive' | 'runSweep' | 'readRunPanelOutcomes' | 'cancelRunFromMonitor' | 'openReport' | 'readReportTabs'
  | 'readCoverageSentence' | 'readReportOutcomes' | 'exportReferences' | 'readInterruptedRow' | 'restartRun'
  | 'rankTheExplorerBy' | 'readExplorerList' | 'readExplorerTitles' | 'collapseDuplicates' | 'openFirstPaper'
  | 'readWhyPanel' | 'savePapersFromRun' | 'readReadingQueue' | 'markPaperRead' | 'removeFromReadingQueue'
  | 'exportReadingQueue'
  | 'listRoutineNames' | 'readRoutine' | 'activateRoutine' | 'deactivateRoutine' | 'toggleDesktopNotification'
  | 'readUpcomingFires' | 'runNowControlIsOnTheRow' | 'askForThisRoutineToRunNow' | 'readDeliveryRecord'
  | 'skipDelivery' | 'readCoverageAudit' | 'writeRoutineIntent'
  | 'createWatchProfile' | 'readProfileMatches' | 'readBasisBadgesInTheExplorer' | 'readTheHelpOnThisPage'
  | 'readWhatThisPlaceSays'
  | 'readDaemonPanel' | 'saveConfiguration' | 'exportConfigurations' | 'importConfigurations'
  | 'configureEmail' | 'readEmailSettings' | 'sendATestEmail' | 'setNotificationPreferences'
  | 'readNotificationPreferences'>;

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
};

function isoDate(at: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}`;
}

export function createAtlasDriver(session: Session, testInfo: TestInfo, backend: BackendFacts): AtlasDriver {
  const win = () => session.win;

  const notInAtlasYet = (what: string): never => {
    testInfo.skip(true, `Not in Atlas yet: ${what}.`);
    throw new Error('unreachable: a skipped journey does not continue');
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
    days: number | undefined, cap: number | undefined): Promise<RunHandle> => {
    await fillAsk(kind, sources, terms, days, cap);
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
      const answered = win().waitForResponse(
        (r) => r.url().endsWith('/api/configurations/export') && r.request().method() === 'POST',
      );
      await button.click();
      const response = await answered;
      expect(response.ok(), 'Export was refused').toBe(true);
      const written = String((await response.json()).path ?? '');
      // The path a person reads is the one they would hand back.
      await expect(win().locator('[data-saved="exported"] code'), 'the page never said where the export went')
        .toHaveText(written, { timeout: 30_000 });
      expect(fs.existsSync(written), `the export names ${written}, which is not there`).toBe(true);
      session.alsoRemoveOnClose(written);
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
        return { note: '', controlsPresent: false, list: await readList() };
      }
      await control.getByRole('button', { name: 'Closest in meaning' }).click();
      const note = win().locator('.rank-note').first();
      await expect(note).toContainText('Closest to:', { timeout: 60_000 });
      await settledResults();
      return { note: (await note.innerText()).trim(), controlsPresent: true, list: await readList() };
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

    runDive: async (request) => {
      if (request.summarize) notInAtlasYet('a summary of each paper on a Deep Dive');
      return ask('Deep Dive', [request.source], request.keywords, request.days, request.cap);
    },

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
      await row.getByRole('button', { name: 'Restart' }).click();
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
      const notes = (await win().locator('.index-scroll [role="note"]').allInnerTexts()).map((t) => t.trim());
      const numbers = (await win().locator('.entry .badge').allInnerTexts()).map(Number);
      const emptyLine = win().locator('.index-empty');
      const empty = (await emptyLine.count()) ? (await emptyLine.innerText()).trim() : null;
      return { heading: full.replace(/\s*[\d,]+$/, ''), total, groups, notes, numbers, empty };
    },

    markAllRead: async () => {
      await openToday();
      const button = win().getByRole('button', { name: 'Mark all read' });
      await expect(button).toBeEnabled({ timeout: 30_000 });
      await button.click();
      await expect.poll(async () => (await backend.today()).window, { timeout: 30_000 }).toBe('since_last_look');
      await expect(win().locator('.index-bar h2 span')).toHaveText('0', { timeout: 30_000 });
    },
  };
}
