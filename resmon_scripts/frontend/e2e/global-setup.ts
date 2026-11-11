/**
 * Choose the backend's interpreter once, prove it works, and refuse to start
 * the suite if it does not.
 *
 * Playwright runs this before the first spec is loaded. Throwing here fails the
 * run with a non-zero exit status and no spec results, which is the whole point:
 * the failure this replaces was a run whose backend never started, where most
 * specs reported "did not run" and the process still exited 0.
 *
 * The chosen path is exported into the child processes through `RESMON_PYTHON`,
 * so every spec, every helper that shells out, and the Electron app all agree on
 * one interpreter, and the printed line below names the one they got.
 */
import { resolveInterpreter, verifyInterpreter } from './fixtures/python-interpreter';

export default function globalSetup(): void {
  const { python, source } = resolveInterpreter();
  const backendModule = verifyInterpreter(python);
  process.env.RESMON_PYTHON = python;
  // One line, once, before anything launches — so a run's log says which Python
  // produced it without anyone having to reconstruct it afterwards.
  console.log(`[e2e] backend interpreter: ${python} (from ${source}); imports ${backendModule}`);
}
