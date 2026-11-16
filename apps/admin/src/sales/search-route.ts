// Which API input a Sales list's one search box fills (spec 0.5). The API has two: `q`, an exact id
// (or a tracking reference), and `search`, a customer or store name that the owning modules
// resolve. The page shows one box and decides here.

export const SEARCH_MIN = 2;
export const SEARCH_MAX = 80;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const isUuid = (text: string): boolean => UUID.test(text);

export type SearchRoute =
  | { readonly kind: 'none' }
  /** One character: nothing is asked, and the box says to type more. */
  | { readonly kind: 'too-short' }
  | { readonly kind: 'q'; readonly value: string }
  | { readonly kind: 'search'; readonly value: string };

export interface SearchRouteOptions {
  /** The box looks for an exact reference only (Shipments "Tracking reference"): always `q`. */
  readonly exact?: boolean;
  /** Text that starts with one of these is an exact id (Refunds: `re_`). */
  readonly exactPrefixes?: readonly string[];
}

/** Routes the trimmed text of a search box. */
export function routeSearch(text: string, options: SearchRouteOptions = {}): SearchRoute {
  const value = Array.from(text.trim()).slice(0, SEARCH_MAX).join('');
  if (value === '') return { kind: 'none' };
  if (options.exact === true) return { kind: 'q', value };
  if (isUuid(value) || (options.exactPrefixes ?? []).some((prefix) => value.startsWith(prefix))) {
    return { kind: 'q', value };
  }
  if (value.length < SEARCH_MIN) return { kind: 'too-short' };
  return { kind: 'search', value };
}
