/**
 * `plate/papers.json`: every paper on the plate, as its hover and its panel
 * say it (`../../data/papers.json`). The page fetches it the first time a
 * reader points at the map, so the first view never waits for it.
 */
import papers from '../../data/papers.json';

export const GET = () =>
  new Response(JSON.stringify({ fields: papers.fields, papers: papers.papers }), {
    headers: { 'Content-Type': 'application/json' },
  });
