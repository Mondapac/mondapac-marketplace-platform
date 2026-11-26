import { cardsOf, isObject } from './home-source.ts';
import type { PhotoUrl } from './photos.ts';
import type { ShelfCard } from './types.ts';

// The Offers page (`/offers`): the specials shelf of the home page as a page of its own. One read,
// `GET search/specials?limit=24`: the route's largest answer, newest special first, with no paging,
// total or category chips yet (those wait for the API; see docs/future-enhancements). Every answer
// is checked here before it becomes a card (./home-source.ts `cardsOf`).

/** The most the specials route answers in one read. */
export const OFFERS_LIMIT = 24;

export const OFFERS_PATH = `search/specials?limit=${OFFERS_LIMIT}`;

export type OffersPage =
  { readonly kind: 'ok'; readonly items: readonly ShelfCard[] } | { readonly kind: 'failed' };

/** The page from a specials answer; a body that is no shelf is `failed`, never an empty page. */
export function offersOf(
  body: unknown,
  slugs: ReadonlyMap<string, string>,
  photo: PhotoUrl | null,
): OffersPage {
  if (!isObject(body) || !Array.isArray(body.items)) return { kind: 'failed' };
  return { kind: 'ok', items: cardsOf(body, slugs, photo) };
}
