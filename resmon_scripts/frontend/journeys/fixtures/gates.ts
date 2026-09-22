/**
 * Journeys whose evidence is a gate, not a screen.
 *
 * Two register rows are user journeys with no route behind them. J43 is
 * "install a newer resmon over an older one" — what the user does is double
 * click an installer, and what has to stay true is that the corpus they already
 * have walks every migration on the first launch. J16 is the weekly
 * live-network job. Neither has a screen, and `README.md` records the pattern
 * the harness was born with: **run the existing gate as a subprocess and assert
 * its exit status and the denominators it prints.** The row's evidence stays
 * the real gate. Re-implementing a migration walk in TypeScript would be a
 * second thing to keep in step with `database.py`, and the second thing is
 * always the one that goes stale.
 *
 * So this is deliberately thin. It knows how to start a pytest file in the
 * build under test, under an isolated state directory, and how to hand back
 * everything it wrote. What that output has to contain is the spec's business.
 *
 * It lives here rather than on `JourneyDriver` because it is not something a
 * renderer can do: there is no screen to drive and no driver to pick. A 3.0
 * candidate build runs exactly this gate, from its own checkout, unchanged.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawnSync } from 'child_process';
import { resolveInterpreter } from '../../e2e/fixtures/python-interpreter';
import { targetAppRoot } from '../drivers/session';

/** What a gate run left behind: enough for a spec to assert on and to quote. */
export interface GateOutcome {
  /** The file that was run, as it was named. */
  readonly gate: string;
  /** The process exit status. Zero is the only passing answer. */
  readonly status: number | null;
  /** Everything the run wrote, stdout and stderr interleaved as a reader sees it. */
  readonly output: string;
  /** The interpreter it ran under, and the checkout it ran in. */
  readonly python: string;
  readonly repo: string;
  /** The run's own summary line — `12 passed, 1 skipped in 4.20s` or whatever pytest said. */
  readonly summary: string;
  /** Per-outcome counts taken from that summary line, so a spec can quote a denominator. */
  readonly counts: Record<string, number>;
}

/**
 * How long a gate may take.
 *
 * The cumulative upgrade walk opens a released corpus, runs every migration and
 * then compares the result object for object against a fresh install. On a
 * loaded runner that is minutes, not seconds — but it is bounded work, and a
 * gate that has not finished in this long has stopped rather than slowed.
 */
const GATE_DEADLINE_MS = 600_000;

/**
 * Run one of the build's own pytest gates and report what it did.
 *
 * `-v` and `-s` rather than `-q`, for one reason each. `-v` prints every test's
 * node id, and for J43 the node id *is* the assertion — the walked schema range
 * is in the name `…_from_13_to_21`, and a gate that silently started walking a
 * different range would still be green under `-q`. `-s` lets the gate's own
 * `print` lines through, which is where its denominators are.
 *
 * The run gets its own `RESMON_STATE_DIR`. The suite's other launches are
 * isolated because B3 requires it, and a subprocess that inherited this
 * session's environment would be the one exception.
 */
export function runGate(gate: string): GateOutcome {
  const root = targetAppRoot();
  const { python } = resolveInterpreter();
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'resmon-journey-gate-'));
  try {
    const run = spawnSync(
      python,
      ['-m', 'pytest', '-v', '-s', '--no-header', path.join('verification_scripts', gate)],
      {
        cwd: path.join(root.repo, 'resmon_scripts'),
        timeout: GATE_DEADLINE_MS,
        encoding: 'utf8',
        maxBuffer: 64 * 1024 * 1024,
        env: {
          ...process.env,
          RESMON_STATE_DIR: stateDir,
          RESMON_DB_PATH: path.join(stateDir, 'resmon.db'),
          RESMON_REPORTS_DIR: path.join(stateDir, 'reports'),
          RESMON_PORT_FILE: path.join(stateDir, 'resmon.port'),
          PYTHONDONTWRITEBYTECODE: '1',
          PYTHON_KEYRING_BACKEND: 'keyring.backends.null.Keyring',
        },
      },
    );
    const output = `${run.stdout ?? ''}${run.stderr ?? ''}`;
    // pytest's last non-empty line is its summary: "8 passed, 1 skipped in 12.3s",
    // wrapped in `=` padding. Taken from the output rather than recomputed,
    // because the number a spec quotes should be the number the gate reported.
    const summary = output.trim().split('\n').filter((line) => line.trim()).slice(-1)[0] ?? '';
    const counts: Record<string, number> = {};
    for (const [, n, outcome] of summary.matchAll(/(\d+)\s+(passed|failed|skipped|error|errors|xfailed|xpassed|deselected|warning|warnings)\b/g)) {
      counts[outcome] = Number(n);
    }
    return { gate, status: run.status, output, python, repo: root.repo, summary: summary.replace(/=/g, '').trim(), counts };
  } finally {
    fs.rmSync(stateDir, { recursive: true, force: true });
  }
}
