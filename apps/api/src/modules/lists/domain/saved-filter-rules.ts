import { err, ok } from '@mondapac/shared-kernel';
import type { Id, Result, Temporal } from '@mondapac/shared-kernel';

// Pure rules of a saved filter that hold for every list: the name, who can see one and who may
// change one. The payload is the owning module's.

export const SAVED_FILTER_VISIBILITIES = ['me', 'everyone'] as const;
export type StoredFilterVisibility = (typeof SAVED_FILTER_VISIBILITIES)[number];

/** The fields of a stored filter the rules below read (the domain imports no contract). */
interface FilterFields {
  readonly id: Id<'SavedFilter'>;
  readonly ownerAccountId: Id<'Account'>;
  readonly visibility: StoredFilterVisibility;
  readonly position: number;
  readonly createdAt: Temporal.Instant;
}
export const SAVED_FILTER_NAME_MAX = 60;

export type SavedFilterNameFailure = 'required' | 'type' | 'length' | 'format';

/** A name as it is shown and stored: trimmed, 1 to 60 characters, no control character. */
export function parseSavedFilterName(value: unknown): Result<string, SavedFilterNameFailure> {
  if (value === undefined || value === null) return err('required');
  if (typeof value !== 'string') return err('type');
  const name = value.trim();
  if (name === '') return err('required');
  if (Array.from(name).length > SAVED_FILTER_NAME_MAX) return err('length');
  if (/\p{C}/u.test(name)) return err('format');
  return ok(name);
}

/** The owner always; anybody who holds the share key, for a filter shared with everyone. */
export function mayManage(
  filter: Pick<FilterFields, 'ownerAccountId' | 'visibility'>,
  actorAccountId: Id<'Account'>,
  canShare: boolean,
): boolean {
  if (filter.ownerAccountId === actorAccountId) return true;
  return filter.visibility === 'everyone' && canShare;
}

/** The caller's own filters, or the ones shared with everyone. */
export const isVisibleTo = (
  filter: Pick<FilterFields, 'ownerAccountId' | 'visibility'>,
  actorAccountId: Id<'Account'>,
): boolean => filter.ownerAccountId === actorAccountId || filter.visibility === 'everyone';

/** The order of the tabs: the caller's own by position, then the shared ones, oldest first. */
export function inTabOrder<
  T extends Pick<FilterFields, 'id' | 'ownerAccountId' | 'position' | 'createdAt'>,
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
