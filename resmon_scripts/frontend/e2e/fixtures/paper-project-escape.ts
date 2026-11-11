import { expect, type Locator, type Page } from '@playwright/test';

/** Escape closes the project sheet while the chosen map paper stays open. */
export async function projectSheetEscape(win: Page, panel: Locator): Promise<void> {
  const button = panel.getByRole('button', { name: /^Add to a Project for/ });
  await button.click();
  const dialog = win.getByRole('dialog', { name: /^Add “/ });
  await expect(dialog).toBeVisible();
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).focus();
  await win.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  await expect(panel).toBeVisible();
  await expect(button).toBeFocused();
}
