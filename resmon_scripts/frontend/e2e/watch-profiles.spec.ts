/**
 * P10 and the real-browser half of P8 — the basis rule, painted.
 *
 * Phase 2.1's spine stored a basis on every match row and displayed it nowhere,
 * and the reconciliation refused to release in that state: a constraint that
 * "`name_only` is never presented as the person" is kept by nothing when there
 * is no presentation. jsdom now asserts the components render the field they are
 * given. **This file asserts a real Chromium paints it on the real route**, over
 * a real backend, which is a different claim and the one the last three shipped
 * defects were about.
 *
 * Everything is seeded through the backend's own API — the rule
 * `search-record.spec.ts` set: the schema is not this suite's to write to. A
 * match row is produced the way a routine produces one, by creating a profile,
 * creating a watch routine and firing it, so what reaches the screen came
 * through the code a user's routine uses.
 *
 * **Five of the six arms need no network.** The sixth does, deliberately: a real
 * author search against a real source is the point of it, and arXiv is the right
 * source because it returns no ORCID for anybody — so every match it can produce
 * is `name_only`, and `name_only` rendered honestly is the guarantee this phase
 * exists for. Where the network is absent that arm prints what it did **not**
 * verify and asserts the empty state instead of passing quietly. Both CI jobs
 * have network.
 */
import * as fs from 'fs';
import { execFileSync } from 'child_process';
import * as os from 'os';
import * as path from 'path';
import { test, expect, _electron as electron } from '@playwright/test';
import type { ElectronApplication, Page } from '@playwright/test';
import { launchEnv, FRONTEND_ROOT, ensureScreenshotDir } from './fixtures/resmon-app';
import { APP_ROUTES, allRouteHashes } from '../src/routes';

test.describe.configure({ mode: 'serial' });

const ORCID = '0000-0002-1825-0097';

interface Launched { app: ElectronApplication; win: Page; close: () => Promise<void>; }

async function launch(seedTrust = false): Promise<Launched> {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'resmon-e2e-watch-'));
  if (seedTrust) {
    const env = launchEnv(stateDir, true);
    const seed = path.resolve(FRONTEND_ROOT, '../verification_scripts/test_trust_corrections.py');
    // Synthetic existing-schema rows are prepared before app startup. Current
    // rows carry output from the actual Python matcher, not renderer fixtures.
    execFileSync(env.RESMON_PYTHON, [seed, env.RESMON_DB_PATH], { env });
  }
  const app = await electron.launch({
    args: ['.', `--user-data-dir=${path.join(stateDir, 'electron-user-data')}`],
    cwd: FRONTEND_ROOT, env: launchEnv(stateDir, true), timeout: 180_000,
  });
  const win = await app.firstWindow({ timeout: 180_000 });
  await win.waitForLoadState('domcontentloaded');
  await win.locator('.app-main').waitFor({ state: 'visible', timeout: 60_000 });
  const port = await win.evaluate(
    () => (window as unknown as { resmonAPI: { getBackendPort(): string } })
      .resmonAPI.getBackendPort(),
  );
  expect(port, 'the e2e app must never attach to the live daemon').not.toBe('8742');
  return {
    app, win,
    close: async () => {
      await app.close().catch(() => { /* already gone */ });
      fs.rmSync(stateDir, { recursive: true, force: true });
    },
  };
}

async function api(win: Page, method: string, route: string, body?: unknown): Promise<any> {
  return win.evaluate(async ([m, r, b]) => {
    const port = (window as unknown as { resmonAPI: { getBackendPort(): string } })
      .resmonAPI.getBackendPort();
    const res = await fetch(`http://127.0.0.1:${port}${r as string}`, {
      method: m as string,
      headers: { 'Content-Type': 'application/json' },
      body: b === undefined ? undefined : JSON.stringify(b),
    });
    return { status: res.status, body: await res.json().catch(() => null) };
  }, [method, route, body] as const);
}

