import type { components } from '../../api/schema';
import { REGION_COLORS } from '../sky/regionColors';
import type { MapPoints, Sky } from '../today/model';
import type { PlateLook } from '../today/Plate';

export type RunMembership = components['schemas']['RunDocumentIds'];
export const SOURCE_COLORS = [...REGION_COLORS, 'var(--ink-2)'];
export const OTHER_SOURCES = '__other_sources__';

/** Palette slots follow the run's saved source order, including sources still asking. */
export function sourceChoices(data: RunMembership, names: (slug: string) => string) {
  const top = data.sources.slice(0, REGION_COLORS.length);
  const extra = data.sources.slice(top.length);
  const choices = top.map((slug, i) => ({ key: slug, label: names(slug), color: SOURCE_COLORS[i]!, sources: [slug] }));
  if (extra.length) choices.push({ key: OTHER_SOURCES, label: 'Other Sources', color: SOURCE_COLORS[REGION_COLORS.length]!, sources: extra });
  return choices.map((choice) => ({ ...choice, count: data.papers.filter((paper) => paper.sources.some((slug) => choice.sources.includes(slug))).length }));
}

/** One placed copy per recorded DOI, retaining all the run's source names for its tip. */
export function runMapIds(data: RunMembership, points: MapPoints, selected: string | null): number[] {
  const placed = new Set(points.id);
  const chosen = selected === OTHER_SOURCES ? data.sources.slice(REGION_COLORS.length) : selected ? [selected] : null;
  return data.papers.flatMap((paper) => {
    if (chosen && !paper.sources.some((slug) => chosen.includes(slug))) return [];
    const id = paper.copies.find((copy) => placed.has(copy));
    return id === undefined ? [] : [id];
  });
}

export function runSourceLook(sky: Sky, data: RunMembership, base: PlateLook | null): PlateLook {
  const membership = new Map(data.papers.flatMap((paper) => paper.copies.map((id) => [id, paper.sources] as const)));
  const group = Uint8Array.from(sky.ids, (id) => {
    const slots = (membership.get(id) ?? []).map((slug) => data.sources.indexOf(slug)).filter((i) => i >= 0);
    return Math.min(REGION_COLORS.length, ...slots);
  });
  return { lit: base?.lit ?? null, found: base?.found ?? new Int32Array(), group, colors: SOURCE_COLORS };
}

export function sourcesFor(data: RunMembership | undefined, id: number | null, names: (slug: string) => string): string {
  return data?.papers.find((paper) => id !== null && paper.copies.includes(id))?.sources.map(names).join(', ') ?? '';
}
