/**
 * Numbers in a chart's tooltip exactly as the engine served them: a share the
 * engine rounded to four places is shown to two places of a percent, never
 * rounded again, and a count is shown whole with its thousands marked. A
 * chart's own labels may round to fit; its tooltip is where the full number is.
 */

const WHOLE = new Intl.NumberFormat('en-US');

/** Places after the decimal point in a number as written: `0.7834` has 4. */
function places(value: number): number {
  const text = String(value);
  if (/e-/i.test(text)) {
    const [mantissa = '', exponent = '0'] = text.toLowerCase().split('e-');
    return (mantissa.split('.')[1]?.length ?? 0) + Number(exponent);
  }
  return text.split('.')[1]?.length ?? 0;
}

/** A count, whole: "12,408". */
export function exactCount(value: number): string {
  return WHOLE.format(value);
}

/**
 * A share the engine served as a fraction, as a percent with every digit it
 * carried: 0.7834 is "78.34%", 0.8 is "80%", 1 is "100%". `null` is "not
 * enough to say", never 0.
 */
export function exactShare(share: number | null | undefined): string | null {
  if (share === null || share === undefined || !Number.isFinite(share)) return null;
  const digits = Math.max(0, places(share) - 2);
  const percent = (share * 100).toFixed(digits);
  // `toFixed` writes no thousands mark; a share is at most 100%, so it needs none.
  return `${percent}%`;
}

/**
 * Days as the engine served them, to the place it rounded to: "0.4 days",
 * "1 day", "12.5 days". A negative lag is a paper first seen before its
 * stated date, said so rather than as a negative.
 */
export function exactDays(days: number | null | undefined): string | null {
  if (days === null || days === undefined || !Number.isFinite(days)) return null;
  const size = Math.abs(days);
  const text = size.toFixed(places(size));
  const unit = size === 1 ? 'day' : 'days';
  return days < 0 ? `${text} ${unit} before its stated date` : `${text} ${unit}`;
}