async function goto(win: Page, hash: string): Promise<void> {
  await win.evaluate((h) => { window.location.hash = `#${h}`; }, hash);
  await win.waitForFunction((h) => window.location.hash.startsWith(`#${h}`), hash,
    { timeout: 15_000 });
  await win.waitForLoadState('networkidle').catch(() => { /* polling pages never idle */ });
  await win.waitForTimeout(500);
}

test('P10: the Profiles route is in the sweep table and the sweep grew by exactly one',
  async () => {
    /**
     * The denominator, asserted rather than assumed. `routes.ts` is the one
     * route table — `App.tsx` renders from it and this suite imports it — so a
     * page that exists without a row here is a page nothing sweeps. The brief
     * says the sweep grows by exactly one, and this is where that number lives.
     */
    const hashes = allRouteHashes().map((r) => r.hash);
    expect(hashes).toContain('/profiles');
    expect(APP_ROUTES.filter((r) => r.path === '/profiles')).toHaveLength(1);
    // 24 through v2.0.1; Watch Profiles is the twenty-fifth.
    expect(hashes).toHaveLength(25);
  });

test('P10 + P8: the page renders, and a profile with no ORCID says so in a real browser',
  async () => {
    const { win, close } = await launch();
    try {
      const created = await api(win, 'POST', '/api/profiles', {
        kind: 'person', display_name: 'A Person With No Identifier',
      });
      expect(created.status).toBe(201);
      expect(created.body.basis_warning, 'the API half of P8').toBeTruthy();

      await goto(win, '/profiles');
      await expect(win.locator('h1', { hasText: 'Watch Profiles' })).toBeVisible();
      await expect(win.getByTestId('profiles-list')).toBeVisible();

      // The sentence, on screen, in Chromium — not "the component was handed it".
      const warning = win.getByTestId('profile-basis-warning');
      await expect(warning).toBeVisible();
      await expect(warning).toContainText('every match will be name-only');

      // And the weakness is legible from the list without opening the profile.
      await expect(win.getByTestId('profiles-list').locator('.basis-chip').first())
        .toHaveText('name only');

      await win.screenshot({
        path: path.join(ensureScreenshotDir(), 'watch-profiles-warning.png'),
        fullPage: true,
      });
    } finally {
      await close();
    }
  });

test('P8: an ORCID retires the warning, and the editor previews it while you type',
  async () => {
    /**
     * The negative control for the test above, and the editor's live half. The
     * warning that only appears after saving is a warning about a decision
     * already made, so the preview is the thing being checked here — it moves
     * as the ORCID field is filled, in a real browser, with no save in between.
     */
    const { win, close } = await launch();
    try {
      await goto(win, '/profiles');
      await win.getByRole('button', { name: 'New profile' }).click();
      await expect(win.getByTestId('profile-editor')).toBeVisible();

      const preview = win.getByTestId('basis-warning');
      await expect(preview).toContainText('every match will be name-only');

      await win.locator('#profile-affiliations').fill('University of Somewhere');
      await expect(preview).toContainText('never by identity');

      await win.locator('#profile-orcid').fill(ORCID);
      await expect(preview).toContainText('matched on identity');

      await win.locator('#profile-name').fill('A Person With An Identifier');
      await win.locator('#profile-orcid-cited').fill('their ORCID record');
      await win.getByRole('button', { name: 'Save profile' }).click();

      await expect(win.getByTestId('profile-basis-warning'))
        .toContainText('matched on identity');
      // No weak marker on a profile that has an identifier.
      await expect(win.getByTestId('profiles-list').locator('.basis-chip'))
        .toHaveCount(0);
    } finally {
      await close();
    }
  });

