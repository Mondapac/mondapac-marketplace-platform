// Which API input a Sales list's one search box fills (spec 0.5). The API has two: `q`, an exact id
// (or a tracking reference), and `search`, a customer or store name that the owning modules
// resolve. The page shows one box and decides here.

export const SEARCH_MIN = 2;
export const SEARCH_MAX = 80;

// The API's ids are canonical lower-case UUID v7 only (`CANONICAL_UUID_V7` in shared-kernel's
// id.ts). Typed or linked ids may be upper-case: callers send `toId(text)`, the lower-case form.
const UUID_V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** True for a UUID v7 in any case. A v4 UUID is not an id the API knows: it is plain text. */
export const isUuid = (text: string): boolean => UUID_V7.test(text);

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

/** The canonical (lower-case) form of an id the API accepts, or null for anything else. */
export const toId = (text: string): string | null => (isUuid(text) ? text.toLowerCase() : null);

/** Routes the trimmed text of a search box. */
export function routeSearch(text: string, options: SearchRouteOptions = {}): SearchRoute {
  const value = Array.from(text.trim()).slice(0, SEARCH_MAX).join('');
  if (value === '') return { kind: 'none' };
  if (options.exact === true) return { kind: 'q', value };
  if (isUuid(value)) return { kind: 'q', value: value.toLowerCase() };
  if ((options.exactPrefixes ?? []).some((prefix) => value.startsWith(prefix))) {
    return { kind: 'q', value };
  }
  if (value.length < SEARCH_MIN) return { kind: 'too-short' };
  return { kind: 'search', value };
}
