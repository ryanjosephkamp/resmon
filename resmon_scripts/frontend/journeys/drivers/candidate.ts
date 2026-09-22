/**
 * The journey driver for the candidate build — whatever `main` produces.
 *
 * Today `main`'s renderer *is* the classic renderer, so this re-exports the
 * classic driver and the two legs of the CI job differ only in which build they
 * launch. That is deliberate and it is the point of landing this now: the two
 * legs are green on the same commit today, so when they stop agreeing the
 * disagreement is the 3.0 renderer's and not the harness's.
 *
 * When the 3.0 renderer exists, **only this file's body changes**: it grows a
 * `createCandidateDriver` of its own against the new markup, and every spec in
 * this directory runs against it unedited. If that turns out not to be true,
 * the seam was in the wrong place and the specs will say so by needing edits —
 * which is a measurement, and the reason `register.spec.ts` refuses to let a
 * spec reach the renderer directly.
 */
import { createClassicDriver } from './classic';

export { createClassicDriver as createCandidateDriver };