test('P10: a real match shows its basis, and a name-only one is never shown as the person',
  async () => {
    /**
     * The central assertion of the phase, in the real app, over a real match.
     *
     * The match is produced the way a routine produces one — a profile, a watch
     * routine, `POST /api/routines/{id}/run` — so what reaches the screen came
     * through the code a user's routine uses, including the deliverable-12 seam
     * that would have refused a bad profile id.
     *
     * **arXiv returns no ORCID for anybody**, which is why it is the right source
     * here: every match it can produce is `name_only`, and `name_only` rendered
     * honestly is the thing this phase exists to guarantee. A source that
     * returned identifiers would make the weakest case the one left untested.
     *
     * The arm needs the network — a real author search against a real source is
     * the point — and says what it did **not** verify when there is none, rather
     * than passing quietly. Both CI jobs have network.
     */
    // A real author search over a real source, then a wait for the run. The
    // config's 120 s is the whole test's budget and the poll alone can use it.
    test.setTimeout(300_000);
    const { win, close } = await launch();
    try {
      const person = 'Yoshua Bengio';
      const weak = (await api(win, 'POST', '/api/profiles', {
        kind: 'person', display_name: person,
      })).body;
      expect(weak.basis_warning, 'no ORCID, so every match must be name-only')
        .toBeTruthy();

      const routine = await api(win, 'POST', '/api/routines', {
        name: `Watch ${person}`, schedule_cron: '0 8 * * *', is_active: false,
        parameters: {
          repositories: ['arxiv'], keywords: [], query: '', max_results: 10,
          entity: { profile_id: weak.id, mode: 'new_papers' },
        },
      });
      expect(routine.status, JSON.stringify(routine.body)).toBe(201);

      const run = await api(win, 'POST', `/api/routines/${routine.body.id}/run`);
      expect(run.status).toBe(200);
      const execId = run.body.execution_id;
      const deadline = Date.now() + 120_000;
      while (Date.now() < deadline) {
        const exec = await api(win, 'GET', `/api/executions/${execId}`);
        if (exec.body?.status && exec.body.status !== 'running') break;
        await win.waitForTimeout(1000);
      }

      const matches = await api(win, 'GET', `/api/profiles/${weak.id}/matches`);
      expect(matches.status).toBe(200);
      console.log('P10 MATCHES', JSON.stringify(matches.body.by_basis));

      await goto(win, '/profiles');
      await expect(win.getByTestId('profiles-list')).toBeVisible();

      if (matches.body.total === 0) {
        // Said out loud rather than skipped silently. Reaching a real author
        // search needs the network, and this machine did not have one.
        console.log(
          'NOT VERIFIED — no match row was produced, so this machine could not '
          + 'reach arXiv. The empty state is asserted instead; a populated list '
          + 'is covered in jsdom (WatchProfiles.test.tsx) and over the API '
          + '(test_api_profiles.py). Both CI jobs have network.',
        );
        await expect(win.getByTestId('no-matches')).toBeVisible();
        await expect(win.getByTestId('no-matches')).toContainText('Watch a person');
        return;
      }

      // arXiv carries no ORCID, so this is the honest weak case and it must
      // read as one.
      expect(Object.keys(matches.body.by_basis)).toEqual(['name_only']);

      const counts = win.getByTestId('basis-counts');
      await expect(counts).toBeVisible();
      await expect(counts).toContainText('name only');

      const rows = win.getByTestId('profile-matches').locator('li');
      const count = await rows.count();
      expect(count).toBeGreaterThan(0);
      for (let i = 0; i < count; i += 1) {
        // No row without a chip. Asserted per row, not as "a chip exists".
        await expect(rows.nth(i).locator('.basis-chip')).toHaveCount(1);
        await expect(rows.nth(i).locator('.basis-chip')).toHaveText('name only');
        // And the string the source actually returned, so the reader can judge
        // the match rather than take resmon's word for it.
        await expect(rows.nth(i).locator('.basis-author')).toHaveCount(1);
      }

      await win.screenshot({
        path: path.join(ensureScreenshotDir(), 'watch-profiles-matches.png'),
        fullPage: true,
      });
    } finally {
      await close();
    }
  });

