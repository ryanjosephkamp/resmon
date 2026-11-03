/**
 * `plate/sky.json`: what the home page's script needs to draw the plate with
 * the app's own map component. Written at build time from the engine's answers
 * (`../../lib/plate.ts`).
 */
import { live } from '../../lib/plate';

export const GET = () => new Response(JSON.stringify(live), { headers: { 'Content-Type': 'application/json' } });
