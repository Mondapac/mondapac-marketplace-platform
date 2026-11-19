import { isUuid } from '../../sales/search-route.ts';

/**
 * The one search box of the queue looks for an id: a certificate id or a submission id, exact. Any
 * other text is not asked (the API would refuse it) and the box says what it takes.
 */
export type QueueSearch =
  | { readonly kind: 'none' }
  | { readonly kind: 'id'; readonly value: string }
  | { readonly kind: 'invalid' };

export function queueSearchRoute(text: string): QueueSearch {
  const value = text.trim();
  if (value === '') return { kind: 'none' };
  return isUuid(value) ? { kind: 'id', value: value.toLowerCase() } : { kind: 'invalid' };
}
