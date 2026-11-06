import type { Ranking } from './filters';

/**
 * Search's order is held in the address as `order=similarity`, beside the words
 * and the filters, so Back finds the results in the order they were left in.
 * The default order, newest first, is the address without it.
 */

/** The order the address names: newest for none, or for a name that is not an order. */
export function readOrder(params: URLSearchParams): Ranking {
  return params.get('order') === 'similarity' ? 'similarity' : 'newest';
}

/** The address with the order set; the default order takes the parameter off. */
export function withOrder(params: URLSearchParams, order: Ranking): URLSearchParams {
  const next = new URLSearchParams(params);
  if (order === 'newest') next.delete('order'); else next.set('order', order);
  return next;
}
