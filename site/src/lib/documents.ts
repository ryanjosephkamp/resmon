/**
 * The reference documents in `docs/` were written to be read in a checkout, so
 * none of them carries front matter: each starts with a single `# Heading` and
 * then a paragraph. That is the title and the description, and taking them from
 * the file rather than from a list beside it means a renamed document does not
 * quietly keep its old title on the site.
 */

export interface DocumentHead {
  title: string;
  description: string;
  /** The Markdown with the leading `# Heading` removed, so the page has one h1. */
  body: string;
}

const MAX_DESCRIPTION = 180;

/** Collapse Markdown emphasis, code ticks and links down to readable prose. */
function toPlainText(markdown: string): string {
  return markdown
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/[*_`]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

export function readDocument(markdown: string, fallbackTitle: string): DocumentHead {
  const lines = markdown.split('\n');

  let title = fallbackTitle;
  let body = markdown;

  // The heading is only taken when it is the first non-blank line. A `#` part
  // way down the file is a section, not the document's name.
  let index = 0;
  while (index < lines.length && lines[index].trim() === '') index += 1;
  const heading = lines[index]?.match(/^#\s+(.*\S)\s*$/);
  if (heading) {
    title = toPlainText(heading[1]);
    body = lines.slice(index + 1).join('\n').replace(/^\n+/, '');
  }

  // The description is the first paragraph that is prose: not a heading, not a
  // table row, not a fence, not a list.
  let description = '';
  const paragraphs = body.split(/\n\s*\n/);
  for (const paragraph of paragraphs) {
    const trimmed = paragraph.trim();
    if (!trimmed) continue;
    if (/^[#>|`\-*\d]/.test(trimmed)) continue;
    description = toPlainText(trimmed);
    break;
  }
  if (!description) description = title;
  if (description.length > MAX_DESCRIPTION) {
    description = `${description.slice(0, MAX_DESCRIPTION - 1).trimEnd()}…`;
  }

  return { title, description, body };
}
