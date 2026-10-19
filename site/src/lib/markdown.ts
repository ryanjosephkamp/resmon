import { createMarkdownProcessor } from '@astrojs/markdown-remark';

/**
 * One Markdown processor, used by every page **and** by the Atom feed.
 *
 * The feed is not decoration. ``BlogTab.tsx`` fetches ``/feed.xml`` on every
 * tab open, parses it with ``DOMParser``, and builds the post list's preview
 * text by stripping the tags out of each entry's ``<content>`` and taking the
 * first 240 characters. If the feed's HTML came from a different renderer than
 * the post pages, the preview in the app and the page the user then opens could
 * disagree about what the post says. Sharing the processor removes that
 * possibility rather than testing for it.
 *
 * The settings match Astro's own defaults for ``.md`` files — GitHub-flavored
 * Markdown, SmartyPants, and generated heading ids — which are also what
 * Jekyll's kramdown produced for these 27 posts. The HTML is therefore
 * equivalent to the old feed's, not byte-identical to it; the differences are
 * enumerated in ``scripts/verify-output.mjs``.
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
 * Anchors that pointed at a heading inside the single 165 KB ``README.md`` and
 * now point at a different page. Listed one by one, because a guess at where a
 * fragment used to resolve is a broken link that looks like a working one.
 */
const README_ANCHORS: Record<string, string> = {
  '#configuration': `${BASE}/guide/configuration/`,
  '#google-drive-backup': `${BASE}/guide/backup/#google-drive-backup`,
};

/**
 * Rewrite the repository-relative links that appear in this content so they
 * resolve on the published site.
 *
 * Applied to the Markdown source rather than the rendered HTML so that a link
 * and its inline-code label (``[`docs/backup.md`](docs/backup.md)``) are both
 * visible to the same pass — the label keeps the repository path, which is what
 * a reader looking at a checkout wants, while the href goes to the site.
 *
 * Anything this does not recognise is left alone. A link left pointing at the
 * repository is a worse page; a link rewritten to a URL that does not exist is
 * a lie about where something is.
 */
export function rewriteLinks(markdown: string, options: { fromReadme?: boolean } = {}): string {
  let out = markdown;

  // docs/api-contract/<name>.md -> /resmon/api-contract/<name>/
  out = out.replace(
    /\]\((?:\.\/)?(?:docs\/)?api-contract\/([a-zA-Z0-9._-]+)\.md(#[^)]*)?\)/g,
    (_match, name: string, fragment = '') =>
      `](${BASE}/api-contract/${name === 'README' ? '' : `${name}/`}${fragment})`,
  );

  // docs/<name>.md -> /resmon/<name>/   (and ./<name>.md from inside docs/)
  out = out.replace(
    /\]\(docs\/([a-zA-Z0-9._-]+)\.md(#[^)]*)?\)/g,
    (_match, name: string, fragment = '') => `](${BASE}/${name}/${fragment})`,
  );

  // Repository files with no page of their own.
  out = out.replace(
    /\]\((?:\.\/)?(CONTRIBUTING|AGENTS|LICENSE|CHANGELOG)\.md(#[^)]*)?\)/g,
    (_match, name: string, fragment = '') => `](${REPO_BLOB}/${name}.md${fragment})`,
  );

  if (options.fromReadme) {
    for (const [anchor, target] of Object.entries(README_ANCHORS)) {
      out = out.split(`](${anchor})`).join(`](${target})`);
    }
    // The banner is committed in the repository, not on the site.
    out = out.replace(/src="resmon_reports\//g, `src="${REPO_RAW}/resmon_reports/`);
  }

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

/** Render Markdown to the HTML string both the pages and the feed use. */
export async function renderMarkdown(
  markdown: string,
  options: { fromReadme?: boolean } = {},
): Promise<Rendered> {
  const result = await processor.render(rewriteLinks(markdown, options));
  return { html: result.code, headings: result.metadata.headings as Heading[] };
}
