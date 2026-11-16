import { isUuid, routeSearch, type SearchRoute } from '../search-route.ts';

/** What the one search box looks in: customer, store or id, or a tracking reference. */
export const SEARCH_SCOPES = ['name', 'tracking'] as const;
export type SearchScope = (typeof SEARCH_SCOPES)[number];

/**
 * The tracking references the API accepts (`TRACKING` in the ordering module's order.ts): letters
 * and digits at both ends, spaces and `. _ # -` between, 80 characters at most. Anything else is
 * refused there with a 422, so the page does not send it.
 */
const TRACKING = /^[A-Za-z0-9][A-Za-z0-9 ._#-]{0,78}[A-Za-z0-9]$|^[A-Za-z0-9]$/;

export type ShipmentSearchRoute = SearchRoute | { readonly kind: 'invalid-tracking' };

/** A route that asks for nothing: the box keeps its text and says what is wrong. */
export const asksNothing = (route: ShipmentSearchRoute): boolean =>
  route.kind === 'too-short' || route.kind === 'invalid-tracking';

/**
 * The API input the text goes to. The tracking scope sends the text as an exact `q`, when it is a
 * tracking reference or an id the API accepts.
 */
export function shipmentSearchRoute(text: string, scope: SearchScope): ShipmentSearchRoute {
  const route = routeSearch(text, { exact: scope === 'tracking' });
  if (
    scope === 'tracking' &&
    route.kind === 'q' &&
    !TRACKING.test(route.value) &&
    !isUuid(route.value)
  ) {
    return { kind: 'invalid-tracking' };
  }
  return route;
}
