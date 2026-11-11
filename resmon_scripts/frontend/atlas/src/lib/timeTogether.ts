/**
 * A time kept whole on its line: the space Intl puts between a time and its
 * AM or PM ("11:35 AM") becomes a no-break space, so text that wraps moves
 * the whole time to the next line and never leaves "AM" or "PM" on a line of
 * its own. Every formatter in Atlas that says a time of day passes it here.
 */
export function timeTogether(text: string): string {
  return text.replace(/(\d)[ \u202f]([AP]M)\b/g, '$1\u00a0$2');
}
