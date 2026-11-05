/**
 * Removing the folders a test made, once the test is over.
 *
 * A launch's state folder holds the engine's database and logs and Chromium's
 * profile, and the processes writing them do not all stop the moment the app's
 * close resolves: the engine, Electron, and Chromium's helper processes can
 * still be writing into the folder for a moment after. A recursive removal that
 * meets one of those writes fails with ENOTEMPTY (EBUSY or EPERM on Windows),
 * and a failure there would turn a test whose assertions all passed red in its
 * teardown. So the removal is retried, and if it still cannot finish, the folder
 * is named on one line and left: every folder passed here is one the suite made
 * under the system's temporary folder, so one left behind costs disk space, not
 * the result of the test.
 *
 * Only for teardown, and only after the app's close has resolved. A removal that
 * is part of what a test does, or whose failure should fail the test, calls
 * `fs.rmSync` itself.
 */
import * as fs from 'fs';

export function removeStateDir(dir: string): void {
  try {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code ?? String(error);
    console.warn(`[e2e] could not remove ${dir}: ${code}; left for the system to clear`);
  }
}
