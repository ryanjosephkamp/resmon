/**
 * A reporter that fails the run when specs were collected but never ran.
 *
 * Playwright exits 0 when every test it actually *ran* passed, and a test that
 * was never reached — a worker that died, a fixture that killed the process, a
 * collection error swallowed downstream — is reported as "did not run" without
 * changing the exit status. A local run once printed "28 passed / 3 skipped /
 * 56 did not run" and exited 0. That is a green tick over an absence.
 *
 * So: count what was collected in `onBegin`, count what reported a result in
 * `onTestEnd`, and turn a shortfall into a failed run with both numbers.
 * Skipped tests count as completed — a skip is a decision the suite made and
 * reported, not a test that vanished.
 */
import type { Reporter, Suite, TestCase, TestResult, FullResult } from '@playwright/test/reporter';

class CompletionGuard implements Reporter {
  private collected = 0;
  private completed = new Set<string>();

  onBegin(_config: unknown, suite: Suite): void {
    this.collected = suite.allTests().length;
  }

  onTestEnd(test: TestCase, _result: TestResult): void {
    this.completed.add(test.id);
  }

  async onEnd(result: FullResult): Promise<{ status?: FullResult['status'] } | void> {
    const missing = this.collected - this.completed.size;
    if (missing > 0) {
      console.error(
        `\n[e2e] ${missing} of ${this.collected} collected test cases never ran ` +
        `(${this.completed.size} reported a result). A run that did not run is not a pass.`,
      );
      return { status: 'failed' };
    }
    if (result.status === 'passed') {
      console.log(`[e2e] ${this.completed.size} of ${this.collected} collected test cases reported a result.`);
    }
  }
}

export default CompletionGuard;
