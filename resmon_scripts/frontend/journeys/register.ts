/**
 * The denominator.
 *
 * Forty-eight rows, one per user journey the 3.0 renderer has to carry forward.
 * J01–J44 are copied from the workspace parity register — the same list the
 * capability register's J-rows come from — and `register.spec.ts` refuses to
 * let this file and the spec files in this directory disagree. A row with no
 * test cannot exist, and a test with no row cannot exist either; that mutual
 * guard is the only thing that makes "N of 48" a measurement rather than a
 * hand count.
 *
 * **J45 was added here, not copied.** The Source wall (#175) became a page on
 * October 18, 2026, 26 days after this register was written, and for the nine
 * days after that it was a journey nothing measured: the guard compared the register with
 * the spec files and nothing compared it with the app. The check that found it
 * is now `ROUTE_ROWS` below. The workspace register has to take the same row,
 * with the same title, for the two to agree again.
 *
 * **J46 is the first row the rebuilt interface added.** Atlas keeps the theme
 * and the accent color in the engine, at `/api/appearance`, because the
 * renderer's storage does not survive a launch; the route needed a row to
 * serve. Its test is owed by the `atlas` slice, whose candidate driver is the
 * first that can reach a screen where the accent is chosen. J47, the
 * collection map behind Today's plate (`/api/map`), and J48, Today itself
 * (`/api/today`), arrived the same way.
 *
 * **`status`.** Every row is `carried` today: nothing has been dropped from the
 * register. A row that stops being carried takes `status: 'not_carried_forward'`
 * and must then carry a `reason` naming the N-row it was decided under and the
 * initials of whoever decided it — B4 in prose, enforced by the guard. There
 * are no such rows yet.
 *
 * **`slice` and `built`.** `slice` is which delivery owes the row's test; every
 * slice-1 row is built by definition, and a later slice's row is built once it
 * carries `built: true`. A row that is neither is *pending*, and the guard
 * accepts its missing spec only because the slice is named here. The printed
 * count moves when a spec and its flag arrive together, without anyone editing
 * a number.
 *
 * **Two rows whose journey is a gate, not a screen.** J16 (the weekly
 * live-network job) and J43 (upgrade in place) are user journeys whose evidence
 * is a CI job and a migration, not a route. The pattern, settled by J43 in
 * slice 2b, is a journey test that runs the *existing* gate as a subprocess and
 * asserts its exit status and the denominators it prints — `runGate` in
 * `fixtures/gates.ts`, re-exported from `driver.ts` so a spec can reach it
 * without importing `child_process`. The row's evidence stays the real gate;
 * re-implementing it here would be a second thing to keep in step. J16 is slice 2a's
 * and takes the same shape: `test_live_suite.py` under the build's own
 * interpreter for the gate, plus `live_suite.py --summary` for the denominator,
 * because a `-q` pytest run does not print one.
 */

/**
 * `refresh` is the October 27, 2026 check of the register against the app's
 * routes — the delivery that owes J45, the one row it added. `atlas` is the
 * rebuilt interface, which owes J46, J47 and J48.
 */
export type JourneySlice = '1' | '2a' | '2b' | 'refresh' | 'atlas';
export type JourneyStatus = 'carried' | 'not_carried_forward';

export interface JourneyRow {
  /** `J01`…`J48`, as the workspace register numbers them. */
  id: string;
  /** The row's title, byte-identical to the workspace register's. */
  title: string;
  /** Which slice of the journey suite builds this row's test. */
  slice: JourneySlice;
  status: JourneyStatus;
  /**
   * This row's spec exists in this checkout.
   *
   * Slice 1's rows do not carry it — `BUILT_SLICE` already says they are built,
   * and that is the shape `register.spec.ts` was written against. A later slice
   * marks its own rows one at a time as it lands them, which is deliberate:
   * slices 2a and 2b are two workers on two branches, and a flag on each row is
   * a diff in disjoint lines rather than a shared list both of them rewrite.
   * A row of a later slice with no flag is *pending*, which is the honest
   * reading — the slice was dispatched, this row was not reached.
   */
  built?: true;
  /**
   * Only for `not_carried_forward`: the N-row of the workspace register that
   * decided it and the initials of whoever initialled it, e.g.
   * `'N1; dropped by RK 2026-09-22'`. The guard fails on a dropped row without one.
   */
  reason?: string;
}

