/** A paper's web address, with arXiv links upgraded to HTTPS. */
export function sourceAddress(value: string | null | undefined): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    if (url.protocol === 'http:' && /(^|\.)arxiv\.org$/i.test(url.hostname)) url.protocol = 'https:';
    return url.href;
  } catch {
    return null;
  }
}
