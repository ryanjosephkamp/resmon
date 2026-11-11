import { test, expect } from './fixtures/resmon-app';

test('Deep Sweep and the watch editor choose all eligible sources and clear them; Deep Dive has no bulk controls', async ({ win, goto }) => {
  await goto('/search/ask');
  await expect(win.getByRole('button', { name: 'Select All', exact: true })).toHaveCount(0);
  await win.getByRole('button', { name: 'Deep Sweep', exact: true }).click();
  for (const target of ['sweep', 'watch']) {
    if (target === 'watch') await goto('/watches/new');
    const catalog = win.locator('fieldset.catalog');
    await expect(catalog.locator('.source')).not.toHaveCount(0);
    await catalog.getByRole('searchbox').fill('arxiv');
    await catalog.getByRole('button', { name: 'Select All', exact: true }).click();
    await catalog.getByRole('searchbox').fill('');
    const chosen = await catalog.locator('.source:has(input:checked)').evaluateAll(rows => rows.map(row => ({
      slug: row.getAttribute('data-source'), keyMissing: !!row.querySelector('.source-key:not([data-author-query]):not([data-notice])'),
    })));
    expect(chosen.length).toBeGreaterThan(1);
    expect(chosen.some(source => source.keyMissing)).toBe(false);
    if (target === 'sweep') await expect(win.getByRole('button', { name: `Ask ${chosen.length} Sources`, exact: true })).toBeVisible();
    else await expect(win.locator('[data-will="asks"]')).toContainText('arXiv');
    await catalog.getByRole('button', { name: 'Deselect All', exact: true }).click();
    await expect(catalog.locator('input:checked')).toHaveCount(0);
  }
});
