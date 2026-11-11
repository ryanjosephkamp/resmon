import { test, expect } from './fixtures/resmon-app';

const TOO_LONG = 'A_long_collection_name_'.repeat(5);
const ACCEPTED = 'Collection_'.repeat(8).slice(0, 80);

test('collection names are refused visibly instead of truncated', async ({ win, goto }) => {
  await win.getByRole('navigation', { name: 'Sections' }).waitFor();
  await goto('/settings/collections');
  const name = win.getByRole('textbox', { name: 'Name of the new collection' });
  await name.fill(TOO_LONG);
  await expect(name).toHaveValue(TOO_LONG);
  await expect(win.getByText('A collection name can have up to 80 characters.').first()).toBeVisible();
  await expect(win.getByRole('button', { name: 'Make Collection', exact: true })).toBeDisabled();
  await name.fill('Name limit');
  await win.getByRole('button', { name: 'Make Collection', exact: true }).click();
  const row = win.locator('.collection-row').filter({ hasText: 'Name limit' });
  await row.getByRole('button', { name: 'Rename', exact: true }).click();
  const rename = row.getByRole('textbox', { name: 'New name for Name limit' });
  await rename.fill(TOO_LONG);
  await expect(rename).toHaveValue(TOO_LONG);
  await expect(row.getByText('A collection name can have up to 80 characters.')).toBeVisible();
  await expect(row.getByRole('button', { name: 'Save', exact: true })).toBeDisabled();
  await row.getByRole('button', { name: 'Cancel', exact: true }).click();
});

test('an accepted collection name fits its Search heading and count at every width', async ({ app, win, goto }) => {
  await win.getByRole('navigation', { name: 'Sections' }).waitFor();
  await goto('/settings/collections');
  await win.getByRole('textbox', { name: 'Name of the new collection' }).fill(ACCEPTED);
  await win.getByRole('button', { name: 'Make Collection', exact: true }).click();
  const row = win.locator('.collection-row').filter({ hasText: ACCEPTED });
  await row.getByRole('button', { name: 'Show', exact: true }).click();
  await goto('/search');
  const bounds = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.getBounds());
  try {
    for (const width of [1728, 960]) {
      await app.evaluate(({ BrowserWindow }, w) => { BrowserWindow.getAllWindows()[0]!.setSize(w, 640); }, width);
      await expect(win.getByRole('heading', { name: ACCEPTED, exact: true })).toBeVisible();
      for (const selector of ['.results-head .page-title', '.count-sentence']) {
        await expect.poll(async () => win.locator(selector).evaluate((element) => {
          const box = element.getBoundingClientRect();
          const parent = element.closest('.results')!.getBoundingClientRect();
          return box.left >= parent.left && box.right <= parent.right && element.scrollWidth <= element.clientWidth + 1;
        })).toBe(true);
      }
    }
  } finally {
    await app.evaluate(({ BrowserWindow }, original) => { BrowserWindow.getAllWindows()[0]!.setBounds(original); }, bounds);
  }
});
