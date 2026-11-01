import { defineCollection, z } from 'astro:content';
import { glob } from 'astro/loaders';

/**
 * Four content collections, three of which read Markdown that lives **outside**
 * this directory and stays where it is.
 *
 *   - ``docs/_posts/``      the 27 published update posts. Their URLs are
 *                           already published, so the files are read in place
 *                           rather than moved.
 *   - ``docs/``             the reference documents. ``README.md`` and
 *                           ``CONTRIBUTING.md`` link to several of them by repository
 *                           path (``docs/adding-a-source.md`` and so on), so
 *                           moving them would break links in files this change
 *                           is not allowed to touch.
 *   - ``docs/api-contract/``generated and guarded: ``api_contract.py`` writes
 *                           ``openapi.json`` and ``http.md`` to that exact path
 *                           and ``test_api_contract.py`` regenerates and diffs
 *                           them. Nothing here may move them or rewrite them.
 *   - ``src/content/guide/``the only new content home: the sections split out
 *                           of the 165 KB ``README.md``.
 *
 * Reading the first three in place means there is one copy of each document,
 * so the site and the repository cannot drift apart.
 */

/** Front matter is as written for Jekyll; the schema describes it, not an ideal. */
const postSchema = z.object({
  title: z.string(),
  // Left deliberately loose: see ``parsePostDate`` in ``src/lib/posts.ts`` for
  // why some of these 27 files hand back a Date and some hand back a string.
  date: z.union([z.date(), z.string()]),
  categories: z.union([z.string(), z.array(z.string())]).optional(),
  layout: z.string().optional(),
});

const posts = defineCollection({
  loader: glob({
    pattern: '*.md',
    base: '../docs/_posts',
    // Keep the file stem as the id. The permalink's day comes from the front
    // matter and its slug comes from the file name, and both halves of that are
    // needed, so the id must stay recoverable rather than being slugified.
    generateId: ({ entry }) => entry.replace(/\.md$/, ''),
  }),
  schema: postSchema,
});

/**
 * ``docs/*.md``, minus the two that are not reference documents: ``index.md``
 * was the Jekyll landing page and ``README.md`` explains the folder to a
 * maintainer. Jekyll published neither as a document page and neither does this.
 */
const docs = defineCollection({
  loader: glob({
    pattern: ['*.md', '!index.md', '!README.md'],
    base: '../docs',
    generateId: ({ entry }) => entry.replace(/\.md$/, ''),
  }),
});

/**
 * ``docs/api-contract/*.md``. ``README.md`` is the folder's own half-page
 * explainer and Jekyll published it at ``/api-contract/``; that URL is live, so
 * it is reproduced rather than dropped.
 */
const apiContract = defineCollection({
  loader: glob({
    pattern: '*.md',
    base: '../docs/api-contract',
    generateId: ({ entry }) => entry.replace(/\.md$/, ''),
  }),
});

/** The README split. ``order`` is the reading order, not the alphabet. */
const guide = defineCollection({
  loader: glob({ pattern: '*.md', base: './src/content/guide' }),
  schema: z.object({
    title: z.string(),
    summary: z.string(),
    order: z.number(),
    /** The ``README.md`` line range this page was cut from, for the audit. */
    readmeLines: z.array(z.string()),
  }),
});

export const collections = { posts, docs, apiContract, guide };
