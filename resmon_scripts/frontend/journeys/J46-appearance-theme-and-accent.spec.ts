/**
 * J46 Appearance: theme and accent — a person chooses how the window looks,
 * and it stays chosen.
 *
 * The claim is "comes back", so the journey reopens the app between choosing
 * and reading: the Atlas renderer is served from a new port on every launch,
 * so a choice it kept for itself would be gone, and only one the engine kept
 * survives. What is read is what the window is drawn in, not the setting; the
 * setting is read separately, from the engine, as a backend fact.
 */
import { expect, journey } from './driver';

journey.describe('J46 Appearance: theme and accent', () => {
  journey('a theme and an accent chosen in Settings are what the window is drawn in, after reopening too', async ({ resmon }) => {
    await resmon.chooseTheme('dark');
    await resmon.chooseAccent('#3D8AFF');
    expect(await resmon.readAppearance()).toEqual({ theme: 'dark', accent: '#3d8aff' });
    expect(await resmon.backend.appearance(), 'the engine keeps something other than what was chosen')
      .toEqual({ theme: 'dark', accent: '#3d8aff' });

    await resmon.reopenTheApp();
    expect(await resmon.readAppearance(), 'the choice did not survive reopening the app')
      .toEqual({ theme: 'dark', accent: '#3d8aff' });

    // A second choice replaces the first, and keeps the accent it did not touch.
    await resmon.chooseTheme('light');
    await resmon.reopenTheApp();
    expect((await resmon.readAppearance()).theme).toBe('light');
    expect(await resmon.backend.appearance()).toEqual({ theme: 'light', accent: '#3d8aff' });
  });
});
