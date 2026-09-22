/**
 * The denominator.
 *
 * Forty-four rows, one per user journey the 3.0 renderer has to carry forward.
 * The IDs and titles are copied from the workspace parity register — the same
 * list the capability register's J-rows come from — and `register.spec.ts`
 * refuses to let this file and the spec files in this directory disagree. A row
 * with no test cannot exist, and a test with no row cannot exist either; that
 * mutual guard is the only thing that makes "N of 44" a measurement rather than
 * a hand count.
 *
 * **`status`.** Every row is `carried` today: nothing has been dropped from the
 * register. A row that stops being carried takes `status: 'not_carried_forward'`
 * and must then carry a `reason` naming the N-row it was decided under and the
 * initials of whoever decided it — B4 in prose, enforced by the guard. There
 * are no such rows yet.
 *
 * **`slice` and `built`.** `slice` says which delivery owes the row's test;
 * `built` says whether it has arrived. A row marked `built` must have a spec
 * and a row without the marker must not, both ways round, so the printed count
 * moves when a spec lands rather than when somebody edits a number. The two
 * fields are separate because slices 2a and 2b are built in parallel: a single
 * "the built slice is X" constant would have put every row of both slices on
 * one line and made the merge a conflict rather than a union.
 *
 * **Two rows whose journey is a gate, not a screen.** J16 (the weekly
 * live-network job) and J43 (upgrade in place) are user journeys whose evidence
 * is a CI job and a migration, not a route. The pattern is a journey test that
 * runs the *existing* gate as a subprocess and asserts its exit status and the
 * denominators it prints; re-implementing the gate here would be a second thing
 * to keep in step. J16 does exactly that in slice 2a — `test_live_suite.py`
 * under the build's own interpreter, plus `live_suite.py --summary` for the
 * denominator, because a `-q` pytest run does not print one. J43
 * (`test_cumulative_upgrade.py`) is slice 2b's and is undecided beyond this
 * note.
 */

export type JourneySlice = '1' | '2a' | '2b';
export type JourneyStatus = 'carried' | 'not_carried_forward';

export interface JourneyRow {
  /** `J01`…`J44`, as the workspace register numbers them. */
  id: string;
  /** The row's title, byte-identical to the workspace register's. */
  title: string;
  /** Which slice of the journey suite builds this row's test. */
  slice: JourneySlice;
  status: JourneyStatus;
  /**
   * Whether this checkout has the row's test.
   *
   * Per row rather than per slice, and that is the whole reason it exists: two
   * slices are built in parallel on disjoint rows, and a single "the built
   * slice is 2a" constant would have made every row of the other slice a
   * conflict in the same line. A row without this marker is a row some slice
   * still owes, and `pendingRows()` says which.
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
  { id: 'J01', title: 'Deep Dive', slice: '1', status: 'carried', built: true },
  { id: 'J02', title: 'Deep Sweep', slice: '1', status: 'carried', built: true },
  { id: 'J03', title: 'Routines', slice: '1', status: 'carried', built: true },
  { id: 'J04', title: 'Background daemon', slice: '2a', status: 'carried', built: true },
  { id: 'J05', title: 'Analytics', slice: '2a', status: 'carried', built: true },
  { id: 'J06', title: 'Watchdog', slice: '2a', status: 'carried', built: true },
  { id: 'J07', title: 'Watch profiles', slice: '2a', status: 'carried', built: true },
  { id: 'J08', title: 'Author identity and entity search', slice: '2a', status: 'carried', built: true },
  { id: 'J09', title: 'Semantic search', slice: '2a', status: 'carried', built: true },
  { id: 'J10', title: 'Near-duplicate links', slice: '2a', status: 'carried', built: true },
  { id: 'J11', title: 'Coverage audit', slice: '2a', status: 'carried', built: true },
  { id: 'J12', title: 'Explorer', slice: '1', status: 'carried', built: true },
  { id: 'J13', title: 'The assistant (CLI lane)', slice: '2a', status: 'carried', built: true },
  { id: 'J14', title: 'The assistant on a key', slice: '2a', status: 'carried', built: true },
  { id: 'J15', title: 'First-run card', slice: '2a', status: 'carried', built: true },
  { id: 'J16', title: 'Weekly live-network job', slice: '2a', status: 'carried', built: true },
  { id: 'J17', title: 'AI summarization lanes', slice: '2a', status: 'carried', built: true },
  { id: 'J18', title: 'Reports and exports', slice: '1', status: 'carried', built: true },
  { id: 'J19', title: 'Live monitoring', slice: '1', status: 'carried', built: true },
  { id: 'J20', title: 'Calendar', slice: '1', status: 'carried', built: true },
  { id: 'J21', title: 'Saved configurations', slice: '1', status: 'carried', built: true },
  { id: 'J22', title: 'Repositories and keys', slice: '2a', status: 'carried', built: true },
  { id: 'J23', title: 'Notifications and email', slice: '2a', status: 'carried', built: true },
  { id: 'J24', title: 'Google Drive backup', slice: '2a', status: 'carried', built: true },
  { id: 'J25', title: 'In-app documentation', slice: '2a', status: 'carried', built: true },
  { id: 'J26', title: 'Danger Zone', slice: '2a', status: 'carried', built: true },
  { id: 'J27', title: 'Citation graph', slice: '2a', status: 'carried', built: true },
  { id: 'J28', title: 'Reading queue', slice: '2b', status: 'carried' },
  { id: 'J29', title: 'Recorded-source coverage', slice: '1', status: 'carried', built: true },
  { id: 'J30', title: 'Runtime identity', slice: '1', status: 'carried', built: true },
  { id: 'J31', title: 'Readable Ask', slice: '2b', status: 'carried' },
  { id: 'J32', title: 'Chats and export', slice: '2b', status: 'carried' },
  { id: 'J33', title: 'Composer choices', slice: '2b', status: 'carried' },
  { id: 'J34', title: 'Owned Library', slice: '2b', status: 'carried' },
  { id: 'J35', title: 'Evidence workspace', slice: '2b', status: 'carried' },
  { id: 'J36', title: 'Selected-evidence answers', slice: '2b', status: 'carried' },
  { id: 'J37', title: 'Portable saved-answer HTML', slice: '2b', status: 'carried' },
  { id: 'J38', title: 'Interrupted runs and Restart', slice: '1', status: 'carried', built: true },
  { id: 'J39', title: 'One run per routine, one per submission, missed fires', slice: '2b', status: 'carried' },
  { id: 'J40', title: 'Delivery: where a report goes, and whether it got there', slice: '2b', status: 'carried' },
  { id: 'J41', title: 'Backup and restore', slice: '1', status: 'carried', built: true },
  { id: 'J42', title: 'Local API locked to this app', slice: '2b', status: 'carried' },
  { id: 'J43', title: 'Upgrade in place', slice: '2b', status: 'carried' },
  { id: 'J44', title: 'Driving resmon from an external harness (MCP)', slice: '2b', status: 'carried' },
];

/** Rows the guard requires a spec for: the ones a slice has actually delivered. */
export function builtRows(): JourneyRow[] {
  return JOURNEY_REGISTER.filter((row) => row.status === 'carried' && row.built === true);
}

/** Carried rows whose test a later slice still owes. */
export function pendingRows(): JourneyRow[] {
  return JOURNEY_REGISTER.filter((row) => row.status === 'carried' && row.built !== true);
}

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
 * directory — 13 of them today, one per built row plus the guard — with no
 * exemption at all. (44 is the register's rows; 22 is the suite's test cases;
 * neither is what this counts.)
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