export const JOURNEY_REGISTER: readonly JourneyRow[] = [
  { id: 'J01', title: 'Deep Dive', slice: '1', status: 'carried' },
  { id: 'J02', title: 'Deep Sweep', slice: '1', status: 'carried' },
  { id: 'J03', title: 'Routines', slice: '1', status: 'carried' },
  { id: 'J04', title: 'Background daemon', slice: '2a', status: 'carried', built: true },
  { id: 'J05', title: 'Analytics', slice: '2a', status: 'carried', built: true },
  { id: 'J06', title: 'Watchdog', slice: '2a', status: 'carried', built: true },
  { id: 'J07', title: 'Watch profiles', slice: '2a', status: 'carried', built: true },
  { id: 'J08', title: 'Author identity and entity search', slice: '2a', status: 'carried', built: true },
  { id: 'J09', title: 'Semantic search', slice: '2a', status: 'carried', built: true },
  { id: 'J10', title: 'Near-duplicate links', slice: '2a', status: 'carried', built: true },
  { id: 'J11', title: 'Coverage audit', slice: '2a', status: 'carried', built: true },
  { id: 'J12', title: 'Explorer', slice: '1', status: 'carried' },
  { id: 'J13', title: 'The assistant (CLI lane)', slice: '2a', status: 'carried', built: true },
  { id: 'J14', title: 'The assistant on a key', slice: '2a', status: 'carried', built: true },
  { id: 'J15', title: 'First-run card', slice: '2a', status: 'carried', built: true },
  { id: 'J16', title: 'Weekly live-network job', slice: '2a', status: 'carried', built: true },
  { id: 'J17', title: 'AI summarization lanes', slice: '2a', status: 'carried', built: true },
  { id: 'J18', title: 'Reports and exports', slice: '1', status: 'carried' },
  { id: 'J19', title: 'Live monitoring', slice: '1', status: 'carried' },
  { id: 'J20', title: 'Calendar', slice: '1', status: 'carried' },
  { id: 'J21', title: 'Saved configurations', slice: '1', status: 'carried' },
  { id: 'J22', title: 'Repositories and keys', slice: '2a', status: 'carried', built: true },
  { id: 'J23', title: 'Notifications and email', slice: '2a', status: 'carried', built: true },
  { id: 'J24', title: 'Google Drive backup', slice: '2a', status: 'carried', built: true },
  { id: 'J25', title: 'In-app documentation', slice: '2a', status: 'carried', built: true },
  { id: 'J26', title: 'Danger Zone', slice: '2a', status: 'carried', built: true },
  { id: 'J27', title: 'Citation graph', slice: '2a', status: 'carried', built: true },
  { id: 'J28', title: 'Reading queue', slice: '2b', status: 'carried', built: true },
  { id: 'J29', title: 'Recorded-source coverage', slice: '1', status: 'carried' },
  { id: 'J30', title: 'Runtime identity', slice: '1', status: 'carried' },
  { id: 'J31', title: 'Readable Ask', slice: '2b', status: 'carried', built: true },
  { id: 'J32', title: 'Chats and export', slice: '2b', status: 'carried', built: true },
  { id: 'J33', title: 'Composer choices', slice: '2b', status: 'carried', built: true },
  { id: 'J34', title: 'Owned Library', slice: '2b', status: 'carried', built: true },
  { id: 'J35', title: 'Evidence workspace', slice: '2b', status: 'carried', built: true },
  { id: 'J36', title: 'Selected-evidence answers', slice: '2b', status: 'carried', built: true },
  { id: 'J37', title: 'Portable saved-answer HTML', slice: '2b', status: 'carried', built: true },
  { id: 'J38', title: 'Interrupted runs and Restart', slice: '1', status: 'carried' },
  { id: 'J39', title: 'One run per routine, one per submission, missed fires', slice: '2b', status: 'carried', built: true },
  { id: 'J40', title: 'Delivery: where a report goes, and whether it got there', slice: '2b', status: 'carried', built: true },
  { id: 'J41', title: 'Backup and restore', slice: '1', status: 'carried' },
  { id: 'J42', title: 'Local API locked to this app', slice: '2b', status: 'carried', built: true },
  { id: 'J43', title: 'Upgrade in place', slice: '2b', status: 'carried', built: true },
  { id: 'J44', title: 'Driving resmon from an external harness (MCP)', slice: '2b', status: 'carried', built: true },
  { id: 'J45', title: 'Source wall: what every source did on recent runs', slice: 'refresh', status: 'carried', built: true },
  { id: 'J46', title: 'Appearance: theme and accent', slice: 'atlas', status: 'carried' },
  { id: 'J47', title: 'Collection map: where every paper sits', slice: 'atlas', status: 'carried' },
  { id: 'J48', title: 'Today: the papers since you last looked', slice: 'atlas', status: 'carried' },
];

