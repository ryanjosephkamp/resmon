/**
 * The rail beside a document: every page in its part of the site, in order.
 *
 * Built from the same collections the pages are built from, so a page added to
 * `site/src/content/guide/`, `docs/`, or `docs/api-contract/` appears in its
 * rail without anything here changing.
 */
import { getCollection } from 'astro:content';
import { readDocument } from './documents';

export interface Rail {
  label: string;
  href: string;
  items: { title: string; href: string }[];
}

export async function guideRail(): Promise<Rail> {
  const guide = await getCollection('guide');
  const items = guide
    .sort((a, b) => a.data.order - b.data.order)
    .map((entry) => ({ title: entry.data.title, href: `/guide/${entry.id}/` }));
  return { label: 'Guide', href: '/guide/', items };
}

export async function referenceRail(): Promise<Rail> {
  const docs = await getCollection('docs');
  const items = docs
    .map((entry) => ({ title: readDocument(entry.body ?? '', entry.id).title, href: `/${entry.id}/` }))
    .sort((a, b) => a.title.localeCompare(b.title));
  return { label: 'Reference', href: '/reference/', items };
}

export async function contractRail(): Promise<Rail> {
  const entries = await getCollection('apiContract');
  const items = entries
    .filter((entry) => entry.id !== 'README')
    .map((entry) => ({
      title: readDocument(entry.body ?? '', entry.id).title,
      href: `/api-contract/${entry.id}/`,
    }))
    .sort((a, b) => a.title.localeCompare(b.title));
  return { label: 'The API contract', href: '/api-contract/', items };
}
