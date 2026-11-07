/**
 * `plate/facets.json`: the engine's facets of the plate's collection
 * (`../../data/facets.json`), what the map's filters and colors read. Fetched
 * when a reader opens the map's menus or chooses a view that needs them.
 */
import data from '../../data/facets.json';

export const GET = () =>
  new Response(JSON.stringify(data.facets), { headers: { 'Content-Type': 'application/json' } });
