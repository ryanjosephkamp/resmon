/**
 * The Library's gallery as a person meets it. It draws only the rows near
 * the view, so how many cards are in the page depends on the window: a spec
 * reads a shelf's size from what the list states, and brings a card into view
 * before it uses it, by scrolling or with the find field, as a person would.
 */
import { expect, type Locator, type Page } from '@playwright/test';

/** The shelf's size as the list states it (`aria-setsize` on its items), whatever is drawn. */
export async function shelfHolds(win: Page, n: number, timeout = 30_000): Promise<void> {
  await expect(win.locator('.gal [role="listitem"]').first()).toHaveAttribute('aria-setsize', String(n), { timeout });
}

/**
 * A card brought into view by scrolling: the page scrolled down from the top,
 * a frame at a time, until the gallery draws it, and then centered. Fails if
 * the shelf ends without it.
 */
export async function inView(win: Page, selector: string): Promise<Locator> {
  const target = win.locator(selector);
  await expect(win.locator('.gal [role="listitem"]').first()).toBeVisible({ timeout: 30_000 });
  const found = await win.evaluate(async (wanted) => {
    const stage = document.querySelector('main.stage') as HTMLElement;
    const drawn = () => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done)));
    stage.scrollTop = 0;
    await drawn();
    for (let step = 0; step < 400; step += 1) {
      const card = document.querySelector(wanted);
      if (card) {
        card.scrollIntoView({ block: 'center' });
        await drawn();
        return true;
      }
      if (stage.scrollTop + stage.clientHeight >= stage.scrollHeight - 2) return false;
      stage.scrollTop += Math.round(stage.clientHeight * 0.6);
      await drawn();
    }
    return false;
  }, selector);
  expect(found, `${selector} is not on this shelf`).toBe(true);
  await expect(target).toBeVisible({ timeout: 5_000 });
  return target;
}

/** A card found by its title with the shelf's find field, which leaves the shelf holding the cards that match. */
export async function findCard(win: Page, title: string): Promise<Locator> {
  await win.locator('.lib-find input').fill(title);
  const card = win.locator('article.card', { has: win.getByRole('heading', { name: title, exact: true }) });
  await expect(card).toBeVisible({ timeout: 30_000 });
  return card;
}
