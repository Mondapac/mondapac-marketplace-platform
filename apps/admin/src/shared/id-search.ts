// The search box of a list that finds rows by one full id (an order, a seller order): text that
// is not an id asks for nothing, and the box says so. Pure, so the lists share one rule.

import { isUuid } from '../sales/search-route.ts';

/** A pasted id is 36 characters; the box takes a little more, for spaces around it. */
export const ID_SEARCH_MAX = 80;

export type IdSearch =
  | { readonly kind: 'none' }
  | { readonly kind: 'not-id' }
  | { readonly kind: 'id'; readonly value: string };

/**
 * Routes the text of the box: empty asks for nothing, an id is sent in lower case (the same id in
 * capitals is the same search), any other text is not an id. A pasted tab or line break is a
 * space, so the value the API and the relay check holds printable text only.
 */
export function idSearchRoute(text: string): IdSearch {
  // eslint-disable-next-line no-control-regex
  const value = Array.from(text.replace(/[\u0000-\u001f\u007f]+/g, ' ').trim())
    .slice(0, ID_SEARCH_MAX)
    .join('');
  if (value === '') return { kind: 'none' };
  if (isUuid(value)) return { kind: 'id', value: value.toLowerCase() };
  return { kind: 'not-id' };
}
