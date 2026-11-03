import { defineCollection, z } from 'astro:content';
import { glob } from 'astro/loaders';

/**
 * Three content collections, two of which read Markdown that lives **outside**
 * this directory and stays where it is.
 *
 *   - ``docs/``             the reference documents. ``README.md`` and
 *                           ``CONTRIBUTING.md`` link to several of them by repository
 *                           path (``docs/adding-a-source.md`` and so on), so
 *                           moving them would break those links.
 *   - ``docs/api-contract/``generated and guarded: ``api_contract.py`` writes
 *                           ``openapi.json`` and ``http.md`` to that exact path
 *                           and ``test_api_contract.py`` regenerates and diffs
 *                           them. Nothing here may move them or rewrite them.
 *   - ``src/content/guide/``the guide, one page per topic.
 *
 * Reading the first two in place means there is one copy of each document,
 * so the site and the repository cannot drift apart.
 */

/**
 * ``docs/*.md``, minus the two that are not reference documents: ``index.md``
 * and ``README.md``, which explains the folder to a maintainer.
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
 * explainer, published at ``/api-contract/``.
 */
const apiContract = defineCollection({
  loader: glob({
    pattern: '*.md',
    base: '../docs/api-contract',
    generateId: ({ entry }) => entry.replace(/\.md$/, ''),
  }),
});

/** The guide. ``order`` is the reading order, not the alphabet. */
const guide = defineCollection({
  loader: glob({ pattern: '*.md', base: './src/content/guide' }),
  schema: z.object({
    title: z.string(),
    summary: z.string(),
    order: z.number(),
  }),
});

export const collections = { docs, apiContract, guide };