/** The slice whose rows were built when this directory was born. */
export const BUILT_SLICE: JourneySlice = '1';

/** The later slices, any of which may still owe a row its test. */
export const LATER_SLICES: readonly JourneySlice[] = ['2a', '2b', 'refresh', 'atlas'];

/** Rows the guard requires a spec for: slice 1, plus every later row marked built. */
export function builtRows(): JourneyRow[] {
  return JOURNEY_REGISTER.filter(
    (row) => row.status === 'carried' && (row.slice === BUILT_SLICE || row.built === true),
  );
}

/** Carried rows whose test a later slice still owes. */
export function pendingRows(): JourneyRow[] {
  return JOURNEY_REGISTER.filter(
    (row) => row.status === 'carried' && row.slice !== BUILT_SLICE && row.built !== true,
  );
}

/**
 * Every page a person can reach, and the rows that carry what they do there.
 *
 * **Why this exists.** The guard below this file's rows compares the register
 * with the spec files, and until October 27, 2026 nothing compared it with the
 * app: the Source wall shipped as a page and had no row, and the suite stayed
 * green over a journey it did not measure. So every hash `allRouteHashes()` in
 * `src/routes.ts` returns — the same denominator the smoke suite sweeps,
 * Settings and About tabs included — has an entry here, and `register.spec.ts`
 * fails on a hash with none, on an entry that is not a hash, and on an entry
 * that names no carried row. A page added without a row is now a red run
 * rather than a nine-day silence.
 *
 * **What an entry claims.** That the row's journey is what a person does on
 * that page — not that the row's spec exercises every control on it. Where a
 * page and its row do not share a name, `why` says what the page is for and
 * why that is the row's journey rather than one of its own; where the row's
 * spec does not reach the page at all, `why` says that too. Those are the
 * places a reviewer should look first when deciding whether the register is
 * missing a journey.
 */
