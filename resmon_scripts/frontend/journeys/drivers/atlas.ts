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
import * as fs from 'fs';
import * as path from 'path';
import { expect, type TestInfo } from '@playwright/test';
import type {
  BackendFacts, DrawnAppearance, ExplorerList, ExportedFile, InterruptedRow, JourneyDriver, Place, PlateReading,
  QueuedPaper, RankedList, RunHandle, SourceOutcome, ThemeChoice, TodayReading, WhyPanel,
} from '../driver';
import type { Session } from './session';

/** The hash behind each place Atlas has. */
const ATLAS_PLACES: Partial<Record<Place, string>> = {
  Today: '/today',
  'Appearance settings': '/settings',
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
  | 'exportReadingQueue'>;

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

  const ask = async (kind: 'Deep Dive' | 'Deep Sweep', sources: string[], terms: string[],
    days: number | undefined, cap: number | undefined): Promise<RunHandle> => {
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

  return {
    open: (place) => goto(place),

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
