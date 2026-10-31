import type { components } from '../../api/schema';
import { buildSky, density, type Field, type Sky } from '../today/model';

type CollectionMap = components['schemas']['CollectionMap'];

/** The sky every map of the whole collection draws, and its shading. */
export interface CollectionSky { sky: Sky; field: Field }

// One per answer from `/api/map` and day, however many pages draw it: at
// 100,000 papers the two together take tens of milliseconds, and Today,
// Search, Watches, and a paper's page all draw the same collection.
const built = new WeakMap<CollectionMap, Map<number, CollectionSky>>();

/** The whole collection as a sky, built once for each answer from the engine and each day. */
export function collectionSky(map: CollectionMap, day: number): CollectionSky {
  let byDay = built.get(map);
  if (!byDay) {
    byDay = new Map();
    built.set(map, byDay);
  }
  let found = byDay.get(day);
  if (!found) {
    const sky = buildSky(map.points, map.regions, day);
    found = { sky, field: density(sky, 160, 2) };
    byDay.set(day, found);
  }
  return found;
}
