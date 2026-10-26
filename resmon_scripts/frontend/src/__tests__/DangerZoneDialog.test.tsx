/**
 * The Danger Zone's confirmation takes the theme's colors, so its Cancel button
 * can be read.
 *
 * The dialog set an inline white background over ``.modal-content``'s dark
 * surface while its buttons kept the dark theme's light text, so on Factory
 * reset the safe way out was near-white on white. Found in a walk of the app on
 * October 26, 2026. jsdom computes no contrast; what it can pin is that nothing
 * in the dialog overrides the theme with a fixed light color.
 */
import React from 'react';
import { act, fireEvent, screen } from '@testing-library/react';
import AdvancedSettings from '../components/Settings/AdvancedSettings';
import { mockRoutedFetch, renderWithProviders } from './testUtils';

const ROUTES = {
  '/api/settings/execution': { max_concurrent_executions: 3, routine_fire_queue_limit: 16 },
  '/api/scheduler/jobs': [],
  '/api/service/status': { installed: false, unit_path: '/x', platform: 'darwin' },
  '/api/service/daemon-status': { lock_present: false, running: false },
};

test('the Factory reset dialog uses the theme, and Cancel is the ordinary secondary button', async () => {
  mockRoutedFetch(ROUTES);
  await renderWithProviders(<AdvancedSettings />);
  await act(async () => {
    fireEvent.click(await screen.findByRole('button', { name: 'Factory reset' }));
  });

  const dialog = document.querySelector('.modal-content') as HTMLElement;
  expect(dialog).not.toBeNull();
  expect(dialog.style.background).toBe('');
  expect(dialog.style.backgroundColor).toBe('');
  const fixedLight = /(^|[^-])(white|#fff\b|#ffffff|#444|#666|#ccc)/i;
  for (const el of [dialog, ...Array.from(dialog.querySelectorAll<HTMLElement>('*'))]) {
    expect(el.getAttribute('style') ?? '').not.toMatch(fixedLight);
  }
  const cancel = screen.getByRole('button', { name: 'Cancel' });
  expect(cancel).toHaveClass('btn', 'btn-secondary');
  expect(cancel.getAttribute('style')).toBeNull();
});
