import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createMarkdownProcessor } from '@astrojs/markdown-remark';

/**
 * One Markdown processor, used by every page.
 *
 * The settings match Astro's own defaults for ``.md`` files: GitHub-flavored
 * Markdown, SmartyPants, and generated heading ids.
 */
const processor = await createMarkdownProcessor({
  gfm: true,
  smartypants: true,
  syntaxHighlight: { type: 'shiki', excludeLangs: ['math'] },
  shikiConfig: { themes: { light: 'github-light', dark: 'github-dark' }, wrap: true },
});

const BASE = '/resmon';
const REPO_BLOB = 'https://github.com/ryanjosephkamp/resmon/blob/main';
const REPO_RAW = 'https://raw.githubusercontent.com/ryanjosephkamp/resmon/main';

/**
 * The checkout this build is running in — `site/src/lib` up three.
 *
 * Read at build time only, to answer one question: is this path a file that
 * exists in the repository? That is the difference between sending a reader to
 * GitHub and leaving a link alone, and it cannot be answered from the path's
 * shape. Nothing here runs in a browser; the site ships no client JavaScript
 * and `scripts/verify-output.mjs` asserts it.
 */
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

/**
 * Where a document's own links are written from.
 *
 * A Markdown link inside `docs/api-contract/README.md` reads `http.md`,
 * because that is what works in GitHub's file browser, where the reader is
 * standing in `docs/api-contract/`. On the published site the reader is
 * standing at `/resmon/api-contract/` and a browser resolves the same link to
 * `/resmon/api-contract/http.md` — the raw Markdown, if `sync-docs.mjs`
 * happened to preserve it, and nothing at all if it did not. Resolving the
 * link needs the directory it was written from, which only the page that
 * renders the document knows, so each one passes it in.
 */
export type SourceDirectory = '.' | 'docs' | 'docs/api-contract';

export interface RewriteOptions {
  /** The document's directory in the repository. */
  from?: SourceDirectory;
}

/** Collapse `a/b/../c` to `a/c`. Returns null if the path climbs out of the repository. */
function normalizeRepoPath(directory: string, target: string): string | null {
  const segments: string[] = [];
  for (const segment of `${directory}/${target}`.split('/')) {
    if (segment === '' || segment === '.') continue;
    if (segment === '..') {
      if (segments.length === 0) return null;
      segments.pop();
    } else segments.push(segment);
  }
  return segments.join('/');
}

/**
 * A repository path -> where the published site should send a reader, or null
 * to leave the link as it was.
 *
 * Three outcomes, in order of preference: the rendered page, when the site
 * publishes one; the file on GitHub, when it exists in the repository but has
 * no page; and nothing, when the path is not in the repository at all. A link
 * left broken is visibly broken. A link rewritten to a GitHub URL that 404s
 * looks right and is not, which is worse.
 */
function siteTargetFor(repoPath: string): string | null {
  // `docs/api-contract/` — a directory, written with its trailing slash.
  if (repoPath === 'docs/api-contract') return `${BASE}/api-contract/`;

  const contract = /^docs\/api-contract\/([a-zA-Z0-9._-]+)\.md$/.exec(repoPath);
  if (contract) {
    return `${BASE}/api-contract/${contract[1] === 'README' ? '' : `${contract[1]}/`}`;
  }

  // The generated OpenAPI document has no page; `sync-docs.mjs` publishes the
  // file itself, and `reference/index.astro` already links to it there.
  const contractJson = /^docs\/api-contract\/([a-zA-Z0-9._-]+\.json)$/.exec(repoPath);
  if (contractJson) return `${BASE}/api-contract/${contractJson[1]}`;

  // A reference document: `docs/<name>.md` renders at `/resmon/<name>/`.
  const reference = /^docs\/([a-zA-Z0-9._-]+)\.md$/.exec(repoPath);
  if (reference && reference[1] !== 'README' && reference[1] !== 'index') {
    return `${BASE}/${reference[1]}/`;
  }

  // The root README's content is the guide.
  if (repoPath === 'README.md') return `${BASE}/guide/`;

  // Anything else that is really in the repository: send the reader to GitHub,
  // where it is, rather than to a path this site does not serve.
  if (existsSync(join(REPO_ROOT, repoPath))) return `${REPO_BLOB}/${repoPath}`;

  return null;
}

