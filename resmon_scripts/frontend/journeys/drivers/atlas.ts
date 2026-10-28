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
import { expect, type TestInfo } from '@playwright/test';
import type {
  BackendFacts, DrawnAppearance, JourneyDriver, Place, PlateReading, ThemeChoice, TodayReading,
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
  | 'readToday' | 'markAllRead'>;

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

  return {
    open: (place) => goto(place),

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
