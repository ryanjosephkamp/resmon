/*
 * GENERATED FILE — do not edit by hand.
 *
 * Source of truth: implementation_scripts/zero_reason.py
 * Regenerate with: npm run gen:zero-reason
 *
 * `ZeroReasonSurfaces.test.tsx` regenerates this from the Python and fails if
 * the committed text differs, so a reason added to the backend turns the
 * renderer suite red rather than reaching a user as an unhandled slug.
 */

/** Every reason the backend can record for a zero — `zero_reason.ZERO_REASONS`. */
export const ZERO_REASONS = [
  'missing_key',
  'retired',
  'window_unanswerable',
  'upstream_failure',
  'parse_failure',
  'rights_filtered',
  'records_unusable',
  'entity_unsupported',
  'answered_empty',
  'not_recorded',
] as const;

export type ZeroReason = typeof ZERO_REASONS[number];

/**
 * The reasons that mean *the source did not answer*, as opposed to *it
 * answered and had nothing* — `zero_reason.DID_NOT_ANSWER`.
 */
export const DID_NOT_ANSWER: ReadonlySet<string> = new Set<string>([
  'missing_key',
  'retired',
  'window_unanswerable',
  'upstream_failure',
  'parse_failure',
  'entity_unsupported',
]);