/**
 * The same question for an image, which has a different right answer.
 *
 * `![alt](src)` is the same five characters of Markdown as a link, but a
 * `blob` URL is GitHub's HTML page *about* a file, and an `<img>` pointed at
 * one renders as a broken image. The `raw.githubusercontent.com` host is the
 * file itself, which is why REPO_RAW exists.
 *
 * `site/public/**` is copied verbatim into the output, so an image that lives
 * there is served by the site and that is the better target.
 */
function imageTargetFor(repoPath: string): string | null {
  const published = /^site\/public\/(.+)$/.exec(repoPath);
  if (published && existsSync(join(REPO_ROOT, repoPath))) return `${BASE}/${published[1]}`;

  if (existsSync(join(REPO_ROOT, repoPath))) return `${REPO_RAW}/${repoPath}`;

  return null;
}

/**
 * Is the `]` at `closeAt` the end of an image's label rather than a link's?
 *
 * Walks left from the closing bracket to the `[` that opens it, counting
 * depth so a label containing its own brackets does not fool it, and reports
 * whether a `!` sits immediately before that `[`.
 */
function isImage(markdown: string, closeAt: number): boolean {
  let depth = 1;
  for (let at = closeAt - 1; at >= 0; at -= 1) {
    const character = markdown[at];
    if (character === ']') depth += 1;
    else if (character === '[') {
      depth -= 1;
      if (depth === 0) return markdown[at - 1] === '!';
    }
  }
  return false;
}

/**
 * Rewrite the repository-relative links that appear in this content so they
 * resolve on the published site.
 *
 * Applied to the Markdown source rather than the rendered HTML so that a link
 * and its inline-code label (``[`docs/backup.md`](docs/backup.md)``) are both
 * visible to the same pass — the label keeps the repository path, which is what
 * a reader looking at a checkout wants, while the href goes to the site.
 *
 * Anything this does not recognize is left alone. A link left pointing at the
 * repository is a worse page; a link rewritten to a URL that does not exist is
 * a lie about where something is.
 *
 * Only the href moves. No link's visible text is touched, which matters most
 * in `docs/third-party-notices.md`, where the text of an attribution is the
 * attribution and rendering it differently would be a change to it.
 */
export function rewriteLinks(markdown: string, options: RewriteOptions = {}): string {
  const from = options.from ?? '.';

  // `](target)` and `](target "title")`, with no spaces or parentheses in the
  // target — the forms these documents actually use. A target that is already
  // a URL, a fragment or a site-absolute path is left alone.
  //
  // Whether this `](` closes an image rather than a link is decided by walking
  // back to the `[` that opened it and looking for a `!`, not by widening the
  // pattern to `!?\[([^\]]*)\]`: a label can contain a `]`, as in
  // ``[`list[0]`](x)``, and the narrow pattern is what keeps those working.
  const out = markdown.replace(
    /\]\((?!<)([^()\s#]+)(#[^()\s]*)?((?:\s+"[^"]*")?)\)/g,
    (whole, target: string, fragment = '', title = '', offset: number) => {
      if (/^(?:[a-z][a-z0-9+.-]*:|\/\/|\/)/i.test(target)) return whole;
      const repoPath = normalizeRepoPath(from, target);
      if (repoPath === null) return whole;
      const site = isImage(markdown, offset) ? imageTargetFor(repoPath) : siteTargetFor(repoPath);
      return site === null ? whole : `](${site}${fragment}${title})`;
    },
  );

  return out;
}

export interface Heading {
  depth: number;
  slug: string;
  text: string;
}

export interface Rendered {
  html: string;
  /** Generated heading ids, used to build the on-page contents list. */
  headings: Heading[];
}

/** Render Markdown to the HTML string the pages use. */
export async function renderMarkdown(
  markdown: string,
  options: RewriteOptions = {},
): Promise<Rendered> {
  const result = await processor.render(rewriteLinks(markdown, options));
  return { html: result.code, headings: result.metadata.headings as Heading[] };
}
