/**
 * Settings › About resmon: the facts the group states, kept where a test can
 * hold each one to the file it describes (`__tests__/about.test.ts`), so the
 * page cannot go on saying something the build has stopped doing.
 */
import type { Health } from './model';

/** The repository, written once here. `test_repository_name.py` holds every other place that spells it out to `config.py`'s copy. */
export const REPOSITORY = 'ryanjosephkamp/resmon';

/** The repository's issues page, where a person reports a problem themselves. */
export const ISSUES_URL = `https://github.com/${REPOSITORY}/issues`;

/** Who made resmon, and where to find him: the credit row his project sites end with, in its order and words. */
export const MAKER = { name: 'Ryan Kamp', website: 'https://ryanjosephkamp.github.io/' } as const;

export type CreditIcon = 'website' | 'github' | 'linkedin' | 'x' | 'youtube';

export const CREDIT_LINKS: readonly { icon: CreditIcon; href: string; label: string; title: string }[] = [
  { icon: 'website', href: MAKER.website, label: 'Ryan Kamp’s website', title: 'Website' },
  { icon: 'github', href: 'https://github.com/ryanjosephkamp/', label: 'Ryan Kamp on GitHub', title: 'GitHub' },
  { icon: 'linkedin', href: 'https://www.linkedin.com/in/rjk1999', label: 'Ryan Kamp on LinkedIn', title: 'LinkedIn' },
  { icon: 'x', href: 'https://x.com/ryanjosephkamp', label: 'Ryan Kamp on X', title: 'X' },
  { icon: 'youtube', href: 'https://m.youtube.com/@RyanJosephKamp', label: 'Ryan Kamp on YouTube', title: 'YouTube' },
];

export const SPONSOR_URL = 'https://github.com/sponsors/ryanjosephkamp';

/** The repository's `LICENSE`, word for word. */
export const LICENSE_TEXT = `MIT License

Copyright (c) 2026 Ryan Kamp

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
`;

/** The license's own copyright line, as it stands in the file, rather than this year's date. */
export const COPYRIGHT = LICENSE_TEXT.split('\n').find((line) => line.startsWith('Copyright')) ?? '';

/**
 * When an installed copy asks GitHub for a newer version (`initAutoUpdater`
 * in `electron/main.ts`): on Windows and Linux only, this long after it
 * opens, and then at this interval.
 */
export const UPDATE_CHECK = { firstAfterSeconds: 15, everyHours: 6 } as const;

/** The version line: the engine's own word for itself, or why there is none. */
export function versionWords(health: Pick<Health, 'version'> | undefined, error: Error | null): string {
  if (health) return `resmon ${health.version}`;
  if (error) return `Not known: the engine did not answer (${error.message}).`;
  return 'Asking the engine.';
}

type BuildFacts = { identity?: Pick<Health['identity'], 'build_id'>; build?: string | null };

/**
 * The build an engine names: the build id its identity carries, else the
 * `build` its health answer carries (the app's own id for the build that
 * started the engine), else none.
 */
export function engineBuild(health: BuildFacts): string | null {
  return health.identity?.build_id || health.build || null;
}

/** About's build line: the build the engine names, else a sentence saying it names none. */
export function buildWords(health: BuildFacts | undefined): string | null {
  if (!health) return null;
  return engineBuild(health) ?? 'Not identified. The engine reports no build id, so none is named here.';
}
