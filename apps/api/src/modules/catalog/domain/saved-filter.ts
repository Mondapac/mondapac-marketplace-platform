import { err, ok } from '@mondapac/shared-kernel';
import type { Id, Result, Temporal } from '@mondapac/shared-kernel';

// Saved filters (saved views) of an admin list (catalog design 9.2d). Pure rules: the names, the
// two visibilities, the caps and who may change a filter. The payload (the list's tab, search,
// filters and sort) is validated by the application, which knows each list's vocabulary.

/** Who can use a filter: only its owner, or every admin of the Market who can see the list. */
export const SAVED_FILTER_VISIBILITIES = ['me', 'everyone'] as const;
export type SavedFilterVisibility = (typeof SAVED_FILTER_VISIBILITIES)[number];

export const SAVED_FILTER_NAME_MAX = 60;
/** Filters one admin keeps in one list (all visibilities). */
export const MAX_SAVED_FILTERS_PER_OWNER = 50;
/** Filters shared with everyone in one list of a Market: each one is a tab for every admin. */
export const MAX_SHARED_SAVED_FILTERS = 20;

/** The stored fields of a saved filter, as the repository reads and writes them. */
export interface SavedFilter {
  readonly id: Id<'SavedFilter'>;
  readonly listKey: string;
  readonly ownerAccountId: Id<'Account'>;
  readonly visibility: SavedFilterVisibility;
  readonly name: string;
  /** The closed document the list validates; opaque to the rules here. */
  readonly payload: unknown;
  readonly position: number;
  readonly createdAt: Temporal.Instant;
  readonly updatedAt: Temporal.Instant;
}

export type SavedFilterNameFailure = 'required' | 'type' | 'length' | 'format';

/**
 * A name as it is shown and stored: trimmed, 1 to 60 characters, no control character. Case is kept;
 * two names that differ only by case are the same name (the database unique is on `lower`).
 */
export function parseSavedFilterName(value: unknown): Result<string, SavedFilterNameFailure> {
  if (value === undefined || value === null) return err('required');
  if (typeof value !== 'string') return err('type');
  const name = value.trim();
  if (name === '') return err('required');
  if (Array.from(name).length > SAVED_FILTER_NAME_MAX) return err('length');
  if (/\p{C}/u.test(name)) return err('format');
  return ok(name);
}

/**
 * Whether the actor may rename, change the visibility of, or delete a filter they can see:
 * the owner always (their own preference, whatever their role is today), and anybody who holds
 * the share key for a filter shared with everyone. Somebody else's "me" filter is not visible to
 * the actor at all, so it is never asked about.
 */
export function mayManage(
  filter: Pick<SavedFilter, 'ownerAccountId' | 'visibility'>,
  actorAccountId: Id<'Account'>,
  canShare: boolean,
): boolean {
  if (filter.ownerAccountId === actorAccountId) return true;
  return filter.visibility === 'everyone' && canShare;
}

/** Whether the actor can see a filter: their own, or one shared with everyone. */
export const isVisibleTo = (
  filter: Pick<SavedFilter, 'ownerAccountId' | 'visibility'>,
  actorAccountId: Id<'Account'>,
): boolean => filter.ownerAccountId === actorAccountId || filter.visibility === 'everyone';

/**
 * The order of the tabs: the account's own filters by their position, then the ones other admins
 * shared with everyone, oldest first (ties by id, so the order is stable).
 */
export function inTabOrder<
  T extends Pick<SavedFilter, 'id' | 'ownerAccountId' | 'position' | 'createdAt'>,
>(filters: readonly T[], actorAccountId: Id<'Account'>): T[] {
  const byId = (a: T, b: T) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  const own = filters
    .filter((filter) => filter.ownerAccountId === actorAccountId)
    .sort((a, b) => a.position - b.position || byId(a, b));
  const others = filters
    .filter((filter) => filter.ownerAccountId !== actorAccountId)
    .sort((a, b) => a.createdAt.epochMilliseconds - b.createdAt.epochMilliseconds || byId(a, b));
  return [...own, ...others];
}
