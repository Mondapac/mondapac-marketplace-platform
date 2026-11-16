import { routeSearch, type SearchRoute } from '../search-route.ts';

/** What the one search box looks in: customer, store or id, or a tracking reference. */
export const SEARCH_SCOPES = ['name', 'tracking'] as const;
export type SearchScope = (typeof SEARCH_SCOPES)[number];

/** The API input the text goes to. The tracking scope always sends the text as an exact `q`. */
export const shipmentSearchRoute = (text: string, scope: SearchScope): SearchRoute =>
  routeSearch(text, { exact: scope === 'tracking' });
