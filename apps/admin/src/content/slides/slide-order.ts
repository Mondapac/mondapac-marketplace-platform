// The "Order by position" view: the live slides of one position in the order buyers read them
// (apps/api storefront `GET storefront/admin/slides/order` and `PUT storefront/admin/slides/order`).
// Pure functions over that list, so the rules are tested without a screen.

import {
  ORDER_API_PATH,
  ORDER_PATH,
  SLIDE_POSITIONS,
  SLIDE_SCOPES,
  type SlideScope,
} from './slide-types.ts';

/** The first position of the catalogue, shown when the page is opened without one. */
export const DEFAULT_ORDER_POSITION = SLIDE_POSITIONS[0]?.key ?? 'home.hero';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Where a list sits: a position, a scope and (but for `all`) the id of the scope. */
export interface OrderPlace {
  readonly position: string;
  readonly scope: SlideScope;
  /** Null with scope `all`, and while the id of another scope has not been entered. */
  readonly scopeId: string | null;
}

/** A row of `GET storefront/admin/slides/order`. */
export interface OrderEntry {
  readonly id: string;
  readonly internalName: string;
  readonly status: 'live' | 'scheduled';
  readonly pinned: boolean;
  readonly startsAt: string;
  readonly endsAt: string;
  readonly overLimit: boolean;
}

export interface OrderView {
  readonly position: string;
  readonly scope: string;
  readonly scopeId: string | null;
  readonly maxActive: number;
  readonly slides: readonly OrderEntry[];
}

export const isScope = (value: string): value is SlideScope =>
  (SLIDE_SCOPES as readonly string[]).includes(value);

export const positionOf = (key: string) => SLIDE_POSITIONS.find((entry) => entry.key === key);

/** The scopes a placement at a position may have; every position takes `all`. */
export const scopesOf = (key: string): readonly SlideScope[] => positionOf(key)?.scopes ?? ['all'];

/**
 * The place named by the address of the page. Anything unknown falls back: a position outside the
 * catalogue to the first one, a scope the position does not take to `all`, and a scope id that is
 * not a UUID to none (the page then asks for it).
 */
export function placeFromSearch(search: {
  readonly position?: string | undefined;
  readonly scope?: string | undefined;
  readonly scopeId?: string | undefined;
}): OrderPlace {
  const position =
    search.position !== undefined && positionOf(search.position) !== undefined
      ? search.position
      : DEFAULT_ORDER_POSITION;
  const scope: SlideScope =
    search.scope !== undefined && isScope(search.scope) && scopesOf(position).includes(search.scope)
      ? search.scope
      : 'all';
  const scopeId =
    scope !== 'all' && search.scopeId !== undefined && UUID.test(search.scopeId.trim())
      ? search.scopeId.trim().toLowerCase()
      : null;
  return { position, scope, scopeId };
}

export const isValidScopeId = (value: string): boolean => UUID.test(value.trim());

/** True when the list can be read: every scope but `all` needs its id. */
export const isReadable = (place: OrderPlace): boolean =>
  place.scope === 'all' || place.scopeId !== null;

function query(place: OrderPlace): URLSearchParams {
  const params = new URLSearchParams({ position: place.position });
  if (place.scope !== 'all') {
    params.set('scope', place.scope);
    if (place.scopeId !== null) params.set('scopeId', place.scopeId);
  }
  return params;
}

/** The page of one place, for the view switch, the selects and the reload. */
export const orderPageHref = (place: OrderPlace): string =>
  `${ORDER_PATH}?${query(place).toString()}`;

/** The API path that reads the order of one place. */
export const orderReadPath = (place: OrderPlace): string =>
  `${ORDER_API_PATH}?${query(place).toString()}`;

/** The body of `PUT storefront/admin/slides/order` for the list as it stands. */
export function orderBody(place: OrderPlace, entries: readonly OrderEntry[]) {
  return {
    position: place.position,
    scope: place.scope,
    scopeId: place.scope === 'all' ? null : place.scopeId,
    slideIds: entries.map((entry) => entry.id),
  };
}

/** How many slides at the start of the list are pinned: they stay first and cannot move. */
export function pinnedCount(entries: readonly OrderEntry[]): number {
  let count = 0;
  while (entries[count]?.pinned === true) count += 1;
  return count;
}

export type Direction = 'up' | 'down';

/** A slide can move one place when it is not pinned and the place is not above the pinned ones. */
export function canMove(entries: readonly OrderEntry[], index: number, direction: Direction) {
  const locked = pinnedCount(entries);
  if (index < locked || index >= entries.length) return false;
  return direction === 'up' ? index > locked : index < entries.length - 1;
}

/** The list with one slide moved a place; the same list when the move is not allowed. */
export function move(
  entries: readonly OrderEntry[],
  index: number,
  direction: Direction,
): readonly OrderEntry[] {
  if (!canMove(entries, index, direction)) return entries;
  const target = direction === 'up' ? index - 1 : index + 1;
  const next = [...entries];
  const moved = next[index];
  const other = next[target];
  if (moved === undefined || other === undefined) return entries;
  next[index] = other;
  next[target] = moved;
  return next;
}

export const sameOrder = (a: readonly OrderEntry[], b: readonly OrderEntry[]): boolean =>
  a.length === b.length && a.every((entry, index) => entry.id === b[index]?.id);

/**
 * Which slides are over the limit if the list is read in this order: a live slide is over the
 * limit when `maxActive` or more live slides come before it. A scheduled slide never is.
 */
export function overLimitFlags(entries: readonly OrderEntry[], maxActive: number): boolean[] {
  let live = 0;
  return entries.map((entry) => {
    if (entry.status !== 'live') return false;
    live += 1;
    return live > maxActive;
  });
}

export type SaveFailure =
  'mismatch' | 'denied' | 'network' | 'unknown-slide' | 'invalid' | 'generic';

/** What a refused save means to the admin, from the status and code of the API's answer. */
export function saveFailureOf(failure: {
  readonly status: number;
  readonly code: string;
  readonly details?: {
    readonly fields?: readonly { readonly path: string; readonly code: string }[];
  };
}): SaveFailure {
  if (failure.code === 'network') return 'network';
  if (failure.code === 'storefront.slide-order-mismatch') return 'mismatch';
  if (failure.status === 403) return 'denied';
  if (failure.code === 'validation.failed') {
    const fields = failure.details?.fields ?? [];
    if (fields.some((field) => field.path.startsWith('slideIds['))) return 'unknown-slide';
    return fields.length > 0 ? 'invalid' : 'generic';
  }
  return 'generic';
}