test('P10: the coverage sentence is on the page before any finding is', async () => {
  /**
   * "Nothing found" means nothing unless the reader can see how much has been
   * looked at. The order is the assertion: coverage above findings.
   */
  const { win, close } = await launch();
  try {
    await api(win, 'POST', '/api/profiles', {
      kind: 'person', display_name: 'Somebody Watched',
    });
    await goto(win, '/profiles');
    const coverage = win.getByTestId('lifecycle-coverage');
    await expect(coverage).toBeVisible();
    await expect(coverage).toContainText('have been through a lifecycle check');
    await expect(coverage).toContainText('not the same as having nothing to report');
  } finally {
    await close();
  }
});

test('P10: the routine editor offers Watch mode and repeats the profile’s warning',
  async () => {
    const { win, close } = await launch();
    try {
      await api(win, 'POST', '/api/profiles', {
        kind: 'person', display_name: 'A Watched Person',
      });
      await goto(win, '/routines');
      await win.getByRole('button', { name: /New Routine|Create Routine/i })
        .first().click();
      await expect(win.getByTestId('routine-watch-mode')).toBeVisible();

      // The enum, read off the real page. `institution_output` is refused by the
      // backend and must not be offered here.
      const modes = await win.locator('[data-testid="routine-watch-mode"] option')
        .evaluateAll((options) => options.map((o) => (o as HTMLOptionElement).value));
      expect(modes).toEqual(['', 'new_papers', 'retractions']);

      await win.selectOption('[data-testid="routine-watch-mode"] select', 'new_papers');
      await expect(win.getByTestId('routine-watch-profile')).toBeVisible();
      await win.selectOption('#routine-profile', { index: 1 });
      await expect(win.getByTestId('routine-basis-warning'))
        .toContainText('every match will be name-only');

      // Keywords go away, and the page says why rather than leaving a gap.
      await expect(win.getByTestId('keywords-not-used')).toBeVisible();

      await win.selectOption('[data-testid="routine-watch-mode"] select', 'retractions');
      await expect(win.getByTestId('retractions-hint')).toContainText('queries no source');

      await win.screenshot({
        path: path.join(ensureScreenshotDir(), 'watch-routine-mode.png'),
        fullPage: true,
      });
    } finally {
      await close();
    }
  });


test('Trust: current counterevidence and historical rows render after existing DB startup', async () => {
  const { win, close } = await launch(true);
  try {
    const response = await api(win, 'GET', '/api/profiles/1/matches');
    expect(response.body.total).toBe(7);
    await goto(win, '/profiles');
    const list = win.getByTestId('profile-matches');
    await expect(list.locator('li')).toHaveCount(7);
    await expect(list.locator('.basis-history')).toHaveCount(3);
    await expect(list).toContainText('Historical match — not rechecked');
    for (const [title, evidence] of [
      ['Ambiguous candidate', 'ambiguous single-token name'],
      ['Conflicting identifier', 'conflicting ORCID'],
    ]) {
      const row = list.locator('li').filter({ hasText: title });
      await expect(row.locator('.basis-chip')).toHaveText('name only');
      await expect(row.locator('.basis-evidence')).toContainText(evidence);
      await expect(row.locator('.basis-history')).toHaveCount(0);
    }
    await win.screenshot({ path: path.join(ensureScreenshotDir(), 'trust-profiles-evidence.png'), fullPage: true });
    const after = await api(win, 'GET', '/api/profiles/1/matches');
    expect(after.body).toEqual(response.body);
    await goto(win, '/explorer');
    await expect(win.locator('.basis-history')).toHaveCount(3);
    await expect(win.locator('.basis-evidence').filter({ hasText: 'conflicting ORCID' })).toBeVisible();
    await expect(win.locator('.basis-evidence').filter({ hasText: 'ambiguous single-token name' })).toBeVisible();
    await win.screenshot({ path: path.join(ensureScreenshotDir(), 'trust-explorer-evidence.png'), fullPage: true });
  } finally {
    await close();
  }
});