export const ROUTE_ROWS: Readonly<Record<string, { rows: readonly string[]; why?: string }>> = {
  '/': {
    rows: ['J15'],
    why: 'The Dashboard summarizes routines and runs whose journeys are J03 and J18; what is its '
      + 'own is the first-run card, J15. Its sentence when it cannot read routines or runs (#210) '
      + 'is a property of that summary, not a journey of its own, and no spec reaches it.',
  },
  '/dive': { rows: ['J01'] },
  '/sweep': { rows: ['J02', 'J21'] },
  '/routines': { rows: ['J03', 'J11', 'J39', 'J40'] },
  '/calendar': { rows: ['J20'] },
  '/results': { rows: ['J18', 'J38'] },
  '/chats': { rows: ['J32'] },
  '/reading-queue': { rows: ['J28'] },
  '/library': { rows: ['J34'] },
  '/evidence': { rows: ['J35', 'J36', 'J37'] },
  '/analytics': { rows: ['J05'] },
  '/watchdog': { rows: ['J06'] },
  '/source-wall': { rows: ['J45'] },
  '/explorer': { rows: ['J12', 'J09', 'J10'] },
  '/profiles': { rows: ['J07', 'J08'] },
  '/configurations': { rows: ['J21'] },
  '/monitor': { rows: ['J19', 'J29'] },
  '/repositories': { rows: ['J22', 'J08'] },
  '/settings': { rows: ['J23'], why: 'Lands on the Email tab.' },
  '/settings/email': { rows: ['J23'] },
  '/settings/cloud': { rows: ['J24'] },
  '/settings/ai': { rows: ['J13', 'J14', 'J17', 'J33'] },
  '/settings/storage': { rows: ['J41'] },
  '/settings/notifications': { rows: ['J23'] },
  '/settings/advanced': { rows: ['J04', 'J26'] },
  '/about-resmon': { rows: ['J25'], why: 'Lands on the Tutorials tab.' },
  '/about-resmon/tutorials': { rows: ['J25'] },
  '/about-resmon/issues': {
    rows: ['J25'],
    why: 'Composes a report and hands it to the person\'s own mail client or a GitHub issue page; '
      + 'resmon sends nothing itself. Filed with the in-app documentation rather than given a row, '
      + 'and J25\'s spec does not open this tab.',
  },
  '/about-resmon/blog': {
    rows: ['J25'],
    why: 'Reads the public site\'s posts in an origin-locked view: documentation about resmon, not '
      + 'monitoring. J25\'s spec does not open this tab.',
  },
  '/about-resmon/about-app': {
    rows: ['J25'],
    why: 'The version and the author\'s links. The version a person can check against the backend '
      + 'is J30\'s header; this tab is documentation, and J25\'s spec does not open it.',
  },
};

/** `J01-deep-dive` from `J01` + `Deep Dive`: the spec file's stem. */
export function specStem(row: JourneyRow): string {
  const slug = row.title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return `${row.id}-${slug}`;
}

/**
 * The tokens a journey spec may not contain — what makes "runnable against the
 * candidate" a property rather than a hope.
 *
 * A spec that reaches the renderer directly is a spec that has to be rewritten
 * when the renderer is rebuilt, which is the exact cost this suite exists to
 * avoid. Everything a spec does goes through the driver, so the seam is checked
 * by a grep rather than by good intentions.
 *
 * **Why the list lives here and not in the guard.** The guard scans *every*
 * `*.spec.ts` in this directory, including itself. If it spelled these patterns
 * out in its own source it would match itself and fail, and the tempting fix —
 * excluding the guard from its own scan — leaves one spec file in the directory
 * that is allowed to reach the renderer. Keeping the literals in this module,
 * which is not a spec file, lets the guard cover every spec file in the
 * directory — one per built row plus the guard — with no exemption at all.
 * (45 is the register's rows and the suite's case count is a third number;
 * neither is what this counts. The guard takes its denominator from a
 * directory read rather than from a figure written here, which is why no
 * number appears in this sentence.)
 *
 * `page.` is matched with no space after the dot on purpose: prose ending a
 * sentence with "…on the page. The next…" is not a renderer call, and a guard
 * that goes red on a comment gets deleted.
 */
export const FORBIDDEN_RENDERER_PATTERNS: readonly { name: string; pattern: RegExp }[] = [
  { name: 'page.<member>', pattern: /\bpage\.[A-Za-z_$]/ },
  { name: 'win.<member>', pattern: /\bwin\.[A-Za-z_$]/ },
  { name: 'getBy…', pattern: /\bgetBy[A-Z]/ },
  { name: 'locator(', pattern: /\blocator\s*\(/ },
  { name: 'frameLocator(', pattern: /\bframeLocator\s*\(/ },
  { name: '_electron', pattern: /\b_electron\b/ },
];

/**
 * What a journey spec is allowed to import.
 *
 * The token grep above catches a renderer call written out; this catches the
 * way around it — importing Playwright, Node's `fs`, or the `e2e/` fixtures and
 * building a selector somewhere the grep does not look. A journey spec needs
 * the driver and nothing else, and `driver.ts` re-exports the two Playwright
 * names (`expect` and the test object) it legitimately uses.
 */
export const ALLOWED_SPEC_IMPORTS: readonly string[] = ['./driver', './register'];
